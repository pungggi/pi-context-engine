/**
 * R14 (issue #45): rarity-weighted FTS fusion.
 *
 * A query whose tokens are corpus-near-unique (a prose term that matches one
 * chunk in the whole repo) used to lose fusion: flat RRF gave its FTS rank-1
 * the same 1/(k+1) as every vector-noise hit. The retriever now measures
 * token rarity (normalised IDF over real df counts) and concentrates extra
 * FTS weight on the BM25 list head, where BM25's own ordering is trustworthy.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ftsQueryTokens, FTSStore } from "../src/storage/fts-store.js";
import { HybridRetriever, queryTokenRarity } from "../src/retrieval/retriever.js";
import { LocalBackend } from "../src/storage/local-backend.js";
import { makeChunk } from "../src/types.js";
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

describe("ftsQueryTokens", () => {
	it("lowercases, drops stopwords and single-character tokens", () => {
		expect(ftsQueryTokens("The Raretok Controller!")).toEqual(["raretok", "controller"]);
		expect(ftsQueryTokens("a I to run")).toEqual(["run"]);
	});

	it("keeps words from quoted phrases", () => {
		expect(ftsQueryTokens('"error handling" route')).toEqual(["error", "handling", "route"]);
	});
});

describe("queryTokenRarity", () => {
	it("scores a corpus-unique token near 1 and an everywhere-token near 0", () => {
		const unique = queryTokenRarity(["zzquartzvalve"], 600, [1]);
		const common = queryTokenRarity(["data"], 600, [600]);
		expect(unique).toBeGreaterThan(0.9);
		expect(common).toBeLessThan(0.01);
	});

	it("averages across tokens and guards bad input", () => {
		const unique = queryTokenRarity(["zzquartzvalve"], 600, [1]);
		const mixed = queryTokenRarity(["zzquartzvalve", "data"], 600, [1, 600]);
		expect(mixed).toBeCloseTo(unique / 2, 2);
		expect(queryTokenRarity([], 600, [])).toBe(0);
		expect(queryTokenRarity(["x"], 0, [0])).toBe(0);
		expect(queryTokenRarity(["x"], 600, [])).toBe(0);
		expect(queryTokenRarity(["x"], 10, [99])).toBe(0); // stale df > N clamps to 0
	});
});

describe("FTSStore df primitives", () => {
	it("counts rows and per-term document frequency", () => {
		const dir = makeTempDir("pce-df-");
		dirs.push(dir);
		const fts = new FTSStore(dir);
		openStores.push(fts);
		expect(fts.docCount()).toBe(0);
		fts.ingest([
			makeChunk({
				id: "a",
				content: "Fernwaerme controller notes with details",
				chunkType: "function",
				filePath: "src/a.ts",
				startLine: 1,
				endLine: 1,
				language: "typescript",
			}),
			makeChunk({
				id: "b",
				content: "unrelated dispatch handler",
				chunkType: "function",
				filePath: "src/b.ts",
				startLine: 1,
				endLine: 1,
				language: "typescript",
			}),
		]);
		expect(fts.docCount()).toBe(2);
		expect(fts.termDocCount("fernwaerme")).toBe(1);
		expect(fts.termDocCount("controller")).toBe(1);
		expect(fts.termDocCount("dispatch")).toBe(1);
		expect(fts.termDocCount("missingterm")).toBe(0);
		// Query-syntax characters must not escape the quoted term (no throw, no match).
		expect(fts.termDocCount('a" OR 1=1 --')).toBe(0);
		fts.deleteByFile("src/a.ts");
		expect(fts.docCount()).toBe(1);
		expect(fts.termDocCount("fernwaerme")).toBe(0);
		fts.close();
	});
});

describe("R14: rarity-weighted FTS fusion (issue #45)", () => {
	// Corpus mimicking the issue: one long prose chunk carrying a corpus-unique
	// term, drowned by short code chunks. The filler word is chosen to collide
	// with the unique term's fake-embedder hash bucket, so — exactly like the
	// real repro — the prose chunk is too long to make the vector top-30 and
	// its only evidence path is the FTS list.
	function buildCorpus(): { backend: LocalBackend } {
		const dir = makeTempDir("pce-r14-");
		dirs.push(dir);
		const backend = new LocalBackend(dir);
		openBackends.push(backend);
		const probe = new FakeEmbeddingBackend();
		const bucket = probe.vec("zzquartzvalve").findIndex((v) => v > 0);
		let collider = "";
		for (let i = 0; i < 500 && !collider; i++) {
			const w = `tok${i}`;
			if (probe.vec(w).findIndex((v) => v > 0) === bucket) collider = w;
		}
		const chunks = [];
		for (let i = 0; i < 70; i++) {
			const body = `${collider} ${collider} mod${i} handler dispatch table request route`;
			chunks.push(
				makeChunk({
					id: `mod${i}`,
					content: `// file: src/mod${i}.ts | lang: typescript | unit: Mod${i}.handler\n${body}`,
					chunkType: "function",
					filePath: `src/mod${i}.ts`,
					startLine: 10,
					endLine: 12,
					language: "typescript",
					embedding: probe.vec(body),
				}),
			);
		}
		// Long single-sentence prose so its fake-embedder vector is too diluted
		// to rank: the term is 1 of ~120 tokens.
		const proseWords = Array.from({ length: 120 }, (_, i) => `word${i + 500}`);
		const proseBody = `Field notes about the zzquartzvalve retrofit. ${proseWords.join(" ")}`;
		chunks.push(
			makeChunk({
				id: "fieldnotes",
				content: `// file: src/notes/fieldnotes.txt | lang: markdown | unit: fieldnotes\n${proseBody}`,
				chunkType: "doc",
				filePath: "src/notes/fieldnotes.txt",
				startLine: 1,
				endLine: 4,
				language: "markdown",
				embedding: probe.vec(proseBody),
			}),
		);
		backend.ingest(chunks, [], []);
		return { backend };
	}

	it("measures df through the backend (plumbing)", () => {
		const { backend } = buildCorpus();
		expect(backend.ftsDocCount()).toBe(71);
		expect(backend.ftsTermDocCount("zzquartzvalve")).toBe(1);
		expect(backend.ftsTermDocCount("dispatch")).toBe(70);
		backend.close();
	});

	it("surfaces the corpus-unique prose file at rank 1", async () => {
		const { backend } = buildCorpus();
		const retriever = new HybridRetriever(backend, makeFakeEmbedder());
		// "dispatch" is in 70 of 71 chunks: pre-R14 fusion let the dispatch
		// matches (strong in BOTH lists) outvote the prose chunk whose ONLY
		// evidence is its unique term at FTS rank 0.
		const results = await retriever.retrieve("zzquartzvalve dispatch", {
			topK: 10,
			confidenceThreshold: 0,
		});
		expect(results[0]!.filePath).toBe("src/notes/fieldnotes.txt");
		backend.close();
	});
});
