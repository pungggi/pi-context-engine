/**
 * Background turn/session compression — port of upstream
 * `memory/compressor.py` (MIT). Extractive summary → PII scrub → grammar
 * compress, with auto decision extraction and savings accounting.
 */
import { epochSeconds } from "../utils.js";
import { extractDecisions } from "./decision-extractor.js";
import { extractiveSummary, truncationSummary } from "./extractive.js";
import { compressWithCounts, DEFAULT_LEVEL } from "./grammar.js";
import { scrubPii, type MemoryDb } from "./db.js";
import type { Embedder } from "../indexer/embedder.js";

const DEFAULT_TURN_TOP_K = 3;
const DEFAULT_ROLLUP_TOP_K = 5;
const TOOL_OUTPUT_CHAR_CAP = 1500;
const TOOL_INPUT_CHAR_CAP = 4000;
const MAX_ATTEMPTS = 5;

function approxTokens(text: string): number {
	return text ? Math.max(1, Math.floor(text.length / 4)) : 0;
}

export interface CompressionDeps {
	memory: MemoryDb;
	embedder: Embedder;
}

/** Concatenate prompt + tool inputs/outputs into one text blob. */
function buildTurnText(memory: MemoryDb, sessionId: string, promptNumber: number): string {
	const parts: string[] = [];
	const prompt = memory.db
		.prepare("SELECT prompt_text FROM prompts WHERE session_id = ? AND prompt_number = ?")
		.get(sessionId, promptNumber) as { prompt_text: string } | undefined;
	if (prompt?.prompt_text) parts.push(`User: ${prompt.prompt_text}`);

	const events = memory.db
		.prepare(
			`SELECT te.tool_name, p.raw_input, p.raw_output
			 FROM tool_events te
			 LEFT JOIN tool_event_payloads p ON p.id = te.payload_id
			 WHERE te.session_id = ? AND te.prompt_number = ?
			 ORDER BY te.id ASC`,
		)
		.all(sessionId, promptNumber) as { tool_name: string; raw_input: string | null; raw_output: string | null }[];

	for (const ev of events) {
		parts.push(describeInput(ev.tool_name, ev.raw_input ?? ""));
		const out = (ev.raw_output ?? "").trim();
		if (out) parts.push(out.length > TOOL_OUTPUT_CHAR_CAP ? out.slice(0, TOOL_OUTPUT_CHAR_CAP) + "…" : out);
	}
	return parts.join("\n");
}

/** One-line descriptor of a tool invocation for the summary candidates. */
export function describeInput(toolName: string, rawInput: string): string {
	if (!rawInput) return toolName;
	if (rawInput.length > TOOL_INPUT_CHAR_CAP) return `${toolName}: ${rawInput.slice(0, 120)}`;
	let data: unknown;
	try {
		data = JSON.parse(rawInput);
	} catch {
		return `${toolName}: ${rawInput.slice(0, 120)}`;
	}
	if (!data || typeof data !== "object" || Array.isArray(data)) return `${toolName}: ${rawInput.slice(0, 120)}`;
	const record = data as Record<string, unknown>;
	for (const key of ["file_path", "path", "command", "pattern", "query"]) {
		const value = record[key];
		if (value) return `${toolName} ${key}=${String(value)}`;
	}
	const keys = Object.keys(record).slice(0, 2);
	return `${toolName} ${keys.join(",")}`;
}

async function summarise(
	text: string,
	embedder: Embedder,
	topK: number,
): Promise<{ summary: string; tier: string }> {
	if (!text.trim()) return { summary: "", tier: "empty" };
	try {
		const out = await extractiveSummary(text, embedder, topK);
		return { summary: out, tier: "extractive" };
	} catch {
		return { summary: truncationSummary(text), tier: "truncation" };
	}
}

/** Compute + persist one turn summary. Returns the stored (compressed) summary. */
export async function compressTurn(
	deps: CompressionDeps,
	sessionId: string,
	promptNumber: number,
): Promise<string> {
	const { memory, embedder } = deps;
	const text = buildTurnText(memory, sessionId, promptNumber);
	const rawTokens = approxTokens(text);
	const { summary: extractive, tier } = await summarise(text, embedder, DEFAULT_TURN_TOP_K);
	const extractiveTokens = approxTokens(extractive);

	let summary = "";
	let gramRaw = 0;
	let gramComp = 0;
	if (extractive) {
		const scrubbed = scrubPii(extractive);
		const compressed = compressWithCounts(scrubbed, DEFAULT_LEVEL);
		summary = compressed.text;
		gramRaw = compressed.rawTokens;
		gramComp = compressed.compressedTokens;
	}

	// Explicit DELETE-then-INSERT: SQLite only fires delete triggers on a
	// REPLACE conflict when recursive_triggers is ON, so OR REPLACE would
	// leave dangling FTS/vec rows.
	memory.db
		.prepare("DELETE FROM turn_summaries WHERE session_id = ? AND prompt_number = ?")
		.run(sessionId, promptNumber);
	const result = memory.db
		.prepare(
			"INSERT INTO turn_summaries (session_id, prompt_number, summary, tier, created_at_epoch) VALUES (?, ?, ?, ?, ?)",
		)
		.run(sessionId, promptNumber, summary, tier, epochSeconds());
	const turnId = Number(result.lastInsertRowid);

	if (summary) {
		await autoCaptureDecisions(deps, summary, sessionId);
		await memory.recordTurnSummaryVec(embedder, turnId, summary);
	}
	if (summary && gramRaw > 0) {
		memory.recordSavings("grammar", gramRaw, gramComp);
	}
	if (rawTokens > 0 && extractiveTokens > 0) {
		memory.recordSavings("turn_summarization", rawTokens, extractiveTokens, { kind: "turn", tier });
	}
	return summary;
}

