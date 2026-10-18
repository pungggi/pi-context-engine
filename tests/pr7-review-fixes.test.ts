/**
 * PR #7 review fixes:
 * - calls edges survive incremental reindexes in BOTH directions
 *   (changed caller → unchanged callee, unchanged caller → changed callee);
 * - manifest migration (clearEntries) no longer orphans chunks of files
 *   deleted before the run;
 * - record_decision replies and recall lines expose decision ids;
 * - escapeFts5 keeps Unicode letters in quoted phrases;
 * - nodeUnit picks the method name, not the Java return type;
 * - rowToChunk restores `unit` from the context header (refine hints filter);
 * - rerank tail capping keeps unjudged hits below the reranked floor.
 */
import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ContextEngine } from "../src/engine.js";
import { defaultConfig, type Config } from "../src/config.js";
import { LocalBackend } from "../src/storage/local-backend.js";
import { escapeFts5 } from "../src/storage/fts-store.js";
import { capTailBelowRerankedFloor } from "../src/retrieval/retriever.js";
import { Chunker, warmupLanguages } from "../src/indexer/chunker.js";
import { projectStorageDir } from "../src/utils.js";
import { makeFakeEmbedder, makeTempDir, rmrf, writeFiles } from "./helpers.js";

const dirs: string[] = [];
const engines: ContextEngine[] = [];

afterAll(async () => {
	await Promise.all(engines.map((e) => e.shutdown().catch(() => undefined)));
	for (const d of dirs.splice(0)) rmrf(d);
});

async function setup(files: Record<string, string>): Promise<{ engine: ContextEngine; backend: LocalBackend; projectDir: string }> {
	const projectDir = makeTempDir("pce-pr7-");
	dirs.push(projectDir);
	writeFiles(projectDir, files);
	const storageRoot = makeTempDir("pce-pr7store-");
	dirs.push(storageRoot);
	const config: Config = { ...defaultConfig(), storagePath: storageRoot };
	const backend = new LocalBackend(storageRoot);
	const engine = new ContextEngine({ projectDir, config, runtime: { backend, embedder: makeFakeEmbedder() } });
	engines.push(engine);
	await engine.reindex({ full: true });
	return { engine, backend, projectDir };
}

function callsEdgesFrom(backend: LocalBackend, filePath: string): { target: string }[] {
	const nodes = backend.graphNeighbors(
		backend.getNodesByFile(filePath).find((n) => n.nodeType === "file")!.id,
		"defines",
	);
	void nodes;
	// calls edges are chunk→chunk: walk each chunk node of the file.
	const out: { target: string }[] = [];
	for (const node of backend.getNodesByFile(filePath)) {
		if (node.nodeType !== "function") continue;
		for (const target of backend.graphNeighbors(node.id, "calls")) {
			out.push({ target: target.filePath });
		}
	}
	return out;
}

describe("PR #7: incremental calls edges survive partial reindexes", () => {
	const FILES = {
		"src/lib.ts": "export function helper(x: number): number {\n  return x * 2;\n}\n",
		"src/app.ts": 'import { helper } from "./lib.js";\n\nexport function runner(n: number): number {\n  return helper(n) + 1;\n}\n',
	};

	it("keeps changed→unchanged and unchanged→changed call edges on incremental runs", async () => {
		const { engine, backend, projectDir } = await setup(FILES);
		// Baseline: app.ts runner → lib.ts helper.
		expect(callsEdgesFrom(backend, "src/app.ts").map((e) => e.target)).toContain("src/lib.ts");

		// 1) Change ONLY the caller: its edge into unchanged lib.ts must survive.
		fs.writeFileSync(
			path.join(projectDir, "src/app.ts"),
			'import { helper } from "./lib.js";\n\nexport function runner(n: number): number {\n  const v = helper(n);\n  return v + 1;\n}\n',
			"utf-8",
		);
		await engine.reindex({});
		expect(callsEdgesFrom(backend, "src/app.ts").map((e) => e.target)).toContain("src/lib.ts");

		// 2) Change ONLY the callee (new chunk ids): the unchanged caller's
		//    edge into it must be re-derived, not lost.
		fs.writeFileSync(
			path.join(projectDir, "src/lib.ts"),
			"export function helper(x: number): number {\n  const doubled = x * 2;\n  return doubled;\n}\n",
			"utf-8",
		);
		await engine.reindex({});
		expect(callsEdgesFrom(backend, "src/app.ts").map((e) => e.target)).toContain("src/lib.ts");
	});
});

