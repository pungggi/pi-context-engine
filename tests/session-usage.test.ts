import { describe, expect, it } from "vitest";
import {
	estimateSessionCost,
	summarizeSessionJsonl,
	summarizeSessionUsage,
	type SessionEntryLike,
} from "../src/session-usage.js";

const usage = (over: Record<string, unknown> = {}) => ({
	input: 100,
	output: 20,
	cacheRead: 800,
	cacheWrite: 50,
	totalTokens: 970,
	cost: { input: 0.001, output: 0.001, cacheRead: 0.002, cacheWrite: 0.0005, total: 0.0035 },
	...over,
});

const assistantEntry = (model: string, u: Record<string, unknown> = {}, toolCalls = 0): SessionEntryLike => ({
	type: "message",
	message: {
		role: "assistant",
		provider: "anthropic",
		model,
		usage: usage(u),
		content: Array.from({ length: toolCalls }, () => ({ type: "toolCall" })),
	},
});

describe("summarizeSessionUsage", () => {
	it("sums assistant usage and counts messages/tool calls", () => {
		const s = summarizeSessionUsage([
			{ type: "message", message: { role: "user" } },
			assistantEntry("claude-opus-4-7", {}, 2),
			assistantEntry("claude-opus-4-7", {}, 1),
		]);
		expect(s.userMessages).toBe(1);
		expect(s.assistantMessages).toBe(2);
		expect(s.toolCalls).toBe(3);
		expect(s.input).toBe(200);
		expect(s.output).toBe(40);
		expect(s.cacheRead).toBe(1600);
		expect(s.cacheWrite).toBe(100);
		expect(s.promptTokens).toBe((100 + 800 + 50) * 2); // (input+cacheRead+cacheWrite) per assistant message
		expect(s.totalTokens).toBe(s.promptTokens + s.output);
		expect(s.cost).toBeCloseTo(0.007, 6);
	});

	it("includes toolResult (nested-call) usage and usage entries with attribution", () => {
		const s = summarizeSessionUsage([
			assistantEntry("claude-opus-4-7"),
			{
				type: "message",
				message: { role: "toolResult", usage: usage({ cost: { total: 0.01 } }) },
			},
			{ type: "usage", provider: "anthropic", model: "claude-opus-4-7", usage: usage() },
		]);
		expect(s.toolResults).toBe(1);
		expect(s.cost).toBeCloseTo(0.0035 + 0.01 + 0.0035, 6);
		expect(s.byModel["anthropic/claude-opus-4-7"]!.cost).toBeCloseTo(0.0035 * 2, 6);
	});

	it("attributes compaction and branch_summary usage without a model", () => {
		const s = summarizeSessionUsage([
			{ type: "compaction", usage: usage({ cost: { total: 0.05 } }) },
			{ type: "branch_summary", usage: usage({ cost: { total: 0.02 } }) },
		]);
		expect(s.cost).toBeCloseTo(0.07, 6);
		expect(s.byModel["(other)"]!.cost).toBeCloseTo(0.07, 6);
	});

	it("latestCacheHitRate follows the newest assistant message only", () => {
		const s = summarizeSessionUsage([
			assistantEntry("m", { cacheRead: 400 }), // 400/550 ≈ 72.7%
			assistantEntry("m", { cacheRead: 900 }), // 900/1050 ≈ 85.7%
		]);
		expect(s.latestCacheHitRate).toBeCloseTo((900 / 1050) * 100, 5);
	});

	it("is tolerant of missing usage and malformed content blocks", () => {
		const s = summarizeSessionUsage([
			{ type: "message", message: { role: "assistant", content: "plain string", usage: null } },
			{ type: "message", message: { role: "assistant", usage: { input: -5, cost: null } } },
			{ type: "message", message: { role: "toolResult" } },
			{ type: "custom" },
		]);
		expect(s.assistantMessages).toBe(2);
		expect(s.toolResults).toBe(1);
		expect(s.cost).toBe(0);
		expect(s.totalTokens).toBe(0);
		expect(s.latestCacheHitRate).toBeNull();
	});
});

describe("summarizeSessionJsonl", () => {
	const lines = (entries: unknown[]): string =>
		[
			JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "t", cwd: "C:\\proj" }),
			...entries.map((e) => JSON.stringify(e)),
			"not json at all {{{",
			"",
		].join("\n");

	it("matches the entry-list summarizer on the same data", () => {
		const entries: SessionEntryLike[] = [
			{ type: "message", message: { role: "user" } },
			assistantEntry("claude-opus-4-7", {}, 1),
			{ type: "message", message: { role: "toolResult", usage: usage({ total: 0.01 }) } },
			{ type: "usage", kind: "cache_warm", provider: "anthropic", model: "claude-opus-4-7", usage: usage() },
			{ type: "compaction", usage: usage({ total: 0.05 }) },
			assistantEntry("other-model", { cacheRead: 900 }),
		];
		const fromEntries = summarizeSessionUsage(entries);
		const fromJsonl = summarizeSessionJsonl(lines(entries));
		expect(fromJsonl).toEqual(fromEntries);
	});

	it("returns an all-zero summary for empty or garbage input", () => {
		for (const content of ["", "{}", "[1,2]", lines([])]) {
			const s = summarizeSessionJsonl(content);
			expect(s.totalTokens).toBe(0);
			expect(s.cost).toBe(0);
			expect(s.userMessages).toBe(0);
		}
	});
});

describe("estimateSessionCost", () => {
	it("prices prompt volume with cache multipliers plus output", () => {
		const s = summarizeSessionUsage([assistantEntry("m")]);
		// 100 in + 800*0.1 + 50*1.25 = 242.5 prompt-equivalents; opus = 15/1M in, 75/1M out
		const est = estimateSessionCost(s, { input: 15, output: 75 });
		expect(est).toBeCloseTo((242.5 / 1e6) * 15 + (20 / 1e6) * 75, 8);
	});
});
