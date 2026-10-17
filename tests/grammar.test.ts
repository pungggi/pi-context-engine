import { describe, expect, it } from "vitest";
import { compress, compressWithCounts, compressionRatio, expand } from "../src/memory/grammar.js";
import { extractDecisions } from "../src/memory/decision-extractor.js";
import { splitSentences, truncationSummary } from "../src/memory/extractive.js";

describe("grammar.compress", () => {
	it("drops articles at lite but keeps structured tokens byte-for-byte", () => {
		const input = "The order is in the `payments.py` file at /src/app and uses v2.1.0";
		const out = compress(input, "lite");
		expect(out).toContain("`payments.py`");
		expect(out).toContain("/src/app");
		expect(out).toContain("v2.1.0");
		expect(out).not.toMatch(/\bthe\b/i);
	});

	it("preserves fenced code blocks exactly", () => {
		const fence = "```js\nconst the = 'a';\n```";
		const input = `The fix is:\n${fence}\nand it is the same`;
		expect(compress(input, "full")).toContain(fence);
	});

	it("is deterministic for the same input and level", () => {
		const input = "We decided to use the JWT token because the cookies were a problem";
		expect(compress(input, "full")).toBe(compress(input, "full"));
	});

	it("abbreviates at ultra and expand() restores them", () => {
		const out = compress("the configuration of the database in production", "ultra");
		expect(out).toContain("config");
		expect(expand(out)).toContain("configuration");
	});

	it("never touches identifiers", () => {
		for (const level of ["lite", "full", "ultra"] as const) {
			expect(compress("call getUserSession and camelCaseThing", level)).toContain("getUserSession");
			expect(compress("call getUserSession and camelCaseThing", level)).toContain("camelCaseThing");
		}
	});

	it("reports counts consistent with the /4 heuristic", () => {
		const { text, rawTokens, compressedTokens } = compressWithCounts("the database of the app", "full");
		expect(rawTokens).toBe(Math.max(1, Math.floor("the database of the app".length / 4)));
		expect(compressedTokens).toBeLessThanOrEqual(rawTokens);
		expect(text.length).toBeLessThan("the database of the app".length);
	});

	it("computes a sane compression ratio", () => {
		expect(compressionRatio("", "x")).toBe(0);
		expect(compressionRatio("abcd", "abcd")).toBe(0);
		expect(compressionRatio("abcd", "ab")).toBeCloseTo(0.5);
	});

	it("returns the input for empty strings", () => {
		expect(compress("", "lite")).toBe("");
		expect(expand("")).toBe("");
	});
});

describe("decision extractor", () => {
	it("extracts decision + reason when a reason clause is present", () => {
		const found = extractDecisions("We chose JWT over cookies because cookies broke mobile logins.");
		expect(found).toHaveLength(1);
		expect(found[0]!.decision.toLowerCase()).toContain("jwt");
		expect(found[0]!.reason.toLowerCase()).toContain("cookies broke mobile");
	});

	it("ignores statements without an explicit reason clause", () => {
		expect(extractDecisions("We use chi as the router for this service.")).toEqual([]);
	});

	it("dedupes repeated decisions", () => {
		const text =
			"We went with Redis because it handles the write volume. Later we went with Redis because it handles the write volume.";
		expect(extractDecisions(text)).toHaveLength(1);
	});
});

describe("extractive helpers", () => {
	it("splits sentences on punctuation and newlines", () => {
		expect(splitSentences("First one. Second one!\nThird one")).toEqual([
			"First one.",
			"Second one!",
			"Third one",
		]);
	});

	it("truncates long text with an ellipsis", () => {
		const out = truncationSummary("x".repeat(300), 100);
		expect(out.length).toBeLessThanOrEqual(100);
		expect(out.endsWith("…")).toBe(true);
	});

	it("returns short text unchanged", () => {
		expect(truncationSummary("short", 100)).toBe("short");
	});
});
