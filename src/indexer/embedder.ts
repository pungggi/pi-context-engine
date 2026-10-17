/**
 * Embedding generation with pluggable backends — port of upstream
 * `indexer/embedder.py` (MIT), with fastembed replaced by transformers.js
 * (ONNX, pure JS + prebuilt native runtime) so no Python/ONNX setup is
 * needed. Ollama support is unchanged.
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { sha256Hex } from "../utils.js";

export const DEFAULT_LOCAL_MODEL = "Xenova/all-MiniLM-L6-v2";
export const DEFAULT_OLLAMA_MODEL = "nomic-embed-text";
export const DEFAULT_OLLAMA_URL = "http://localhost:11434";

export interface EmbeddingBackend {
	name: string;
	modelName: string;
	dimension: number;
	embedTexts(texts: string[], batchSize?: number): Promise<number[][]>;
	embedQuery(query: string): Promise<number[]>;
	/** Resolve model/runtime and learn the dimension. */
	init(): Promise<void>;
}

// ── Local (transformers.js / ONNX) ──────────────────────────────────────────

function resolveModelCacheDir(): string {
	const override = process.env.PCE_TRANSFORMERS_CACHE?.trim() || process.env.TRANSFORMERS_CACHE?.trim();
	if (override) return path.resolve(override.replace(/^~/, os.homedir()));
	return path.join(os.homedir(), ".pi-context-engine", "models");
}

interface TransformersModule {
	pipeline: (
		task: string,
		model: string,
		options?: Record<string, unknown>,
	) => Promise<(inputs: string | string[], options?: Record<string, unknown>) => Promise<unknown>>;
	env: Record<string, unknown>;
}

export class LocalBackend implements EmbeddingBackend {
	readonly name = "local";
	readonly modelName: string;
	dimension = 0;
	private pipelinePromise: Promise<(inputs: string | string[]) => Promise<number[][]>> | null = null;

	constructor(modelName: string = DEFAULT_LOCAL_MODEL) {
		this.modelName = modelName;
	}

	private getPipeline(): Promise<(inputs: string | string[]) => Promise<number[][]>> {
		if (!this.pipelinePromise) {
			this.pipelinePromise = (async () => {
				const cacheDir = resolveModelCacheDir();
				fs.mkdirSync(cacheDir, { recursive: true });
				const transformers = (await import("@huggingface/transformers")) as unknown as TransformersModule;
				transformers.env.cacheDir = cacheDir;
				const extractor = await transformers.pipeline("feature-extraction", this.modelName, {
					pooling: "mean",
					normalize: true,
				} as Record<string, unknown>);
				return async (inputs: string | string[]): Promise<number[][]> => {
					const out = (await extractor(inputs)) as { data: Float32Array; dims: number[] } | { data: Float32Array; dims: number[] }[];
					const single = Array.isArray(out) ? out[0]! : out;
					const dim = single.dims[single.dims.length - 1]!;
					const vecs: number[][] = [];
					if (typeof inputs === "string") {
						vecs.push(Array.from(single.data.slice(0, dim)));
					} else {
						const count = single.dims[0]!;
						for (let i = 0; i < count; i++) {
							vecs.push(Array.from(single.data.slice(i * dim, (i + 1) * dim)));
						}
					}
					return vecs;
				};
			})();
		}
		return this.pipelinePromise;
	}

	async init(): Promise<void> {
		const embed = await this.getPipeline();
		const probe = await embed(["_"]);
		this.dimension = probe[0]!.length;
	}

	async embedTexts(texts: string[], _batchSize = 64): Promise<number[][]> {
		const embed = await this.getPipeline();
		if (texts.length === 0) return [];
		if (texts.length === 1) return embed(texts);
		const out: number[][] = [];
		for (let i = 0; i < texts.length; i += 64) {
			const batch = await embed(texts.slice(i, i + 64));
			out.push(...batch);
		}
		return out;
	}

	async embedQuery(query: string): Promise<number[]> {
		const embed = await this.getPipeline();
		return (await embed(query))[0]!;
	}
}

