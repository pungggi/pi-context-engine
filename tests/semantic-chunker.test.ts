import { describe, expect, it } from "vitest";
import {
	MIN_SEMANTIC_CHUNK_CHARS,
	chunkSemanticProse,
	cosineDistance,
	groupSemanticUnits,
	quantile,
	semanticBreakpoints,
	splitParagraphUnits,
	type EmbedTexts,
	type SemanticUnit,
} from "../src/indexer/semantic-chunker.js";
import { proseHasStructure } from "../src/indexer/prose-chunker.js";

/** Deterministic unit embedder: units containing a topic word map to that
 * topic's orthogonal basis vector; unknown text maps to a diagonal vector. */
function topicEmbedder(): EmbedTexts {
	const topics: Array<[string, number[]]> = [
		["database", [1, 0, 0]],
		["network", [0, 1, 0]],
		["ui", [0, 0, 1]],
	];
	return async (texts) =>
		texts.map((t) => {
			for (const [word, vec] of topics) if (t.includes(word)) return vec;
			return [1, 1, 1];
		});
}

/** n paragraphs of `topic` text, each comfortably over MIN chunk size. */
function para(topic: string, i: number): string {
	return `${topic} paragraph ${i} ${topic} ${"x".repeat(340)} ${topic} end ${i}`;
}

describe("splitParagraphUnits", () => {
	it("covers the file contiguously with no gaps or overlaps", () => {
		const src = ["intro line", "", "second para", "still second", "", "", "third", ""].join("\n");
		const units = splitParagraphUnits(src);
		expect(units).toHaveLength(3);
		for (let i = 1; i < units.length; i++) {
			expect(units[i]!.startLine).toBe(units[i - 1]!.endLine + 1);
		}
		expect(units[0]!.startLine).toBe(1);
	});

	it("returns empty for blank-only sources", () => {
		expect(splitParagraphUnits(" \n\n  \n")).toHaveLength(0);
	});
});

describe("cosineDistance / quantile / breakpoints", () => {
	it("cosine: identical → 0, orthogonal → 1, zero vector → 1", () => {
		expect(cosineDistance([1, 2, 3], [1, 2, 3])).toBeCloseTo(0);
		expect(cosineDistance([1, 0], [0, 1])).toBeCloseTo(1);
		expect(cosineDistance([0, 0], [1, 1])).toBeCloseTo(1);
	});

	it("quantile interpolates linearly", () => {
		expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5);
		expect(quantile([5], 0.9)).toBe(5);
	});

	it("breakpoints flag topic changes, not within-topic boundaries", () => {
		// distances: within-topic ~0, topic switches ~1
		const d = [0.01, 1.0, 0.01, 0.02, 1.0, 0.01];
		const bp = semanticBreakpoints(d);
		expect(bp).toEqual([false, true, false, false, true, false]);
	});

	it("uniform distances produce no breakpoints (homogeneous fallback)", () => {
		expect(semanticBreakpoints([0.3, 0.3, 0.3, 0.3])).toEqual([false, false, false, false]);
	});
});

describe("groupSemanticUnits", () => {
	const mkUnit = (start: number, end: number, nw: number): SemanticUnit => ({
		startLine: start,
		endLine: end,
		nwChars: nw,
		text: "u",
	});

	it("splits at breakpoints and merges undersize groups into the closer neighbour", () => {
		// units: [A][A][B][B], boundary 1→2 is a breakpoint; unit 0 is tiny
		const units = [mkUnit(1, 1, 50), mkUnit(2, 4, 600), mkUnit(5, 7, 600), mkUnit(8, 9, 600)];
		const breakAt = [false, true, false];
		const emb = [
			[1, 0],
			[1, 0],
			[0, 1],
			[0, 1],
		];
		const lines = Array.from({ length: 9 }, () => "line");
		const groups = groupSemanticUnits(units, breakAt, emb, lines, 1200, MIN_SEMANTIC_CHUNK_CHARS);
		// tiny unit 0 merges into unit 1 (same topic, distance 0)
		expect(groups).toHaveLength(2);
		expect(groups[0]!.startLine).toBe(1);
		expect(groups[0]!.endLine).toBe(4);
		expect(groups[1]!.startLine).toBe(5);
	});

	it("splits an oversize single unit on line boundaries within budget", () => {
		const units = [mkUnit(1, 9, 5000)];
		const lines = Array.from({ length: 9 }, () => "x".repeat(600)); // ~600 nw per line
		const groups = groupSemanticUnits(units, [], [[]], lines, 1200, MIN_SEMANTIC_CHUNK_CHARS);
		expect(groups.length).toBeGreaterThan(1);
		for (const g of groups) expect(g.nwChars).toBeLessThanOrEqual(1200 + 600); // last line may tip over
		expect(groups[0]!.startLine).toBe(1);
		expect(groups.at(-1)!.endLine).toBe(9);
		for (let i = 1; i < groups.length; i++) expect(groups[i]!.startLine).toBe(groups[i - 1]!.endLine + 1);
	});
});

