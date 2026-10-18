/**
 * SQLite-vec backed vector store — port of upstream `storage/vector_store.py` (MIT).
 *
 * Synchronous (better-sqlite3) instead of Python's async+RLock; the
 * surrounding tool handlers remain async so pi stays responsive.
 *
 * IMPORTANT (better-sqlite3 quirk): JS numbers bind as REAL, and sqlite-vec's
 * vec0 rejects non-INTEGER rowids. All vec0 rowid access therefore uses
 * INSERT...SELECT / IN-subquery forms (rowid never crosses the bind boundary),
 * mirroring the upstream batch-delete shape.
 */
import fs from "node:fs";
import path from "node:path";
import { openDatabase, type SqliteHandle } from "../sqlite.js";
import { batchedParams } from "../utils.js";
import { parseContextHeaderUnit } from "../indexer/context-header.js";
import type { Chunk, ChunkType } from "../types.js";

const MAX_CONTENT_CHARS = 5_000;

export function serializeVec(vec: readonly number[]): Buffer {
	return Buffer.from(Float32Array.from(vec).buffer);
}

type Sqlite = SqliteHandle;

export class VectorStore {
	private db: Sqlite;
	private dim: number | null = null;
	/** Set when a legacy L2 vec table was wiped — pipeline forces a full reindex. */
	metricRebuilt = false;
	constructor(dbPath: string) {
		fs.mkdirSync(dbPath, { recursive: true });
		// Without sqlite-vec the store still keeps chunk metadata; search()
		// returns [] and retrieval continues FTS-only.
		this.db = openDatabase(path.join(dbPath, "vectors.db")).db;
		this.ensureTables();
	}

	private get vecAvailable(): boolean {
		return this.dim !== null || this.vecTableExists();
	}

	private vecTableExists(): boolean {
		const row = this.db
			.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='chunks_vec'")
			.get() as { sql: string } | undefined;
		return row !== undefined;
	}

	private ensureTables(): void {
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS chunks (
				id TEXT PRIMARY KEY,
				content TEXT NOT NULL,
				chunk_type TEXT NOT NULL,
				file_path TEXT NOT NULL,
				start_line INTEGER NOT NULL,
				end_line INTEGER NOT NULL,
				language TEXT NOT NULL,
				modified_ts REAL
			)
		`);
		const cols = (this.db.pragma("table_info(chunks)") as { name: string }[]).map((c) => c.name);
		if (!cols.includes("modified_ts")) {
			this.db.exec("ALTER TABLE chunks ADD COLUMN modified_ts REAL");
		}
		this.db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path)");
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS chunk_compressions (
				chunk_id TEXT NOT NULL,
				level TEXT NOT NULL,
				compressed TEXT NOT NULL,
				PRIMARY KEY (chunk_id, level)
			)
		`);