describe("PR #7: migration clearEntries no longer orphans deleted files", () => {
	it("prunes chunks of a file deleted before a format migration", async () => {
		const FILES = {
			"src/keep.ts": "export function keepOne(x: number): number {\n  return x + 1;\n}\n",
			"src/gone.ts": "export function goneTwo(x: number): number {\n  return x + 2;\n}\n",
		};
		const { engine, backend, projectDir } = await setup(FILES);
		expect(backend.countChunks()).toBeGreaterThan(0);

		// File vanishes from disk BEFORE the run that migrates the index format.
		fs.rmSync(path.join(projectDir, "src/gone.ts"));

		// Simulate a format migration: stale schemaVersion makes the pipeline
		// clearEntries() before re-walking, exactly like a real format bump.
		const storageRoot = (engine as unknown as { config: Config }).config.storagePath;
		const manifestPath = path.join(projectStorageDir(storageRoot, projectDir), "manifest.json");
		const parsed = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as { schemaVersion?: number };
		const bumped = { ...parsed, schemaVersion: (parsed.schemaVersion ?? 1) - 1 };
		fs.writeFileSync(manifestPath, JSON.stringify(bumped));

		await engine.reindex({});
		// gone.ts chunks must NOT survive the migration run.
		const goneChunks = backend.chunksByFile("src/gone.ts", 100);
		expect(goneChunks).toHaveLength(0);
		expect(backend.chunksByFile("src/keep.ts", 100).length).toBeGreaterThan(0);
	});
});

describe("PR #7: decision ids are discoverable", () => {
	it("record_decision reply and recall lines carry [#id]", async () => {
		const { engine } = await setup({ "src/x.ts": "export const x = 1;\n" });
		const reply = await engine.recordDecision("Use vitest fake timers", "real timers are flaky");
		expect(reply).toMatch(/\[#\d+\]$/);
		const recall = await engine.sessionRecall("vitest timers");
		expect(recall).toMatch(/\[decision #\d+ src=manual\|sid:/);
	});
});

describe("PR #7: FTS Unicode phrases", () => {
	it("keeps Unicode letters inside quoted phrases", () => {
		expect(escapeFts5('"café writer"')).toBe('"café writer"');
		expect(escapeFts5('"日本語 code"')).toBe('"日本語 code"');
	});
});

describe("PR #7: nodeUnit name priority", () => {
	it("labels a Java method by its name, not its return type", async () => {
		await warmupLanguages(["java"]);
		const chunker = new Chunker();
		const src = [
			"public class Foo {",
			"  public Result compute(int value) {",
			"    return new Result(value);",
			"  }",
			"}",
			"",
		].join("\n");
		const out = chunker.chunkWithImports(src, "src/Foo.java", "java");
		const compute = out.chunks.find((c) => c.chunkType === "function");
		expect(compute?.metadata["unit"]).toBe("Foo.compute");
	});
});

describe("PR #7: rowToChunk restores unit from the context header", () => {
	it("served chunks carry metadata.unit for refine-hint filtering", async () => {
		const { engine } = await setup({
			"src/svc.ts": "export function alphaSvc(n: number): number {\n  return n;\n}\n\nexport function betaSvc(n: number): number {\n  return n * 2;\n}\n",
		});
		const out = await engine.search("alphaSvc", { topK: 2 });
		const served = [...out.inline, ...out.overflow].filter((c) => c.filePath === "src/svc.ts");
		expect(served.length).toBeGreaterThan(0);
		expect(served.some((c) => c.metadata["unit"] === "alphaSvc")).toBe(true);
	});
});

describe("PR #7: rerank tail capping", () => {
	it("keeps every unjudged tail entry strictly below the reranked floor", () => {
		const scored = [
			{ score: 0.9 },
			{ score: 0.85 },
			{ score: 0.2 }, // blended down by the reranker (floor = 0.2)
			{ score: 0.7 }, // tail, unjudged — must be capped below 0.2
			{ score: 0.65 },
		];
		capTailBelowRerankedFloor(scored, 3);
		expect(scored[3]!.score).toBeLessThan(0.2);
		expect(scored[4]!.score).toBeLessThan(scored[3]!.score);
		// Judged prefix untouched.
		expect(scored[0]!.score).toBe(0.9);
		expect(scored[2]!.score).toBe(0.2);
		// Sorted order puts every judged hit above the tail.
		const sorted = [...scored].sort((a, b) => b.score - a.score);
		expect(sorted.indexOf(scored[3]!)).toBeGreaterThan(2);
		expect(sorted.indexOf(scored[4]!)).toBe(4);
	});
});
