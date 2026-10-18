/**
 * R6 module chunks + small-to-big serving:
 * - top-level content (imports, consts, interfaces) finally gets a chunk;
 * - the module chunk is the parent context (never overlap-deduped away);
 * - a top hit pulls in its module parent and adjacent chunk within the
 *   per-file cap, and expansion deliberately bypasses the marginal stop
 *   because it rides along with an already-accepted hit.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ContextEngine } from "../src/engine.js";
import { defaultConfig, type Config } from "../src/config.js";
import { LocalBackend } from "../src/storage/local-backend.js";
import { HybridRetriever } from "../src/retrieval/retriever.js";
import { Chunker, warmupLanguages } from "../src/indexer/chunker.js";
import { makeFakeEmbedder, makeTempDir, rmrf, writeFiles } from "./helpers.js";

const dirs: string[] = [];
const engines: ContextEngine[] = [];

afterAll(async () => {
	await Promise.all(engines.map((engine) => engine.shutdown().catch(() => undefined)));
	for (const d of dirs.splice(0)) rmrf(d);
});

const SRC = `import { readFile } from "node:fs";

export const DEFAULT_IGNORE = [".git", "node_modules", "dist"];

export function walkTree(dir: string): string[] {
  return readFile(dir, "utf-8").split("\\n").filter(Boolean);
}

export function countEntries(items: string[]): number {
  return items.reduce((total, item) => total + item.length, 0);
}
`;

describe("chunker: module chunks", () => {
	beforeAll(async () => {
		await warmupLanguages(["typescript"]);
	});

	it("covers top-level imports and consts the function walk leaves out", () => {
		const { chunks } = new Chunker().chunkWithImports(SRC, "src/tools.ts", "typescript");
		const module = chunks.find((c) => c.chunkType === "module");
		expect(module).toBeDefined();
		expect(module!.content).toContain("DEFAULT_IGNORE");
		expect(module!.content).toContain("node:fs");
		expect(module!.content).toContain("defines:");
		expect(module!.startLine).toBe(1);
		expect(module!.metadata["unit"]).toBe("tools");
		// Function chunks still exist alongside it.
		expect(chunks.some((c) => c.chunkType === "function" && c.content.includes("walkTree"))).toBe(true);
	});

	it("is deterministic (same id and content for the same source)", () => {
		const a = new Chunker().chunkWithImports(SRC, "src/tools.ts", "typescript").chunks.find((c) => c.chunkType === "module");
		const b = new Chunker().chunkWithImports(SRC, "src/tools.ts", "typescript").chunks.find((c) => c.chunkType === "module");
		expect(a!.id).toBe(b!.id);
		expect(a!.content).toBe(b!.content);
		expect(a!.id).toMatch(/^[0-9a-f]{16}$/);
	});

	it("bounds the module chunk when a file is mostly top-level", () => {
		const big = Array.from({ length: 400 }, (_, i) => `export const VALUE_${i} = ${i};`).join("\n");
		const { chunks } = new Chunker().chunkWithImports(big, "src/big.ts", "typescript");
		const module = chunks.find((c) => c.chunkType === "module");
		expect(module).toBeDefined();
		expect(module!.content.length).toBeLessThan(3400);
		expect(module!.content).toContain("truncated");
	});
});

describe("retriever: module parent dedupe + expansion", () => {
	async function setup(): Promise<{ backend: LocalBackend; embedder: ReturnType<typeof makeFakeEmbedder> }> {
		const dir = makeTempDir("pce-r6-");
		dirs.push(dir);
		const backend = new LocalBackend(dir);
		const embedder = makeFakeEmbedder();
		const config: Config = { ...defaultConfig(), storagePath: dir };
		const projectDir = makeTempDir("pce-r6proj-");
		dirs.push(projectDir);
		writeFiles(projectDir, { "src/tools.ts": SRC });
		const engine = new ContextEngine({ projectDir, config });
		engines.push(engine);
		const internals = engine as unknown as {
			backendInstance: LocalBackend | null;
			embedderInstance: unknown;
			injectedRuntime: unknown;
		};
		internals.backendInstance = backend;
		internals.embedderInstance = embedder;
		internals.injectedRuntime = { backend, embedder };
		await engine.reindex({});
		return { backend, embedder };
	}

	it("keeps the module chunk next to the function chunks it covers", async () => {
		const { backend, embedder } = await setup();
		const retriever = new HybridRetriever(backend, embedder);
		const results = await retriever.retrieve("walkTree reading files DEFAULT_IGNORE", {
			topK: 10,
			confidenceThreshold: 0,
		});
		expect(results.some((c) => c.chunkType === "module")).toBe(true);
		expect(results.some((c) => c.content.includes("walkTree") && c.chunkType === "function")).toBe(true);
	});

	it("serves module parent + neighbour for a top hit, within the per-file cap", async () => {
		const { backend, embedder } = await setup();
		const query = "walkTree reading files DEFAULT_IGNORE";
		const on = new HybridRetriever(backend, embedder, { expandContext: true });
		const served = await on.retrieve(query, { topK: 10, confidenceThreshold: 0, marginalRatio: 0.9 });
		const fileChunks = served.filter((c) => c.filePath === "src/tools.ts");
		expect(fileChunks.some((c) => c.chunkType === "module")).toBe(true);
		// hit + parent + neighbour, never beyond the cap
		expect(fileChunks.length).toBeGreaterThanOrEqual(2);
		expect(fileChunks.length).toBeLessThanOrEqual(3);
		for (const c of served) {
			const perFile = served.filter((x) => x.filePath === c.filePath).length;
			expect(perFile).toBeLessThanOrEqual(3);
		}
	});

	it("does not expand when retrieval.expand_context is off", async () => {
		const { backend, embedder } = await setup();
		// A strict confidence threshold cuts the module parent from the ranked
		// pool (its text only names the function via `defines:`), while the hit
		// itself clears the bar. Expansion deliberately skips the threshold for
		// its extras — they ride along with an accepted hit — so ON keeps the
		// parent and OFF does not. That difference is the mechanic under test.
		const query = "walkTree readFile readdir directory listing";
		const opts = { topK: 10, confidenceThreshold: 0.9, marginalRatio: 0 };
		const off = new HybridRetriever(backend, embedder, { expandContext: false });
		const offServed = await off.retrieve(query, opts);
		expect(offServed.length).toBeGreaterThan(0);
		expect(offServed.some((c) => c.chunkType === "module")).toBe(false);

		const on = new HybridRetriever(backend, embedder, { expandContext: true });
		const onServed = await on.retrieve(query, opts);
		expect(onServed.some((c) => c.chunkType === "module")).toBe(true);
	});
});

describe("engine: module-level content is retrievable end to end", () => {
	it("serves a top-level const for a query naming it", async () => {
		const projectDir = makeTempDir("pce-r6eng-");
		dirs.push(projectDir);
		writeFiles(projectDir, {
			"src/tools.ts": SRC,
			"src/app.ts": "export function start(): void {\n  console.log('hi');\n}\n",
		});
		const storageRoot = makeTempDir("pce-store-");
		dirs.push(storageRoot);
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
		await engine.reindex({});

		const out = await engine.search("where is DEFAULT_IGNORE defined", { topK: 5 });
		const served = out.inline.map((c) => c.compressedContent || c.content).join("\n");
		expect(served).toContain("DEFAULT_IGNORE");
	});
});
