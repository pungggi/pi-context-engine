import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ContextEngine } from "../src/engine.js";
import { LocalBackend } from "../src/storage/local-backend.js";
import { defaultConfig, loadConfig, type Config } from "../src/config.js";
import { makeFakeEmbedder, makeTempDir, rmrf, writeFiles, SAMPLE_REPO } from "./helpers.js";

const engines: ContextEngine[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
	// Close sqlite handles before deleting directories — Windows refuses to
	// unlink a file that still has an open handle.
	for (const engine of engines.splice(0)) {
		try {
			await engine.shutdown();
		} catch {
			// already closed
		}
	}
	for (const dir of tempDirs.splice(0)) rmrf(dir);
});

interface Harness {
	engine: ContextEngine;
	projectDir: string;
	storageRoot: string;
}

async function harness(opts: { autoIndex?: boolean; repo?: Record<string, string> } = {}): Promise<Harness> {
	const projectDir = makeTempDir("pce-auto-");
	const storageRoot = makeTempDir("pce-auto-store-");
	tempDirs.push(projectDir, storageRoot);
	writeFiles(projectDir, opts.repo ?? SAMPLE_REPO);

	const config: Config = {
		...defaultConfig(),
		storagePath: storageRoot,
		compressionLevel: "standard",
		indexerAutoIndex: opts.autoIndex ?? true,
	};
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

	return { engine, projectDir, storageRoot };
}

describe("autoIndexOnce", () => {
	it("indexes once when enabled, then reports null on every further call", async () => {
		const { engine } = await harness();

		const first = await engine.autoIndexOnce();
		expect(first).not.toBeNull();
		expect(first!.errors).toEqual([]);
		expect(first!.indexed).toBeGreaterThanOrEqual(3);
		expect(first!.chunks).toBeGreaterThan(0);
		expect(engine.chunkCount()).toBe(first!.chunks);

		// One-shot guard: the second call must not re-walk the repo.
		expect(await engine.autoIndexOnce()).toBeNull();

		// And an incremental no-op reindex is safe for a manual run afterwards.
		const manual = await engine.reindex({});
		expect(manual.indexed).toBe(0);
	});

	it("un-consumes its one-shot when the run rejects, so a later kick can retry", async () => {
		const { engine } = await harness();
		// Break embedding AFTER engine construction: embed failures propagate
		// as rejections (unlike per-file errors, which land in result.errors),
		// so a naive one-shot would burn itself on an index that never filled.
		const internals = engine as unknown as { embedderInstance: { embedTexts: () => Promise<number[][]> } };
		internals.embedderInstance.embedTexts = async () => {
			throw new Error("model download failed");
		};

		await expect(engine.autoIndexOnce()).rejects.toThrow("model download failed");
		// The failed run must not have consumed the one-shot: the retry re-runs
		// (and rejects again) instead of returning null on an empty index.
		await expect(engine.autoIndexOnce()).rejects.toThrow("model download failed");
	});

	it("is a no-op (null, nothing indexed) when indexer.auto_index is off", async () => {
		const { engine } = await harness({ autoIndex: false });

		expect(await engine.autoIndexOnce()).toBeNull();
		expect(engine.chunkCount()).toBe(0);
	});

	it("stays a one-shot even when the first run found nothing to do", async () => {
		const { engine } = await harness({ repo: {} });

		const first = await engine.autoIndexOnce();
		expect(first).not.toBeNull();
		expect(first!.indexed).toBe(0);
		// An empty result still consumed the one shot — no background loop spins.
		expect(await engine.autoIndexOnce()).toBeNull();
	});
});

describe("bootstrapText empty-index wording", () => {
	it("points at the auto-index when it is enabled", async () => {
		const { engine } = await harness({ autoIndex: true });

		const bootstrap = await engine.bootstrapText();
		expect(bootstrap).toMatch(/background index starts automatically/i);
		expect(bootstrap).toMatch(/indexer\.auto_index/);
	});

	it("points at /context-index when auto-index is disabled", async () => {
		const { engine } = await harness({ autoIndex: false });

		const bootstrap = await engine.bootstrapText();
		expect(bootstrap).toMatch(/\/context-index/);
		expect(bootstrap).not.toMatch(/automatically/i);
	});
});

describe("config mapping indexer.auto_index", () => {
	it("maps the yaml key and defaults to true", () => {
		const globalPath = path.join(makeTempDir("pce-cfg-"), "config.yaml");
		tempDirs.push(path.dirname(globalPath));

		expect(loadConfig(globalPath).indexerAutoIndex).toBe(true);

		fs.writeFileSync(globalPath, "indexer:\n  auto_index: false\n");
		expect(loadConfig(globalPath).indexerAutoIndex).toBe(false);

		// Project config wins over global.
		fs.writeFileSync(globalPath, "indexer:\n  auto_index: true\n");
		const projectDir = makeTempDir("pce-cfg-proj-");
		tempDirs.push(projectDir);
		fs.writeFileSync(path.join(projectDir, "pi-context-engine.yaml"), "indexer:\n  auto_index: false\n");
		expect(loadConfig(globalPath, path.join(projectDir, "pi-context-engine.yaml")).indexerAutoIndex).toBe(false);
	});
});

describe("indexing yields to the event loop", () => {
	it("lets setImmediate callbacks run while a reindex is in flight", async () => {
		// Regression guard for the TUI-lag fix: the pipeline and embedder must
		// yield between units of work, so queued macrotasks (pi's render/keys)
		// interleave with indexing instead of starving behind it.
		const { engine } = await harness({ repo: { ...SAMPLE_REPO, "src/extra.ts": "export const extra = 1;\n" } });

		let turns = 0;
		let ticking = true;
		// Self-rescheduling ticker: counts macrotask turns until the run
		// settles. Every yieldToEventLoop in the pipeline queues an immediate,
		// which gives the ticker another turn — so "turns" tracks how many
		// interleaves the indexing actually granted.
		const tick = () => {
			turns++;
			if (ticking) setImmediate(tick);
		};

		const reindex = engine.reindex({}).finally(() => {
			ticking = false;
		});
		setImmediate(tick);
		const result = await reindex;

		expect(result.errors).toEqual([]);
		// The single batch-top yield would produce ~2 turns no matter how many
		// files ran. Cooperative yielding must interleave at least once per FILE
		// (per-file and per-chunk yields), so require strictly more turns than
		// indexed files — removing any per-file/per-chunk/embed yield drops
		// turns below this and fails.
		expect(turns).toBeGreaterThan(result.indexed);
	});
});
