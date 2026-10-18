/**
 * Confidence scoring — port of upstream `retrieval/confidence.py` (MIT).
 * Weighted sum: vector similarity 0.5, keyword/file-hint 0.4, recency 0.1.
 */
import type { Chunk } from "../types.js";
import type { ParsedQuery } from "./query-parser.js";
import type { QuerySignals } from "./retriever.js";

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

// ── R8: query-level confidence ─────────────────────────────────────────────

export type QueryConfidence = "high" | "medium" | "low";

export interface QueryAssessment {
	level: QueryConfidence;
	/** Composite 0..1 quality score (reported for observability). */
	quality: number;
	/** 1-3 deterministic recovery hints; non-empty only below `high`. */
	hints: string[];
}

/** Signal weights for the composite quality score. */
const SIGNAL_WEIGHTS = { topScore: 0.5, agreement: 0.35, margin: 0.15 };
/** Candidate pools this small cap the level at `medium` (tiny indexes lie). */
const MIN_CANDIDATES = 5;

/**
 * Map query signals to high/medium/low plus recovery hints. Thresholds come
 * from config (calibrated on the eval fixture); hints are derived from the
 * parsed query so the agent gets actionable, deterministic advice instead of
 * a silent rewrite it cannot inspect.
 */
export function assessQuery(
	signals: QuerySignals,
	parsed: ParsedQuery,
	thresholds: { high: number; low: number },
): QueryAssessment {
	const marginNorm = Math.min(1, Math.max(0, signals.margin));
	const quality =
		SIGNAL_WEIGHTS.topScore * Math.min(1, Math.max(0, signals.topScore)) +
		SIGNAL_WEIGHTS.agreement * Math.min(1, Math.max(0, signals.agreement)) +
		SIGNAL_WEIGHTS.margin * marginNorm;

	let level: QueryConfidence;
	if (quality >= thresholds.high) level = "high";
	else if (quality >= thresholds.low) level = "medium";
	else level = "low";
	if (signals.candidates < MIN_CANDIDATES && level === "high") level = "medium";

	const hints: string[] = [];
	if (level !== "high") {
		if (parsed.fileHints.length === 0) hints.push("name a file or path fragment (e.g. retriever.ts)");
		const identifierLike = parsed.keywords.some((k) => k.length >= 4 && /[a-z][A-Z]|[A-Z][a-z]/.test(k));
		if (!identifierLike) hints.push("use an exact symbol name (function or class, e.g. HybridRetriever)");
		if (parsed.keywords.length > 8) hints.push("drop vague terms; keep 2-4 specific keywords");
		if (signals.agreement < 0.2) hints.push("results disagree between retrieval paths; try a more specific query");
	}
	return { level, quality, hints: hints.slice(0, 3) };
}
