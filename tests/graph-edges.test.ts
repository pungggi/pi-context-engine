/**
 * R7 graph edges + PageRank prior:
 * - imports edges must resolve to real indexed files (the old `module_<spec>`
 *   targets never existed, so every imports JOIN was empty);
 * - calls edges connect a caller chunk to the defining chunk cross-file;
 * - PageRank over the file graph feeds a bounded retrieval prior;
 * - related_context returns real neighbours instead of a dead end.
 */
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
	// b.ts is imported by a.ts and c.ts → hub in the file graph.
	"src/b.ts": "export function helper(x: number): number {\n  return x * 2;\n}\n",
	"src/a.ts": 'import { helper } from "./b.js";\n\nexport function runner(n: number): number {\n  return helper(n) + 1;\n}\n',
	"src/c.ts": 'import { helper } from "./b";\n\nexport function calc(x: number): number {\n  return helper(x) - 1;\n}\n',
	// Bare package imports must not create edges.
	"src/d.ts": 'import { readFile } from "node:fs";\n\nexport function readConfig(p: string): string {\n  return readFile(p, "utf-8");\n}\n',
};

async function setup(): Promise<{ engine: ContextEngine; backend: LocalBackend }> {
	const projectDir = makeTempDir("pce-r7-");
	dirs.push(projectDir);
	writeFiles(projectDir, FILES);
	const storageRoot = makeTempDir("pce-r7store-");
	dirs.push(storageRoot);
	const config: Config = { ...defaultConfig(), storagePath: storageRoot };
	const backend = new LocalBackend(storageRoot);
	const engine = new ContextEngine({ projectDir, config, runtime: { backend, embedder: makeFakeEmbedder() } });
	engines.push(engine);
	await engine.reindex({ full: true });
	return { engine, backend };
}

describe("R7: imports edges resolve to indexed files", () => {
	it("creates file→file imports edges for relative specs (.js rewrite and extensionless)", async () => {
		const { backend } = await setup();
		// a.ts imports ./b.js → file src/a.ts --imports--> file src/b.ts
		const aNode = backend.graphNeighbors("file_src/a.ts", "imports");
		const cNode = backend.graphNeighbors("file_src/c.ts", "imports");
		expect(aNode.map((n) => n.filePath)).toContain("src/b.ts");
		expect(cNode.map((n) => n.filePath)).toContain("src/b.ts");
	});

	it("creates no imports edges for bare package imports", async () => {
		const { backend } = await setup();
		const dNode = backend.graphNeighbors("file_src/d.ts", "imports");
		expect(dNode.filter((n) => n.filePath === "src/d.ts" || n.name.includes("node:fs"))).toHaveLength(0);
	});

	it("getRelatedFilePaths returns import neighbours (was a no-op before R7)", async () => {
		const { backend } = await setup();
		const related = backend.getRelatedFilePaths(["src/a.ts"]);
		expect(related).toContain("src/b.ts");
		expect(related).not.toContain("src/a.ts");
	});
});

describe("R7: cross-file calls edges", () => {
	it("links the caller chunk to the defining chunk", async () => {
		const { backend } = await setup();
		// Find the runner chunk in src/a.ts, then its calls neighbours.
		const aChunks = backend.chunksByFile("src/a.ts", 10);
		const runner = aChunks.find((c) => c.chunkType === "function" && c.content.includes("runner"));
		expect(runner).toBeDefined();
		const callees = backend.graphNeighbors(runner!.id, "calls");
		expect(callees.length).toBeGreaterThan(0);
		expect(callees.some((n) => n.name === "helper" && n.filePath === "src/b.ts")).toBe(true);
		// Cross-file only: no calls edge back into src/a.ts.
		expect(callees.every((n) => n.filePath !== "src/a.ts")).toBe(true);
	});
});

describe("R7: PageRank prior", () => {
	it("ranks the imported hub above the importing leaves", async () => {
		const { backend } = await setup();
		const ranks = backend.pageRanks();
		expect(ranks.size).toBeGreaterThan(0);
		expect(ranks.get("src/b.ts")!).toBeGreaterThan(ranks.get("src/a.ts")!);
		// Normalised to [0,1].
		for (const s of ranks.values()) expect(s).toBeLessThanOrEqual(1.000001);
	});

	it("breaks retrieval ties toward the hub file", async () => {
		// Two byte-identical files except the import graph: twin-hub is
		// imported by a third file, twin-leaf is not. Same content → same
		// lexical/vector evidence; only the prior can order them.
		const projectDir = makeTempDir("pce-r7twin-");
		dirs.push(projectDir);
		const body = "export function twinTarget(value: number): number {\n  return value + 41;\n}\n";
		writeFiles(projectDir, {
			"src/twin-hub.ts": body,
			"src/twin-leaf.ts": body,
			"src/uses-hub.ts": 'import { twinTarget } from "./twin-hub.js";\n\nexport function go(n: number): number {\n  return twinTarget(n);\n}\n',
		});
		const storageRoot = makeTempDir("pce-r7twins-");
		dirs.push(storageRoot);
		const config: Config = { ...defaultConfig(), storagePath: storageRoot };
		const backend = new LocalBackend(storageRoot);
		const engine = new ContextEngine({ projectDir, config, runtime: { backend, embedder: makeFakeEmbedder() } });
		engines.push(engine);
		await engine.reindex({ full: true });

		const retriever = await engine.getRetriever();
		const served = await retriever.retrieve("twinTarget value", { topK: 10, confidenceThreshold: 0, marginalRatio: 0 });
		const hubIdx = served.findIndex((c) => c.filePath === "src/twin-hub.ts");
		const leafIdx = served.findIndex((c) => c.filePath === "src/twin-leaf.ts");
		expect(hubIdx).toBeGreaterThanOrEqual(0);
		expect(leafIdx).toBeGreaterThanOrEqual(0);
		expect(hubIdx).toBeLessThan(leafIdx);
	});
});

describe("R7: related_context", () => {
	it("returns call targets for a caller chunk (was always empty before R7)", async () => {
		const { engine, backend } = await setup();
		const aChunks = backend.chunksByFile("src/a.ts", 10);
		const runner = aChunks.find((c) => c.chunkType === "function" && c.content.includes("runner"))!;
		const text = engine.relatedContext(runner.id);
		expect(text).not.toContain("No related context");
		expect(text).toContain("helper");
		expect(text).toContain("src/b.ts");
	});

	it("falls back to file-level import neighbours when a chunk makes no cross-file calls", async () => {
		const { engine, backend } = await setup();
		const dChunks = backend.chunksByFile("src/d.ts", 10);
		const fn = dChunks.find((c) => c.chunkType === "function")!;
		const text = engine.relatedContext(fn.id);
		// d.ts imports nothing indexed; its file has no graph neighbours.
		expect(text).toContain("No related context");
	});
});

describe("R7: deletion keeps pagerank consistent", () => {
	it("drops pagerank rows for deleted files", async () => {
		const { backend } = await setup();
		expect(backend.pageRanks().has("src/a.ts")).toBe(true);
		backend.deleteByFiles(["src/a.ts"]);
		expect(backend.pageRanks().has("src/a.ts")).toBe(false);
		expect(backend.pageRanks().has("src/b.ts")).toBe(true);
	});
});
