/**
 * Targeted-reindex policy tests, ported lessons from upstream issues:
 * - #165a: dotted `.cceignore` patterns must match root entries.
 * - #165b: a directory `--path` target must respect `.cceignore` dir rules.
 * - #127:  a target newly rejected by policy must purge its stale chunks.
 * - #137:  memory vec rows survive an embedder change via backfill.
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ContextEngine } from "../src/engine.js";
import { defaultConfig, type Config } from "../src/config.js";
import { LocalBackend } from "../src/storage/local-backend.js";
import { MemoryDb, memoryDbPath } from "../src/memory/db.js";
import { matchesAny } from "../src/indexer/ignorefile.js";
import { makeFakeEmbedder, makeTempDir, rmrf, writeFiles } from "./helpers.js";

const tempDirs: string[] = [];
const engines: ContextEngine[] = [];

afterAll(async () => {
	await Promise.all(engines.map((engine) => engine.shutdown().catch(() => undefined)));
	for (const dir of tempDirs) rmrf(dir);
});

interface Harness {
	engine: ContextEngine;
	projectDir: string;
}

async function harness(repo: Record<string, string>): Promise<Harness> {
	const projectDir = makeTempDir("pce-targets-");
	tempDirs.push(projectDir);
	writeFiles(projectDir, repo);
	const storageRoot = makeTempDir("pce-store-");
	tempDirs.push(storageRoot);

	const config: Config = { ...defaultConfig(), storagePath: storageRoot };
	const engine = new ContextEngine({ projectDir, config });
	const embedder = makeFakeEmbedder();
	const backend = new LocalBackend(engine.storageBase);
	engines.push(engine);
	const internals = engine as unknown as {
		backendInstance: LocalBackend | null;
		embedderInstance: unknown;
		injectedRuntime: unknown;
	};
	internals.backendInstance = backend;
	internals.embedderInstance = embedder;
	internals.injectedRuntime = { backend, embedder };
	return { engine, projectDir };
}

describe("ignorefile: dotted root patterns (upstream #165a)", () => {
	it("matches dotfiles and dotted dirs at the project root", () => {
		expect(matchesAny(".env", false, [".env"])).toBe(true);
		expect(matchesAny(".mcp.json", false, [".mcp.json"])).toBe(true);
		expect(matchesAny(".pytest-tmp-7f", true, [".pytest-tmp*/"])).toBe(true);
		expect(matchesAny(".pytest-tmp-7f", false, [".pytest-tmp*"])).toBe(true);
		expect(matchesAny("src/.env", false, [".env"])).toBe(true);
	});

	it("still strips a literal ./ prefix", () => {
		expect(matchesAny("./src/a.ts", false, ["src/a.ts"])).toBe(true);
	});
});

describe("targeted reindex: exclusion policy (upstream #165b)", () => {
	it("does not index a .cceignore-excluded directory target", async () => {
		const { engine } = await harness({
			"src/a.ts": "export const a = 1;\n",
			"dist/b.ts": "export const b = 2;\n",
		});
		fs.writeFileSync(path.join(engine.projectDir, ".cceignore"), "dist/\n", "utf-8");

		const result = await engine.reindex({ targetPath: "dist" });
		expect(result.indexed).toBe(0);
		expect(result.skipped).toBe(1);
		expect(result.chunks).toBe(0);
	});

	it("does not index a target inside an excluded ancestor directory", async () => {
		const { engine } = await harness({
			"gen/out/widget.ts": "export const w = 3;\n",
		});
		fs.writeFileSync(path.join(engine.projectDir, ".cceignore"), "gen/\n", "utf-8");

		const result = await engine.reindex({ targetPath: "gen/out" });
		expect(result.indexed).toBe(0);
		expect(result.skipped).toBe(1);
	});

	it("indexes a non-excluded directory target normally", async () => {
		const { engine } = await harness({
			"src/a.ts": "export const a = 1;\n",
			"src/nested/b.ts": "export const b = 2;\n",
		});
		const result = await engine.reindex({ targetPath: "src" });
		expect(result.indexed).toBe(2);
	});
});

