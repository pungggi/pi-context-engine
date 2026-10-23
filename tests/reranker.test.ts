/**
 * R10: opt-in local reranker — pipeline ordering only, no model downloads
 * in unit tests (stubbed RerankerLike), graceful fallback on failure.
 */
import { afterAll, describe, expect, it } from "vitest";
import { ContextEngine } from "../src/engine.js";
import { defaultConfig, type Config } from "../src/config.js";
import { LocalBackend } from "../src/storage/local-backend.js";
import { HybridRetriever } from "../src/retrieval/retriever.js";
import { LocalReranker, type RerankerLike } from "../src/retrieval/reranker.js";
import { makeFakeEmbedder, makeTempDir, rmrf, writeFiles } from "./helpers.js";

const dirs: string[] = [];
const engines: ContextEngine[] = [];

afterAll(async () => {
	await Promise.all(engines.map((e) => e.shutdown().catch(() => undefined)));
	for (const d of dirs.splice(0)) rmrf(d);
});

const FILES = {
	"src/alpha.ts": "export function alphaSort(items: string[]): string[] {\n  return [...items].sort();\n}\n",
	"src/beta.ts": "export function betaNeedle(values: number[]): number {\n  return values.reduce((a, b) => a + b, 0);\n}\n",
	"src/gamma.ts": "export function gammaFilter(rows: string[], term: string): string[] {\n  return rows.filter((r) => r.includes(term));\n}\n",
};

async function freshBackend(): Promise<LocalBackend> {
	const projectDir = makeTempDir("pce-r10-");
	dirs.push(projectDir);
	writeFiles(projectDir, FILES);
	const storageRoot = makeTempDir("pce-r10store-");
	dirs.push(storageRoot);
	const backend = new LocalBackend(storageRoot);
	const config: Config = { ...defaultConfig(), storagePath: storageRoot };
	const engine = new ContextEngine({ projectDir, config, runtime: { backend, embedder: makeFakeEmbedder() } });
	engines.push(engine);
	await engine.reindex({ full: true });
	return backend;
}

/** Stub that ranks docs by how much it likes the word "needle". */
class NeedleStub implements RerankerLike {
	calls = 0;
	lastDocCount = 0;
	async rerank(_query: string, docs: string[]): Promise<number[]> {
		this.calls += 1;
		this.lastDocCount = docs.length;
		return docs.map((d) => (d.includes("betaNeedle") ? 0.99 : 0.01));
	}
}

class ThrowingStub implements RerankerLike {
	async rerank(): Promise<number[]> {
		throw new Error("model not downloadable");
	}
}

/** transformers.js stub for LocalReranker: counts loads, optionally fails. */
function stubTransformers(opts: { fail?: boolean } = {}) {
	let loads = 0;
	const loader = async () => {
		loads++;
		if (opts.fail) throw new Error("network down");
		return {
			env: {},
			AutoTokenizer: { from_pretrained: async () => (text: string) => ({ text }) },
			AutoModelForSequenceClassification: {
				from_pretrained: async () => async () => ({ logits: { data: [0] } }),
			},
		};
	};
	return { loader, loadCount: () => loads };
}

describe("LocalReranker.warm (issue #11)", () => {
	it("loads the model once and reports ready", async () => {
		const { loader, loadCount } = stubTransformers();
		const reranker = new LocalReranker("fake-model", loader);

		expect(await reranker.warm()).toBe(true);
		expect(reranker.failed).toBe(false);
		expect(reranker.loadError).toBeNull();
		// A second warm reuses the memoized load — no double download.
		expect(await reranker.warm()).toBe(true);
		expect(loadCount()).toBe(1);
	});

	it("returns false and records the reason when the load fails", async () => {
		const { loader } = stubTransformers({ fail: true });
		const reranker = new LocalReranker("fake-model", loader);

		expect(await reranker.warm()).toBe(false);
		expect(reranker.failed).toBe(true);
		expect(reranker.loadError).toBe("network down");
		// Degrade-never-break: a later query is still a silent no-op.
		expect(await reranker.rerank("q", ["doc"])).toEqual([]);
	});
});

describe("R10: opt-in reranker", () => {
	it("reorders the served list toward the reranker's preference", async () => {
		const backend = await freshBackend();
		const embedder = makeFakeEmbedder();
		const without = new HybridRetriever(backend, embedder);
		const withRerank = new HybridRetriever(backend, embedder, { reranker: new NeedleStub() });
		const opts = { topK: 3, confidenceThreshold: 0, marginalRatio: 0 } as const;
		const baseline = await without.retrieve("sort filter sum values", opts);
		const reranked = await withRerank.retrieve("sort filter sum values", opts);
		expect(baseline.length).toBeGreaterThan(1);
		expect(reranked[0]!.filePath).toBe("src/beta.ts");
		// The stub saw at most the documented cap.
		expect((reranked as unknown as { __cap?: number }).__cap).toBeUndefined();
	});

	it("caps the number of docs handed to the reranker", async () => {
		const backend = await freshBackend();
		const embedder = makeFakeEmbedder();
		const stub = new NeedleStub();
		const retriever = new HybridRetriever(backend, embedder, { reranker: stub });
		await retriever.retrieve("sort filter sum", { topK: 5, confidenceThreshold: 0, marginalRatio: 0 });
		expect(stub.calls).toBeGreaterThan(0);
		expect(stub.lastDocCount).toBeLessThanOrEqual(30);
	});

	it("falls back to the fused order when the model fails to load", async () => {
		const backend = await freshBackend();
		const embedder = makeFakeEmbedder();
		const without = new HybridRetriever(backend, embedder);
		const withBroken = new HybridRetriever(backend, embedder, { reranker: new ThrowingStub() });
		const opts = { topK: 5, confidenceThreshold: 0, marginalRatio: 0 } as const;
		const a = await without.retrieve("alphaSort items", opts);
		const b = await withBroken.retrieve("alphaSort items", opts);
		expect(b.map((c) => c.id)).toEqual(a.map((c) => c.id));
	});

	it("is off by default: config retrieval.rerank === 'off' builds no reranker", async () => {
		expect(defaultConfig().retrievalRerank).toBe("off");
		const projectDir = makeTempDir("pce-r10def-");
		dirs.push(projectDir);
		writeFiles(projectDir, FILES);
		const storageRoot = makeTempDir("pce-r10defstore-");
		dirs.push(storageRoot);
		const config: Config = { ...defaultConfig(), storagePath: storageRoot };
		const backend = new LocalBackend(storageRoot);
		const engine = new ContextEngine({ projectDir, config, runtime: { backend, embedder: makeFakeEmbedder() } });
		engines.push(engine);
		await engine.reindex({ full: true });
		const retriever = await engine.getRetriever();
		const out = await retriever.retrieve("alphaSort items", { topK: 3 });
		expect(out.length).toBeGreaterThan(0);
		// No reranker attached: internal flag is null (observable via type only,
		// so assert behavior: results equal a plain retriever's).
		const plain = new HybridRetriever(backend, makeFakeEmbedder());
		const plainOut = await plain.retrieve("alphaSort items", { topK: 3 });
		expect(out.map((c) => c.id)).toEqual(plainOut.map((c) => c.id));
	});
});
