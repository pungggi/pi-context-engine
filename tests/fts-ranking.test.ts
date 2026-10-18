/**
 * R2: BM25 strength — quoted phrases constrain, column weights make filename
 * stems decisive, and exact-symbol queries rank the defining chunk first.
 * Also covers the header parser the symbol bonus relies on.
 */
import { afterEach, describe, expect, it } from "vitest";
import { escapeFts5, FTSStore } from "../src/storage/fts-store.js";
import { parseContextHeaderUnit, buildContextHeader } from "../src/indexer/context-header.js";
import { HybridRetriever } from "../src/retrieval/retriever.js";
import { LocalBackend } from "../src/storage/local-backend.js";
import { makeChunk, type Chunk } from "../src/types.js";
import { FakeEmbeddingBackend, makeFakeEmbedder, makeTempDir, rmrf } from "./helpers.js";

const dirs: string[] = [];
const openStores: FTSStore[] = [];
const openBackends: LocalBackend[] = [];
afterEach(() => {
	// Windows cannot rm a directory while an FTS5 db handle is open (EPERM).
	for (const s of openStores.splice(0)) {
		try {
			s.close();
		} catch {
			// already closed
		}
	}
	for (const b of openBackends.splice(0)) {
		try {
			b.close();
		} catch {
			// already closed by the test
		}
	}
	for (const d of dirs.splice(0)) rmrf(d);
});

describe("escapeFts5 with quoted phrases", () => {
	it("keeps unquoted queries OR-joined as before", () => {
		expect(escapeFts5("atomic manifest corruption")).toBe('"atomic" OR "manifest" OR "corruption"');
	});

	it("turns a quoted span into an FTS5 phrase", () => {
		expect(escapeFts5('"error handling"')).toBe('"error handling"');
	});

	it("splits code symbols inside phrases the way the tokenizer indexes them", () => {
		expect(escapeFts5('"encode_token"')).toBe('"encode token"');
	});

	it("constrains phrases together with the remaining tokens", () => {
		expect(escapeFts5('"error handling" route handler')).toBe('"error handling" AND ("route" OR "handler")');
	});

	it("keeps a stopword-only phrase as an explicit constraint, and a stopword-only unquoted query intact", () => {
		// Quoted spans always constrain, even when the words are common.
		expect(escapeFts5('"the of" fallback')).toBe('"the of" AND ("fallback")');
		// Unquoted stopwords: only used when nothing else survives.
		expect(escapeFts5("the of and")).toBe('"the" OR "of" OR "and"');
		expect(escapeFts5("   ")).toBe("");
	});
});

describe("FTSStore phrase matching (end to end)", () => {
	function store(): { fts: FTSStore; add: (id: string, content: string) => void } {
		const dir = makeTempDir("pce-fts-");
		dirs.push(dir);
		const fts = new FTSStore(dir);
		openStores.push(fts);
		const add = (id: string, content: string) =>
			fts.ingest([makeChunk({ id, content, chunkType: "function", filePath: `${id}.ts`, startLine: 1, endLine: 1, language: "typescript" })]);
		return { fts, add };
	}

	it("matches only adjacent words for a quoted phrase", () => {
		const { fts, add } = store();
		add("adjacent", "if (!resp.ok) throw new Error('error handling needed')");
		add("scattered", "the error came first; later we saw the final handling pass");
		add("other", "unrelated text with neither target word");

		const hits = fts.search('"error handling"', 10).map((r) => r.id);
		expect(hits).toEqual(["adjacent"]);
	});

	it("still OR-matches when the same words are unquoted", () => {
		const { fts, add } = store();
		add("adjacent", "error handling needed");
		add("scattered", "the error came first; later the handling pass");
		const hits = fts.search("error handling", 10).map((r) => r.id);
		expect(hits).toHaveLength(2);
	});
});

