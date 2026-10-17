/**
 * Confidence scoring — port of upstream `retrieval/confidence.py` (MIT).
 * Weighted sum: vector similarity 0.5, keyword/file-hint 0.4, recency 0.1.
 */
import type { Chunk } from "../types.js";

const VECTOR_WEIGHT = 0.5;
const KEYWORD_WEIGHT = 0.4;
const RECENCY_WEIGHT = 0.1;
const MAX_KEYWORD_DISTANCE = 5;
const RECENCY_HALF_LIFE = 7 * 24 * 3600; // 1 week

export class ConfidenceScorer {
	score(chunk: Chunk, vectorDistance: number, keywordDistance: number): number {
		const vectorScore = Math.max(0, 1 - vectorDistance);
		const keywordScore = Math.max(0, 1 - keywordDistance / MAX_KEYWORD_DISTANCE);
		const recencyScore = this.recencyScore(chunk);
		const combined = VECTOR_WEIGHT * vectorScore + KEYWORD_WEIGHT * keywordScore + RECENCY_WEIGHT * recencyScore;
		return Math.min(1, Math.max(0, combined));
	}

	private recencyScore(chunk: Chunk): number {
		const modifiedTs = chunk.metadata["modified_ts"];
		if (typeof modifiedTs !== "number") return 0.5;
		const ageSeconds = Date.now() / 1000 - modifiedTs;
		if (ageSeconds <= 0) return 1;
		return Math.pow(0.5, ageSeconds / RECENCY_HALF_LIFE);
	}
}
