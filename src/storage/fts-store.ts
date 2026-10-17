/**
 * SQLite FTS5 full-text store — port of upstream `storage/fts_store.py` (MIT).
 */
import fs from "node:fs";
import path from "node:path";
import { openDatabase, type SqliteHandle } from "../sqlite.js";
import { batchedParams } from "../utils.js";
import type { Chunk } from "../types.js";

const MAX_CONTENT_CHARS = 5_000;

// Common English words dropped so natural-language phrasing doesn't drown the
// signal terms. If every token is a stopword we fall back to using them all.
const STOPWORDS = new Set([
	"a", "an", "and", "are", "as", "at", "be", "by", "can", "do", "does",
	"for", "from", "how", "i", "in", "is", "it", "of", "on", "or", "that",
	"the", "this", "to", "was", "we", "what", "when", "where", "which",
	"who", "why", "will", "with", "you", "not",
]);

/**
 * Build a safe FTS5 MATCH expression from free-form user input. Each token is
 * individually quoted (internal quotes doubled) which neutralises FTS5
 * operators; tokens are OR-joined so BM25 still ranks multi-token hits higher.
 * Returns "" when nothing usable remains — callers must skip the query.
 */
export function escapeFts5(query: string): string {
	const tokens = query.split(/\s+/).filter((t) => /[a-zA-Z0-9]/.test(t));
	let kept = tokens.filter((t) => !STOPWORDS.has(t.toLowerCase()));
	if (kept.length === 0) kept = tokens;
	return kept.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

type Sqlite = SqliteHandle;

export class FTSStore {
	private db: Sqlite;

	constructor(dbPath: string) {
		fs.mkdirSync(dbPath, { recursive: true });
		this.db = openDatabase(path.join(dbPath, "fts.db")).db;
		this.db.exec(
			"CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(id UNINDEXED, content, file_path, language, chunk_type)",
		);
	}

	ingest(chunks: Chunk[]): void {
		if (chunks.length === 0) return;
		const rows = chunks.map((c) => [
			c.id,
			c.content.length > MAX_CONTENT_CHARS ? c.content.slice(0, MAX_CONTENT_CHARS) : c.content,
			c.filePath,
			c.language,
			c.chunkType,
		]);
		const del = this.db.prepare("DELETE FROM chunks_fts WHERE id = ?");
		const ins = this.db.prepare(
			"INSERT INTO chunks_fts(id, content, file_path, language, chunk_type) VALUES (?, ?, ?, ?, ?)",
		);
		const run = this.db.transaction((items: (string | number)[][]) => {
			for (const row of items) {
				del.run(row[0]);
				ins.run(...row);
			}
		});
		run(rows as (string | number)[][]);
	}

	search(query: string, topK = 30): { id: string; rank: number }[] {
		if (!query.trim()) return [];
		const matchExpr = escapeFts5(query);
		if (!matchExpr) return [];
		try {
			const rows = this.db
				.prepare("SELECT id, rank FROM chunks_fts WHERE chunks_fts MATCH ? ORDER BY rank LIMIT ?")
				.all(matchExpr, topK) as { id: string; rank: number }[];
			return rows;
		} catch {
			return [];
		}
	}

	deleteByFile(filePath: string): void {
		this.deleteByFiles([filePath]);
	}

	deleteByFiles(filePaths: string[]): void {
		if (filePaths.length === 0) return;
		const del = this.db.prepare(
			`DELETE FROM chunks_fts WHERE file_path IN (${filePaths.map(() => "?").join(",")})`,
		);
		const run = this.db.transaction((batches: string[][]) => {
			for (const batch of batches) del.run(...batch);
		});
		run([...batchedParams(filePaths)]);
	}

	clear(): void {
		this.db.exec("DELETE FROM chunks_fts");
	}

	close(): void {
		this.db.close();
	}
}
