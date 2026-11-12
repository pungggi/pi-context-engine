/**
 * Scanner behind the dashboard's "All pi sessions" table.
 *
 * Lists pi session files across every project directory (the same source
 * pi's own /resume picker scans), then sums the usage entries of the
 * requested page window only — parsing hundreds of session files up front
 * would block the host for seconds on every tab open. Parsed summaries are
 * cached keyed by file mtime+size, so repeated tab opens are O(1) and an
 * active session's growing file is re-summarized automatically.
 *
 * Read-only: listAll() + file reads. Uses the static/cached pricing-free
 * catalog cost recorded inside the session files — no network, no model init.
 */
import { promises as fs } from "node:fs";
import { basename } from "node:path";
import { SessionManager, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { summarizeSessionJsonl, type SessionUsageSummary } from "../session-usage.js";

export interface PiSessionRow {
	id: string;
	/** Project working directory from the session header ("" on old sessions). */
	cwd: string;
	/** Basename of cwd — the display name in the table. */
	project: string;
	name?: string;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
	tokens: number;
	/** Catalog cost from the session's usage entries (0 when none recorded). */
	cost: number;
	cacheHitRate: number | null;
}

export interface PiSessionsPayload {
	total: number;
	offset: number;
	sessions: PiSessionRow[];
}

const PARSE_CONCURRENCY = 8;
const CACHE_CAP = 5000;
const FIRST_MESSAGE_MAX_CHARS = 200;
/** listAll() reads every session file's header to build SessionInfo — on a
 * few hundred sessions that dwarfs our page-window parsing (measured ~2.4 s
 * for 821 files). The list only needs to be fresh enough for a dashboard
 * tab, so cache it briefly and validate per-file mtimes in the summary
 * cache below. */
const LIST_TTL_MS = 30_000;
const listCache = new Map<string, { at: number; infos: SessionInfo[] }>();

/** path → cached summary keyed by mtimeMs:size, insertion-ordered LRU-ish. */
const summaryCache = new Map<string, { key: string; summary: SessionUsageSummary }>();

const emptySummary = (): SessionUsageSummary => ({
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
});

const statKey = async (filePath: string): Promise<string> => {
	const st = await fs.stat(filePath);
	return `${Math.round(st.mtimeMs)}:${st.size}`;
};

async function summarizeFile(filePath: string): Promise<SessionUsageSummary> {
	const key = await statKey(filePath);
	const cached = summaryCache.get(filePath);
	if (cached && cached.key === key) return cached.summary;
	const content = await fs.readFile(filePath, "utf8");
	const summary = summarizeSessionJsonl(content);
	if (!summaryCache.has(filePath) && summaryCache.size >= CACHE_CAP) {
		const oldest = summaryCache.keys().next().value;
		if (oldest !== undefined) summaryCache.delete(oldest);
	}
	summaryCache.set(filePath, { key, summary });
	return summary;
}

const toRow = (info: SessionInfo, summary: SessionUsageSummary): PiSessionRow => ({
	id: info.id,
	cwd: info.cwd ?? "",
	project: info.cwd ? basename(info.cwd) : "(unknown project)",
	name: info.name,
	created: info.created instanceof Date && !Number.isNaN(info.created.getTime()) ? info.created.toISOString() : "",
	modified: info.modified instanceof Date && !Number.isNaN(info.modified.getTime()) ? info.modified.toISOString() : "",
	messageCount: info.messageCount ?? 0,
	firstMessage: (info.firstMessage ?? "").slice(0, FIRST_MESSAGE_MAX_CHARS),
	tokens: summary.totalTokens,
	cost: summary.cost,
	cacheHitRate: summary.latestCacheHitRate,
});

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index]!);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
	return results;
}

/** One page of pi sessions across all projects, most recently active first
 * (listAll's own ordering). `root` overrides pi's default sessions directory
 * (tests); cost/tokens are parsed only for the visible window. */
export async function listPiSessions(root: string | undefined, limit = 100, offset = 0): Promise<PiSessionsPayload> {
	const cacheKey = root ?? "";
	let infos: SessionInfo[];
	const cachedList = listCache.get(cacheKey);
	if (cachedList && Date.now() - cachedList.at < LIST_TTL_MS) {
		infos = cachedList.infos;
	} else {
		infos = await SessionManager.listAll(root);
		if (!listCache.has(cacheKey) && listCache.size >= 8) {
			const oldest = listCache.keys().next().value;
			if (oldest !== undefined) listCache.delete(oldest);
		}
		listCache.set(cacheKey, { at: Date.now(), infos });
	}
	const start = Math.max(0, Math.min(Math.floor(offset) || 0, infos.length));
	const size = Math.max(1, Math.min(Math.floor(limit) || 100, 500));
	const window = infos.slice(start, start + size);
	const rows = await mapLimited(window, PARSE_CONCURRENCY, async (info) => {
		let summary: SessionUsageSummary;
		try {
			summary = await summarizeFile(info.path);
		} catch {
			summary = emptySummary();
		}
		return toRow(info, summary);
	});
	return { total: infos.length, offset: start, sessions: rows };
}
