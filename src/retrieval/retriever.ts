/**
 * Hybrid retrieval — vector + BM25 via Reciprocal Rank Fusion with confidence
 * blending and graph expansion. Port of upstream `retrieval/retriever.py` (MIT).
 */
import type { Chunk } from "../types.js";
import type { LocalBackend } from "../storage/local-backend.js";
import type { Embedder } from "../indexer/embedder.js";
import { parseContextHeaderUnit } from "../indexer/context-header.js";
import { ConfidenceScorer } from "./confidence.js";
import { elaborateQuery, QueryParser, type ParsedQuery } from "./query-parser.js";
import type { RerankerLike } from "./reranker.js";

const DEPRIORITISED_PATHS = ["tests/", "test_", "docs/", "spec", "plan"];
const RRF_K = 60;
const CONFIDENCE_WEIGHT = 0.5;
const MAX_CHUNKS_PER_FILE = 3;
const FTS_BOOST_CODE_LOOKUP = 1.5;
const WORST_COSINE_DISTANCE = 2.0;
/** R2: reweight near-ties toward the chunk that defines an exact query symbol. */
const SYMBOL_MATCH_BONUS = 0.06;
/** R5: structured paths — symbol nodes and explicit file hints as extra RRF lists. */
const SYMBOL_LIST_MAX = 20;
const HINT_FILES_MAX = 2;
const HINT_CHUNKS_PER_FILE = 10;
const HINT_PATH_BOOST = 1.5;
/** R6: small-to-big serving — parent module + adjacent chunk for top hits. */
const EXPAND_FILES_MAX = 3;
const EXPAND_NEIGHBOR_GAP = 30;
const EXPAND_SIBLINGS_LOOKUP = 16;
/** R7: max multiplicative boost from the file PageRank prior (hub files). */
const PAGE_RANK_WEIGHT = 0.1;
/** R8: auto-elaborated candidates fuse at half weight and never outscore a raw hit. */
const ELABORATE_WEIGHT = 0.5;
/** R10: opt-in reranker reorders at most this many fused candidates. */
const RERANK_TOPN = 30;
/** R10: blend weight of the reranker score vs the fused score. */
const RERANK_WEIGHT = 0.7;

/** R8: deterministic query-quality signals exposed to the engine/tool layer. */
export interface QuerySignals {
	/** Best final score after fusion (0..1). */
	topScore: number;
	/** Score drop from the top hit to the best hit from a DIFFERENT file. */
	margin: number;
	/** Jaccard overlap of vector-top-10 and FTS-top-10 ids (0..1). */
	agreement: number;
	/** Distinct candidates that reached fusion. */
	candidates: number;
}

export interface RetrieveOptions {
	topK?: number;
	confidenceThreshold?: number;
	maxTokens?: number | null;
	marginalRatio?: number;
	statsOut?: {
		candidates?: number;
		selected?: number;
		droppedLowValue?: number;
		/** R8: filled on every call; consumed by the confidence line in results. */
		querySignals?: QuerySignals;
		/** R9: files ranked 11-15 but not served — refine-hint material. */
		nearMissFiles?: string[];
	};
}

export class HybridRetriever {
	private backend: LocalBackend;
	private embedder: Embedder;
	private scorer = new ConfidenceScorer();
	private parser = new QueryParser();
	private expandContext: boolean;
	private autoElaborate: boolean;
	private reranker: RerankerLike | null;

	constructor(
		backend: LocalBackend,
		embedder: Embedder,
		options: { expandContext?: boolean; autoElaborate?: boolean; reranker?: RerankerLike | null } = {},
	) {
		this.backend = backend;
		this.embedder = embedder;
		this.expandContext = options.expandContext ?? true;
		this.autoElaborate = options.autoElaborate ?? false;
		this.reranker = options.reranker ?? null;
	}

