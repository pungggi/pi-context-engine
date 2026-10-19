/**
 * Compat-layer removal (chore/drop-compat-layers):
 * - a pre-versioning plain-dict manifest is REFUSED (version 0) and the index
 *   stores are wiped — its entries were never interpreted as file hashes;
 * - a corrupt manifest JSON gets the same wipe instead of silently indexing
 *   on top of possibly-stale stores;
 * - a store reset escalates a targeted run to a full reindex, so a wipe can
 *   never leave the index empty except for the one target file;
 * - a memory.db in the pre-0.2 shape (no decision_links, no tags/files
 *   columns, schema_versions=3) converges to the current schema on open with
 *   its recorded decisions intact — shape enforcement, no version ladder.
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ContextEngine } from "../src/engine.js";
import { defaultConfig, type Config } from "../src/config.js";
import { LocalBackend } from "../src/storage/local-backend.js";
import { MemoryDb, memoryDbPath } from "../src/memory/db.js";
import { projectStorageDir } from "../src/utils.js";
import { makeFakeEmbedder, makeTempDir, rmrf, writeFiles } from "./helpers.js";

const dirs: string[] = [];
const engines: ContextEngine[] = [];

afterAll(async () => {
	await Promise.all(engines.map((e) => e.shutdown().catch(() => undefined)));
	for (const d of dirs.splice(0)) rmrf(d);
});

const FILES = {
	"src/a.ts": "export function alpha(x: number): number {\n  return x + 1;\n}\n",
	"src/b.ts": "export function beta(x: number): number {\n  return x + 2;\n}\n",
	"src/gone.ts": "export function gamma(x: number): number {\n  return x + 3;\n}\n",
};

async function setup(): Promise<{ engine: ContextEngine; backend: LocalBackend; projectDir: string; storageRoot: string }> {
	const projectDir = makeTempDir("pce-dropc-");
	dirs.push(projectDir);
	writeFiles(projectDir, FILES);
	const storageRoot = makeTempDir("pce-dropcstore-");
	dirs.push(storageRoot);
	const config: Config = { ...defaultConfig(), storagePath: storageRoot };
	const backend = new LocalBackend(storageRoot);
	const engine = new ContextEngine({ projectDir, config, runtime: { backend, embedder: makeFakeEmbedder() } });
	engines.push(engine);
	await engine.reindex({ full: true });
	return { engine, backend, projectDir, storageRoot };
}

describe("plain-dict manifest (pre-versioning) is refused, not parsed", () => {
	it("wipes the stores and rebuilds instead of reading entries from the dict keys", async () => {
		const { engine, backend, projectDir, storageRoot } = await setup();
		expect(backend.countChunks()).toBeGreaterThan(0);

		// File vanishes, THEN the manifest is replaced by the old plain-dict
		// shape: path → hash keys, no __schema_version at all.
		fs.rmSync(path.join(projectDir, "src/gone.ts"));
		const manifestPath = path.join(projectStorageDir(storageRoot, projectDir), "manifest.json");
		fs.writeFileSync(
			manifestPath,
			JSON.stringify({ "src/a.ts": "deadbeef", "src/b.ts": "cafebabe", "src/gone.ts": "01234567" }),
			"utf-8",
		);

		const result = await engine.reindex({});
		expect(result.errors).toHaveLength(0);
		// Rebuilt from source: every surviving file is indexed again despite
		// the manifest carrying bogus hashes.
		const counts = backend.fileChunkCounts();
		expect(counts["src/a.ts"]).toBeGreaterThan(0);
		expect(counts["src/b.ts"]).toBeGreaterThan(0);
		// And gone.ts cannot leak through: the wipe removed every store row
		// before the prune even ran.
		expect(counts["src/gone.ts"]).toBeUndefined();
		expect(backend.countChunks()).toBeGreaterThan(0);
	});
});

describe("corrupt manifest JSON triggers the same wipe", () => {
	it("rebuilds cleanly instead of indexing on top of stale rows", async () => {
		const { engine, backend, projectDir, storageRoot } = await setup();
		fs.rmSync(path.join(projectDir, "src/gone.ts"));
		const manifestPath = path.join(projectStorageDir(storageRoot, projectDir), "manifest.json");
		fs.writeFileSync(manifestPath, "{ this is not json", "utf-8");

		const result = await engine.reindex({});
		expect(result.errors).toHaveLength(0);
		const counts = backend.fileChunkCounts();
		expect(counts["src/a.ts"]).toBeGreaterThan(0);
		expect(counts["src/gone.ts"]).toBeUndefined();
		expect(backend.countChunks()).toBeGreaterThan(0);
	});
});

describe("store reset escalates targeted runs", () => {
	it("a targeted reindex after a format reset rebuilds the whole index, not just the target", async () => {
		const { engine, backend, projectDir, storageRoot } = await setup();
		const before = backend.countChunks();
		expect(before).toBeGreaterThan(0);

		// Trigger the reset, but arrive via the watcher's targeted path.
		const manifestPath = path.join(projectStorageDir(storageRoot, projectDir), "manifest.json");
		const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as { __schema_version?: number };
		fs.writeFileSync(manifestPath, JSON.stringify({ ...parsed, __schema_version: 0 }), "utf-8");

		const result = await engine.reindex({ targetPath: "src/a.ts" });
		expect(result.errors).toHaveLength(0);
		// Without escalation this would contain ONLY src/a.ts's chunks — the
		// wipe erased everything else and a targeted walk visits one file.
		expect(backend.countChunks()).toBeGreaterThanOrEqual(before);
		const counts = backend.fileChunkCounts();
		expect(counts["src/b.ts"]).toBeGreaterThan(0);
		expect(counts["src/gone.ts"]).toBeGreaterThan(0);
	});
});

describe("pre-0.2 memory.db converges via shape enforcement", () => {
	it("opens a v3-shaped db (no decision_links, no tags/files), keeps decisions, converges to v4", () => {
		const dir = makeTempDir("pce-oldmem-");
		dirs.push(dir);
		const dbPath = memoryDbPath(dir);

		// Build the current schema, then strip it back to the 0.1.x shape.
		{
			const seed = new MemoryDb(dbPath);
			const ins = seed.db.prepare(
				"INSERT INTO decisions (session_id, decision, reason, source, created_at_epoch, created_at) VALUES (NULL, ?, ?, 'manual', ?, ?)",
			);
			ins.run("Use vitest fake timers", "real timers are flaky", 1_700_000_000, "2026-10-18T12:00:00Z");
			ins.run("Prefer plain SQL over an ORM", "fewer magic joins", 1_700_000_100, "2026-10-18T12:05:00Z");
			seed.close();
		}
		{
			const db = new MemoryDb(dbPath);
			db.db.exec("DROP TABLE IF EXISTS decision_links");
			db.db.exec("ALTER TABLE decisions DROP COLUMN tags");
			db.db.exec("ALTER TABLE decisions DROP COLUMN files");
			db.db.exec("DELETE FROM schema_versions WHERE version = 4");
			db.db.exec("INSERT INTO schema_versions (version, applied_at_epoch) VALUES (3, strftime('%s','now'))");
			expect(db.schemaVersion()).toBe(3);
			db.close();
		}

		// Reopen with the current code: shape is enforced, data survives.
		const reopened = new MemoryDb(dbPath);
		expect(reopened.schemaVersion()).toBe(4);
		const cols = (reopened.db.prepare("PRAGMA table_info(decisions)").all() as { name: string }[]).map((c) => c.name);
		expect(cols).toContain("tags");
		expect(cols).toContain("files");
		expect(
			reopened.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='decision_links'").get(),
		).toBeTruthy();
		const rows = reopened.db.prepare("SELECT decision FROM decisions ORDER BY id").all() as { decision: string }[];
		expect(rows.map((r) => r.decision)).toEqual(["Use vitest fake timers", "Prefer plain SQL over an ORM"]);
		reopened.close();
	});
});
