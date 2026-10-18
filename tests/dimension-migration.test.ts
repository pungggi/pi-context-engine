/**
 * R11: an embedding-model change (different dimension) must force a full
 * reindex — stale vectors from another model space must never be searched
 * alongside new ones. Regression test for the manifest.embeddingDim migration.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ContextEngine } from "../src/engine.js";
import { defaultConfig, type Config } from "../src/config.js";
import { LocalBackend } from "../src/storage/local-backend.js";
import { makeFakeEmbedder, makeTempDir, rmrf, writeFiles } from "./helpers.js";

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
		// still delete chunks of files that vanished before this run.
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
		expect(backend.fileChunkCounts()["src/c.ts"]).toBeGreaterThan(0);
		await engine1.shutdown();

		fs.rmSync(path.join(projectDir, "src/c.ts"));

		const backend2 = new LocalBackend(storageRoot);
		const engine2 = new ContextEngine({ projectDir, config, runtime: { backend: backend2, embedder: makeFakeEmbedder(32) } });
		engines.push(engine2);
		await engine2.reindex({});

		const counts = backend2.fileChunkCounts();
		expect(counts["src/c.ts"]).toBeUndefined(); // deleted before the run — no orphans
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
});