	async retrieve(query: string, options: RetrieveOptions = {}): Promise<Chunk[]> {
		const topK = options.topK ?? 10;
		const confidenceThreshold = options.confidenceThreshold ?? 0;
		const maxTokens = options.maxTokens ?? null;
		const marginalRatio = options.marginalRatio ?? 0;

		const parsed = this.parser.parse(query);
		const queryEmbedding = await this.embedder.embedQuery(query);

		const vectorResults = this.backend.vectorSearch(queryEmbedding, Math.max(topK * 3, 1));
		const ftsResults = this.backend.ftsSearch(query, topK * 3);
		const ftsIds = new Map<string, number>(ftsResults.map((r, i) => [r.id, i]));

		const vectorRanks = new Map<string, number>();
		const chunkMap = new Map<string, Chunk>();
		const seenKeys = new Set<string>();

		vectorResults.forEach((chunk, rank) => {
			const dedupKey = `${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`;
			if (seenKeys.has(dedupKey)) return;
			seenKeys.add(dedupKey);
			vectorRanks.set(chunk.id, rank);
			chunkMap.set(chunk.id, chunk);
		});

		const ftsOnlyIds = [...ftsIds.keys()].filter((id) => !chunkMap.has(id));
		if (ftsOnlyIds.length > 0) {
			for (const chunk of this.backend.getChunksByIds(ftsOnlyIds)) {
				chunkMap.set(chunk.id, chunk);
			}
		}

		// ── R5: structured paths ───────────────────────────────────────────────
		// Two deterministic lists fused alongside vector and BM25: exact symbol
		// hits from the graph index (so an identifier query hits the definition,
		// not prose about it) and the chunks of files the query names outright.
		// Evidence: CodeRAG's multi-path retrieval is a core reason it beats
		// single-similarity baselines on repo-level tasks.
		const symbolRanks = new Map<string, number>();
		const hintRanks = new Map<string, number>();
		if (parsed.keywords.length > 0) {
			this.backend.findSymbols(parsed.keywords, SYMBOL_LIST_MAX).forEach((node, i) => {
				symbolRanks.set(node.id, i);
			});
		}
		if (parsed.fileHints.length > 0) {
			const files = Object.keys(this.backend.fileChunkCounts());
			let rank = 0;
			for (const hint of parsed.fileHints.slice(0, 3)) {
				const matches = files.filter((f) => f.includes(hint)).sort().slice(0, HINT_FILES_MAX);
				for (const file of matches) {
					for (const chunk of this.backend.chunksByFile(file, HINT_CHUNKS_PER_FILE)) {
						if (!hintRanks.has(chunk.id)) hintRanks.set(chunk.id, rank++);
					}
				}
			}
		}
		const structuredOnlyIds = [...symbolRanks.keys(), ...hintRanks.keys()].filter((id) => !chunkMap.has(id));
		if (structuredOnlyIds.length > 0) {
			for (const chunk of this.backend.getChunksByIds(structuredOnlyIds)) chunkMap.set(chunk.id, chunk);
		}

		// ── R8: optional deterministic elaboration ────────────────────────────
		// A stopword-stripped variant enriched with terms from near-miss FTS
		// hits, searched AGAIN and fused as an extra candidate source at half
		// weight. Only ids the raw lists missed are eligible, so every raw
		// candidate's score (and their order among themselves) is untouched —
		// elaboration can only add, never demote. Default off; the eval runs
		// with it off so the gate measures the un-elaborated baseline.
		const elaboratedRanks = new Map<string, number>();
		if (this.autoElaborate && parsed.keywords.length > 0) {
			try {
				const nearMiss = this.backend.getChunksByIds([...ftsIds.keys()].slice(0, 5));
				const variant = elaborateQuery(query, nearMiss);
				if (variant) {
					const variantEmbedding = await this.embedder.embedQuery(variant);
					const seenRaw = (id: string): boolean => vectorRanks.has(id) || ftsIds.has(id);
					this.backend.vectorSearch(variantEmbedding, topK * 3).forEach((c, rank) => {
						if (!seenRaw(c.id) && !elaboratedRanks.has(c.id)) elaboratedRanks.set(c.id, rank);
					});
					this.backend.ftsSearch(variant, topK * 3).forEach((r, i) => {
						if (!seenRaw(r.id) && !elaboratedRanks.has(r.id)) elaboratedRanks.set(r.id, i);
					});
					const elabOnlyIds = [...elaboratedRanks.keys()].filter((id) => !chunkMap.has(id));
					if (elabOnlyIds.length > 0) {
						for (const chunk of this.backend.getChunksByIds(elabOnlyIds)) chunkMap.set(chunk.id, chunk);
					}
				}
			} catch {
				// elaboration is best-effort
			}
		}

		const ftsWeight = parsed.intent === "code_lookup" ? FTS_BOOST_CODE_LOOKUP : 1.0;
		const symbolWeight = parsed.intent === "code_lookup" ? FTS_BOOST_CODE_LOOKUP : 1.0;
		const pageRanks = this.backend.pageRanks();
		const allIds = new Set([
			...vectorRanks.keys(),
			...ftsIds.keys(),
			...symbolRanks.keys(),
			...hintRanks.keys(),
			...elaboratedRanks.keys(),
		]);
		const rrfScores = new Map<string, number>();
		for (const id of allIds) {
			let score = 0;
			const vRank = vectorRanks.get(id);
			if (vRank !== undefined) score += 1 / (RRF_K + vRank);
			const fRank = ftsIds.get(id);
			if (fRank !== undefined) score += ftsWeight * (1 / (RRF_K + fRank));
			const sRank = symbolRanks.get(id);
			if (sRank !== undefined) score += symbolWeight * (1 / (RRF_K + sRank));
			const hRank = hintRanks.get(id);
			if (hRank !== undefined) score += HINT_PATH_BOOST * (1 / (RRF_K + hRank));
			const eRank = elaboratedRanks.get(id);
			if (eRank !== undefined) score += ELABORATE_WEIGHT * (1 / (RRF_K + eRank));
			rrfScores.set(id, score);
		}
		const maxRrf = Math.max(0, ...rrfScores.values());

		const observedDistances = vectorResults
			.map((c) => c.metadata["_distance"])
			.filter((d): d is number => typeof d === "number");
		const noVectorDistance = observedDistances.length > 0 ? Math.max(...observedDistances) : WORST_COSINE_DISTANCE;

		const scored: { chunk: Chunk; score: number }[] = [];
		for (const [id, rrfScore] of rrfScores) {
			const chunk = chunkMap.get(id);
			if (!chunk) continue;
			const distanceRaw = chunk.metadata["_distance"];
			const distance = typeof distanceRaw === "number" ? distanceRaw : noVectorDistance;
			const normalisedDistance = Math.min(Math.max(distance / 2, 0), 1);
			const keywordDistance = estimateKeywordDistance(chunk, parsed);
			const confScore = this.scorer.score(chunk, normalisedDistance, keywordDistance);
			const normalisedRrf = maxRrf > 0 ? rrfScore / maxRrf : 0;
			let finalScore = CONFIDENCE_WEIGHT * confScore + (1 - CONFIDENCE_WEIGHT) * normalisedRrf;
			finalScore += symbolBonus(chunk, parsed);
			// R7: bounded PageRank prior. Structured-importance signal (CodeRank:
			// PageRank over the code graph lifts entry points and hubs above
			// equally-matching leaves). Multiplicative and capped so it can only
			// break ties between near-equal candidates, never override evidence.
			const prior = pageRanks.get(chunk.filePath) ?? 0;
			if (prior > 0) finalScore *= 1 + PAGE_RANK_WEIGHT * prior;
			finalScore = applyPathPenalty(chunk.filePath, finalScore);
			chunk.confidenceScore = finalScore;
			scored.push({ chunk, score: finalScore });
		}

		scored.sort((a, b) => b.score - a.score);

		// ── R10: opt-in rerank of the fused list ─────────────────────────────
		// Reorders the top candidates only; penalties, dedupe, diversity and
		// the marginal stop below are untouched. A failed/missing model leaves
		// the fused order in place (rerank() returns []).
		if (this.reranker && scored.length > 1) {
			const topN = scored.slice(0, RERANK_TOPN);
			const docs = topN.map((s) => s.chunk.compressedContent || s.chunk.content);
			let rerankScores: number[] = [];
			try {
				rerankScores = await this.reranker.rerank(query, docs);
			} catch {
				// reranking is best-effort: model missing/offline → fused order stands
			}
			if (rerankScores.length === topN.length) {
				const min = Math.min(...rerankScores);
				const max = Math.max(...rerankScores);
				const maxOld = topN[0]!.score || 1;
				if (max > min) {
					for (let i = 0; i < topN.length; i++) {
						const norm = (rerankScores[i]! - min) / (max - min);
						const blended = RERANK_WEIGHT * norm + (1 - RERANK_WEIGHT) * (topN[i]!.score / maxOld);
						topN[i]!.score = blended;
						topN[i]!.chunk.confidenceScore = blended;
					}
					// PR #7 review: a reranked candidate can blend down to ~0.3 while
					// unreranked rank-31+ entries keep their raw ~0.7 scores — a full
					// sort would promote unjudged tail hits OVER judged ones. Cap the
					// tail strictly below the blended floor so reranking can only
					// reorder within the judged set.
					capTailBelowRerankedFloor(scored, RERANK_TOPN);
					scored.sort((a, b) => b.score - a.score);
				}
			}
		}

		const deduped = dedupeOverlaps(scored);
		const candidates = deduped.length;

		let filtered = deduped.filter((s) => s.score >= confidenceThreshold);
		if (filtered.length === 0 && deduped.length > 0) filtered = deduped.slice(0, 1);
		const droppedLowValue = candidates - filtered.length;

		// ── R8: query-quality signals ────────────────────────────────────────
		// Deterministic inputs for the confidence line: absolute top score,
		// the margin to the best hit from a different file (single-file results
		// are fragile), vector/FTS agreement (two independent retrievers
		// landing on the same chunks is the strongest quality signal), and the
		// candidate count floor (tiny candidate pools are unreliable).
		const firstHit = filtered[0]?.chunk;
		let nextFileScore = -1;
		if (firstHit) {
			for (const s of filtered) {
				if (s.chunk.filePath !== firstHit.filePath) {
					nextFileScore = s.score;
					break;
				}
			}
		}
		const vTop = new Set([...vectorRanks.keys()].slice(0, 10));
		const fTop = new Set([...ftsIds.keys()].slice(0, 10));
		let agreeInter = 0;
		for (const id of vTop) if (fTop.has(id)) agreeInter += 1;
		const agreeUnion = new Set([...vTop, ...fTop]).size;
		const querySignals: QuerySignals = {
			topScore: filtered[0]?.score ?? 0,
			margin: firstHit ? (nextFileScore >= 0 ? filtered[0]!.score - nextFileScore : filtered[0]!.score) : 0,
			agreement: agreeUnion > 0 ? agreeInter / agreeUnion : 0,
			candidates: allIds.size,
		};

		// File diversity + marginal stop, with R6 small-to-big expansion: the
		// first hit from a file pulls in its module parent and the closest
		// neighbouring chunk so the agent gets surrounding context in ONE call
		// instead of a follow-up expand_chunk (cross-file context length is the
		// dominant quality factor in the controlled chunking study). Extras obey
		// the same per-file cap: they ride along with an accepted hit, they never
		// displace other files.
		// Compare against a REPRESENTATIVE top score (3rd best), not the single
		// best: one outlier at 0.9 used to push everything from rank ~5 onward
		// below 0.75×top and cut true hits that raw ranking put at 5-15 (seen on
		// five eval queries). The stop exists to shed junk tails, not to trust a
		// lucky first candidate.
		const topScore = filtered.length > 0 ? filtered[Math.min(2, filtered.length - 1)]!.score : 0;
		const fileCounts = new Map<string, number>();
		const diverse: Chunk[] = [];
		const diverseKeys = new Set<string>();
		const expandedFiles = new Set<string>();
		let marginalDropped = 0;
		const push = (chunk: Chunk): boolean => {
			const key = `${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`;
			if (diverseKeys.has(key)) return false;
			const count = fileCounts.get(chunk.filePath) ?? 0;
			if (count >= MAX_CHUNKS_PER_FILE) return false;
			diverseKeys.add(key);
			diverse.push(chunk);
			fileCounts.set(chunk.filePath, count + 1);
			return true;
		};

		for (let idx = 0; idx < filtered.length; idx++) {
			const { chunk, score } = filtered[idx]!;
			if (diverse.length > 0 && marginalRatio > 0 && score < marginalRatio * topScore) {
				marginalDropped = filtered.length - idx;
				break;
			}
			if (diverse.length >= topK) break;
			if (!push(chunk)) continue;
			if (
				this.expandContext &&
				!expandedFiles.has(chunk.filePath) &&
				expandedFiles.size < EXPAND_FILES_MAX
			) {
				expandedFiles.add(chunk.filePath);
				for (const extra of this.expansionChunks(chunk)) {
					if (diverse.length >= topK) break;
					push(extra);
				}
			}
		}
		let ranked = diverse;

		// Graph expansion: bonus chunks from files reachable via CALLS/IMPORTS.
		if (ranked.length > 0) {
			try {
				const topFiles = [...new Set(ranked.slice(0, 3).map((c) => c.filePath))];
				const relatedFiles = this.backend.getRelatedFilePaths(topFiles);
				for (const relFp of relatedFiles.slice(0, 2)) {
					const bonus = this.backend.vectorSearch(queryEmbedding, 2, { filePath: relFp });
					for (const b of bonus) {
						const dedupKey = `${b.filePath}:${b.startLine}-${b.endLine}`;
						if (seenKeys.has(dedupKey)) continue;
						seenKeys.add(dedupKey);
						const dist = typeof b.metadata["_distance"] === "number" ? (b.metadata["_distance"] as number) : 1;
						b.confidenceScore = Math.max(0, 1 - dist) * 0.85;
						if (b.confidenceScore >= confidenceThreshold) ranked.push(b);
					}
				}
			} catch {
				// graph expansion is best-effort
			}
		}

		// R9: near-miss files for refine hints — ranked 11-15 after dedupe but
		// not served. Surfaced instead of silently vanishing so the tool result
		// can point the agent one step deeper at near-zero token cost.
		const servedFiles = new Set(diverse.map((c) => c.filePath));
		const nearMissFiles = [...new Set(filtered.slice(10, 15).map((s) => s.chunk.filePath))]
			.filter((f) => !servedFiles.has(f))
			.slice(0, 2);

		const stats = {
			candidates,
			selected: 0,
			droppedLowValue: droppedLowValue + marginalDropped,
			querySignals,
			nearMissFiles,
		};
		if (maxTokens === null) {
			stats.selected = ranked.length;
			if (options.statsOut) Object.assign(options.statsOut, stats);
			return ranked;
		}

		const packed: Chunk[] = [];
		let budget = maxTokens;
		for (const chunk of ranked) {
			const tokens = chunkTokenCountFor(chunk);
			if (tokens <= budget) {
				packed.push(chunk);
				budget -= tokens;
			} else if (chunk.compressedContent) {
				const compressedTokens = Math.max(1, Math.floor(chunk.compressedContent.length / 3.3));
				if (compressedTokens <= budget) {
					packed.push(chunk);
					budget -= compressedTokens;
				}
			}
		}
		stats.selected = packed.length;
		if (options.statsOut) Object.assign(options.statsOut, stats);
		return packed;
	}
	/**
	 * R6: parent context for an accepted hit — the file's module chunk plus the
	 * closest function/class chunk within a 30-line gap. Looked up from storage
	 * (cheap, ≤16 rows) so it works for hits that arrived via any path.
	 */
	private expansionChunks(hit: Chunk): Chunk[] {
		try {
			const siblings = this.backend.chunksByFile(hit.filePath, EXPAND_SIBLINGS_LOOKUP);
			const moduleChunk = siblings.find(
				(c) => c.chunkType === "module" && !(c.startLine === hit.startLine && c.endLine === hit.endLine),
			);
			let neighbor: Chunk | undefined;
			let bestGap = Number.POSITIVE_INFINITY;
			for (const c of siblings) {
				if (c.chunkType === "module" || c.id === hit.id) continue;
				const gap =
					c.startLine > hit.endLine
						? c.startLine - hit.endLine - 1
						: hit.startLine > c.endLine
							? hit.startLine - c.endLine - 1
							: -1;
				if (gap >= 0 && gap <= EXPAND_NEIGHBOR_GAP && gap < bestGap) {
					bestGap = gap;
					neighbor = c;
				}
			}
			const out: Chunk[] = [];
			if (moduleChunk) out.push(moduleChunk);
			if (neighbor) out.push(neighbor);
			return out;
		} catch {
			return []; // expansion is best-effort
		}
	}
}

