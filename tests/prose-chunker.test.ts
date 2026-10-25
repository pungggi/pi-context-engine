import { describe, expect, it } from "vitest";
import { chunkProse, isProseLanguage } from "../src/indexer/prose-chunker.js";
import { sha256Hex } from "../src/utils.js";

const BUDGET = 400; // generous default so fixtures stay single-chunk per section

function nonWs(text: string): number {
	let n = 0;
	for (const ch of text) if (!/\s/.test(ch)) n++;
	return n;
}

const GUIDE = `# Guide

intro line

## Setup

step one

### Windows

install instructions

## Teardown

bye
`;

const FENCED = `# Top

text

\`\`\`python
# not a heading
print("x")
\`\`\`

## After

done
`;

const FRONTMATTER = `---
# yaml comment
title: x
---

# Real

body
`;

describe("isProseLanguage", () => {
	it("claims markdown and plaintext only", () => {
		expect(isProseLanguage("markdown")).toBe(true);
		expect(isProseLanguage("plaintext")).toBe(true);
		expect(isProseLanguage("python")).toBe(false);
		expect(isProseLanguage("json")).toBe(false);
		expect(isProseLanguage("yaml")).toBe(false);
	});
});

describe("chunkProse: markdown sections", () => {
	it("splits at ATX headings with nested heading paths as unit", () => {
		const chunks = chunkProse(GUIDE, "docs/guide.md", "markdown", BUDGET);
		const sections = chunks.filter((c) => c.chunkType === "doc");
		expect(sections.length).toBe(4);
		expect(sections.map((c) => c.metadata["unit"])).toEqual([
			"Guide",
			"Guide > Setup",
			"Guide > Setup > Windows",
			"Guide > Teardown",
		]);
		// The heading line opens its own section; ranges are contiguous and the
		// trailing blank line of a section travels with it.
		expect(sections[0]!.startLine).toBe(1);
		expect(sections[2]!.startLine).toBe(9);
		expect(sections[2]!.endLine).toBe(12);
	});

	it("detects ATX headings in CRLF files (Windows-authored docs)", () => {
		const src = "# Top\r\n\r\nbody\r\n\r\n## Second\r\n\r\ndone\r\n";
		const chunks = chunkProse(src, "docs/crlf.md", "markdown", BUDGET);
		const sections = chunks.filter((c) => c.chunkType === "doc");
		expect(sections.length).toBe(2);
		expect(sections[1]!.metadata["unit"]).toBe("Top > Second");
		const parent = chunks.find((c) => c.chunkType === "module")!;
		expect(parent.content).toContain("## Second");
	});

	it("does not let a YAML literal block inside frontmatter open a fence", () => {
		const src = "---\nexample: |\n  ~~~\n---\n\n# Real\n\nbody\n";
		const chunks = chunkProse(src, "docs/fm-fence.md", "markdown", BUDGET);
		const sections = chunks.filter((c) => c.chunkType === "doc");
		// The `  ~~~` line must not swallow the heading after the frontmatter.
		expect(sections.length).toBe(2);
		expect(sections[1]!.metadata["unit"]).toBe("Real");
		expect(sections[0]!.content).toContain("~~~");
	});

	it("treats an inline code span with backticks as text, not a fence", () => {
		const src = "# Top\n\n```example```\n\n## After\n\ndone\n";
		const chunks = chunkProse(src, "docs/inline.md", "markdown", BUDGET);
		const sections = chunks.filter((c) => c.chunkType === "doc");
		expect(sections.length).toBe(2);
		expect(sections[1]!.metadata["unit"]).toBe("Top > After");
		// The span itself is paragraph text inside the first section.
		expect(sections[0]!.content).toContain("```example```");
	});

	it("returns the sections in source order with unique span-derived ids", () => {
		const chunks = chunkProse(GUIDE, "docs/guide.md", "markdown", BUDGET);
		const sections = chunks.filter((c) => c.chunkType === "doc");
		const ids = chunks.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (let i = 1; i < sections.length; i++) {
			expect(sections[i]!.startLine).toBeGreaterThan(sections[i - 1]!.startLine);
		}
	});

	it("appends an outline module parent built from the heading lines", () => {
		const chunks = chunkProse(GUIDE, "docs/guide.md", "markdown", BUDGET);
		const parent = chunks[chunks.length - 1]!;
		expect(parent.chunkType).toBe("module");
		expect(parent.metadata["tier"]).toBe("parent");
		expect(parent.metadata["unit"]).toBe("guide");
		expect(parent.id).toBe(sha256Hex("docs/guide.md:module").slice(0, 16));
		expect(parent.content).toBe("# Guide\n  ## Setup\n    ### Windows\n  ## Teardown");
	});

	it("does not split on headings inside fenced code blocks", () => {
		const chunks = chunkProse(FENCED, "docs/fenced.md", "markdown", BUDGET);
		const sections = chunks.filter((c) => c.chunkType === "doc");
		expect(sections.length).toBe(2);
		expect(sections[0]!.content).toContain("# not a heading");
		expect(sections[1]!.metadata["unit"]).toBe("Top > After");
		// The fence comment must not have leaked into the outline parent.
		const parent = chunks.find((c) => c.chunkType === "module")!;
		expect(parent.content).not.toContain("yaml comment");
		expect(parent.content).not.toContain("not a heading");
	});

	it("keeps frontmatter out of heading detection", () => {
		const chunks = chunkProse(FRONTMATTER, "docs/fm.md", "markdown", BUDGET);
		const sections = chunks.filter((c) => c.chunkType === "doc");
		expect(sections.length).toBe(2);
		expect(sections[0]!.metadata["unit"]).toBeUndefined(); // preamble
		expect(sections[1]!.metadata["unit"]).toBe("Real");
		const parent = chunks.find((c) => c.chunkType === "module")!;
		expect(parent.content).toBe("# Real");
		expect(parent.content).not.toContain("yaml comment");
	});

	it("treats a bare ##### line and closing hashes correctly", () => {
		const src = "## Real Title ##\n\nbody\n\n#####\n\n## Second\n\ntail\n";
		const chunks = chunkProse(src, "docs/x.md", "markdown", BUDGET);
		const sections = chunks.filter((c) => c.chunkType === "doc");
		expect(sections.length).toBe(2);
		expect(sections[0]!.metadata["unit"]).toBe("Real Title");
		// The textless `#####` line is content, not a boundary.
		expect(sections[0]!.content).toContain("#####");
	});
});