describe("BM25 column weights", () => {
	it("ranks a filename-stem hit above a content-only hit", () => {
		const dir = makeTempDir("pce-bm25-");
		dirs.push(dir);
		const fts = new FTSStore(dir);
		openStores.push(fts);
		fts.ingest([
			makeChunk({
				id: "byPath",
				content: "compress things with strict rules",
				chunkType: "function",
				filePath: "src/memory/grammar.ts",
				startLine: 1,
				endLine: 1,
				language: "typescript",
			}),
			makeChunk({
				id: "byBody",
				content: "grammar shows up in this prose once, and rules show up too",
				chunkType: "function",
				filePath: "src/other/notes.ts",
				startLine: 1,
				endLine: 1,
				language: "typescript",
			}),
		]);
		const hits = fts.search("grammar rules", 10).map((r) => r.id);
		expect(hits[0]).toBe("byPath");
	});
});

describe("parseContextHeaderUnit", () => {
	it("reads the unit from a full header line", () => {
		const header = buildContextHeader({
			filePath: "src/retrieval/retriever.ts",
			language: "typescript",
			unit: "HybridRetriever.retrieve",
			imports: ["./confidence"],
		});
		expect(parseContextHeaderUnit(`${header}\nbody()`)).toBe("HybridRetriever.retrieve");
	});

	it("reads a unit when it ends the line", () => {
		expect(parseContextHeaderUnit("// file: a.py | lang: python | unit: charge_card\ndef f(): pass")).toBe("charge_card");
	});

	it("returns null without a header or a unit part", () => {
		expect(parseContextHeaderUnit("def f(): pass")).toBeNull();
		expect(parseContextHeaderUnit("// file: a.py | lang: python\nbody")).toBeNull();
	});
});

describe("symbol match bonus (R2c)", () => {
	function setup(): { backend: LocalBackend; retriever: HybridRetriever; fake: FakeEmbeddingBackend } {
		const dir = makeTempDir("pce-sym-");
		dirs.push(dir);
		const backend = new LocalBackend(dir);
		openBackends.push(backend);
		const fake = new FakeEmbeddingBackend();
		// Identical bodies and identical embeddings isolate the unit bonus: the
		// only difference between the two candidates is which chunk *defines*
		// the queried symbol in its header.
		const body = "batchedParams chunks sql placeholders for large in lists";
		const a: Chunk = makeChunk({
			id: "definer",
			content: `// file: src/utils.ts | lang: typescript | unit: Utils.batchedParams\n${body}`,
			chunkType: "function",
			filePath: "src/utils.ts",
			startLine: 10,
			endLine: 12,
			language: "typescript",
			embedding: fake.vec(body),
		});
		const b: Chunk = makeChunk({
			id: "mentioner",
			content: `// file: src/engine.ts | lang: typescript | unit: ContextEngine.search\n${body}`,
			chunkType: "function",
			filePath: "src/engine.ts",
			startLine: 20,
			endLine: 22,
			language: "typescript",
			embedding: fake.vec(body),
		});
		backend.ingest([a, b], [], []);
		return { backend, retriever: new HybridRetriever(backend, makeFakeEmbedder()), fake };
	}

	it("ranks the chunk whose unit defines the queried symbol", async () => {
		const { backend, retriever } = setup();
		const results = await retriever.retrieve("batchedParams chunks sql placeholders for large in lists", {
			topK: 5,
			confidenceThreshold: 0,
		});
		expect(results[0]!.id).toBe("definer");
		const definer = results.find((c) => c.id === "definer")!;
		const mentioner = results.find((c) => c.id === "mentioner")!;
		expect(definer.confidenceScore).toBeGreaterThan(mentioner.confidenceScore);
		backend.close();
	});

	it("adds nothing when no unit matches the query", async () => {
		const { backend, retriever } = setup();
		const results = await retriever.retrieve("unrelatedZebraQuery xylophone", {
			topK: 5,
			confidenceThreshold: 0,
		});
		const scores = results.map((c) => c.confidenceScore);
		// Both candidates tie on vector and keyword evidence; without a symbol
		// match the gap stays at pure RRF noise level, far below the 0.06 bonus.
		const gap = Math.max(...scores) - Math.min(...scores);
		expect(gap).toBeLessThan(0.03);
		backend.close();
	});
});
