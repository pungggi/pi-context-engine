/**
 * Issue #11 (upstream elara-labs#168): /context-warmup — pre-fetch/cache the
 * embedding model (and the opt-in reranker) without needing an index. All
 * backends are injected stubs, so no test touches the network or downloads.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ContextEngine } from "../src/engine.js";
import { defaultConfig, type Config } from "../src/config.js";
import { LocalBackend } from "../src/storage/local-backend.js";
import { LocalReranker } from "../src/retrieval/reranker.js";
import { makeFakeEmbedder, makeTempDir, rmrf, writeFiles } from "./helpers.js";

const engines: ContextEngine[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
	for (const engine of engines.splice(0)) {
		try {
			await engine.shutdown();
		} catch {
			// already closed
		}
	}
	for (const dir of tempDirs.splice(0)) rmrf(dir);
});

/** Stub transformers loader for LocalReranker; counts loads, optionally fails. */
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

interface HarnessOpts {
	rerank?: boolean;
	reranker?: LocalReranker;
	repo?: Record<string, string>;
}

async function harness(opts: HarnessOpts = {}) {
	const projectDir = makeTempDir("pce-warm-");
	const storageRoot = makeTempDir("pce-warm-store-");
	tempDirs.push(projectDir, storageRoot);
	writeFiles(projectDir, opts.repo ?? {});

	const config: Config = {
		...defaultConfig(),
		storagePath: storageRoot,
		retrievalRerank: opts.rerank ? "local" : "off",
	};
	const embedder = makeFakeEmbedder();
	const backend = new LocalBackend(storageRoot);
	const engine = new ContextEngine({
		projectDir,
		config,
		runtime: { backend, embedder, reranker: opts.reranker },
	});
	engines.push(engine);
	return { engine, projectDir, storageRoot, embedder, backend };
}

describe("engine.warmup", () => {
	it("resolves the embedder with an empty repo and no index", async () => {
		const { engine, embedder } = await harness();

		const report = await engine.warmup();

		expect(report.backend).toBe("fake");
		expect(report.model).toBe("fake-embed");
		expect(report.dimension).toBe(64);
		expect(report.reranker).toBeUndefined();
		// The injected embedder is reused (no auto-detect, no download) and
		// memoized, so a later search rides the same instance.
		const internals = engine as unknown as { embedderInstance: unknown };
		expect(internals.embedderInstance).toBe(embedder);
	});

	it("skips the reranker when retrieval.rerank is off (default)", async () => {
		const { engine } = await harness();

		const report = await engine.warmup();
		expect(report.reranker).toBeUndefined();
		expect(report.rerankerReady).toBeUndefined();
	});

	it("warms the opt-in reranker with the instance the retriever will use", async () => {
		const { loader, loadCount } = stubTransformers();
		const reranker = new LocalReranker("fake-reranker", loader);
		const { engine } = await harness({ rerank: true, reranker });

		const report = await engine.warmup();

		expect(report.reranker).toBe("fake-reranker");
		expect(report.rerankerReady).toBe(true);
		expect(loadCount()).toBe(1);
		// Same instance the search path gets — the model stays warm across
		// the command boundary (this is what makes warmup worthwhile).
		const internals = engine as unknown as { rerankerInstance: unknown };
		expect(internals.rerankerInstance).toBe(reranker);
	});

	it("reports a reranker failure instead of rejecting", async () => {
		const { loader } = stubTransformers({ fail: true });
		const reranker = new LocalReranker("fake-reranker", loader);
		const { engine } = await harness({ rerank: true, reranker });

		const report = await engine.warmup();

		// The embedder still warmed; the opt-in reranker degrades to a
		// reported failure instead of breaking the whole warmup.
		expect(report.backend).toBe("fake");
		expect(report.rerankerReady).toBe(false);
		expect(report.rerankerError).toBe("network down");
	});

	it("propagates a backend failure so the command can surface the real error", async () => {
		const projectDir = makeTempDir("pce-warm-fail-");
		const storageRoot = makeTempDir("pce-warm-failstore-");
		tempDirs.push(projectDir, storageRoot);
		const config: Config = { ...defaultConfig(), storagePath: storageRoot };
		const engine = new ContextEngine({ projectDir, config });
		engines.push(engine);

		// Force the Ollama backend (no runtime injection) and point it at a
		// port nothing listens on: selectBackend + init must reject, and the
		// command layer relies on warmup NOT swallowing that.
		const prevBackend = process.env.PCE_EMBED_BACKEND;
		const prevUrl = process.env.PCE_OLLAMA_URL;
		process.env.PCE_EMBED_BACKEND = "ollama";
		process.env.PCE_OLLAMA_URL = "http://localhost:59999";
		try {
			await expect(engine.warmup()).rejects.toThrow(/Ollama not reachable/);
		} finally {
			if (prevBackend === undefined) delete process.env.PCE_EMBED_BACKEND;
			else process.env.PCE_EMBED_BACKEND = prevBackend;
			if (prevUrl === undefined) delete process.env.PCE_OLLAMA_URL;
			else process.env.PCE_OLLAMA_URL = prevUrl;
		}
	});
});
