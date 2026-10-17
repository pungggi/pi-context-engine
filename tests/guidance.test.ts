import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
	applyContextSearchGuidance,
	CONTEXT_SEARCH_GUIDELINES,
	CONTEXT_SEARCH_SECTION_KEY,
	type GuidanceTarget,
} from "../src/guidance.js";
import { defaultConfig, loadConfig } from "../src/config.js";
import { makeTempDir, rmrf } from "./helpers.js";

function target(selectedTools: string[]): GuidanceTarget {
	return { selectedTools, sections: {} };
}

describe("applyContextSearchGuidance", () => {
	it("injects the section while context_search is active", () => {
		const options = target(["context_search", "read"]);
		expect(applyContextSearchGuidance(options, true)).toBe(true);
		expect(options.sections[CONTEXT_SEARCH_SECTION_KEY]).toBe(CONTEXT_SEARCH_GUIDELINES);
	});

	it("stays silent when the tool is not selected", () => {
		const options = target(["read", "bash"]);
		expect(applyContextSearchGuidance(options, true)).toBe(false);
		expect(options.sections).toEqual({});
	});

	it("stays silent when the user disabled guidance", () => {
		const options = target(["context_search"]);
		expect(applyContextSearchGuidance(options, false)).toBe(false);
		expect(options.sections).toEqual({});
	});

	it("covers the semantics a user cannot infer from the tool description", () => {
		// Each block exists because the package knows something the generic
		// tool list does not say; if one disappears, users regress to bad
		// queries or stale reads.
		for (const expected of [
			"When to search vs. when not to",
			"Writing effective queries",
			"POOR queries",
			"Reading the results",
			"expand_chunk",
			"Before editing code",
			"Iterative search",
			"Index lifecycle",
			"/context-index",
		]) {
			expect(CONTEXT_SEARCH_GUIDELINES).toContain(expected);
		}
	});

	it("never mentions the retired auggie tool or its auggie-only parameter", () => {
		expect(CONTEXT_SEARCH_GUIDELINES).not.toMatch(/auggie|codebase-retrieval|directory_path/);
	});

	it("injects deterministically (same text every run)", () => {
		const first = target(["context_search"]);
		const second = target(["context_search"]);
		applyContextSearchGuidance(first, true);
		applyContextSearchGuidance(second, true);
		expect(first.sections).toEqual(second.sections);
	});
});

describe("guidance config", () => {
	it("defaults to enabled", () => {
		expect(defaultConfig().guidanceEnabled).toBe(true);
	});

	it("honours guidance.enabled from a project config file", () => {
		const dir = makeTempDir("pce-conf-");
		try {
			fs.writeFileSync(path.join(dir, "config.yaml"), "guidance:\n  enabled: false\n", "utf-8");
			expect(loadConfig(path.join(dir, "missing-global.yaml"), path.join(dir, "config.yaml")).guidanceEnabled).toBe(
				false,
			);
			fs.writeFileSync(path.join(dir, "config.yaml"), "guidance:\n  enabled: true\n", "utf-8");
			expect(loadConfig(path.join(dir, "missing-global.yaml"), path.join(dir, "config.yaml")).guidanceEnabled).toBe(
				true,
			);
		} finally {
			rmrf(dir);
		}
	});

	it("applies the toggle end to end: config off means no section", () => {
		const dir = makeTempDir("pce-conf-");
		try {
			fs.writeFileSync(path.join(dir, "config.yaml"), "guidance:\n  enabled: false\n", "utf-8");
			const config = loadConfig(path.join(dir, "missing-global.yaml"), path.join(dir, "config.yaml"));
			const options = target(["context_search"]);
			expect(applyContextSearchGuidance(options, config.guidanceEnabled)).toBe(false);
		} finally {
			rmrf(dir);
		}
	});
});
