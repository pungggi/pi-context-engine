/**
 * WP2 symbol-level PageRank (docs/RESEARCH-COMPETITORS.md §1):
 * - computeSymbolPageRank ranks individual functions/classes over the
 *   calls/defines graph, not the file projection;
 * - the hub (called by many) outranks a leaf of the same shape;
 * - related_context lists neighbours by centrality, deterministically;
 * - deletion and reset keep the symbol table consistent.
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
	"src/hub.ts": "export function hub(x: number): number {\n  return x * 2;\n}\n",
	"src/leaf.ts": "export function leaf(x: number): number {\n  return x + 1;\n}\n",
	// Two callers in another file point at hub → hub accumulates calls rank.
	"src/callers.ts":
		'import { hub } from "./hub.js";\n\nexport function f1(n: number): number {\n  return hub(n);\n}\n\nexport function f2(n: number): number {\n  return hub(n);\n}\n',
	// q calls BOTH hub and leaf: its neighbours are hub (ranked) and leaf.
	"src/q.ts":
		'import { hub } from "./hub.js";\nimport { leaf } from "./leaf.js";\n\nexport function q(n: number): number {\n  return hub(n) + leaf(n);\n}\n',
};

async function setup(): Promise<{ engine: ContextEngine; backend: LocalBackend }> {
	const projectDir = makeTempDir("pce-wp2-");
	dirs.push(projectDir);
	writeFiles(projectDir, FILES);
	const storageRoot = makeTempDir("pce-wp2store-");
	dirs.push(storageRoot);
	const config: Config = { ...defaultConfig(), storagePath: storageRoot };
	const backend = new LocalBackend(storageRoot);
	const engine = new ContextEngine({ projectDir, config, runtime: { backend, embedder: makeFakeEmbedder() } });
	engines.push(engine);
	await engine.reindex({ full: true });
	return { engine, backend };
}

function chunk(backend: LocalBackend, file: string, needle: string) {
	const found = backend.chunksByFile(file, 20).find((c) => c.chunkType === "function" && c.content.includes(needle));
	expect(found, `function chunk containing ${needle} in ${file}`).toBeDefined();
	return found!;
}

describe("WP2: symbol PageRank table", () => {
	it("ranks the multi-called hub above the singly-called leaf", async () => {
		const { backend } = await setup();
		const ranks = backend.symbolPageRanks();
		expect(ranks.size).toBeGreaterThan(0);
		const hub = chunk(backend, "src/hub.ts", "function hub");
		const leaf = chunk(backend, "src/leaf.ts", "function leaf");
		expect(ranks.get(hub.id)!).toBeGreaterThan(ranks.get(leaf.id)!);
		// Max-normalised to [0,1], and every live node carries mass.
		for (const s of ranks.values()) {
			expect(s).toBeGreaterThan(0);
			expect(s).toBeLessThanOrEqual(1.000001);
		}
	});
});

describe("WP2: related_context ordering", () => {
	it("lists the hub callee before the leaf callee", async () => {
		const { engine, backend } = await setup();
		const q = chunk(backend, "src/q.ts", "function q");
		const text = engine.relatedContext(q.id);
		expect(text).toContain("hub");
		expect(text).toContain("leaf");
		const hubPos = text.indexOf("hub");
		const leafPos = text.indexOf("leaf");
		expect(hubPos).toBeGreaterThanOrEqual(0);
		expect(hubPos).toBeLessThan(leafPos);
	});

	it("returns byte-identical output on repeated calls", async () => {
		const { engine, backend } = await setup();
		const q = chunk(backend, "src/q.ts", "function q");
		const first = engine.relatedContext(q.id);
		const second = engine.relatedContext(q.id);
		expect(second).toBe(first);
	});
});

describe("WP2: deletion keeps symbol ranks consistent", () => {
	it("drops symbol rows for deleted files (same lifecycle as file ranks)", async () => {
		const { backend } = await setup();
		const hub = chunk(backend, "src/hub.ts", "function hub");
		expect(backend.symbolPageRanks().has(hub.id)).toBe(true);
		backend.deleteByFiles(["src/hub.ts"]);
		expect(backend.symbolPageRanks().has(hub.id)).toBe(false);
		// Surviving nodes keep their rows.
		const leaf = chunk(backend, "src/leaf.ts", "function leaf");
		expect(backend.symbolPageRanks().has(leaf.id)).toBe(true);
	});
});