// ── Ollama ──────────────────────────────────────────────────────────────────

const MAX_EMBED_CHARS = 3000;
const PULL_TIMEOUT_SECONDS = 600;

export class OllamaBackend implements EmbeddingBackend {
	readonly name = "ollama";
	readonly modelName: string;
	dimension = 0;
	private baseUrl: string;
	private timeoutMs: number;

	constructor(modelName: string = DEFAULT_OLLAMA_MODEL, baseUrl: string = DEFAULT_OLLAMA_URL, timeoutMs = 60_000) {
		this.modelName = modelName;
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.timeoutMs = timeoutMs;
	}

	async init(): Promise<void> {
		await this.ensureModel();
		const probe = await this.embedBatch(["_"]);
		if (!probe[0] || probe[0].length === 0) {
			throw new Error(`Ollama returned no embedding for model '${this.modelName}'. Pull it with: ollama pull ${this.modelName}`);
		}
		this.dimension = probe[0].length;
	}

	private async ensureModel(): Promise<void> {
		let tagsResp: Response;
		try {
			tagsResp = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(1500) });
		} catch (err) {
			throw new Error(`Ollama not reachable at ${this.baseUrl}: ${(err as Error).message}`);
		}
		if (!tagsResp.ok) throw new Error(`Ollama at ${this.baseUrl} returned HTTP ${tagsResp.status} for /api/tags`);
		const tags = (await tagsResp.json()) as { models?: { name: string }[] };
		const installed = new Set((tags.models ?? []).map((m) => m.name.split(":")[0]!));
		if (installed.has(this.modelName.split(":")[0]!)) return;
		// One-time pull; bounded so a hung pull can't wedge indexing forever.
		const pullTimeoutMs = Number(process.env.PCE_OLLAMA_PULL_TIMEOUT ?? PULL_TIMEOUT_SECONDS * 1000);
		const resp = await fetch(`${this.baseUrl}/api/pull`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: this.modelName, stream: false }),
			signal: AbortSignal.timeout(pullTimeoutMs),
		});
		if (!resp.ok) throw new Error(`Ollama pull for ${this.modelName} failed: HTTP ${resp.status}`);
	}

	private async embedBatch(texts: string[]): Promise<number[][]> {
		const safeTexts: string[] = [];
		const originalIndices: number[] = [];
		for (let i = 0; i < texts.length; i++) {
			const t = texts[i]!;
			if (!t || !t.trim()) continue;
			safeTexts.push(t.slice(0, MAX_EMBED_CHARS));
			originalIndices.push(i);
		}
		const empty: number[][] = texts.map(() => []);
		if (safeTexts.length === 0) return empty;

		let embeddings: number[][];
		try {
			const resp = await fetch(`${this.baseUrl}/api/embed`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: this.modelName, input: safeTexts }),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
			if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
			embeddings = ((await resp.json()) as { embeddings: number[][] }).embeddings;
		} catch (err) {
			if ((err as Error).message.includes("400")) {
				// Batch failed (one text still too large) — one-at-a-time with halving retry.
				embeddings = [];
				for (const text of safeTexts) {
					embeddings.push(await this.embedSingleWithRetry(text));
				}
			} else {
				throw err;
			}
		}
		for (let i = 0; i < originalIndices.length; i++) {
			empty[originalIndices[i]!] = embeddings[i] ?? [];
		}
		return empty;
	}

	private async embedSingleWithRetry(text: string): Promise<number[]> {
		let t = text;
		while (t) {
			const resp = await fetch(`${this.baseUrl}/api/embed`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ model: this.modelName, input: [t] }),
				signal: AbortSignal.timeout(this.timeoutMs),
			});
			if (resp.status === 400 && (await resp.text()).includes("context length")) {
				t = t.slice(0, Math.floor(t.length / 2));
				continue;
			}
			if (!resp.ok) throw new Error(`Ollama embed failed: HTTP ${resp.status}`);
			const data = (await resp.json()) as { embeddings: number[][] };
			return data.embeddings[0] ?? [];
		}
		return [];
	}

	async embedTexts(texts: string[], batchSize = 64): Promise<number[][]> {
		const out: number[][] = [];
		for (let i = 0; i < texts.length; i += batchSize) {
			out.push(...(await this.embedBatch(texts.slice(i, i + batchSize))));
		}
		return out;
	}

	async embedQuery(query: string): Promise<number[]> {
		const result = await this.embedBatch([query]);
		if (!result[0] || result[0].length === 0) {
			throw new Error(`Ollama returned empty embedding for query (model=${this.modelName})`);
		}
		return result[0];
	}
}

