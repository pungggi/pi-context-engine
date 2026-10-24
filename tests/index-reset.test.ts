import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ContextEngine } from "../src/engine.js";
import { LocalBackend } from "../src/storage/local-backend.js";
import { defaultConfig, type Config } from "../src/config.js";
import { Embedder } from "../src/indexer/embedder.js";
import { FakeEmbeddingBackend, makeFakeEmbedder, makeTempDir, rmrf, writeFiles } from "./helpers.js";

const engines: ContextEngine[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
	for (const engine of engines.splice(0)) {
		await engine.shutdown().catch(() => undefined);
	}
	for (const dir of tempDirs.splice(0)) rmrf(dir);
});

interface Harness {
	engine: ContextEngine;
	projectDir: string;
	storageBase: string;
}

/**
 * Mirrors the extension's engine setup for /context-index: a live backend
 * handle is held open (backendInstance), exactly like a running session. A
 * reset that succeeds on Windows proves handles are closed before deletion —
 * the very failure that makes manual `rm -rf` of the storage dir hit EPERM.
 */
function harness(opts: { repo?: Record<string, string> } = {}): Harness {
	const projectDir = makeTempDir("pce-reset-");
	const storageRoot = makeTempDir("pce-reset-store-");
	tempDirs.push(projectDir, storageRoot);
	writeFiles(projectDir, opts.repo ?? {});
	const config: Config = {
		...defaultConfig(),
		storagePath: storageRoot,
		ollamaUrl: "http://127.0.0.1:1",
	};
	const engine = new ContextEngine({ projectDir, config });
	const embedder: Embedder = makeFakeEmbedder();
	const backend = new LocalBackend(engine.storageBase);
	const internals = engine as unknown as {
		backendInstance: LocalBackend;
		embedderInstance: Embedder;
		injectedRuntime: { backend: LocalBackend; embedder: Embedder };
	};
	internals.backendInstance = backend;
	internals.embedderInstance = embedder;
	internals.injectedRuntime = { backend, embedder };
	engines.push(engine);
	return { engine, projectDir, storageBase: engine.storageBase };
}

describe("engine.resetIndex", () => {
	it("deletes index state (not memory/sessions/stats) with handles open, then rebuilds on the same engine", async () => {
		const { engine, storageBase } = harness({
			repo: {
				"src/a.txt": "alpha centauri navigation beacon\n",
				"src/b.txt": "beta quadrant station log\n",
			},
		});
		// User history written BEFORE the reset must survive it.
		await engine.recordDecision("use vitest for tests", "covers unit + integration");

		const first = await engine.reindex({});
		expect(first.indexed).toBe(2);
		expect(engine.chunkCount()).toBeGreaterThan(0);
		expect(fs.existsSync(path.join(storageBase, "manifest.json"))).toBe(true);
		expect(fs.existsSync(path.join(storageBase, "vectors"))).toBe(true);
		expect(fs.existsSync(path.join(storageBase, "fts"))).toBe(true);
		expect(fs.existsSync(path.join(storageBase, "graph.db"))).toBe(true);
		expect(fs.existsSync(path.join(storageBase, "embedding_cache.db"))).toBe(true);

		// The backend handle is open (harness injected it) — reset must still
		// succeed on Windows by closing handles before deletion.
		const report = await engine.resetIndex();
		expect(report.errors).toEqual([]);
		expect(report.deletedFiles).toBeGreaterThanOrEqual(5); // manifest + vector/FTS/graph stores + embedding cache
		expect(report.freedBytes).toBeGreaterThan(0);

		// Index state is gone …
		expect(fs.existsSync(path.join(storageBase, "manifest.json"))).toBe(false);
		expect(fs.existsSync(path.join(storageBase, "vectors"))).toBe(false);
		expect(fs.existsSync(path.join(storageBase, "fts"))).toBe(false);
		expect(fs.existsSync(path.join(storageBase, "graph.db"))).toBe(false);
		expect(fs.existsSync(path.join(storageBase, "graph.db-shm"))).toBe(false);
		expect(fs.existsSync(path.join(storageBase, "graph.db-wal"))).toBe(false);
		expect(fs.existsSync(path.join(storageBase, "embedding_cache.db"))).toBe(false);
		// … user history is not.
		expect(fs.existsSync(path.join(storageBase, "memory.db"))).toBe(true);
		expect(fs.existsSync(path.join(storageBase, "sessions"))).toBe(true);

		// The engine stays usable on the same instance: backend is recreated
		// lazily and reports an empty index.
		expect(engine.chunkCount()).toBe(0);
		const recall = await engine.sessionRecall("vitest");
		expect(recall).toContain("use vitest for tests");

		// Rebuild works end-to-end without a new engine.
		const rebuilt = await engine.reindex({});
		expect(rebuilt.indexed).toBe(2);
		expect(engine.chunkCount()).toBeGreaterThan(0);
		const result = await engine.search("beta quadrant", { topK: 3 });
		expect(result.inline.length + result.overflow.length).toBeGreaterThan(0);
	});

	it("re-unconsumes the automatic one-shot so a reset workspace is auto-rebuildable", async () => {
		const { engine } = harness({ repo: { "src/a.txt": "alpha\n" } });
		const run1 = await engine.autoIndexOnce();
		expect(run1?.indexed).toBe(1);
		await expect(engine.autoIndexOnce()).resolves.toBeNull(); // consumed
		await engine.resetIndex();
		// autoIndexDone was reset: the next automatic kick may rebuild again.
		const run2 = await engine.autoIndexOnce();
		expect(run2?.indexed).toBe(1);
	});

	it("is idempotent: a second reset deletes nothing and reports no errors", async () => {
		const { engine, storageBase } = harness({ repo: { "src/a.txt": "alpha\n" } });
		await engine.recordDecision("idempotent reset probe", "keeps memory alive");
		await engine.reindex({});
		const first = await engine.resetIndex();
		expect(first.deletedFiles).toBeGreaterThan(0);
		const second = await engine.resetIndex();
		expect(second.deletedFiles).toBe(0);
		expect(second.freedBytes).toBe(0);
		expect(second.errors).toEqual([]);
		expect(fs.existsSync(path.join(storageBase, "memory.db"))).toBe(true);
	});
});