function chunkTokenCountFor(chunk: Chunk): number {
	const text = chunk.compressedContent || chunk.content;
	return Math.max(1, Math.floor(text.length / 3.3));
}

function applyPathPenalty(filePath: string, score: number): number {
	if (filePath.startsWith("git:")) return score;
	const fp = filePath.toLowerCase();
	for (const marker of DEPRIORITISED_PATHS) {
		if (fp.includes(marker)) return score * 0.8;
	}
	return score;
}

/**
 * PR #7 review fix: after blending rerank scores into the top-N, cap every
 * unreranked tail entry strictly below the blended floor (monotonically
 * decreasing, preserving the tail's own order). Without this, a full sort
 * promotes unjudged rank-31+ hits over reranked candidates whose blend
 * dropped low. Exported for unit testing.
 */
export function capTailBelowRerankedFloor(scored: { score: number }[], topN: number): void {
	if (scored.length <= topN) return;
	let floor = Math.min(...scored.slice(0, topN).map((s) => s.score));
	for (let i = topN; i < scored.length; i++) {
		floor = Math.min(floor - 1e-6, scored[i]!.score);
		scored[i]!.score = floor;
	}
}

function dedupeOverlaps(scored: { chunk: Chunk; score: number }[]): { chunk: Chunk; score: number }[] {
	const kept: { chunk: Chunk; score: number }[] = [];
	for (const { chunk, score } of scored) {
		let duplicate = false;
		// Module chunks are the file's parent context: their span legitimately
		// covers every function chunk, so overlap-based dedupe would delete the
		// whole point of R6. Only leaf-vs-leaf overlaps are duplicates.
		const isParent = chunk.chunkType === "module";
		for (const k of kept) {
			const kc = k.chunk;
			if (isParent || kc.chunkType === "module") continue;
			if (kc.filePath !== chunk.filePath) continue;
			const overlap =
				Math.min(chunk.endLine, kc.endLine) - Math.max(chunk.startLine, kc.startLine) + 1;
			if (overlap <= 0) continue;
			const shorter = Math.min(chunk.endLine - chunk.startLine + 1, kc.endLine - kc.startLine + 1);
			if (shorter > 0 && overlap / shorter > 0.5) {
				duplicate = true;
				break;
			}
		}
		if (!duplicate) kept.push({ chunk, score });
	}
	return kept;
}

