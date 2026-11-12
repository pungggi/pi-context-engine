/**
 * Session usage accounting — tokens, cost, and per-model attribution.
 *
 * Mirrors pi's own aggregation (AgentSession.getSessionStats / the footer):
 * usage rides assistant messages, tool results from nested LLM calls, usage
 * entries (e.g. cache warming) and compaction/branch-summary generation, so
 * totals reflect what was actually billed across the session rather than
 * only what is still in context.
 *
 * Pure and structural: no pi imports, tolerant of missing/older `usage`
 * shapes, so the same code serves the TUI command and the dashboard scanner.
 */

export interface UsageLike {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
	} | null;
}

/** Structural subset of pi's SessionEntry we read usage from. */
export interface SessionEntryLike {
	type: string;
	/** `message` entries only. */
	message?: {
		role: string;
		usage?: UsageLike | null;
		provider?: string;
		model?: string;
		content?: unknown;
	};
	/** `usage` entries carry a category such as "cache_warm". */
	kind?: string;
	/** `usage`, `compaction` and `branch_summary` entries. */
	usage?: UsageLike | null;
	provider?: string;
	model?: string;
}

export interface ModelUsage {
	tokens: number;
	cost: number;
}

export interface SessionUsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** input + cacheRead + cacheWrite — the prompt volume of the last request. */
	promptTokens: number;
	/** All four token kinds combined. */
	totalTokens: number;
	/** Catalog cost summed from usage.cost.total (0 when a provider reports none). */
	cost: number;
	userMessages: number;
	assistantMessages: number;
	toolResults: number;
	toolCalls: number;
	/** Cache hit percentage of the most recent assistant request, null before the first one. */
	latestCacheHitRate: number | null;
	/** Cost/tokens keyed by `provider/model`; unattributed usage lands in `(other)`. */
	byModel: Record<string, ModelUsage>;
}

const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/** Standard provider multipliers for the estimate fallback: cache reads bill
 * at ~10% of the input rate, cache writes at ~125% (Anthropic convention,
 * close enough for an explicitly-labeled estimate). */
const CACHE_READ_RATE = 0.1;
const CACHE_WRITE_RATE = 1.25;

export function estimateCost(
	summary: Pick<SessionUsageSummary, "input" | "output" | "cacheRead" | "cacheWrite">,
	pricing: { input: number; output: number },
): number {
	const promptCost =
		((n(summary.input) + n(summary.cacheRead) * CACHE_READ_RATE + n(summary.cacheWrite) * CACHE_WRITE_RATE) / 1e6) *
		pricing.input;
	return promptCost + (n(summary.output) / 1e6) * pricing.output;
}

/** Shared mutable accumulator for both entry-list and raw-JSONL inputs. */
interface UsageAccumulator extends SessionUsageSummary {
	byModelMap: Map<string, ModelUsage>;
	/** Prompt tokens (input+cacheRead+cacheWrite) of the newest assistant message. */
	lastPromptTokens: number;
}

const createAccumulator = (): UsageAccumulator => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	promptTokens: 0,
	totalTokens: 0,
	cost: 0,
	userMessages: 0,
	assistantMessages: 0,
	toolResults: 0,
	toolCalls: 0,
	latestCacheHitRate: null,
	byModel: {},
	byModelMap: new Map(),
	lastPromptTokens: 0,
});

function attribute(acc: UsageAccumulator, usage: UsageLike, provider?: string, model?: string): void {
	const input = n(usage.input);
	const output = n(usage.output);
	const cacheRead = n(usage.cacheRead);
	const cacheWrite = n(usage.cacheWrite);
	acc.input += input;
	acc.output += output;
	acc.cacheRead += cacheRead;
	acc.cacheWrite += cacheWrite;
	const cost = n(usage.cost?.total);
	acc.cost += cost;
	const tokens = input + output + cacheRead + cacheWrite;
	const key = provider && model ? `${provider}/${model}` : "(other)";
	const bucket = acc.byModelMap.get(key) ?? { tokens: 0, cost: 0 };
	bucket.tokens += tokens;
	bucket.cost += cost;
	acc.byModelMap.set(key, bucket);
}