/** Compute + persist the session rollup summary from existing turn summaries. */
export async function compressSessionRollup(deps: CompressionDeps, sessionId: string): Promise<string> {
	const { memory, embedder } = deps;
	const rows = memory.db
		.prepare("SELECT summary FROM turn_summaries WHERE session_id = ? ORDER BY prompt_number ASC")
		.all(sessionId) as { summary: string }[];
	const text = rows.map((r) => r.summary).filter(Boolean).join("\n");
	const rawTokens = approxTokens(text);

	let rollup = "";
	let tier = "empty";
	let gramRaw = 0;
	let gramComp = 0;
	let extractiveTokens = 0;
	if (text) {
		const summarised = await summarise(text, embedder, DEFAULT_ROLLUP_TOP_K);
		tier = summarised.tier;
		extractiveTokens = approxTokens(summarised.summary);
		const compressed = compressWithCounts(scrubPii(summarised.summary), DEFAULT_LEVEL);
		rollup = compressed.text;
		gramRaw = compressed.rawTokens;
		gramComp = compressed.compressedTokens;
	}

	memory.db
		.prepare("UPDATE sessions SET rollup_summary = ?, rollup_summary_at_epoch = ? WHERE id = ?")
		.run(rollup, epochSeconds(), sessionId);

	if (gramRaw > 0) memory.recordSavings("grammar", gramRaw, gramComp);
	if (rawTokens > 0 && extractiveTokens > 0) {
		memory.recordSavings("turn_summarization", rawTokens, extractiveTokens, { kind: "session_rollup", tier });
	}
	return rollup;
}

async function autoCaptureDecisions(
	deps: CompressionDeps,
	summary: string,
	sessionId: string,
): Promise<number> {
	const { memory, embedder } = deps;
	const decisions = extractDecisions(summary);
	if (decisions.length === 0) return 0;

	const existing = new Set(
		(
			memory.db
				.prepare("SELECT decision FROM decisions WHERE session_id = ? AND source = 'auto'")
				.all(sessionId) as { decision: string }[]
		).map((r) => r.decision.toLowerCase()),
	);

	const epoch = epochSeconds();
	const createdAt = new Date(epoch * 1000).toISOString();
	let count = 0;
	for (const { decision, reason } of decisions) {
		if (existing.has(decision.toLowerCase())) continue;
		const result = memory.db
			.prepare(
				"INSERT INTO decisions (session_id, decision, reason, source, created_at_epoch, created_at) VALUES (?, ?, ?, 'auto', ?, ?)",
			)
			.run(sessionId, decision, reason, epoch, createdAt);
		existing.add(decision.toLowerCase());
		count++;
		await memory.recordDecisionVec(embedder, Number(result.lastInsertRowid), decision, reason);
	}
	return count;
}

/** Pop and process the oldest pending row below the attempt cap. */
export async function drainOne(deps: CompressionDeps): Promise<boolean> {
	const { memory } = deps;
	const row = memory.db
		.prepare(
			"SELECT id, kind, session_id, prompt_number, attempts FROM pending_compressions WHERE attempts < ? ORDER BY enqueued_at_epoch ASC LIMIT 1",
		)
		.get(MAX_ATTEMPTS) as
		| { id: number; kind: string; session_id: string; prompt_number: number | null; attempts: number }
		| undefined;
	if (!row) return false;
	try {
		if (row.kind === "turn" && row.prompt_number !== null) {
			await compressTurn(deps, row.session_id, row.prompt_number);
		} else {
			await compressSessionRollup(deps, row.session_id);
		}
		memory.db.prepare("DELETE FROM pending_compressions WHERE id = ?").run(row.id);
	} catch (err) {
		memory.db
			.prepare("UPDATE pending_compressions SET attempts = attempts + 1, last_error = ? WHERE id = ?")
			.run(String((err as Error).message).slice(0, 500), row.id);
	}
	return true;
}

export function enqueueTurn(memory: MemoryDb, sessionId: string, promptNumber: number): void {
	try {
		memory.db
			.prepare(
				"INSERT OR IGNORE INTO pending_compressions (kind, session_id, prompt_number, enqueued_at_epoch) VALUES ('turn', ?, ?, ?)",
			)
			.run(sessionId, promptNumber, epochSeconds());
	} catch {
		// queueing is best-effort
	}
}

export function enqueueSessionRollup(memory: MemoryDb, sessionId: string): void {
	try {
		memory.db
			.prepare(
				"INSERT OR IGNORE INTO pending_compressions (kind, session_id, prompt_number, enqueued_at_epoch) VALUES ('session_rollup', ?, 0, ?)",
			)
			.run(sessionId, epochSeconds());
	} catch {
		// best effort
	}
}