// ── Backend selection ───────────────────────────────────────────────────────

export async function ollamaReachable(baseUrl: string = DEFAULT_OLLAMA_URL): Promise<boolean> {
	try {
		const resp = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, { signal: AbortSignal.timeout(1500) });
		return resp.status === 200;
	} catch {
		return false;
	}
}

/**
 * Pick the first available backend. `prefer` ("local" | "ollama") or
 * `PCE_EMBED_BACKEND` forces a choice; anything else auto-detects
 * (Ollama first — it's the cheapest to probe and avoids the model download).
 */
export async function selectBackend(opts: {
	model?: string;
	ollamaModel?: string;
	ollamaUrl?: string;
	prefer?: string;
} = {}): Promise<EmbeddingBackend> {
	const forced = (opts.prefer ?? process.env.PCE_EMBED_BACKEND ?? "").trim().toLowerCase();
	if (forced && forced !== "local" && forced !== "ollama") {
		throw new Error(`Unknown embedding backend '${forced}'. Expected "local" or "ollama".`);
	}

	const makeLocal = () => new LocalBackend(opts.model && opts.model !== "local" ? opts.model : DEFAULT_LOCAL_MODEL);
	const makeOllama = () => new OllamaBackend(opts.ollamaModel ?? DEFAULT_OLLAMA_MODEL, opts.ollamaUrl ?? DEFAULT_OLLAMA_URL);

	let backend: EmbeddingBackend;
	if (forced === "local") {
		backend = makeLocal();
	} else if (forced === "ollama") {
		backend = makeOllama();
	} else if (await ollamaReachable(opts.ollamaUrl ?? DEFAULT_OLLAMA_URL)) {
		backend = makeOllama();
	} else {
		backend = makeLocal();
	}
	await backend.init();
	return backend;
}

// ── Embedder facade with query cache ────────────────────────────────────────

export class Embedder {
	private backend: EmbeddingBackend;
	private queryCache = new Map<string, number[]>();
	private readonly salt: string;

	constructor(backend: EmbeddingBackend) {
		this.backend = backend;
		this.salt = `${backend.name}:${backend.modelName}`;
	}

	get backendName(): string {
		return this.backend.name;
	}
	get modelName(): string {
		return this.backend.modelName;
	}
	get dimension(): number {
		return this.backend.dimension;
	}
	get cacheSalt(): string {
		return this.salt;
	}

	/** SHA-256 of text, salted with backend identity (shared with EmbeddingCache). */
	contentHash(text: string): string {
		return sha256Hex(`${this.salt}:${text}`);
	}

	embedQuery(query: string): Promise<number[]> {
		const key = query;
		const hit = this.queryCache.get(key);
		if (hit) return Promise.resolve(hit);
		return this.backend.embedQuery(query).then((vec) => {
			if (this.queryCache.size > 256) {
				// crude LRU: clear half when full
				const keys = [...this.queryCache.keys()].slice(0, 128);
				for (const k of keys) this.queryCache.delete(k);
			}
			this.queryCache.set(key, vec);
			return vec;
		});
	}

	/** Batch document embedding (no query cache — indexed content is unique). */
	embedTexts(texts: string[], batchSize = 64): Promise<number[][]> {
		return this.backend.embedTexts(texts, batchSize);
	}
}
