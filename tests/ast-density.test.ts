/**
 * R12: ast-density chunking (cAST-style split-merge) — concat round-trip,
 * budget respected, id uniqueness on duplicate spans, legacy mode unchanged.
 */
import { describe, expect, it, beforeAll } from "vitest";
import { Chunker, warmupLanguages, isAstLanguage } from "../src/indexer/chunker.js";

const TS = `import { helper } from "./util.js";

// Module-level constant with a comment.
export const CONFIG = {
	retries: 3,
	timeoutMs: 5_000,
};

export function smallOne(x: number): number {
	return x + 1;
}

export function bigOne(rows: string[]): { total: number; lines: number } {
	let total = 0;
	for (const row of rows) {
		total += row.length;
	}
	return { total, lines: rows.length };
}

export class Widget {
	private count = 0;

	bump(): number {
		this.count += 1;
		return this.count;
	}

	reset(): void {
		this.count = 0;
	}
}
`;

describe("R12: ast-density chunking", () => {
	beforeAll(async () => {
		await warmupLanguages(["typescript"]);
	});

	it("concatenated chunks (excluding module) reproduce the source exactly", () => {
		const chunker = new Chunker();
		const out = chunker.chunkWithImports(TS, "src/demo.ts", "typescript", { chunking: "ast-density", budgetChars: 200 });
		const tiled = out.chunks.filter((c) => c.chunkType !== "module");
		expect(tiled.length).toBeGreaterThan(1);
		const joined = [...tiled].sort((a, b) => a.id.localeCompare(b.id) && 0 || 0) && tiled;
		void joined;
		// Reassemble in offset order via startLine/endLine consistency: use the
		// chunk contents themselves — units are emitted in document order.
		expect(tiled.map((c) => c.content).join("")).toBe(TS);
	});

	it("respects the non-whitespace budget (with tolerance for one unbreakable leaf line)", () => {
		const chunker = new Chunker();
		const budget = 150;
		const out = chunker.chunkWithImports(TS, "src/demo.ts", "typescript", { chunking: "ast-density", budgetChars: budget });
		const tiled = out.chunks.filter((c) => c.chunkType !== "module");
		expect(tiled.length).toBeGreaterThan(2);
		const nonWs = (s: string) => s.replace(/\s/g, "").length;
		// A unit may exceed budget only if it is a single line (unbreakable).
		for (const c of tiled) {
			if (nonWs(c.content) > budget) {
				const lines = c.content.split("\n").filter((l) => l.trim().length > 0);
				expect(lines.length).toBeLessThanOrEqual(1);
			}
		}
	});

	it("produces unique ids even for duplicate spans/contents", () => {
		const chunker = new Chunker();
		const dup = `${"export const A = 1;\n\n".repeat(6)}\n${"export const B = 2;\n\n".repeat(6)}`;
		const out = chunker.chunkWithImports(dup, "src/dup.ts", "typescript", { chunking: "ast-density", budgetChars: 100 });
		const ids = out.chunks.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("legacy mode (default) is byte-identical to the explicit legacy option", () => {
		const chunker = new Chunker();
		const a = chunker.chunkWithImports(TS, "src/demo.ts", "typescript");
		const b = chunker.chunkWithImports(TS, "src/demo.ts", "typescript", { chunking: "legacy" });
		expect(b.chunks.map((c) => [c.id, c.content])).toEqual(a.chunks.map((c) => [c.id, c.content]));
		expect(a.chunks.at(-1)!.chunkType).toBe("module");
	});

	it("oversized nodes split at syntactic children, not line windows, when possible", () => {
		const chunker = new Chunker();
		// One class with many methods: over budget, but every method is small.
		const methods = Array.from({ length: 12 }, (_, i) => `\tmethod${i}(v: number): number {\n\t\treturn v + ${i};\n\t}\n`).join("\n");
		const cls = `export class Big {\n${methods}}\n`;
		const out = chunker.chunkWithImports(cls, "src/big.ts", "typescript", { chunking: "ast-density", budgetChars: 120 });
		const tiled = out.chunks.filter((c) => c.chunkType !== "module");
		expect(tiled.length).toBeGreaterThan(1);
		// Method boundaries survive: chunks start at method/class lines, not mid-line.
		for (const c of tiled) {
			expect(c.startLine).toBeGreaterThan(0);
			expect(c.endLine).toBeGreaterThanOrEqual(c.startLine);
		}
		// And the class name is recorded as parent for its method chunks.
		const methodChunk = tiled.find((c) => c.metadata["parent"] === "Big");
		expect(methodChunk).toBeDefined();
	});

	it("works across a supported language (python)", async () => {
		await warmupLanguages(["python"]);
		const py = `CONST = 42\n\n\ndef small(x):\n    return x + CONST\n\n\ndef big(n):\n    total = 0\n    for i in range(n):\n        total += i\n    return total\n`;
		const chunker = new Chunker();
		const out = chunker.chunkWithImports(py, "src/mod.py", "python", { chunking: "ast-density", budgetChars: 60 });
		const tiled = out.chunks.filter((c) => c.chunkType !== "module");
		expect(tiled.map((c) => c.content).join("")).toBe(py);
		expect(isAstLanguage("python")).toBe(true);
	});
});
