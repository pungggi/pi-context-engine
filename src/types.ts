/**
 * Shared data models — port of upstream `context_engine/models.py` (MIT,
 * elara-labs). Shapes are kept compatible so on-disk formats stay familiar.
 */

export type ChunkType =
	| "function"
	| "class"
	| "module"
	| "doc"
	| "comment"
	| "commit"
	| "session"
	| "decision";

export type NodeType =
	| "function"
	| "class"
	| "file"
	| "module"
	| "doc"
	| "commit"
	| "session"
	| "decision";

export type EdgeType = "calls" | "imports" | "defines" | "modifies" | "discussed_in" | "decided";

export type ConfidenceLevel = "high" | "medium" | "low";

export function confidenceLevelFromScore(score: number): ConfidenceLevel {
	if (score > 0.8) return "high";
	if (score >= 0.5) return "medium";
	return "low";
}

export interface Chunk {
	id: string;
	content: string;
	chunkType: ChunkType;
	filePath: string;
	startLine: number;
	endLine: number;
	language: string;
	metadata: Record<string, unknown>;
	embedding: number[] | null;
	confidenceScore: number;
	compressedContent: string | null;
}

/** chars/token heuristic used by upstream for code-shaped text. */
export const CHARS_PER_TOKEN_CODE = 3.3;

export function chunkTokenCount(chunk: Chunk): number {
	const text = chunk.compressedContent || chunk.content;
	return Math.max(1, Math.floor(text.length / CHARS_PER_TOKEN_CODE));
}

export interface GraphNode {
	id: string;
	nodeType: NodeType;
	name: string;
	filePath: string;
	properties: Record<string, unknown>;
}

export interface GraphEdge {
	sourceId: string;
	targetId: string;
	edgeType: EdgeType;
	properties: Record<string, unknown>;
}

export interface RetrievalResult {
	chunks: Chunk[];
	graphNodes: GraphNode[];
	graphEdges: GraphEdge[];
	query: string;
	confidenceScores: Record<string, number>;
}

export function makeChunk(partial: Partial<Chunk> & Pick<Chunk, "id" | "content" | "chunkType" | "filePath" | "startLine" | "endLine" | "language">): Chunk {
	return {
		metadata: {},
		embedding: null,
		confidenceScore: 0,
		compressedContent: null,
		...partial,
	};
}