describe("targeted reindex: stale-chunk purge (upstream #127)", () => {
	it("purges chunks for a file that .cceignore newly excludes", async () => {
		const { engine, projectDir } = await harness({
			"notes.txt": "design notes worth indexing initially\n",
		});
		const first = await engine.reindex({});
		expect(first.indexed).toBe(1);

		fs.writeFileSync(path.join(projectDir, ".cceignore"), "notes.txt\n", "utf-8");
		const second = await engine.reindex({ targetPath: "notes.txt" });
		expect(second.indexed).toBe(0);
		expect(second.skipped).toBe(1);
		expect(second.deleted).toBe(1);
		expect(engine.chunkCount()).toBe(0);
	});

	it("purges chunks under a directory target that .cceignore newly excludes", async () => {
		const { engine, projectDir } = await harness({
			"gen/a.ts": "export const a = 1;\n",
			"gen/b.ts": "export const b = 2;\n",
			"src/keep.ts": "export const keep = true;\n",
		});
		const first = await engine.reindex({});
		expect(first.indexed).toBe(3);
		const before = engine.chunkCount();
		expect(before).toBeGreaterThan(0);

		fs.writeFileSync(path.join(projectDir, ".cceignore"), "gen/\n", "utf-8");
		const second = await engine.reindex({ targetPath: "gen" });
		expect(second.indexed).toBe(0);
		expect(second.deleted).toBe(2);
		expect(engine.chunkCount()).toBeLessThan(before);
	});

	it("purges chunks for a secret-named file when redaction is later enabled", async () => {
		const projectDir = makeTempDir("pce-targets-");
		tempDirs.push(projectDir);
		writeFiles(projectDir, { id_rsa: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n" });
		const storageRoot = makeTempDir("pce-store-");
		tempDirs.push(storageRoot);

		const mk = (redact: boolean) => {
			const config: Config = { ...defaultConfig(), storagePath: storageRoot, indexerRedactSecrets: redact };
			const engine = new ContextEngine({ projectDir, config });
			const embedder = makeFakeEmbedder();
			const backend = new LocalBackend(engine.storageBase);
			engines.push(engine);
			const internals = engine as unknown as {
				backendInstance: LocalBackend | null;
				embedderInstance: unknown;
				injectedRuntime: unknown;
			};
			internals.backendInstance = backend;
			internals.embedderInstance = embedder;
			internals.injectedRuntime = { backend, embedder };
			return engine;
		};

		const lax = mk(false);
		expect((await lax.reindex({})).indexed).toBe(1);
		expect(lax.chunkCount()).toBeGreaterThan(0);
		await lax.shutdown().catch(() => undefined);

		const strict = mk(true);
		const second = await strict.reindex({ targetPath: "id_rsa" });
		expect(second.indexed).toBe(0);
		expect(second.skipped).toBe(1);
		expect(second.deleted).toBe(1);
		expect(strict.chunkCount()).toBe(0);
	});
});

describe("memory vec backfill (upstream #137)", () => {
	it("backfills vec rows after the tables are wiped by a dim change", async () => {
		const dir = makeTempDir("pce-memvec-");
		tempDirs.push(dir);
		const memory = new MemoryDb(memoryDbPath(dir));
		const embedder = makeFakeEmbedder();

		memory.db
			.prepare("INSERT INTO decisions (session_id, decision, reason, source, created_at_epoch, created_at) VALUES (NULL, 'use sqlite wal', 'crash safety', 'manual', 0, '')")
			.run();
		memory.db
			.prepare("INSERT INTO decisions (session_id, decision, reason, source, created_at_epoch, created_at) VALUES (NULL, 'hash project slugs', 'avoid basename collisions', 'manual', 0, '')")
			.run();
		await memory.recordDecisionVec(embedder, 1, "use sqlite wal", "crash safety");
		await memory.recordDecisionVec(embedder, 2, "hash project slugs", "avoid basename collisions");
		expect(memory.vecBackfillPending().decisions).toBe(0);

		// Simulate an embedder swap: tables recreated empty at a new dim.
		memory.db.exec("DROP TABLE decisions_vec");
		memory.db.exec("CREATE VIRTUAL TABLE decisions_vec USING vec0(embedding float[17])");
		expect(memory.vecBackfillPending().decisions).toBe(2);

		const restored = await memory.backfillVecTables(embedder);
		expect(restored.decisions).toBe(2);
		expect(memory.vecBackfillPending().decisions).toBe(0);
		const hits = await memory.searchDecisionsVec(embedder, "sqlite crash safety", 5);
		expect(hits).toContain(1);
		memory.close();
	});

	it("reports zero pending when vec tables are absent", () => {
		const dir = makeTempDir("pce-memvec-novec-");
		tempDirs.push(dir);
		const memory = new MemoryDb(memoryDbPath(dir));
		if (!memory.hasVecTables()) {
			expect(memory.vecBackfillPending()).toEqual({ decisions: 0, turnSummaries: 0 });
		}
		memory.close();
	});
});
