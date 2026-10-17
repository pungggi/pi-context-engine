/**
 * SQLite-backed embedding cache — port of upstream `indexer/embedding_cache.py` (MIT).
 * SHA-256(content, salted with backend identity) → float32 vector.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { openDatabase, type SqliteHandle } from "../sqlite.js";
import { batchedParams } from "../utils.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS embedding_cache (
	content_hash TEXT PRIMARY KEY,
	dim          INTEGER NOT NULL,
	embedding    BLOB NOT NULL
);
`;

type Sqlite = SqliteHandle;

function pack(vec: readonly number[]): Buffer {
	return Buffer.from(Float32Array.from(vec).buffer);
}

function unpack(blob: Buffer, dim: number): number[] {
	return Array.from(new Float32Array(blob.buffer, blob.byteOffset, dim));
}

export class EmbeddingCache {
	private db: Sqlite;
	private modelSalt: string;
	private hits = 0;
	private misses = 0;

	constructor(cachePath: string, opts: { modelSalt?: string } = {}) {
		this.modelSalt = opts.modelSalt ?? "";
		fs.mkdirSync(path.dirname(cachePath), { recursive: true });
		this.db = openDatabase(cachePath).db;
		this.db.exec(SCHEMA);
	}

	contentHash(text: string): string {
		// matches Embedder.contentHash so pipeline and embedder agree on keys
		return createHash("sha256").update(`${this.modelSalt}:${text}`, "utf-8").digest("hex");
	}

	get(contentHash: string): number[] | null {
		const row = this.db
			.prepare("SELECT dim, embedding FROM embedding_cache WHERE content_hash = ?")
			.get(contentHash) as { dim: number; embedding: Buffer } | undefined;
		if (!row) {
			this.misses++;
			return null;
		}
		this.hits++;
		return unpack(row.embedding, row.dim);
	}

	put(contentHash: string, embedding: readonly number[]): void {
		this.db
			.prepare("INSERT OR REPLACE INTO embedding_cache (content_hash, dim, embedding) VALUES (?, ?, ?)")
			.run(contentHash, embedding.length, pack(embedding));
	}

	putBatch(items: { hash: string; embedding: number[] }[]): void {
		const stmt = this.db.prepare(
			"INSERT OR REPLACE INTO embedding_cache (content_hash, dim, embedding) VALUES (?, ?, ?)",
		);
		const run = this.db.transaction(() => {
			for (const { hash, embedding } of items) {
				stmt.run(hash, embedding.length, pack(embedding));
			}
		});
		run();
	}

	getBatch(contentHashes: string[]): Map<string, number[]> {
		const results = new Map<string, number[]>();
		if (contentHashes.length === 0) return results;
		for (const batch of batchedParams(contentHashes)) {
			const ph = batch.map(() => "?").join(",");
			const rows = this.db
				.prepare(
					`SELECT content_hash, dim, embedding FROM embedding_cache WHERE content_hash IN (${ph})`,
				)
				.all(...batch) as { content_hash: string; dim: number; embedding: Buffer }[];
			for (const row of rows) results.set(row.content_hash, unpack(row.embedding, row.dim));
		}
		this.hits += results.size;
		this.misses += contentHashes.length - results.size;
		return results;
	}

	pruneOrphans(knownHashes: Set<string>): number {
		if (knownHashes.size === 0) return 0;
		const current = (this.db.prepare("SELECT content_hash FROM embedding_cache").all() as { content_hash: string }[]).map(
			(r) => r.content_hash,
		);
		const orphans = current.filter((h) => !knownHashes.has(h));
		if (orphans.length === 0) return 0;
		const run = this.db.transaction((batches: string[][]) => {
			for (const batch of batches) {
				const ph = batch.map(() => "?").join(",");
				this.db.prepare(`DELETE FROM embedding_cache WHERE content_hash IN (${ph})`).run(...batch);
			}
		});
		run([...batchedParams(orphans)]);
		return orphans.length;
	}

	get hitCount(): number {
		return this.hits;
	}
	get missCount(): number {
		return this.misses;
	}

	close(): void {
		this.db.close();
	}
}
