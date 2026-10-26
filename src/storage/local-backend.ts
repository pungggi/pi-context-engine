/**
 * Local storage backend — port of upstream `storage/local_backend.py` (MIT).
 */
import path from "node:path";
import { VectorStore } from "./vector-store.js";
import { FTSStore } from "./fts-store.js";
import { GraphStore } from "./graph-store.js";
import type { Chunk, EdgeType, GraphEdge, GraphNode } from "../types.js";

export class LocalBackend {
	private vectorStore: VectorStore;
	private ftsStore: FTSStore;
	private graphStore: GraphStore;
	/** R7: cached PageRank table; refreshed by recomputePriors(). */
	private pageRankCache: Map<string, number> | null = null;
	/** WP2: cached symbol-level PageRank table; refreshed by recomputePriors(). */
	private symbolPageRankCache: Map<string, number> | null = null;

	constructor(basePath: string) {
		this.vectorStore = new VectorStore(path.join(basePath, "vectors"));
		this.ftsStore = new FTSStore(path.join(basePath, "fts"));
		this.graphStore = new GraphStore(path.join(basePath, "graph"));
	}

	ingest(chunks: Chunk[], nodes: GraphNode[], edges: GraphEdge[]): void {
		this.vectorStore.ingest(chunks);
		this.ftsStore.ingest(chunks);
		this.graphStore.ingest(nodes, edges);
	}

	vectorSearch(queryEmbedding: readonly number[], topK = 10, filters?: { filePath?: string }): Chunk[] {
		return this.vectorStore.search(queryEmbedding, topK, filters);
	}

	ftsSearch(query: string, topK = 30): { id: string; rank: number }[] {
		return this.ftsStore.search(query, topK);
	}

	graphNeighbors(nodeId: string, edgeType?: EdgeType): GraphNode[] {
		return this.graphStore.getNeighbors(nodeId, edgeType);
	}

	/** Files reachable via CALLS/IMPORTS/markdown-reference edges from the given files (1-hop expansion). */
	getRelatedFilePaths(filePaths: string[]): string[] {
		if (filePaths.length === 0) return [];
		const inputSet = new Set(filePaths);
		// WP3: `references` edges hang off prose `doc` chunks, so `doc` joins the
		// source-node filter or linked notes would never surface here.
		const neighbors = this.graphStore.neighborsForFiles(
			filePaths,
			["calls", "imports", "references"],
			["function", "class", "file", "module", "doc"],
		);
		return [...new Set(neighbors.map((n) => n.filePath).filter((fp) => fp && !inputSet.has(fp)))];
	}

	getChunkById(chunkId: string): Chunk | null {
		return this.vectorStore.getById(chunkId);
	}

	/** R7 + WP2: recompute file and symbol PageRank after indexing. */
	recomputePriors(): void {
		this.graphStore.computePageRank();
		this.graphStore.computeSymbolPageRank();
		this.pageRankCache = null;
		this.symbolPageRankCache = null;
	}

	/** R7: cached file→[0,1] PageRank (empty until first recomputePriors). */
	pageRanks(): Map<string, number> {
		if (!this.pageRankCache) this.pageRankCache = this.graphStore.pageRanks();
		return this.pageRankCache;
	}

	/** WP2: cached node id→[0,1] symbol centrality (empty until first recomputePriors). */
	symbolPageRanks(): Map<string, number> {
		if (!this.symbolPageRankCache) this.symbolPageRankCache = this.graphStore.symbolPageRanks();
		return this.symbolPageRankCache;
	}

	/** R5: symbol lookup over graph node names (exact / `.suffix`). */
	findSymbols(names: string[], limit = 20): GraphNode[] {
		return this.graphStore.findSymbols(names, limit);
	}

	/** R9: graph nodes of one file (sibling-symbol hints). */
	getNodesByFile(filePath: string): GraphNode[] {
		return this.graphStore.getNodesByFile(filePath);
	}

	/** PR #7 review: all function/class nodes, for incremental call-graph derivation. */
	listSymbolNodes(): GraphNode[] {
		return this.graphStore.listSymbolNodes();
	}

	/** R5: chunks of one file in source order. */
	chunksByFile(filePath: string, limit = 10): Chunk[] {
		return this.vectorStore.byFile(filePath, limit);
	}

	getChunksByIds(chunkIds: string[]): Chunk[] {
		return this.vectorStore.getChunksByIds(chunkIds);
	}

	deleteByFile(filePath: string): void {
		this.deleteByFiles([filePath]);
	}

	deleteByFiles(filePaths: string[]): void {
		if (filePaths.length === 0) return;
		this.vectorStore.deleteByFiles(filePaths);
		this.ftsStore.deleteByFiles(filePaths);
		this.graphStore.deleteByFiles(filePaths);
		this.pageRankCache = null;
		this.symbolPageRankCache = null;
	}

	countChunks(): number {
		return this.vectorStore.count();
	}

	fileChunkCounts(): Record<string, number> {
		return this.vectorStore.fileChunkCounts();
	}

	getCachedCompression(chunkId: string, level: string): string | null {
		return this.vectorStore.getCachedCompression(chunkId, level);
	}

	putCachedCompression(chunkId: string, level: string, compressed: string): void {
		this.vectorStore.putCachedCompression(chunkId, level, compressed);
	}

	clear(): void {
		this.vectorStore.clear();
		this.ftsStore.clear();
		this.graphStore.clear();
		this.pageRankCache = null;
		this.symbolPageRankCache = null;
	}

	close(): void {
		this.vectorStore.close();
		this.ftsStore.close();
		this.graphStore.close();
	}
}
