/**
 * Per-project memory.db — port of upstream `memory/db.py` (MIT), schema v4
 * (minus `migrated_files`, which only served upstream's session-file import).
 * Schema is enforced idempotently on every open (no version-step migrations),
 * so databases from any earlier release converge to the current shape in place.
 * Synchronous better-sqlite3; vec tables degrade to FTS-only when the
 * sqlite-vec extension can't load.
 */
import fs from "node:fs";
import path from "node:path";
import { openDatabase, type SqliteHandle } from "../sqlite.js";
import { batchedParams, epochSeconds } from "../utils.js";
import { redactPii } from "../indexer/secrets.js";
import type { Embedder } from "../indexer/embedder.js";

export const CURRENT_VERSION = 4;
const VEC_DIM = 384; // bootstrap dim; rebuilt automatically on mismatch

/** Canonical savings buckets — keep in sync with the savings renderer. */
export const BUCKETS = [
	"retrieval",
	"chunk_compression",
	"output_compression",
	"memory_recall",
	"grammar",
	"turn_summarization",
	"progressive_disclosure",
] as const;
export type Bucket = (typeof BUCKETS)[number];

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  started_at_epoch INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at_epoch INTEGER,
  ended_at TEXT,
  exit_reason TEXT,
  prompt_count INTEGER DEFAULT 0,
  status TEXT CHECK(status IN ('active','completed','failed')) NOT NULL DEFAULT 'active',
  rollup_summary TEXT,
  rollup_summary_at_epoch INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at_epoch DESC);

CREATE TABLE IF NOT EXISTS prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  prompt_number INTEGER NOT NULL,
  prompt_text TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, prompt_number)
);
CREATE INDEX IF NOT EXISTS idx_prompts_session ON prompts(session_id, prompt_number);

CREATE TABLE IF NOT EXISTS tool_event_payloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_input TEXT NOT NULL,
  raw_output TEXT,
  size_bytes INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tool_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  prompt_number INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  payload_id INTEGER REFERENCES tool_event_payloads(id) ON DELETE SET NULL,
  summary TEXT,
  created_at_epoch INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session_turn ON tool_events(session_id, prompt_number);

CREATE TABLE IF NOT EXISTS turn_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  prompt_number INTEGER NOT NULL,
  summary TEXT NOT NULL,
  tier TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  UNIQUE(session_id, prompt_number)
);

CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('manual','migrated','auto')) DEFAULT 'manual',
  created_at_epoch INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_decisions_created ON decisions(created_at_epoch DESC);
CREATE INDEX IF NOT EXISTS idx_decisions_source ON decisions(source);

CREATE TABLE IF NOT EXISTS code_areas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  file_path TEXT NOT NULL,
  description TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('manual','migrated','auto')) DEFAULT 'manual',
  created_at_epoch INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_code_areas_file ON code_areas(file_path);

CREATE TABLE IF NOT EXISTS pending_compressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('turn','session_rollup')),
  session_id TEXT NOT NULL,
  prompt_number INTEGER,
  enqueued_at_epoch INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  UNIQUE(kind, session_id, prompt_number)
);

CREATE VIRTUAL TABLE IF NOT EXISTS prompts_fts USING fts5(prompt_text, content='prompts', content_rowid='id');
CREATE VIRTUAL TABLE IF NOT EXISTS decisions_fts USING fts5(decision, reason, content='decisions', content_rowid='id');
CREATE VIRTUAL TABLE IF NOT EXISTS turn_summaries_fts USING fts5(summary, content='turn_summaries', content_rowid='id');

CREATE TRIGGER IF NOT EXISTS prompts_ai AFTER INSERT ON prompts BEGIN
  INSERT INTO prompts_fts(rowid, prompt_text) VALUES (new.id, new.prompt_text);
END;
CREATE TRIGGER IF NOT EXISTS prompts_ad AFTER DELETE ON prompts BEGIN
  INSERT INTO prompts_fts(prompts_fts, rowid, prompt_text) VALUES('delete', old.id, old.prompt_text);
END;
CREATE TRIGGER IF NOT EXISTS prompts_au AFTER UPDATE ON prompts BEGIN
  INSERT INTO prompts_fts(prompts_fts, rowid, prompt_text) VALUES('delete', old.id, old.prompt_text);
  INSERT INTO prompts_fts(rowid, prompt_text) VALUES (new.id, new.prompt_text);
END;

