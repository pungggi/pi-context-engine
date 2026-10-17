/**
 * Per-project memory.db — port of upstream `memory/db.py` (MIT), schema v3
 * (minus `migrated_files`, which only served upstream's session-file import).
 * Synchronous better-sqlite3; vec tables degrade to FTS-only when the
 * sqlite-vec extension can't load.
 */
import fs from "node:fs";
import path from "node:path";
import { openDatabase, type SqliteHandle } from "../sqlite.js";
import { batchedParams, epochSeconds } from "../utils.js";
import { redactPii } from "../indexer/secrets.js";
import type { Embedder } from "../indexer/embedder.js";

export const CURRENT_VERSION = 3;
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
CREATE TABLE sessions (
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
CREATE INDEX idx_sessions_started ON sessions(started_at_epoch DESC);

CREATE TABLE prompts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  prompt_number INTEGER NOT NULL,
  prompt_text TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(session_id, prompt_number)
);
CREATE INDEX idx_prompts_session ON prompts(session_id, prompt_number);

CREATE TABLE tool_event_payloads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_input TEXT NOT NULL,
  raw_output TEXT,
  size_bytes INTEGER NOT NULL
);

CREATE TABLE tool_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  prompt_number INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  payload_id INTEGER REFERENCES tool_event_payloads(id) ON DELETE SET NULL,
  summary TEXT,
  created_at_epoch INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_events_session_turn ON tool_events(session_id, prompt_number);

CREATE TABLE turn_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  prompt_number INTEGER NOT NULL,
  summary TEXT NOT NULL,
  tier TEXT NOT NULL,
  created_at_epoch INTEGER NOT NULL,
  UNIQUE(session_id, prompt_number)
);

CREATE TABLE decisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('manual','migrated','auto')) DEFAULT 'manual',
  created_at_epoch INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_decisions_created ON decisions(created_at_epoch DESC);
CREATE INDEX idx_decisions_source ON decisions(source);

CREATE TABLE code_areas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  file_path TEXT NOT NULL,
  description TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('manual','migrated','auto')) DEFAULT 'manual',
  created_at_epoch INTEGER NOT NULL
);
CREATE INDEX idx_code_areas_file ON code_areas(file_path);

CREATE TABLE pending_compressions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('turn','session_rollup')),
  session_id TEXT NOT NULL,
  prompt_number INTEGER,
  enqueued_at_epoch INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  UNIQUE(kind, session_id, prompt_number)
);

CREATE VIRTUAL TABLE prompts_fts USING fts5(prompt_text, content='prompts', content_rowid='id');
CREATE VIRTUAL TABLE decisions_fts USING fts5(decision, reason, content='decisions', content_rowid='id');
CREATE VIRTUAL TABLE turn_summaries_fts USING fts5(summary, content='turn_summaries', content_rowid='id');

CREATE TRIGGER prompts_ai AFTER INSERT ON prompts BEGIN
  INSERT INTO prompts_fts(rowid, prompt_text) VALUES (new.id, new.prompt_text);
END;
CREATE TRIGGER prompts_ad AFTER DELETE ON prompts BEGIN
  INSERT INTO prompts_fts(prompts_fts, rowid, prompt_text) VALUES('delete', old.id, old.prompt_text);
END;
CREATE TRIGGER prompts_au AFTER UPDATE ON prompts BEGIN
  INSERT INTO prompts_fts(prompts_fts, rowid, prompt_text) VALUES('delete', old.id, old.prompt_text);
  INSERT INTO prompts_fts(rowid, prompt_text) VALUES (new.id, new.prompt_text);
END;

CREATE TRIGGER decisions_ai AFTER INSERT ON decisions BEGIN
  INSERT INTO decisions_fts(rowid, decision, reason) VALUES (new.id, new.decision, new.reason);
END;
CREATE TRIGGER decisions_ad AFTER DELETE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, decision, reason) VALUES('delete', old.id, old.decision, old.reason);
END;
CREATE TRIGGER decisions_au AFTER UPDATE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, decision, reason) VALUES('delete', old.id, old.decision, old.reason);
  INSERT INTO decisions_fts(rowid, decision, reason) VALUES (new.id, new.decision, new.reason);
END;

CREATE TRIGGER turn_summaries_ai AFTER INSERT ON turn_summaries BEGIN
  INSERT INTO turn_summaries_fts(rowid, summary) VALUES (new.id, new.summary);
END;
CREATE TRIGGER turn_summaries_ad AFTER DELETE ON turn_summaries BEGIN
  INSERT INTO turn_summaries_fts(turn_summaries_fts, rowid, summary) VALUES('delete', old.id, old.summary);
END;
CREATE TRIGGER turn_summaries_au AFTER UPDATE ON turn_summaries BEGIN
  INSERT INTO turn_summaries_fts(turn_summaries_fts, rowid, summary) VALUES('delete', old.id, old.summary);
  INSERT INTO turn_summaries_fts(rowid, summary) VALUES (new.id, new.summary);
END;

CREATE TABLE schema_versions (
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
		const bootstrap = this.db
			.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_versions'")
			.get();
		if (!bootstrap) {
			const run = this.db.transaction(() => {
				this.db.exec(SCHEMA_V1);
				if (this.hasVec) {
					this.db.exec(this.vecTableStmts(VEC_DIM));
					this.db.exec(VEC_TRIGGERS);
				}
				this.db.exec(SCHEMA_V3);
				this.db
					.prepare("INSERT INTO schema_versions (version, applied_at_epoch) VALUES (?, ?)")
					.run(this.hasVec ? CURRENT_VERSION : 1, epochSeconds());
			});
			run();
			return;
		}
		const current = this.schemaVersion();
		if (current >= CURRENT_VERSION) return;
		const run = this.db.transaction(() => {
			if (current < 2 && this.hasVec) {
				this.db.exec(this.vecTableStmts(VEC_DIM));
				this.db.exec(VEC_TRIGGERS);
			}
			if (current < 3) this.db.exec(SCHEMA_V3);
			if (current < 2 && !this.hasVec) return; // vec step still pending
			this.db
				.prepare("INSERT INTO schema_versions (version, applied_at_epoch) VALUES (?, ?)")
				.run(CURRENT_VERSION, epochSeconds());
		});
		run();
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

	async backfillVecTables(embedder: Embedder): Promise<{ decisions: number; turnSummaries: number }> {
		const counts = { decisions: 0, turnSummaries: 0 };
		if (!this.hasVecTables()) return counts;
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
		return this.vecSearch("turn_summaries_vec", vec, k, maxDistance);
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
