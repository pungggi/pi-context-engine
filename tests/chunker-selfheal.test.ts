import { beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "node:module";

// Reproduces the live "Parser.init is not a function" incident: if a loader
// evaluates web-tree-sitter's conditional UMD export
// (`"object"==typeof exports && (module.exports=TreeSitter)`) in a non-CJS
// context, require() silently returns `{}` and the poisoned require-cache
// entry bricks every later Parser.init() for the process lifetime.
// getParser() must drop the poisoned entry, re-require, and recover.
const require = createRequire(import.meta.url);
const wtsPath = require.resolve("web-tree-sitter");

describe("chunker web-tree-sitter loading", () => {
	beforeAll(() => {
		// Poison the native require cache BEFORE the chunker module loads.
		const fake = {
			exports: {},
			loaded: true,
			id: wtsPath,
			filename: wtsPath,
			path: wtsPath,
			children: [],
			paths: [],
		} as unknown as NodeModule;
		require.cache[wtsPath] = fake;
	});

	it("self-heals from a poisoned require-cache entry (empty exports)", async () => {
		// Fresh import in this test file's module registry: first getParser()
		// call hits the poisoned entry above, deletes it, and re-requires.
		const { warmupLanguages } = await import("../src/indexer/chunker.js");
		await expect(warmupLanguages(new Set(["javascript"]))).resolves.toBeUndefined();
	});

	it("actually parsed the grammar, not just resolved the module", async () => {
		const { Chunker } = await import("../src/indexer/chunker.js");
		const chunker = new Chunker();
		await import("../src/indexer/chunker.js").then((m) => m.warmupLanguages(new Set(["javascript"])));
		const chunks = chunker.chunk("function hello() { return 1; }", "a.js", "javascript");
		expect(chunks.length).toBeGreaterThan(0);
	});
});