CREATE TRIGGER IF NOT EXISTS decisions_ai AFTER INSERT ON decisions BEGIN
  INSERT INTO decisions_fts(rowid, decision, reason) VALUES (new.id, new.decision, new.reason);
END;
CREATE TRIGGER IF NOT EXISTS decisions_ad AFTER DELETE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, decision, reason) VALUES('delete', old.id, old.decision, old.reason);
END;
CREATE TRIGGER IF NOT EXISTS decisions_au AFTER UPDATE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, decision, reason) VALUES('delete', old.id, old.decision, old.reason);
  INSERT INTO decisions_fts(rowid, decision, reason) VALUES (new.id, new.decision, new.reason);
END;

CREATE TRIGGER IF NOT EXISTS turn_summaries_ai AFTER INSERT ON turn_summaries BEGIN
  INSERT INTO turn_summaries_fts(rowid, summary) VALUES (new.id, new.summary);
END;
CREATE TRIGGER IF NOT EXISTS turn_summaries_ad AFTER DELETE ON turn_summaries BEGIN
  INSERT INTO turn_summaries_fts(turn_summaries_fts, rowid, summary) VALUES('delete', old.id, old.summary);
END;
CREATE TRIGGER IF NOT EXISTS turn_summaries_au AFTER UPDATE ON turn_summaries BEGIN
  INSERT INTO turn_summaries_fts(turn_summaries_fts, rowid, summary) VALUES('delete', old.id, old.summary);
  INSERT INTO turn_summaries_fts(rowid, summary) VALUES (new.id, new.summary);
END;

CREATE TABLE IF NOT EXISTS schema_versions (
  version INTEGER PRIMARY KEY,
  applied_at_epoch INTEGER NOT NULL
);
`;

const SCHEMA_V3 = `
CREATE TABLE IF NOT EXISTS savings_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bucket TEXT NOT NULL,
  baseline INTEGER NOT NULL,
  served INTEGER NOT NULL,
  meta TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_savings_bucket_ts ON savings_log(bucket, ts);
