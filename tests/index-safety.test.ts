import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ContextEngine } from "../src/engine.js";
import { LocalBackend } from "../src/storage/local-backend.js";
import { defaultConfig, loadConfig, type Config } from "../src/config.js";
import { AutomaticIndexFileLimitError } from "../src/indexer/pipeline.js";
import type { Embedder } from "../src/indexer/embedder.js";
import { makeFakeEmbedder, makeTempDir, rmrf, writeFiles } from "./helpers.js";

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
	embedder: Embedder;
}

function harness(opts: { maxAutoFiles: number; repo: Record<string, string> }): Harness {
	const projectDir = makeTempDir("pce-safety-");
	const storageRoot = makeTempDir("pce-safety-store-");
	tempDirs.push(projectDir, storageRoot);
	writeFiles(projectDir, opts.repo);
	const config: Config = {
		...defaultConfig(),
		storagePath: storageRoot,
		indexerMaxAutoFiles: opts.maxAutoFiles,
		ollamaUrl: "http://127.0.0.1:1",
	};
	const engine = new ContextEngine({ projectDir, config });
	const embedder = makeFakeEmbedder();
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
	return { engine, embedder };
}

describe("automatic workspace file budget", () => {
	it("stops before embedding or store migration, does not retry, and leaves manual indexing available", async () => {
		const { engine, embedder } = harness({
			maxAutoFiles: 1,
			repo: { "src/a.txt": "alpha\n", "src/b.txt": "beta\n" },
		});
		let embedCalls = 0;
		const originalEmbed = embedder.embedTexts.bind(embedder);
		embedder.embedTexts = async (texts, batchSize) => {
			embedCalls++;
			return originalEmbed(texts, batchSize);
		};

		const initialError = await engine.autoIndexOnce().catch((err: unknown) => err);
		expect(initialError).toBeInstanceOf(AutomaticIndexFileLimitError);
		expect(initialError).toMatchObject({ limit: 1, observedFiles: 2 });
		expect(embedCalls).toBe(0);
		expect(engine.chunkCount()).toBe(0);
		// Size policy is stable. Unlike a transient network failure, it must not
		// be retried by every lazy search or background kick.
		expect(await engine.autoIndexOnce()).toBeNull();

		const manual = await engine.reindex({});
		expect(manual.errors).toEqual([]);
		expect(manual.indexed).toBe(2);
		expect(embedCalls).toBeGreaterThan(0);
		const chunkCount = engine.chunkCount();

		// The manifest fast path also runs BEFORE schema migration. Otherwise a
		// refused automatic run could wipe a healthy index despite doing no work.
		const manifestPath = path.join(engine.storageBase, "manifest.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
		manifest["__schema_version"] = 2;
		fs.writeFileSync(manifestPath, JSON.stringify(manifest));
		const existingError = await engine.reindex({ automatic: true }).catch((err: unknown) => err);
		expect(existingError).toBeInstanceOf(AutomaticIndexFileLimitError);
		expect(existingError).toMatchObject({ limit: 1, observedFiles: 2 });
		expect(engine.chunkCount()).toBe(chunkCount);
		expect(JSON.parse(fs.readFileSync(manifestPath, "utf-8"))["__schema_version"]).toBe(2);
	});

	it("treats zero as unlimited", async () => {
		const { engine } = harness({
			maxAutoFiles: 0,
			repo: { "src/a.txt": "alpha\n", "src/b.txt": "beta\n" },
		});
		const result = await engine.autoIndexOnce();
		expect(result).not.toBeNull();
		expect(result!.indexed).toBe(2);
	});

	it("yields to the event loop during a large capped walk", async () => {
		const repo = Object.fromEntries(Array.from({ length: 301 }, (_, i) => [`src/walk-${i}.txt`, `${i}\n`]));
		const { engine } = harness({ maxAutoFiles: 300, repo });
		let turns = 0;
		let ticking = true;
		const tick = () => {
			turns++;
			if (ticking) setImmediate(tick);
		};
		const run = engine.autoIndexOnce().finally(() => {
			ticking = false;
		});
		setImmediate(tick);
		const err = await run.catch((error: unknown) => error);
		expect(err).toBeInstanceOf(AutomaticIndexFileLimitError);
		expect(turns).toBeGreaterThan(0);
	});
});

describe("manifest checkpoints", () => {
	it("resumes after an interrupted batch instead of reindexing completed files", async () => {
		const repo = Object.fromEntries(
			Array.from({ length: 51 }, (_, i) => [`src/file-${String(i).padStart(2, "0")}.txt`, `document ${i}\n`]),
		);
		const { engine, embedder } = harness({ maxAutoFiles: 10_000, repo });
		const originalEmbed = embedder.embedTexts.bind(embedder);
		let calls = 0;
		let interrupted = true;
		embedder.embedTexts = async (texts, batchSize) => {
			calls++;
			if (interrupted && calls === 2) throw new Error("simulated interruption");
			return originalEmbed(texts, batchSize);
		};

		await expect(engine.reindex({})).rejects.toThrow("simulated interruption");
		const manifestPath = path.join(engine.storageBase, "manifest.json");
		const checkpoint = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
			files: Record<string, string>;
			embedding_dim: number;
		};
		expect(Object.keys(checkpoint.files)).toHaveLength(50);
		expect(checkpoint.embedding_dim).toBe(64);

		interrupted = false;
		const resumed = await engine.reindex({});
		expect(resumed.errors).toEqual([]);
		expect(resumed.indexed).toBe(1);
		expect(resumed.chunks).toBe(1);
		expect(engine.chunkCount()).toBe(51);
	});
});

describe("config mapping indexer.max_auto_files", () => {
	it("loads the default, project override and validates the value", () => {
		const globalDir = makeTempDir("pce-safety-config-");
		const globalPath = path.join(globalDir, "config.yaml");
		tempDirs.push(globalDir);
		expect(loadConfig(globalPath).indexerMaxAutoFiles).toBe(10_000);

		fs.writeFileSync(globalPath, "indexer:\n  max_auto_files: 1\n");
		expect(loadConfig(globalPath).indexerMaxAutoFiles).toBe(1);

		const projectDir = makeTempDir("pce-safety-project-");
		tempDirs.push(projectDir);
		const projectPath = path.join(projectDir, ".context-engine.yaml");
		fs.writeFileSync(projectPath, "indexer:\n  max_auto_files: 0\n");
		expect(loadConfig(globalPath, projectPath).indexerMaxAutoFiles).toBe(0);

		fs.writeFileSync(globalPath, "indexer:\n  max_auto_files: -1\n");
		expect(() => loadConfig(globalPath)).toThrow(/non-negative integer/);
	});
});
