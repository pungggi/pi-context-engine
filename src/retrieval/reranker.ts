/**
 * R10: opt-in local cross-encoder reranker (plan: docs/IMPLEMENTATION-PLAN.md).
 *
 * Why opt-in and OFF by default: reranking evidence is split — a core gain in
 * CodeRAG-style pipelines, but measured harmful for SE tasks when it costs
 * ~800 ms per query. Only this package's own eval can decide, and the model
 * download (~80 MB) must never happen implicitly in a package that markets
 * "one npm command".
 *
 * The reranker reorders the fused candidate list (capped); path penalty, file
 * diversity and the marginal stop are applied AFTER it, unchanged. If the
 * model cannot load, retrieval silently falls back to the fused order — a
 * missing optional download degrades, never breaks.
 *
 * Implementation notes (PR #7 review): we do NOT go through the
 * text-classification pipeline. Two reasons:
 *
 * 1. Its input is a plain string — there is no `{text, text_pair}` shape, so
 *    pair scoring via the pipeline throws and permanently disables reranking.
 * 2. Cross-encoder rerankers (ms-marco-MiniLM) emit ONE logit; the pipeline
 *    softmaxes it, so every document scores exactly 1.0 and no reordering
 *    can happen. Sentence-transformers' CrossEncoder applies a sigmoid to
 *    the raw logit instead — we do the same, on raw model logits.
 */

import { transformersCacheDir } from "../indexer/embedder.js";

/** Minimal interface so unit tests can inject a stub (no model download). */
export interface RerankerLike {
	rerank(query: string, docs: string[]): Promise<number[]>;
}

/** Structural slice of @huggingface/transformers we need (kept `any`-light). */
interface TransformersModule {
	AutoTokenizer: {
		from_pretrained: (model: string, options?: Record<string, unknown>) => Promise<TokenizerLike>;
	};
	AutoModelForSequenceClassification: {
		from_pretrained: (model: string, options?: Record<string, unknown>) => Promise<ModelLike>;
	};
	env: Record<string, unknown>;
}

interface TokenizerLike {
	(text: string, options: Record<string, unknown>): unknown;
}

interface ModelLike {
	(inputs: unknown): Promise<{ logits: { data: Float32Array | number[] } }>;
}

type LoadedReranker = { tokenizer: TokenizerLike; model: ModelLike };

export class LocalReranker implements RerankerLike {
	private loaded: LoadedReranker | null = null;
	private loading: Promise<LoadedReranker | null> | null = null;
	/** Set after a load failure; every later call short-circuits to no-op. */
	failed = false;

	constructor(
		readonly model: string,
		private readonly loadTransformers: () => Promise<TransformersModule> = async () =>
			(await import("@huggingface/transformers")) as unknown as TransformersModule,
	) {}

	async rerank(query: string, docs: string[]): Promise<number[]> {
		if (this.failed || docs.length === 0) return [];
		try {
			const loaded = await this.ensureLoaded();
			if (!loaded) return [];
			const { tokenizer, model } = loaded;
			const scores: number[] = [];
			// One pair per call: 30 sequential CPU inferences are well inside
			// the latency budget this opt-in feature accepts, and per-pair
			// truncation keeps a long doc from padding the whole batch.
			for (const doc of docs) {
				const inputs = tokenizer(query, { text_pair: doc, padding: true, truncation: true });
				const out = await model(inputs);
				const logit = Number(out.logits.data[0] ?? 0);
				// Sigmoid, not softmax: single-logit cross-encoders must keep
				// their ranking signal (softmax over one logit is constant 1).
				scores.push(1 / (1 + Math.exp(-logit)));
			}
			return scores;
		} catch {
			this.failed = true;
			return [];
		}
	}

	private ensureLoaded(): Promise<LoadedReranker | null> {
		if (this.loaded) return Promise.resolve(this.loaded);
		if (!this.loading) {
			this.loading = (async () => {
				const mod = await this.loadTransformers();
				// Same models dir as the embedder, so opt-in reranking never
				// downloads into a stray ./Xenova folder inside the project.
				mod.env.cacheDir = transformersCacheDir();
				const tokenizer = await mod.AutoTokenizer.from_pretrained(this.model);
				const model = await mod.AutoModelForSequenceClassification.from_pretrained(this.model, {
					quantized: true,
				});
				this.loaded = { tokenizer, model };
				return this.loaded;
			})().catch(() => {
				this.failed = true;
				return null;
			});
		}
		return this.loading;
	}
}