`;

const SCHEMA_V4 = `
CREATE TABLE IF NOT EXISTS decision_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_id INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES decisions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('related_to','annotates')),
  note TEXT,
  created_at_epoch INTEGER NOT NULL,
  UNIQUE(from_id, to_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_decision_links_from ON decision_links(from_id);
CREATE INDEX IF NOT EXISTS idx_decision_links_to ON decision_links(to_id);
`;

const VEC_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS decisions_vec_ad AFTER DELETE ON decisions BEGIN
  DELETE FROM decisions_vec WHERE rowid = old.id;
END;
CREATE TRIGGER IF NOT EXISTS turn_summaries_vec_ad AFTER DELETE ON turn_summaries BEGIN
  DELETE FROM turn_summaries_vec WHERE rowid = old.id;
END;
`;

type Sqlite = SqliteHandle;

export class MemoryDb {
	readonly db: Sqlite;
	private hasVec = false;

	constructor(dbPath: string) {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		const opened = openDatabase(dbPath);
		this.db = opened.db;
		this.hasVec = opened.hasVec;
		this.db.pragma("foreign_keys = ON");
		this.ensureSchema();
	}

	get vecAvailable(): boolean {
		return this.hasVec;
	}

	private ensureSchema(): void {
		// Shape enforcement instead of a version ladder: every statement below
		// is idempotent, so a database from ANY earlier release converges to the
		// current schema on open without version bookkeeping or stepwise
		// migrations. Vec tables are created whenever sqlite-vec is available
		// (and skipped when it isn't), which subsumes the old "created without
		// vec, upgrade later" version dance.
		const run = this.db.transaction(() => {
			this.db.exec(SCHEMA_V1);
			this.applyV4Columns();
			this.db.exec(SCHEMA_V3);
			this.db.exec(SCHEMA_V4);
			if (this.hasVec) {
				this.db.exec(this.vecTableStmts(VEC_DIM));
				this.db.exec(VEC_TRIGGERS);
			}
			// Informational stamp only — nothing branches on it anymore.
			this.db
				.prepare("INSERT OR REPLACE INTO schema_versions (version, applied_at_epoch) VALUES (?, ?)")
				.run(CURRENT_VERSION, epochSeconds());
		});
		run();
	}

	/** `decisions.tags` / `decisions.files` (JSON arrays) on databases created
	 * before R13; guarded so re-runs and partial states stay safe. */
	private applyV4Columns(): void {
		const cols = new Set(
			(this.db.prepare("PRAGMA table_info(decisions)").all() as { name: string }[]).map((c) => c.name),
		);
		if (!cols.has("tags")) this.db.exec("ALTER TABLE decisions ADD COLUMN tags TEXT");
		if (!cols.has("files")) this.db.exec("ALTER TABLE decisions ADD COLUMN files TEXT");
	}

	// ── R13: linked memory (A-MEM style) ─────────────────────────────────────

	/** Outgoing `related_to` links a single decision may accumulate. */
	static readonly MAX_OUTGOING_RELATED = 6;
	/** Inbound `related_to` links a hub decision accepts before new links skip it. */
	static readonly MAX_INBOUND_RELATED = 8;

	/**
	 * Create a directed link between two decisions. Refuses self-links,
	 * unknown ids and cap overflow; dedupes via UNIQUE(from_id, to_id, kind)
	 * (returns false on conflict instead of throwing).
	 */
	linkDecisions(fromId: number, toId: number, kind: "related_to" | "annotates", note: string | null = null): boolean {
		if (!Number.isInteger(fromId) || !Number.isInteger(toId) || fromId === toId) return false;
		const fromRow = this.db.prepare("SELECT 1 FROM decisions WHERE id = ?").get(fromId);
		const toRow = this.db.prepare("SELECT 1 FROM decisions WHERE id = ?").get(toId);
		if (!fromRow || !toRow) return false;
		if (kind === "related_to") {
			const outN = (
				this.db.prepare("SELECT COUNT(*) AS n FROM decision_links WHERE from_id = ? AND kind = 'related_to'").get(fromId) as { n: number }
			).n;
			if (outN >= MemoryDb.MAX_OUTGOING_RELATED) return false;
			const inN = (
				this.db.prepare("SELECT COUNT(*) AS n FROM decision_links WHERE to_id = ? AND kind = 'related_to'").get(toId) as { n: number }
			).n;
			if (inN >= MemoryDb.MAX_INBOUND_RELATED) return false;
		}
		try {
			this.db
				.prepare("INSERT INTO decision_links (from_id, to_id, kind, note, created_at_epoch) VALUES (?, ?, ?, ?, ?)")
				.run(fromId, toId, kind, note, epochSeconds());
			return true;
		} catch {
			return false; // duplicate or FK violation — already linked
		}
	}

	/** Both directions of a decision's links, ready for recall rendering. */
	getDecisionLinks(id: number): {
		relatedTo: number[];
		relatedFrom: number[];
		annotates: { id: number; note: string | null }[];
		annotatedBy: { id: number; note: string | null }[];
	} {
		const rows = this.db
			.prepare("SELECT from_id, to_id, kind, note FROM decision_links WHERE from_id = ? OR to_id = ?")
			.all(id, id) as { from_id: number; to_id: number; kind: string; note: string | null }[];
		const out = {
			relatedTo: [] as number[],
			relatedFrom: [] as number[],
			annotates: [] as { id: number; note: string | null }[],
			annotatedBy: [] as { id: number; note: string | null }[],
		};
		for (const r of rows) {
			if (r.kind === "related_to") {
				if (r.from_id === id) out.relatedTo.push(r.to_id);
				else out.relatedFrom.push(r.from_id);
			} else {
				if (r.from_id === id) out.annotates.push({ id: r.to_id, note: r.note });
				else out.annotatedBy.push({ id: r.from_id, note: r.note });
			}
		}
		return out;
	}

	/** Short one-line text of a decision (for link rendering). */
	decisionHeadline(id: number): string | null {
		const row = this.db.prepare("SELECT decision FROM decisions WHERE id = ?").get(id) as { decision: string } | undefined;
		return row ? row.decision : null;
	}

	/**
	 * R13 auto-linking: embed the new decision, find similar past decisions
	 * and connect them with `related_to` edges (A-MEM's dynamic indexing).
	 * The similarity gate is deliberately tighter than recall (0.85 vs 0.92
	 * L2 on normalized vectors ≈ cosine ≥ 0.64): a wrong link is worse than a
	 * missing one, because recall walks them.
	 */
	autoLinkDecision(
		embedder: Embedder,
		newId: number,
		text: string,
		opts: { k?: number; maxDistance?: number; cap?: number } = {},
	): Promise<number[]> {
		const { k = 4, maxDistance = 0.85, cap = 3 } = opts;
		return (async () => {
			if (!this.hasVecTables() || !text.trim()) return [];
			const ids = await this.searchDecisionsVec(embedder, text, k, maxDistance);
			const linked: number[] = [];
			for (const id of ids) {
				if (id === newId) continue;
				if (linked.length >= cap) break;
				if (this.linkDecisions(newId, id, "related_to")) linked.push(id);
			}
			return linked;
		})();
	}

	private vecTableStmts(dim: number): string {
		return `
CREATE VIRTUAL TABLE IF NOT EXISTS decisions_vec USING vec0(embedding float[${dim}]);
CREATE VIRTUAL TABLE IF NOT EXISTS turn_summaries_vec USING vec0(embedding float[${dim}]);
`;
	}

	schemaVersion(): number {
		const row = this.db.prepare("SELECT MAX(version) AS v FROM schema_versions").get() as { v: number | null };
		return row.v ?? 0;
	}

	hasVecTables(): boolean {
		const rows = this.db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('decisions_vec','turn_summaries_vec')",
			)
			.all() as { name: string }[];
		return rows.length === 2;
	}

	private declaredVecDim(): number | null {
		const row = this.db
			.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='decisions_vec'")
			.get() as { sql: string | null } | undefined;
		if (!row?.sql) return null;
		const m = /float\[(\d+)\]/.exec(row.sql);
		return m ? Number(m[1]) : null;
	}

	private ensureVecDim(dim: number): void {
		if (!this.hasVecTables()) return;
		const current = this.declaredVecDim();
		if (current === dim) return;
		this.db.exec("DROP TABLE IF EXISTS decisions_vec");
		this.db.exec("DROP TABLE IF EXISTS turn_summaries_vec");
		this.db.exec(this.vecTableStmts(dim));
	}

	private writeVecRow(table: "decisions_vec" | "turn_summaries_vec", rowid: number, vec: readonly number[]): void {
		try {
			const del = this.db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE rowid = ?)`);
			del.run(BigInt(rowid));
			const ins = this.db.prepare(`INSERT INTO ${table}(rowid, embedding) SELECT ?, ?`);
			ins.run(BigInt(rowid), Buffer.from(Float32Array.from(vec).buffer));
		} catch {
			// dim mismatch etc — row stays semantically unsearchable until backfill
		}
	}

	async recordDecisionVec(embedder: Embedder, decisionId: number, decision: string, reason: string): Promise<void> {
		if (!this.hasVecTables()) return;
		const text = decision && reason ? `${decision} — ${reason}` : decision || reason;
		if (!text.trim()) return;
		let vec: number[];
		try {
			vec = await embedder.embedQuery(text);
		} catch {
			return;
		}
		this.ensureVecDim(vec.length);
		this.writeVecRow("decisions_vec", decisionId, vec);
	}

	async recordTurnSummaryVec(embedder: Embedder, turnId: number, summary: string): Promise<void> {
		if (!this.hasVecTables() || !summary.trim()) return;
		let vec: number[];
		try {
			vec = await embedder.embedQuery(summary);
		} catch {
			return;
		}
		this.ensureVecDim(vec.length);
		this.writeVecRow("turn_summaries_vec", turnId, vec);
	}

	/**
	 * Count rows still missing a vec entry, without touching an embedder.
	 * Lets callers skip the backfill (and its model init) in the steady state.
	 */
	vecBackfillPending(): { decisions: number; turnSummaries: number } {
		if (!this.hasVecTables()) return { decisions: 0, turnSummaries: 0 };
		try {
			const d = this.db
				.prepare("SELECT COUNT(*) AS n FROM decisions d WHERE NOT EXISTS (SELECT 1 FROM decisions_vec v WHERE v.rowid = d.id)")
				.get() as { n: number };
			const t = this.db
				.prepare("SELECT COUNT(*) AS n FROM turn_summaries t WHERE NOT EXISTS (SELECT 1 FROM turn_summaries_vec v WHERE v.rowid = t.id)")
				.get() as { n: number };
			return { decisions: Number(d?.n ?? 0), turnSummaries: Number(t?.n ?? 0) };
		} catch {
			return { decisions: 0, turnSummaries: 0 };
		}
	}

	async backfillVecTables(embedder: Embedder): Promise<{ decisions: number; turnSummaries: number }> {
		const counts = { decisions: 0, turnSummaries: 0 };
		if (!this.hasVecTables()) return counts;
		// Steady state: nothing missing — skip the embedder entirely.
		const pending = this.vecBackfillPending();
		if (pending.decisions + pending.turnSummaries === 0) return counts;
		try {
			this.ensureVecDim((await embedder.embedQuery("dimension probe")).length);
		} catch {
			return counts;
		}
		const decisionRows = this.db
			.prepare(
				`SELECT d.id, d.decision, d.reason FROM decisions d
				 WHERE NOT EXISTS (SELECT 1 FROM decisions_vec v WHERE v.rowid = d.id)`,
			)
			.all() as { id: number; decision: string; reason: string }[];
		for (const row of decisionRows) {
			await this.recordDecisionVec(embedder, row.id, row.decision ?? "", row.reason ?? "");
			counts.decisions++;
		}
		const turnRows = this.db
			.prepare(
				`SELECT t.id, t.summary FROM turn_summaries t
				 WHERE NOT EXISTS (SELECT 1 FROM turn_summaries_vec v WHERE v.rowid = t.id)`,
			)
			.all() as { id: number; summary: string }[];
		for (const row of turnRows) {
			await this.recordTurnSummaryVec(embedder, row.id, row.summary ?? "");
			counts.turnSummaries++;
		}
		return counts;
	}

	async searchDecisionsVec(embedder: Embedder, topic: string, k = 20, maxDistance = 0.92): Promise<number[]> {
		if (!this.hasVecTables() || !topic.trim()) return [];
		let vec: number[];
		try {
			vec = await embedder.embedQuery(topic);
		} catch {
			return [];
		}
		await this.healVecTables(embedder, vec);
		return this.vecSearch("decisions_vec", vec, k, maxDistance);
	}

	async searchTurnSummariesVec(embedder: Embedder, topic: string, k = 20, maxDistance = 0.92): Promise<number[]> {
		if (!this.hasVecTables() || !topic.trim()) return [];
		let vec: number[];
		try {
			vec = await embedder.embedQuery(topic);
		} catch {
			return [];
		}
		await this.healVecTables(embedder, vec);
		return this.vecSearch("turn_summaries_vec", vec, k, maxDistance);
	}

	/**
	 * Self-heal at the point of recall (upstream #137), covering both failure
	 * shapes a dim-mismatched or partially-empty vec table produces:
	 *
	 * 1. Tables built by another embedder: a dim-mismatched MATCH errors and
	 *    silently returns nothing → recreate at the query's dim.
	 * 2. Rows missing for any reason (e.g. a mid-session `recordDecisionVec`
	 *    wiped the tables via `ensureVecDim` after the engine's one-shot
	 *    backfill already ran) → restore them here, where the embedder is
	 *    already in hand.
	 *
	 * Steady state costs two COUNT queries; the embedder is only touched when
	 * something is actually wrong.
	 */
	private async healVecTables(embedder: Embedder, vec: readonly number[]): Promise<void> {
		if (!this.hasVecTables()) return;
		const declared = this.declaredVecDim();
		if (declared !== null && declared !== vec.length) this.ensureVecDim(vec.length);
		const pending = this.vecBackfillPending();
		if (pending.decisions + pending.turnSummaries > 0) await this.backfillVecTables(embedder);
	}

	private vecSearch(table: string, vec: number[], k: number, maxDistance: number): number[] {
		try {
			const rows = this.db
				.prepare(`SELECT rowid, distance FROM ${table} WHERE embedding MATCH ? AND k = ? ORDER BY distance`)
				.all(Buffer.from(Float32Array.from(vec).buffer), k) as { rowid: number; distance: number }[];
			return rows.filter((r) => r.distance <= maxDistance).map((r) => Number(r.rowid));
		} catch {
			return [];
		}
	}

	// ── Savings ledger ────────────────────────────────────────────────────

	recordSavings(bucket: Bucket, baseline: number, served: number, meta?: Record<string, unknown>): void {
		if (!BUCKETS.includes(bucket)) return;
		try {
			this.db
				.prepare("INSERT INTO savings_log (bucket, baseline, served, meta, ts) VALUES (?, ?, ?, ?, ?)")
				.run(bucket, Math.max(0, Math.floor(baseline)), Math.max(0, Math.floor(served)), meta ? JSON.stringify(meta) : null, epochSeconds());
		} catch {
			// best-effort ledger
		}
	}

	aggregateSavings(): Record<Bucket, { baseline: number; served: number; calls: number }> {
		const out = Object.fromEntries(BUCKETS.map((b) => [b, { baseline: 0, served: 0, calls: 0 }])) as Record<
			Bucket,
			{ baseline: number; served: number; calls: number }
		>;
		try {
			const rows = this.db
				.prepare(
					"SELECT bucket, SUM(baseline) AS baseline, SUM(served) AS served, COUNT(*) AS calls FROM savings_log GROUP BY bucket",
				)
				.all() as { bucket: Bucket; baseline: number | null; served: number | null; calls: number | null }[];
			for (const r of rows) {
				if (r.bucket in out) {
					out[r.bucket] = {
						baseline: Number(r.baseline ?? 0),
						served: Number(r.served ?? 0),
						calls: Number(r.calls ?? 0),
					};
				}
			}
		} catch {
			// zeros
		}
		return out;
	}

	// ── Retention ─────────────────────────────────────────────────────────

	pruneOldPayloads(days = 30): { payloadsPruned: number; bytesFreedEstimate: number } {
		const cutoff = epochSeconds() - days * 86400;
		const rows = this.db
			.prepare(
				`SELECT p.id, p.size_bytes FROM tool_event_payloads p
				 WHERE p.raw_input != ''
				 AND NOT EXISTS (
				   SELECT 1 FROM tool_events te
				   WHERE te.payload_id = p.id AND te.created_at_epoch >= ?
				 )`,
			)
			.all(cutoff) as { id: number; size_bytes: number }[];
		if (rows.length === 0) return { payloadsPruned: 0, bytesFreedEstimate: 0 };
		const bytesFreed = rows.reduce((acc, r) => acc + (r.size_bytes || 0), 0);
		const update = this.db.prepare(
			"UPDATE tool_event_payloads SET raw_input = '', raw_output = NULL, size_bytes = 0 WHERE id = ?",
		);
		const run = this.db.transaction(() => {
			for (const r of rows) update.run(r.id);
		});
		run();
		return { payloadsPruned: rows.length, bytesFreedEstimate: bytesFreed };
	}

	pruneOldRows(opts: {
		storageBase: string;
		turnDays?: number;
		decisionDays?: number;
		codeAreaDays?: number;
		archive?: boolean;
	}): { decisionsPruned: number; turnsPruned: number; codeAreasPruned: number } {
		const turnDays = opts.turnDays ?? 180;
		const decisionDays = opts.decisionDays ?? 365;
		const codeAreaDays = opts.codeAreaDays ?? 180;
		const archive = opts.archive ?? true;
		const now = epochSeconds();
		const counts = { decisionsPruned: 0, turnsPruned: 0, codeAreasPruned: 0 };
		const archived: Record<string, unknown[]> = {};

		const harvest = (table: string, columns: string[], cutoff: number): number => {
			const rows = this.db
				.prepare(`SELECT ${columns.join(", ")} FROM ${table} WHERE created_at_epoch < ?`)
				.all(cutoff) as Record<string, unknown>[];
			if (rows.length === 0) return 0;
			if (archive) archived[table] = rows;
			this.db.prepare(`DELETE FROM ${table} WHERE created_at_epoch < ?`).run(cutoff);
			return rows.length;
		};

		const run = this.db.transaction(() => {
			counts.turnsPruned = harvest("turn_summaries", ["id", "session_id", "prompt_number", "summary", "tier", "created_at_epoch"], now - turnDays * 86400);
			counts.decisionsPruned = harvest("decisions", ["id", "session_id", "decision", "reason", "source", "created_at_epoch", "created_at"], now - decisionDays * 86400);
			counts.codeAreasPruned = harvest("code_areas", ["id", "session_id", "file_path", "description", "source", "created_at_epoch"], now - codeAreaDays * 86400);
		});
		run();

		if (archive && Object.keys(archived).length > 0) {
			try {
				const archiveDir = path.join(opts.storageBase, "archives");
				fs.mkdirSync(archiveDir, { recursive: true });
				const ts = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
				fs.writeFileSync(path.join(archiveDir, `pruned-${ts}.json`), JSON.stringify(archived, null, 2));
			} catch {
				// rows already deleted; archive is best-effort
			}
		}
		return counts;
	}

	close(): void {
		this.db.close();
	}
}

// ── PII redaction toggle ────────────────────────────────────────────────────

let piiRedactionEnabled = true;

export function setPiiRedaction(enabled: boolean): void {
	piiRedactionEnabled = Boolean(enabled);
}

export function scrubPii(text: string): string {
	if (!text || !piiRedactionEnabled) return text;
	return redactPii(text).text;
}

export function memoryDbPath(storageBase: string): string {
	return path.join(storageBase, "memory.db");
}

export { batchedParams };
