import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { LocalBackend } from "../src/storage/local-backend.js";
import { EmbeddingCache } from "../src/indexer/embedding-cache.js";
import { makeChunk, type Chunk } from "../src/types.js";
import { makeTempDir, rmrf, FakeEmbeddingBackend } from "./helpers.js";

const dirs: string[] = [];
function backend(): { store: LocalBackend; dir: string } {
	const dir = makeTempDir("pce-store-");
	dirs.push(dir);
	return { store: new LocalBackend(dir), dir };
}

afterEach(() => {
	for (const d of dirs.splice(0)) rmrf(d);
});

function chunk(id: string, filePath: string, content: string, embedding: number[] | null): Chunk {
	return makeChunk({
		id,
		content,
		chunkType: "function",
		filePath,
		startLine: 1,
		endLine: 5,
		language: "python",
		embedding,
	});
}

describe("LocalBackend", () => {
	it("round-trips chunks through vector, FTS and graph stores", () => {
		const { store } = backend();
		const fake = new FakeEmbeddingBackend();
		const chunks = [
			chunk("a", "src/payments.py", "charge_card validates the amount", fake.vec("charge card validate amount")),
			chunk("b", "src/auth.py", "verify_token decodes the jwt claims", fake.vec("verify token jwt claims")),
		];
		store.ingest(
			chunks,
			[
				{ id: "file_src/payments.py", nodeType: "file", name: "payments.py", filePath: "src/payments.py", properties: {} },
				{ id: "a", nodeType: "function", name: "charge_card", filePath: "src/payments.py", properties: {} },
			],
			[{ sourceId: "file_src/payments.py", targetId: "a", edgeType: "defines", properties: {} }],
		);

		expect(store.countChunks()).toBe(2);
		expect(store.fileChunkCounts()).toEqual({ "src/payments.py": 1, "src/auth.py": 1 });
		expect(store.getChunkById("a")?.filePath).toBe("src/payments.py");

		// Vector search returns the closer chunk first.
		const vectorHits = store.vectorSearch(fake.vec("charge card"), 2);
		expect(vectorHits[0]?.id).toBe("a");

		// FTS finds the keyword.
		const ftsHits = store.ftsSearch("jwt");
		expect(ftsHits.map((h) => h.id)).toContain("b");

		// Graph neighbors resolve through DEFINES.
		const neighbors = store.graphNeighbors("file_src/payments.py");
		expect(neighbors.map((n) => n.id)).toContain("a");

		store.close();
	});

	it("deletes a file's chunks from every store", () => {
		const { store } = backend();
		const emb = new Array(8).fill(0.5);
		store.ingest(
			[chunk("a", "src/a.py", "alpha", emb), chunk("b", "src/b.py", "beta", emb)],
			[{ id: "file_src/a.py", nodeType: "file", name: "a.py", filePath: "src/a.py", properties: {} }],
			[],
		);
		store.deleteByFiles(["src/a.py"]);
		expect(store.countChunks()).toBe(1);
		expect(store.getChunkById("a")).toBeNull();
		expect(store.ftsSearch("alpha")).toHaveLength(0);
		store.close();
	});

	it("survives reopening the same storage directory (persistence)", () => {
		const { store, dir } = backend();
		store.ingest([chunk("a", "src/a.py", "alpha beta", new Array(8).fill(0.25))], [], []);
		store.close();

		const reopened = new LocalBackend(dir);
		expect(reopened.countChunks()).toBe(1);
		expect(reopened.getChunkById("a")?.content).toBe("alpha beta");
		reopened.close();
	});

	it("returns no vector hits for an empty index instead of throwing", () => {
		const { store } = backend();
		expect(store.vectorSearch(new Array(8).fill(0.1), 5)).toEqual([]);
		store.close();
	});

	it("caches compressions per (chunk, level)", () => {
		const { store } = backend();
		expect(store.getCachedCompression("a", "standard")).toBeNull();
		store.putCachedCompression("a", "standard", "summarised");
		expect(store.getCachedCompression("a", "standard")).toBe("summarised");
		expect(store.getCachedCompression("a", "minimal")).toBeNull();
		store.close();
	});

	it("resolves related files through import edges", () => {
		const { store } = backend();
		store.ingest(
			[chunk("a", "src/a.py", "alpha", new Array(8).fill(0.5))],
			[
				{ id: "file_src/a.py", nodeType: "file", name: "a.py", filePath: "src/a.py", properties: {} },
				{ id: "module_requests", nodeType: "module", name: "requests", filePath: "vendor/requests.py", properties: {} },
			],
			[{ sourceId: "file_src/a.py", targetId: "module_requests", edgeType: "imports", properties: {} }],
		);
		expect(store.getRelatedFilePaths(["src/a.py"])).toContain("vendor/requests.py");
		store.close();
	});
});

describe("EmbeddingCache", () => {
	it("stores and retrieves vectors keyed by salted content hash", () => {
		const dir = makeTempDir("pce-cache-");
		try {
			const cache = new EmbeddingCache(path.join(dir, "cache.db"), { modelSalt: "fake:fake-embed" });
			const hash = cache.contentHash("hello world");
			expect(cache.get(hash)).toBeNull();
			cache.put(hash, [0.1, 0.2, 0.3]);
			expect(cache.get(hash)).toEqual([
				expect.closeTo(0.1, 5),
				expect.closeTo(0.2, 5),
				expect.closeTo(0.3, 5),
			]);
			expect(cache.hitCount).toBe(1);
			expect(cache.missCount).toBe(1);
			cache.close();
		} finally {
			rmrf(dir);
		}
	});

	it("salts the hash with the model so a backend swap misses the cache", () => {
		const dir = makeTempDir("pce-cache-");
		try {
			const a = new EmbeddingCache(path.join(dir, "a.db"), { modelSalt: "a" });
			const b = new EmbeddingCache(path.join(dir, "b.db"), { modelSalt: "b" });
			expect(a.contentHash("same text")).not.toBe(b.contentHash("same text"));
			a.close();
			b.close();
		} finally {
			rmrf(dir);
		}
	});

	it("prunes orphans to bound disk growth", () => {
		const dir = makeTempDir("pce-cache-");
		try {
			const cache = new EmbeddingCache(path.join(dir, "cache.db"), { modelSalt: "m" });
			const keep = cache.contentHash("keep");
			const drop = cache.contentHash("drop");
			cache.putBatch([
				{ hash: keep, embedding: [0.1] },
				{ hash: drop, embedding: [0.2] },
			]);
			expect(cache.pruneOrphans(new Set([keep]))).toBe(1);
			expect(cache.get(keep)).not.toBeNull();
			expect(cache.get(drop)).toBeNull();
			cache.close();
		} finally {
			rmrf(dir);
		}
	});
});

describe("storage layout", () => {
	it("creates separate databases per store", () => {
		const dir = makeTempDir("pce-layout-");
		try {
			const store = new LocalBackend(dir);
			store.close();
			expect(fs.existsSync(path.join(dir, "vectors", "vectors.db"))).toBe(true);
			expect(fs.existsSync(path.join(dir, "fts", "fts.db"))).toBe(true);
			expect(fs.existsSync(path.join(dir, "graph.db"))).toBe(true);
		} finally {
			rmrf(dir);
		}
	});
});