/**
 * R2c: when a query names an exact symbol (`atomicWriteText`,
 * `HybridRetriever`), the chunk whose unit *defines* that name should win
 * near-ties against chunks that merely discuss it. High precision by design:
 * whole-segment, case-insensitive equality only, small constant bonus, so it
 * never outvotes real relevance evidence.
 */
function symbolBonus(chunk: Chunk, parsed: ParsedQuery): number {
	const unit =
		typeof chunk.metadata["unit"] === "string"
			? (chunk.metadata["unit"] as string)
			: parseContextHeaderUnit(chunk.content);
	if (!unit) return 0;
	const segments = unit.split(".").map((s) => s.toLowerCase());
	for (const kw of parsed.keywords) {
		const k = kw.toLowerCase();
		if (k.length < 3) continue;
		if (segments.includes(k)) return SYMBOL_MATCH_BONUS;
	}
	return 0;
}

/**
 * Keyword evidence as COVERAGE, not any-hit. One generic word ("result",
 * "list") used to earn the same full credit as naming the actual identifier,
 * which let loosely-related chunks score like precise matches. Identifiers
 * (camelCase / snake_case / acronyms) weigh 3x: they are rare and specific,
 * which is exactly what code search rewards (see R2 evidence: BM25 and exact
 * matching dominate code retrieval).
 */
function estimateKeywordDistance(chunk: Chunk, parsed: ParsedQuery): number {
	if (parsed.fileHints.length > 0) {
		for (const hint of parsed.fileHints) {
			if (chunk.filePath.includes(hint)) return 0;
		}
	}
	const content = chunk.content.toLowerCase();
	let total = 0;
	let covered = 0;
	for (const keyword of parsed.keywords) {
		const weight = identifierLike(keyword) ? 3 : 1;
		total += weight;
		if (content.includes(keyword.toLowerCase())) covered += weight;
	}
	if (total === 0) return 2;
	// 0 = every keyword present, 2 = none present (the old miss value).
	return (1 - covered / total) * 2;
}

function identifierLike(keyword: string): boolean {
	return keyword.length >= 3 && (/[A-Z]/.test(keyword) || keyword.includes("_"));
}