		const row = this.db
			.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='chunks_vec'")
			.get() as { sql: string | null } | undefined;
		if (row) {
			if (!(row.sql ?? "").includes("distance_metric=cosine")) {
				this.db.exec("DROP TABLE IF EXISTS chunks_vec");
				this.db.exec("DELETE FROM chunks");
				this.db.exec("DELETE FROM chunk_compressions");
				this.metricRebuilt = true;
			} else {
				const r = this.db.prepare("SELECT rowid FROM chunks_vec LIMIT 1").get() as
					| { rowid: number }
					| undefined;
				if (r) {
					const len = this.db
						.prepare("SELECT vec_length(embedding) AS len FROM chunks_vec LIMIT 1")
						.get() as { len: number };
					this.dim = len.len;
				}
			}
		}
	}

	private ensureVecTable(dim: number): void {
		if (this.dim === dim) return;
		if (this.dim !== null && this.dim !== dim) {
			this.db.exec("DROP TABLE IF EXISTS chunks_vec");
			this.db.exec("DELETE FROM chunks");
			this.db.exec("DELETE FROM chunk_compressions");
		}
		this.db.exec(
			`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(embedding float[${dim}] distance_metric=cosine)`,
		);
		this.dim = dim;
	}

	private chunkToRow(chunk: Chunk): (string | number | null)[] {
		const content =
			chunk.content.length > MAX_CONTENT_CHARS
				? chunk.content.slice(0, MAX_CONTENT_CHARS) + "\n...[truncated]"
				: chunk.content;
		const modifiedTs = chunk.metadata["modified_ts"];
		return [
			chunk.id,
			content,
			chunk.chunkType,
			chunk.filePath,
			chunk.startLine,
			chunk.endLine,
			chunk.language,
			typeof modifiedTs === "number" ? modifiedTs : null,
		];
	}

	private rowToChunk(row: Record<string, unknown>, distance?: number): Chunk {
		const chunk: Chunk = {
			id: row.id as string,
			content: row.content as string,
			chunkType: row.chunk_type as ChunkType,
			filePath: row.file_path as string,
			startLine: row.start_line as number,
			endLine: row.end_line as number,
			language: row.language as string,
			metadata: {},
			embedding: null,
			confidenceScore: 0,
			compressedContent: null,
		};
		if (row.modified_ts != null) chunk.metadata["modified_ts"] = row.modified_ts;
		if (distance !== undefined) chunk.metadata["_distance"] = distance;
		// Restore `unit` from the R1 context header line so served chunks carry
		// their symbol (refine hints filter siblings by it; the header is the
		// single source of truth for indexed content). No header → no unit,
		// same as before.
		const unit = parseContextHeaderUnit(chunk.content);
		if (unit) chunk.metadata["unit"] = unit;
		return chunk;
	}

	ingest(chunks: Chunk[]): void {
		if (chunks.length === 0) return;
		const valid = chunks.filter((c) => c.embedding && c.embedding.length > 0);
		if (valid.length === 0) return;
		this.ensureVecTable(valid[0]!.embedding!.length);

		const upsert = this.db.prepare(`
			INSERT INTO chunks (id, content, chunk_type, file_path, start_line, end_line, language, modified_ts)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET
				content = excluded.content,
				chunk_type = excluded.chunk_type,
				file_path = excluded.file_path,
				start_line = excluded.start_line,
				end_line = excluded.end_line,
				language = excluded.language,
				modified_ts = excluded.modified_ts
		`);
		const delVec = this.db.prepare(
			"DELETE FROM chunks_vec WHERE rowid IN (SELECT rowid FROM chunks WHERE id = ?)",
		);
		const insVec = this.db.prepare(
			"INSERT INTO chunks_vec(rowid, embedding) SELECT rowid, ? FROM chunks WHERE id = ?",
		);

		const run = this.db.transaction((items: Chunk[]) => {
			for (const chunk of items) {
				upsert.run(...this.chunkToRow(chunk));
				delVec.run(chunk.id);
				insVec.run(serializeVec(chunk.embedding!), chunk.id);
			}
		});
		run(valid);
	}

	search(queryEmbedding: readonly number[], topK = 10, filters?: { filePath?: string }): Chunk[] {
		if (this.dim === null) return [];
		try {
			const q = serializeVec(queryEmbedding);
			let rows: Record<string, unknown>[];
			if (filters?.filePath !== undefined) {
				rows = this.db
					.prepare(
						`SELECT c.id, c.content, c.chunk_type, c.file_path, c.start_line, c.end_line, c.language,
						        c.modified_ts, v.distance
						 FROM chunks_vec v
						 JOIN chunks c ON c.rowid = v.rowid
						 WHERE v.embedding MATCH ? AND k = ? AND c.file_path = ?
						 ORDER BY v.distance`,
					)
					.all(q, topK * 3, filters.filePath) as Record<string, unknown>[];
				rows = rows.slice(0, topK);
			} else {
				rows = this.db
					.prepare(
						`SELECT c.id, c.content, c.chunk_type, c.file_path, c.start_line, c.end_line, c.language,
						        c.modified_ts, v.distance
						 FROM chunks_vec v
						 JOIN chunks c ON c.rowid = v.rowid
						 WHERE v.embedding MATCH ? AND k = ?
						 ORDER BY v.distance`,
					)
					.all(q, topK) as Record<string, unknown>[];
			}
			return rows.map((r) => this.rowToChunk(r, r.distance as number));
		} catch {
			return [];
		}
	}

	deleteByFile(filePath: string): void {
		this.deleteByFiles([filePath]);
	}

	deleteByFiles(filePaths: string[]): void {
		if (filePaths.length === 0) return;
		const placeholders = filePaths.map(() => "?").join(",");
		// Only prepare the vec statement when the table exists: on a virgin
		// index there is no chunks_vec yet and prepare() would throw.
		const delVec = this.vecTableExists()
			? this.db.prepare(
					`DELETE FROM chunks_vec WHERE rowid IN (SELECT rowid FROM chunks WHERE file_path IN (${placeholders}))`,
				)
			: null;
		const delComp = this.db.prepare(
			`DELETE FROM chunk_compressions WHERE chunk_id IN (SELECT id FROM chunks WHERE file_path IN (${placeholders}))`,
		);
		const delChunks = this.db.prepare(`DELETE FROM chunks WHERE file_path IN (${placeholders})`);
		const run = this.db.transaction((batches: string[][]) => {
			for (const batch of batches) {
				delVec?.run(...batch);
				delComp.run(...batch);
				delChunks.run(...batch);
			}
		});
		run([...batchedParams(filePaths)]);
	}

	getCachedCompression(chunkId: string, level: string): string | null {
		try {
			const row = this.db
				.prepare("SELECT compressed FROM chunk_compressions WHERE chunk_id = ? AND level = ?")
				.get(chunkId, level) as { compressed: string } | undefined;
			return row?.compressed ?? null;
		} catch {
			return null;
		}
	}

	putCachedCompression(chunkId: string, level: string, compressed: string): void {
		try {
			this.db
				.prepare("INSERT OR REPLACE INTO chunk_compressions (chunk_id, level, compressed) VALUES (?, ?, ?)")
				.run(chunkId, level, compressed);
		} catch {
			// best-effort cache
		}
	}

	count(): number {
		try {
			const row = this.db.prepare("SELECT COUNT(*) AS n FROM chunks").get() as { n: number };
			return row.n;
		} catch {
			return 0;
		}
	}

	fileChunkCounts(): Record<string, number> {
		try {
			const rows = this.db
				.prepare("SELECT file_path, COUNT(*) AS n FROM chunks GROUP BY file_path")
				.all() as { file_path: string; n: number }[];
			return Object.fromEntries(rows.map((r) => [r.file_path, r.n]));
		} catch {
			return {};
		}
	}

	clear(): void {
		try {
			this.db.exec("DELETE FROM chunks");
			this.db.exec("DELETE FROM chunk_compressions");
			if (this.vecTableExists()) {
				this.db.exec("DROP TABLE IF EXISTS chunks_vec");
				this.dim = null;
			}
		} catch {
			// ignore
		}
	}

	getById(chunkId: string): Chunk | null {
		try {
			const row = this.db
				.prepare(
					"SELECT id, content, chunk_type, file_path, start_line, end_line, language, modified_ts FROM chunks WHERE id = ?",
				)
				.get(chunkId) as Record<string, unknown> | undefined;
			return row ? this.rowToChunk(row) : null;
		} catch {
			return null;
		}
	}

	getChunksByIds(chunkIds: string[]): Chunk[] {
		if (chunkIds.length === 0) return [];
		try {
			const placeholders = chunkIds.map(() => "?").join(",");
			const rows = this.db
				.prepare(
					`SELECT id, content, chunk_type, file_path, start_line, end_line, language, modified_ts FROM chunks WHERE id IN (${placeholders})`,
				)
				.all(...chunkIds) as Record<string, unknown>[];
			return rows.map((r) => this.rowToChunk(r));
		} catch {
			return [];
		}
	}

	/** R5: chunks of one file in source order (file-hint retrieval path). */
	byFile(filePath: string, limit = 10): Chunk[] {
		try {
			const rows = this.db
				.prepare(
					`SELECT id, content, chunk_type, file_path, start_line, end_line, language, modified_ts
					 FROM chunks WHERE file_path = ? ORDER BY start_line ASC LIMIT ?`,
				)
				.all(filePath, limit) as Record<string, unknown>[];
			return rows.map((r) => this.rowToChunk(r));
		} catch {
			return [];
		}
	}

	close(): void {
		this.db.close();
	}
}