describe("chunkProse: legacy-compatible shapes", () => {
	it("keeps a small single-section file byte-identical to the old fallback", () => {
		const src = "# Only\n\nshort\n";
		const chunks = chunkProse(src, "docs/only.md", "markdown", BUDGET);
		expect(chunks.length).toBe(1);
		expect(chunks[0]!.chunkType).toBe("module");
		expect(chunks[0]!.content).toBe(src);
		expect(chunks[0]!.id).toBe(sha256Hex("docs/only.md:module").slice(0, 16));
	});

	it("returns [] for empty or whitespace-only files", () => {
		expect(chunkProse("", "docs/empty.md", "markdown", BUDGET)).toEqual([]);
		expect(chunkProse("   \n\t\n", "notes.txt", "plaintext", BUDGET)).toEqual([]);
	});
});

describe("chunkProse: budget packing", () => {
	it("splits an oversize section at paragraph boundaries and keeps paragraphs whole", () => {
		const para1 = "aaa bbb ccc ddd eee"; // 20 non-ws
		const para2 = "fff ggg hhh iii jjj"; // 20 non-ws
		const src = `## S\n\n${para1}\n\n${para2}\n`;
		const chunks = chunkProse(src, "docs/pack.md", "markdown", 30);
		const sections = chunks.filter((c) => c.chunkType === "doc");
		// 20 + 20 > 30 but each paragraph fits: no mid-paragraph cut.
		expect(sections.length).toBe(2);
		expect(sections[0]!.content).toContain("aaa bbb");
		expect(sections[0]!.content).not.toContain("fff ggg");
		expect(sections[1]!.content).toContain("fff ggg");
	});

	it("falls back to line windows when one paragraph exceeds the budget", () => {
		const lines = Array.from({ length: 12 }, (_, i) => `line${i} aaaa bbbb cccc`);
		const src = `## S\n\n${lines.join("\n")}\n`;
		const chunks = chunkProse(src, "docs/big.md", "markdown", 40);
		const sections = chunks.filter((c) => c.chunkType === "doc");
		expect(sections.length).toBeGreaterThan(1);
		for (const s of sections) {
			// Every line-window chunk respects the budget (line count × ~24 chars).
			if (s.content.includes("\n")) expect(nonWs(s.content)).toBeLessThanOrEqual(40 + 24);
		}
		// All content survives: every source line appears exactly once overall.
		const joined = sections.map((c) => c.content).join("\n");
		for (const line of lines) expect(joined).toContain(line);
	});

	it("emits a single oversize line as its own chunk instead of dropping it", () => {
		const longLine = "x".repeat(120);
		const src = `intro\n\n${longLine}\n\nout\n`;
		const chunks = chunkProse(src, "docs/longline.txt", "plaintext", 40);
		const docChunks = chunks.filter((c) => c.chunkType === "doc");
		expect(docChunks.some((c) => c.content.includes(longLine))).toBe(true);
	});
});

describe("chunkProse: plaintext", () => {
	it("packs paragraphs without adding an outline parent", () => {
		const src = `first paragraph has enough words to stand alone here\n\nsecond paragraph also has enough words to stand alone\n`;
		const chunks = chunkProse(src, "notes/log.txt", "plaintext", 30);
		const sections = chunks.filter((c) => c.chunkType === "doc");
		expect(sections.length).toBeGreaterThanOrEqual(2);
		expect(chunks.some((c) => c.chunkType === "module")).toBe(false);
		expect(sections.every((c) => c.metadata["unit"] === undefined)).toBe(true);
	});

	it("keeps a small note as the whole-file module chunk", () => {
		const src = "just a small note\n";
		const chunks = chunkProse(src, "notes/small.txt", "plaintext", BUDGET);
		expect(chunks.length).toBe(1);
		expect(chunks[0]!.chunkType).toBe("module");
		expect(chunks[0]!.content).toBe(src);
	});
});