describe("chunkSemanticProse", () => {
	it("chunks a two-topic heading-less file at the topic boundary", async () => {
		const src = [
			para("database", 1),
			"",
			para("database", 2),
			"",
			para("network", 3),
			"",
			para("network", 4),
			"",
		].join("\n");
		const chunks = await chunkSemanticProse(src, "notes.txt", "plaintext", 1200, topicEmbedder());
		expect(chunks.length).toBe(2);
		expect(chunks[0]!.content).toContain("database paragraph 1");
		expect(chunks[0]!.content).toContain("database paragraph 2");
		expect(chunks[1]!.content).toContain("network paragraph 3");
		expect(chunks[0]!.metadata["semantic"]).toBe(true);
		// byte-exact tiling: ranges are ordered, contiguous, cover the file
		expect(chunks[0]!.startLine).toBe(1);
		expect(chunks[1]!.startLine).toBe(chunks[0]!.endLine + 1);
		expect(chunks.at(-1)!.endLine).toBe(src.split("\n").length);
		// and the contents join back to the source
		expect(chunks.map((c) => c.content).join("\n")).toBe(src);
	});

	it("returns [] below 3 units (fallback to chunkProse)", async () => {
		const src = [para("database", 1), "", para("database", 2)].join("\n");
		expect(await chunkSemanticProse(src, "a.txt", "plaintext", 1200, topicEmbedder())).toEqual([]);
	});

	it("returns [] when total size fits one budget chunk", async () => {
		const short = ["tiny", "", "also tiny", "", "still tiny"].join("\n");
		expect(await chunkSemanticProse(short, "a.txt", "plaintext", 1200, topicEmbedder())).toEqual([]);
	});

	it("returns [] when the embed pass throws (deterministic fallback)", async () => {
		const src = [para("database", 1), "", para("database", 2), "", para("network", 3)].join("\n");
		const boom: EmbedTexts = async () => {
			throw new Error("no backend");
		};
		expect(await chunkSemanticProse(src, "a.txt", "plaintext", 1200, boom)).toEqual([]);
	});

	it("returns [] on embedding-length mismatch", async () => {
		const src = [para("database", 1), "", para("database", 2), "", para("network", 3)].join("\n");
		const short: EmbedTexts = async (texts) => texts.slice(0, -1).map(() => [1]);
		expect(await chunkSemanticProse(src, "a.txt", "plaintext", 1200, short)).toEqual([]);
	});
});

describe("proseHasStructure", () => {
	it("detects markdown headings (ATX only — setext underlines are not segmented)", () => {
		expect(proseHasStructure("# Title\n\nbody", "markdown")).toBe(true);
		expect(proseHasStructure("setext\n=======\n", "markdown")).toBe(false);
	});

	it("heading-less markdown and plaintext are unstructured", () => {
		expect(proseHasStructure("just paragraphs\n\nno headings", "markdown")).toBe(false);
		expect(proseHasStructure("# ignored for txt", "plaintext")).toBe(false);
	});

	it("headings inside fences do not count", () => {
		expect(proseHasStructure("```\n# not a heading\n```\n\ntext", "markdown")).toBe(false);
	});
});