function finalize(acc: UsageAccumulator): SessionUsageSummary {
	acc.promptTokens = acc.input + acc.cacheRead + acc.cacheWrite;
	acc.totalTokens = acc.promptTokens + acc.output;
	acc.byModel = Object.fromEntries([...acc.byModelMap.entries()].sort((a, b) => b[1].cost - a[1].cost));
	const copy: UsageAccumulator = { ...acc };
	delete (copy as { byModelMap?: Map<string, ModelUsage> }).byModelMap;
	delete (copy as { lastPromptTokens?: number }).lastPromptTokens;
	return copy;
}

/** Aggregate a session's entries exactly like pi's /session footer accounting. */
export function summarizeSessionUsage(entries: readonly SessionEntryLike[]): SessionUsageSummary {
	const acc = createAccumulator();
	for (const entry of entries) {
		if (entry.type === "usage") {
			attribute(acc, entry.usage ?? {}, entry.provider, entry.model);
			continue;
		}
		if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
			attribute(acc, entry.usage);
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!message) continue;
		if (message.role === "user") {
			acc.userMessages++;
		} else if (message.role === "assistant") {
			acc.assistantMessages++;
			const usage = message.usage ?? {};
			attribute(acc, usage, message.provider, message.model);
			const promptTokens = n(usage.input) + n(usage.cacheRead) + n(usage.cacheWrite);
			if (promptTokens > 0) {
				acc.lastPromptTokens = promptTokens;
				acc.latestCacheHitRate = (n(usage.cacheRead) / promptTokens) * 100;
			}
			if (Array.isArray(message.content)) {
				acc.toolCalls += message.content.filter(
					(block) => typeof block === "object" && block !== null && (block as { type?: string }).type === "toolCall",
				).length;
			}
		} else if (message.role === "toolResult") {
			acc.toolResults++;
			// Nested-call usage has no model attribution of its own.
			if (message.usage) attribute(acc, message.usage);
		}
	}
	return finalize(acc);
}

/** Aggregate a raw session .jsonl (pi session-file format). Tolerant:
 * unknown/garbage lines are skipped, usage-bearing entry types are the same
 * set pi itself sums. */
export function summarizeSessionJsonl(content: string): SessionUsageSummary {
	const acc = createAccumulator();
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (typeof parsed !== "object" || parsed === null) continue;
		const entry = parsed as SessionEntryLike;
		if (entry.type === "usage") {
			attribute(acc, entry.usage ?? {}, entry.provider, entry.model);
		} else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
			attribute(acc, entry.usage);
		} else if (entry.type === "message" && entry.message) {
			const message = entry.message;
			if (message.role === "user") {
				acc.userMessages++;
			} else if (message.role === "assistant") {
				acc.assistantMessages++;
				const usage = message.usage ?? {};
				attribute(acc, usage, message.provider, message.model);
				const promptTokens = n(usage.input) + n(usage.cacheRead) + n(usage.cacheWrite);
				if (promptTokens > 0) {
					acc.lastPromptTokens = promptTokens;
					acc.latestCacheHitRate = (n(usage.cacheRead) / promptTokens) * 100;
				}
				if (Array.isArray(message.content)) {
					acc.toolCalls += message.content.filter(
						(block: unknown) =>
							typeof block === "object" && block !== null && (block as { type?: string }).type === "toolCall",
						).length;
				}
			} else if (message.role === "toolResult") {
				acc.toolResults++;
				if (message.usage) attribute(acc, message.usage);
			}
		}
	}
	return finalize(acc);
}

/** Estimated session cost at the given rates; used when the provider reports
 * no catalog cost (usage.cost.total stays 0 across the session). */
export function estimateSessionCost(summary: SessionUsageSummary, pricing: { input: number; output: number }): number {
	return estimateCost(summary, pricing);
}
