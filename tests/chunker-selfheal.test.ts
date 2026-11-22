import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

// Reproduces the live "Parser.init is not a function" incident: if a loader
// evaluates web-tree-sitter's conditional UMD export
// (`"object"==typeof exports && (module.exports=TreeSitter)`) in a non-CJS
// context, require() silently returns `{}` and the poisoned require-cache
// entry bricks every later Parser.init() for the process lifetime.
// getParser() must drop the poisoned entry, re-require, and recover.
//
// Isolation: vi.resetModules() before each test so chunker.js is re-evaluated
// cold (cachedParser/its module-scope reset), and the poison is re-planted in
// beforeEach. Without this the test depends on which test file imports
// chunker.js first and can pass vacuously.
const require = createRequire(import.meta.url);
const wtsPath = require.resolve("web-tree-sitter");

function plantPoison(): void {
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
}

describe("chunker web-tree-sitter loading", () => {
	beforeEach(() => {
		vi.resetModules();
		// resetModules does NOT clear a globalThis Symbol.for stash (it survives
		// module re-evaluation), so a stash filled by an earlier test would let
		// getParser() return early and the poison path would never run. Clear it
		// so this test genuinely exercises the cache-drop recovery.
		delete (globalThis as Record<PropertyKey, unknown>)[Symbol.for("pce.web-tree-sitter.Parser")];
		plantPoison();
	});

	it("self-heals from a poisoned require-cache entry (empty exports)", async () => {
		// Cold import: first getParser() call hits the poisoned entry, deletes
		// it, and re-requires a clean module.
		const { warmupLanguages } = await import("../src/indexer/chunker.js");
		await expect(warmupLanguages(new Set(["javascript"]))).resolves.toBeUndefined();
	});

	it("actually performs the cache-drop retry (spy: poison deleted, clean module loaded)", async () => {
		// Isolate the DROP step itself: plant the poison, then observe that
		// getParser() deletes that exact entry (the cache-drop) before the
		// re-require returns a clean module. Without the drop this test fails,
		// proving the recovery depends on the drop and not on a lucky clean load.
		let droppedPath: string | undefined;
		const handler: ProxyHandler<Record<string, unknown>> = {
			deleteProperty(target, prop) {
				if (prop === wtsPath) droppedPath = String(prop);
				return Reflect.deleteProperty(target, prop);
			},
		};
		const ModuleCtor = require("module") as unknown as { _cache: Record<string, unknown> };
		const realCache = ModuleCtor._cache;
		const spyCache = new Proxy(realCache, handler);
		Object.defineProperty(ModuleCtor, "_cache", { value: spyCache, configurable: true });
		try {
			const { warmupLanguages } = await import("../src/indexer/chunker.js");
			await expect(warmupLanguages(new Set(["javascript"]))).resolves.toBeUndefined();
			// The drop must have targeted the poisoned web-tree-sitter entry.
			expect(droppedPath).toBe(wtsPath);
			// And the cache now holds a real module (not our fake poison).
			const loaded = realCache[wtsPath] as NodeModule | undefined;
			expect(loaded).toBeDefined();
			expect(loaded?.exports).not.toEqual({}); // clean export, not the empty poison
		} finally {
			Object.defineProperty(ModuleCtor, "_cache", { value: realCache, configurable: true });
		}
	});

	it("actually parsed the grammar, not just resolved the module", async () => {
		const { Chunker, warmupLanguages } = await import("../src/indexer/chunker.js");
		await warmupLanguages(new Set(["javascript"]));
		const chunker = new Chunker();
		const chunks = chunker.chunk("function hello() { return 1; }", "a.js", "javascript");
		// Assert a real AST artifact: the function definition was recognized,
		// which only happens if the grammar actually loaded and parsed.
		expect(chunks.some((c) => c.chunkType === "function")).toBe(true);
	});

	it("throws the fingerprint and caches it when the poison survives the cache-drop", async () => {
		// Make the poison IMMUNE to the cache-drop: swap the shared Module._cache
		// (=== require.cache) for a Proxy that re-plants the empty-exports entry
		// every time it is deleted, so getParser()'s re-require is poisoned too
		// and it falls through to the fingerprint + cachedParserError path.
		const ModuleCtor = require("module") as unknown as {
			_cache: Record<string, unknown>;
		};
		const realCache = ModuleCtor._cache;
		const poisonEntry = (): NodeModule =>
			({
				exports: {},
				loaded: true,
				id: wtsPath,
				filename: wtsPath,
				path: wtsPath,
				children: [],
				paths: [],
			}) as unknown as NodeModule;
		const proxy = new Proxy(realCache, {
			deleteProperty(target, prop) {
				Reflect.deleteProperty(target, prop);
				if (prop === wtsPath) target[prop] = poisonEntry(); // re-plant after drop
				return true;
			},
		});
		Object.defineProperty(ModuleCtor, "_cache", { value: proxy, configurable: true });
		const priorEntry = realCache[wtsPath]; // preserve whatever was there before
		realCache[wtsPath] = poisonEntry();

		const { warmupLanguages } = await import("../src/indexer/chunker.js");
		try {
			// warmupLanguages → ensureParserInit → getParser(): both the first require
			// and the post-drop re-require are poisoned, so it must throw the
			// fingerprint (keys=[…]) instead of recovering.
			await expect(warmupLanguages(new Set(["javascript"]))).rejects.toThrow(
				/web-tree-sitter malformed: keys=/,
			);
		} finally {
			// Restore the real cache for later tests — even if the assertion above
			// throws, or the Proxy would stay on Module._cache and poison every
			// subsequent test in this process. Put back the prior entry rather than
			// unconditionally deleting, so we do not clobber state another test needs.
			Object.defineProperty(ModuleCtor, "_cache", { value: realCache, configurable: true });
			if (priorEntry === undefined) delete realCache[wtsPath];
			else realCache[wtsPath] = priorEntry;
		}
	});

	it("caps full resolve cycles per window (no toast-spam under persistent poison)", async () => {
		// Persistent poison that survives the cache-drop (re-planted on delete),
		// counted by deleteProperty. Over many watcher ticks the windowed budget
		// must limit full resolve cycles (delete → re-require → diagnostics) to
		// PARSER_RESOLVE_RETRY_LIMIT, after which getParser() throws the CACHED
		// error cheaply instead of re-running the cycle every tick.
		const ModuleCtor = require("module") as unknown as { _cache: Record<string, unknown> };
		const realCache = ModuleCtor._cache;
		let fullCycles = 0;
		const poisonEntry = (): NodeModule =>
			({
				exports: {},
				loaded: true,
				id: wtsPath,
				filename: wtsPath,
				path: wtsPath,
				children: [],
				paths: [],
			}) as unknown as NodeModule;
		const proxy = new Proxy(realCache, {
			deleteProperty(target, prop) {
				Reflect.deleteProperty(target, prop);
				if (prop === wtsPath) {
					fullCycles++;
					target[prop] = poisonEntry(); // re-plant so every retry is poisoned
				}
				return true;
			},
		});
		Object.defineProperty(ModuleCtor, "_cache", { value: proxy, configurable: true });
		const priorEntry = realCache[wtsPath];
		realCache[wtsPath] = poisonEntry();

		const { warmupLanguages } = await import("../src/indexer/chunker.js");
		try {
			const TICKS = 8; // well past PARSER_RESOLVE_RETRY_LIMIT (3)
			let caught = 0;
			for (let i = 0; i < TICKS; i++) {
				try {
					await warmupLanguages(new Set(["javascript"]));
				} catch {
					caught++;
				}
			}
			// Every tick fails (poison never clears), but full resolve cycles are
			// capped at the retry limit — not one per tick.
			expect(caught).toBe(TICKS);
			expect(fullCycles).toBeLessThanOrEqual(3);
			expect(fullCycles).toBeGreaterThan(0); // it did retry at least once
		} finally {
			Object.defineProperty(ModuleCtor, "_cache", { value: realCache, configurable: true });
			if (priorEntry === undefined) delete realCache[wtsPath];
			else realCache[wtsPath] = priorEntry;
		}
	});
});
