/**
 * Read-only JSON snapshots for the web dashboard.
 *
 * Every function here is a pure reader over the engine's stores: no writes,
 * no savings accounting, no embedder/model initialization (a dashboard
 * refresh must never trigger a model download). Dollar estimates use the
 * static/cached pricing table only — resolvePricing(config, false).
 */
import type { ContextEngine } from "../engine.js";
import { resolvePricing } from "../pricing.js";

export interface ExtDashboardState {
	/** True while a background (auto/watcher) index run is in flight. */
	indexing: boolean;
}

const num = (n: number): number => Math.max(0, Math.floor(n || 0));

/** Cheap overview: index size, config summary and savings aggregates. No
 * pricing resolution, no model init — polled every few seconds. */
export function statusPayload(eng: ContextEngine, ext: ExtDashboardState) {
	const stats = eng.getStats();
	let fileCounts: Record<string, number> = {};
	try {
		fileCounts = eng.backend.fileChunkCounts();
	} catch {
		// index stores may not exist yet
	}
	const saved = num(stats.rawTokens - stats.servedTokens);
	const fullSaved = num(stats.fullFileTokens - stats.servedTokens);
	return {
		project: eng.projectName,
		projectDir: eng.projectDir,
		storageDir: eng.storageBase,
		sessionId: eng.sessionId,
		chunks: eng.chunkCount(),
		files: Object.keys(fileCounts).length,
		indexing: ext.indexing,
		config: {
			embeddingModel: eng.config.embeddingModel,
			topK: eng.config.retrievalTopK,
			rerank: eng.config.retrievalRerank,
			chunking: eng.config.indexerChunking,
			autoIndex: eng.config.indexerAutoIndex,
			watch: eng.config.indexerWatch,
			compression: eng.config.compressionLevel,
		},
		stats: {
			queries: stats.queries,
			rawTokens: stats.rawTokens,
			servedTokens: stats.servedTokens,
			fullFileTokens: stats.fullFileTokens,
			tokensSaved: saved,
			fullFileTokensSaved: fullSaved,
			savingsPct: stats.fullFileTokens > 0 ? Math.floor((fullSaved / stats.fullFileTokens) * 100) : null,
		},
	};
}

/** Bucket ledger + dollar estimates + per-day trend. Never fetches live
 * pricing: the dashboard must stay offline-safe. */
export async function savingsPayload(eng: ContextEngine) {
	const { label, pricing } = await resolvePricing(eng.config, false);
	const buckets: Record<string, { baseline: number; served: number; calls: number }> = eng.aggregateSavings() ?? {};
	const toUsd = (tokens: number): number => (tokens / 1e6) * pricing.input;
	const rows = Object.entries(buckets)
		.map(([bucket, v]) => ({
			bucket,
			calls: v.calls,
			baseline: v.baseline,
			served: v.served,
			saved: num(v.baseline - v.served),
			savedUsd: toUsd(num(v.baseline - v.served)),
		}))
		.sort((a, b) => b.saved - a.saved);
	let memory = null;
	try {
		memory = eng.getMemory();
	} catch {
		memory = null;
	}
	const byDay = (memory?.savingsByDay(30) ?? []).map((d) => ({
		day: d.day,
		saved: num(d.baseline - d.served),
	}));
	const stats = eng.getStats();
	const fullSaved = num(stats.fullFileTokens - stats.servedTokens);
	return {
		pricing: { model: label, inputUsdPer1M: pricing.input, outputUsdPer1M: pricing.output },
		totals: {
			savedTokens: fullSaved,
			savedUsd: toUsd(fullSaved),
			savingsPct: stats.fullFileTokens > 0 ? Math.floor((fullSaved / stats.fullFileTokens) * 100) : null,
		},
		buckets: rows,
		byDay,
	};
}

/** Indexed files with chunk counts, largest first. */
export function filesPayload(eng: ContextEngine, limit = 500) {
	let counts: Record<string, number> = {};
	try {
		counts = eng.backend.fileChunkCounts();
	} catch {
		// no index yet
	}
	const rows = Object.entries(counts)
		.map(([filePath, chunks]) => ({ filePath, chunks }))
		.sort((a, b) => b.chunks - a.chunks || a.filePath.localeCompare(b.filePath));
	return {
		total: rows.length,
		chunks: rows.reduce((acc, r) => acc + r.chunks, 0),
		files: rows.slice(0, Math.max(1, Math.min(limit, 5000))),
	};
}

export function sessionsPayload(eng: ContextEngine, limit = 50) {
	const memory = eng.getMemory();
	return {
		sessions: memory ? memory.listSessions(limit) : [],
		// JSON snapshots (SessionCapture) survive memory-db failures and carry
		// decisions/code areas even when SQLite is unavailable.
		activeSessionId: eng.sessionId,
	};
}

export function timelinePayload(eng: ContextEngine, sessionId: string) {
	const memory = eng.getMemory();
	if (!memory) return { session: null, turns: [], events: [] };
	const meta = memory.listSessions(500).find((s) => s.id === sessionId) ?? null;
	const detail = memory.sessionDetail(sessionId);
	return { session: meta, turns: detail.turns, events: detail.events };
}

export function decisionsPayload(eng: ContextEngine, limit = 100) {
	const memory = eng.getMemory();
	return {
		decisions: memory?.listDecisions(limit) ?? [],
		codeAreas: memory?.listCodeAreas(limit) ?? [],
		consolidated: eng.sessionCapture.loadConsolidatedDecisions().slice(0, limit),
	};
}

/** Everything, for /api/export. */
export async function exportPayload(eng: ContextEngine, ext: ExtDashboardState) {
	return {
		generatedAt: new Date().toISOString(),
		status: statusPayload(eng, ext),
		savings: await savingsPayload(eng),
		files: filesPayload(eng),
		sessions: sessionsPayload(eng),
		decisions: decisionsPayload(eng),
	};
}
