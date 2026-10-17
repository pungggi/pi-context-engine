/**
 * Hybrid retrieval — vector + BM25 via Reciprocal Rank Fusion with confidence
 * blending and graph expansion. Port of upstream `retrieval/retriever.py` (MIT).
 */
import type { Chunk } from "../types.js";
import type { LocalBackend } from "../storage/local-backend.js";
import type { Embedder } from "../indexer/embedder.js";
import { ConfidenceScorer } from "./confidence.js";
import { QueryParser, type ParsedQuery } from "./query-parser.js";

const DEPRIORITISED_PATHS = ["tests/", "test_", "docs/", "spec", "plan"];
const RRF_K = 60;
const CONFIDENCE_WEIGHT = 0.5;
const MAX_CHUNKS_PER_FILE = 3;
const FTS_BOOST_CODE_LOOKUP = 1.5;
const WORST_COSINE_DISTANCE = 2.0;

export interface RetrieveOptions {
	topK?: number;
	confidenceThreshold?: number;
	maxTokens?: number | null;
	marginalRatio?: number;
	statsOut?: { candidates?: number; selected?: number; droppedLowValue?: number };
}

export class HybridRetriever {
	private backend: LocalBackend;
	private embedder: Embedder;
	private scorer = new ConfidenceScorer();
	private parser = new QueryParser();

	constructor(backend: LocalBackend, embedder: Embedder) {
		this.backend = backend;
		this.embedder = embedder;
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

		const ftsWeight = parsed.intent === "code_lookup" ? FTS_BOOST_CODE_LOOKUP : 1.0;
		const allIds = new Set([...vectorRanks.keys(), ...ftsIds.keys()]);
		const rrfScores = new Map<string, number>();
		for (const id of allIds) {
			let score = 0;
			const vRank = vectorRanks.get(id);
			if (vRank !== undefined) score += 1 / (RRF_K + vRank);
			const fRank = ftsIds.get(id);
			if (fRank !== undefined) score += ftsWeight * (1 / (RRF_K + fRank));
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
			finalScore = applyPathPenalty(chunk.filePath, finalScore);
			chunk.confidenceScore = finalScore;
			scored.push({ chunk, score: finalScore });
		}

		scored.sort((a, b) => b.score - a.score);
		const deduped = dedupeOverlaps(scored);
		const candidates = deduped.length;

		let filtered = deduped.filter((s) => s.score >= confidenceThreshold);
		if (filtered.length === 0 && deduped.length > 0) filtered = deduped.slice(0, 1);
		const droppedLowValue = candidates - filtered.length;

		// File diversity + marginal stop.
		const topScore = filtered.length > 0 ? filtered[0]!.score : 0;
		const fileCounts = new Map<string, number>();
		const diverse: Chunk[] = [];
		let marginalDropped = 0;
		for (let idx = 0; idx < filtered.length; idx++) {
			const { chunk, score } = filtered[idx]!;
			if (diverse.length > 0 && marginalRatio > 0 && score < marginalRatio * topScore) {
				marginalDropped = filtered.length - idx;
				break;
			}
			const count = fileCounts.get(chunk.filePath) ?? 0;
			if (count < MAX_CHUNKS_PER_FILE) {
				diverse.push(chunk);
				fileCounts.set(chunk.filePath, count + 1);
				if (diverse.length >= topK) break;
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

		const stats = { candidates, selected: 0, droppedLowValue: droppedLowValue + marginalDropped };
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

function dedupeOverlaps(scored: { chunk: Chunk; score: number }[]): { chunk: Chunk; score: number }[] {
	const kept: { chunk: Chunk; score: number }[] = [];
	for (const { chunk, score } of scored) {
		let duplicate = false;
		for (const k of kept) {
			const kc = k.chunk;
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

function estimateKeywordDistance(chunk: Chunk, parsed: ParsedQuery): number {
	if (parsed.fileHints.length > 0) {
		for (const hint of parsed.fileHints) {
			if (chunk.filePath.includes(hint)) return 0;
		}
	}
	const content = chunk.content.toLowerCase();
	for (const keyword of parsed.keywords) {
		if (content.includes(keyword.toLowerCase())) return 0;
	}
	return 2;
}
