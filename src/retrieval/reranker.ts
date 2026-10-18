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
 */

/** Minimal interface so unit tests can inject a stub (no model download). */
export interface RerankerLike {
	rerank(query: string, docs: string[]): Promise<number[]>;
}

interface TransformersModule {
	pipeline: (
		task: string,
		model: string,
		options?: Record<string, unknown>,
	) => Promise<(inputs: unknown, options?: Record<string, unknown>) => Promise<unknown>>;
	env: Record<string, unknown>;
}



export class LocalReranker implements RerankerLike {
	private pipe: ((inputs: unknown, options?: Record<string, unknown>) => Promise<unknown>) | null = null;
	private loading: Promise<((inputs: unknown, options?: Record<string, unknown>) => Promise<unknown>) | null> | null = null;
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
			const pipe = await this.ensurePipe();
			if (!pipe) return [];
			const scores: number[] = [];
			// One pair per call: transformers.js batching for cross-encoders
			// varies by version, and 30 sequential CPU inferences are well
			// inside the latency budget this opt-in feature accepts.
			for (const doc of docs) {
				const out = (await pipe({ text: query, text_pair: doc })) as
					| { label?: string; score?: number }[]
					| { label?: string; score?: number };
				const first = Array.isArray(out) ? out[0] : out;
				scores.push(typeof first?.score === "number" ? first.score : 0);
			}
			return scores;
		} catch {
			this.failed = true;
			return [];
		}
	}

	private ensurePipe(): Promise<((inputs: unknown, options?: Record<string, unknown>) => Promise<unknown>) | null> {
		if (this.pipe) return Promise.resolve(this.pipe);
		if (!this.loading) {
			this.loading = (async () => {
				const mod = await this.loadTransformers();
				const pipe = await mod.pipeline("text-classification", this.model, {
					quantized: true,
				});
				this.pipe = pipe;
				return this.pipe;
			})().catch(() => {
				this.failed = true;
				return null;
			});
		}
		return this.loading;
	}
}

