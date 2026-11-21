/**
 * R11: an embedding-model change (different dimension) must force a full
 * reindex — stale vectors from another model space must never be searched
 * alongside new ones. Regression test for the manifest.embeddingDim migration.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ContextEngine } from "../src/engine.js";
import { openDatabase } from "../src/sqlite.js";
import { Embedder } from "../src/indexer/embedder.js";
import { defaultConfig, type Config } from "../src/config.js";
import { LocalBackend } from "../src/storage/local-backend.js";
import { makeChunk } from "../src/types.js";
import { projectStorageDir } from "../src/utils.js";
import { makeFakeEmbedder, makeTempDir, rmrf, writeFiles, FakeEmbeddingBackend } from "./helpers.js";

const dirs: string[] = [];
const engines: ContextEngine[] = [];

afterAll(async () => {
	await Promise.all(engines.map((e) => e.shutdown().catch(() => undefined)));
	for (const d of dirs.splice(0)) rmrf(d);
});

const FILES = {
	"src/a.ts": "export function alphaOne(x: number): number {\n  return x + 1;\n}\n",
	"src/b.ts": "export function betaTwo(x: number): number {\n  return x + 2;\n}\n",
	"src/c.ts": "export function gammaThree(x: number): number {\n  return x + 3;\n}\n",
};

describe("R11: dimension-change migration", () => {
	it("re-indexes everything when the embedder dimension changes", async () => {
		const projectDir = makeTempDir("pce-r11-");
		dirs.push(projectDir);
		writeFiles(projectDir, FILES);
		const storageRoot = makeTempDir("pce-r11store-");
		dirs.push(storageRoot);
		const config: Config = { ...defaultConfig(), storagePath: storageRoot };

		const backend1 = new LocalBackend(storageRoot);
		const engine1 = new ContextEngine({ projectDir, config, runtime: { backend: backend1, embedder: makeFakeEmbedder(64) } });
		engines.push(engine1);
		const first = await engine1.reindex({ full: true });
		expect(first.indexed).toBe(3);
		await engine1.shutdown();

		// Same files, unchanged content, DIFFERENT model dimension: the second
		// run must not skip everything as "unchanged" — stored vectors are in
		// the wrong space.
		const backend2 = new LocalBackend(storageRoot);
		const engine2 = new ContextEngine({ projectDir, config, runtime: { backend: backend2, embedder: makeFakeEmbedder(32) } });
		engines.push(engine2);
		const second = await engine2.reindex({});
		expect(second.indexed).toBe(3);
		expect(second.errors).toHaveLength(0);

		// And search works on the new space.
		const out = await engine2.search("alphaOne", { topK: 3 });
		expect(out.inline.length + out.overflow.length).toBeGreaterThan(0);
	});

	it("prunes files deleted before a dim-change run (clearEntries path, no wipe)", async () => {
		// The dim migration clearEntries()s WITHOUT wiping stores — the only
		// remaining path of that kind. The preMigrationPaths snapshot must
		// still delete the vanished file's rows. FTS and graph are asserted
		// explicitly because the vector rows are NOT a valid signal here:
		// ensureVecTable() DELETEs every chunks row on any dim switch, so a
		// vector-only assertion would pass even with the prune path removed.
		const projectDir = makeTempDir("pce-r11c-");
		dirs.push(projectDir);
		writeFiles(projectDir, FILES);
		const storageRoot = makeTempDir("pce-r11cstore-");
		dirs.push(storageRoot);
		const config: Config = { ...defaultConfig(), storagePath: storageRoot };
		const backend = new LocalBackend(storageRoot);
		const engine1 = new ContextEngine({ projectDir, config, runtime: { backend, embedder: makeFakeEmbedder(64) } });
		engines.push(engine1);
		await engine1.reindex({ full: true });
		// Establish the baseline in ALL three stores before the dim change…
		expect(backend.fileChunkCounts()["src/c.ts"]).toBeGreaterThan(0);
		expect(backend.ftsSearch("gammaThree", 5).length).toBeGreaterThan(0);
		expect(backend.getNodesByFile("src/c.ts").length).toBeGreaterThan(0);
		await engine1.shutdown();

		fs.rmSync(path.join(projectDir, "src/c.ts"));

		const backend2 = new LocalBackend(storageRoot);
		const engine2 = new ContextEngine({ projectDir, config, runtime: { backend: backend2, embedder: makeFakeEmbedder(32) } });
		engines.push(engine2);
		await engine2.reindex({});

		// …and require the prune to remove them. FTS/graph rows are deleted by
		// NOTHING else on this path — if preMigrationPaths pruning regresses,
		// these assertions fail even though the vector rows would be wiped by
		// the dim switch regardless.
		expect(backend2.ftsSearch("gammaThree", 5)).toHaveLength(0);
		expect(backend2.getNodesByFile("src/c.ts")).toHaveLength(0);
		const counts = backend2.fileChunkCounts();
		expect(counts["src/c.ts"]).toBeUndefined();
		expect(counts["src/a.ts"]).toBeGreaterThan(0);
		expect(counts["src/b.ts"]).toBeGreaterThan(0);
	});

	it("unchanged model skips re-chunking (incremental path intact)", async () => {
		const projectDir = makeTempDir("pce-r11b-");
		dirs.push(projectDir);
		writeFiles(projectDir, FILES);
		const storageRoot = makeTempDir("pce-r11bstore-");
		dirs.push(storageRoot);
		const config: Config = { ...defaultConfig(), storagePath: storageRoot };
		const backend = new LocalBackend(storageRoot);
		const engine = new ContextEngine({ projectDir, config, runtime: { backend, embedder: makeFakeEmbedder(64) } });
		engines.push(engine);
		await engine.reindex({ full: true });
		const again = await engine.reindex({});
		expect(again.indexed).toBe(0); // unchanged content + same model = nothing re-indexed
	});

	// The two regressions below reproduce a real-world failure loop (seen on a
	// project whose store was emptied while the embedder later changed):
	// "Context index: watcher reindex failed (Dimension mismatch for inserted
	// vector for the \"embedding\" column. Expected N dimensions but received M.)"
	// repeating on every change burst, with the index permanently dead.

	it("recovers when an EMPTY chunks_vec declares a stale dimension", async () => {
		// Store state: table exists at float[64] with ZERO rows, manifest empty.
		// The old row-based dim read returned null for an empty table, so the
		// ingest skipped the drop branch, CREATE IF NOT EXISTS kept float[64],
		// and the very first 32-dim insert threw — rolling the run back and
		// repeating the failure forever (nothing ever healed the table).
		const projectDir = makeTempDir("pce-r11e-");
		dirs.push(projectDir);
		writeFiles(projectDir, FILES);
		const storageRoot = makeTempDir("pce-r11estore-");
		dirs.push(storageRoot);
		const config: Config = { ...defaultConfig(), storagePath: storageRoot };

		const backend1 = new LocalBackend(storageRoot);
		const engine1 = new ContextEngine({ projectDir, config, runtime: { backend: backend1, embedder: makeFakeEmbedder(64) } });
		engines.push(engine1);
		await engine1.reindex({ full: true });
		await engine1.shutdown();

		// Empty the store (rows deleted, table NOT dropped) and reset the manifest
		// — exactly the on-disk state the wedged project presented.
		const wiper = new LocalBackend(storageRoot);
		wiper.deleteByFiles(Object.keys(FILES));
		wiper.close();
		fs.rmSync(path.join(projectStorageDir(storageRoot, projectDir), "manifest.json"));

		const backend2 = new LocalBackend(storageRoot);
		expect(backend2.declaredVecDim()).toBe(64); // empty table still declares 64
		const engine2 = new ContextEngine({ projectDir, config, runtime: { backend: backend2, embedder: makeFakeEmbedder(32) } });
		engines.push(engine2);
		const second = await engine2.reindex({}); // must NOT throw a dimension mismatch
		expect(second.errors).toHaveLength(0);
		expect(second.indexed).toBe(3);
		expect(backend2.declaredVecDim()).toBe(32);

		const out = await engine2.search("alphaOne", { topK: 3 });
		expect(out.inline.length + out.overflow.length).toBeGreaterThan(0);
	});

	it("re-indexes everything when the STORE dim disagrees with the embedder (manifest agrees)", async () => {
		// Store state: manifest.embeddingDim == embedder dim (64), but the table
		// was rebuilt at another dim (32) by an interrupted past. Without the
		// store-dim signal in the migration gate, the run would skip everything
		// as unchanged while ensureVecTable wiped the chunk metadata — leaving
		// files whose hashes match stranded out of the index.
		const projectDir = makeTempDir("pce-r11s-");
		dirs.push(projectDir);
		writeFiles(projectDir, FILES);
		const storageRoot = makeTempDir("pce-r11sstore-");
		dirs.push(storageRoot);
		const config: Config = { ...defaultConfig(), storagePath: storageRoot };

		const backend1 = new LocalBackend(storageRoot);
		const engine1 = new ContextEngine({ projectDir, config, runtime: { backend: backend1, embedder: makeFakeEmbedder(64) } });
		engines.push(engine1);
		await engine1.reindex({ full: true });
		await engine1.shutdown();

		// Swap the table to 32 dims behind the manifest's back (one synthetic
		// 32-dim chunk: ensureVecTable rebuilds the table at 32 and wipes rows).
		const swapBackend = new LocalBackend(storageRoot);
		swapBackend.ingest(
			[
				makeChunk({
					id: "synthetic32",
					content: "synthetic chunk that swaps the table dim",
					chunkType: "module",
					filePath: "synthetic/swap.txt",
					startLine: 1,
					endLine: 1,
					language: "plaintext",
					embedding: new Array<number>(32).fill(0).map((_, i) => (i === 0 ? 1 : 0)),
				}),
			],
			[],
			[],
		);
		swapBackend.close();

		const backend2 = new LocalBackend(storageRoot);
		expect(backend2.declaredVecDim()).toBe(32); // store now disagrees with the manifest (64)
		const engine2 = new ContextEngine({ projectDir, config, runtime: { backend: backend2, embedder: makeFakeEmbedder(64) } });
		engines.push(engine2);
		const second = await engine2.reindex({});
		expect(second.errors).toHaveLength(0);
		expect(second.indexed).toBe(3); // gate cleared the manifest: full re-chunk
		expect(backend2.declaredVecDim()).toBe(64);

		// Nothing stranded: all three files have live chunk metadata again.
		const counts = backend2.fileChunkCounts();
		for (const rel of Object.keys(FILES)) expect(counts[rel]).toBeGreaterThan(0);
		expect(counts["synthetic/swap.txt"]).toBeUndefined(); // wiped by the table rebuild
	});

	it("re-embeds stale-dim cache hits under the same backend identity (salt collision)", async () => {
		// FakeEmbeddingBackend(dim) with the DEFAULT modelName shares the cache
		// salt across dims — the same shape as a backend that changed dimension
		// under a fixed identity (re-pulled Ollama model variant). The first run
		// caches 64-dim vectors; the second run must NOT ingest them: it
		// re-embeds at 32, replaces the entries, and the transition reports the
		// stale entries as misses, not hits.
		const projectDir = makeTempDir("pce-r11x-");
		dirs.push(projectDir);
		writeFiles(projectDir, FILES);
		const storageRoot = makeTempDir("pce-r11xstore-");
		dirs.push(storageRoot);
		const config: Config = { ...defaultConfig(), storagePath: storageRoot };

		const backend1 = new LocalBackend(storageRoot);
		const engine1 = new ContextEngine({
			projectDir,
			config,
			runtime: { backend: backend1, embedder: new Embedder(new FakeEmbeddingBackend(64)) },
		});
		engines.push(engine1);
		const first = await engine1.reindex({ full: true });
		expect(first.indexed).toBe(3);
		await engine1.shutdown();

		// Same modelName ("fake-embed") → same cache salt, different dimension.
		const backend2 = new LocalBackend(storageRoot);
		const engine2 = new ContextEngine({
			projectDir,
			config,
			runtime: { backend: backend2, embedder: new Embedder(new FakeEmbeddingBackend(32)) },
		});
		engines.push(engine2);
		const second = await engine2.reindex({});
		expect(second.errors).toHaveLength(0);
		expect(second.indexed).toBe(3);
		// Without the cache-hit dim validation this stays 64 (stale vectors ingested).
		expect(backend2.declaredVecDim()).toBe(32);
		// ...and every cache entry is replaced at the new dim (nothing 64-dim left).
		const { db: cacheDb } = openDatabase(
			path.join(projectStorageDir(storageRoot, projectDir), "embedding_cache.db"),
		);
		const dimRows = cacheDb.prepare("SELECT dim, COUNT(*) AS n FROM embedding_cache GROUP BY dim").all() as {
			dim: number;
			n: number;
		}[];
		cacheDb.close();
		expect(dimRows.map((r) => r.dim)).toEqual([32]);

		// A third run at 32 serves everything from the (now correct) cache.
		const backend3 = new LocalBackend(storageRoot);
		const engine3 = new ContextEngine({
			projectDir,
			config,
			runtime: { backend: backend3, embedder: new Embedder(new FakeEmbeddingBackend(32)) },
		});
		engines.push(engine3);
		const third = await engine3.reindex({});
		expect(third.indexed).toBe(0); // unchanged content, same model → no re-chunk
	});
});
