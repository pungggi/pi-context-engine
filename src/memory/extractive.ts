/**
 * Extractive summarisation using the embedding model already loaded for the
 * index — port of upstream `memory/extractive.py` (MIT). Real sentences only,
 * ranked by cosine similarity to the centroid.
 */
import type { Embedder } from "../indexer/embedder.js";

const SENTENCE_SPLIT = /(?<=[.!?])\s+/;

export function splitSentences(text: string): string[] {
	const pieces: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		for (const s of trimmed.split(SENTENCE_SPLIT)) {
			if (s.trim()) pieces.push(s.trim());
		}
	}
	return pieces;
}

export function cosine(a: readonly number[], b: readonly number[]): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	for (let i = 0; i < a.length; i++) {
		const x = a[i]!;
		const y = b[i]!;
		dot += x * y;
		na += x * x;
		nb += y * y;
	}
	if (na <= 0 || nb <= 0) return 0;
	return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export async function extractiveSummary(
	text: string,
	embedder: Pick<Embedder, "embedQuery">,
	topK = 3,
): Promise<string> {
	const sentences = splitSentences(text);
	if (sentences.length <= topK) return sentences.join(" ") || text.trim();

	const embeddings: number[][] = [];
	for (const s of sentences) {
		embeddings.push(await embedder.embedQuery(s));
	}
	if (embeddings.length === 0 || embeddings[0]!.length === 0) {
		return sentences.slice(0, topK).join(" ");
	}

	const dim = embeddings[0]!.length;
	const centroid = new Array<number>(dim).fill(0);
	for (const emb of embeddings) {
		for (let i = 0; i < dim; i++) centroid[i]! += emb[i]!;
	}
	for (let i = 0; i < dim; i++) centroid[i]! /= embeddings.length;

	const scored = embeddings.map((emb, i) => ({ i, score: cosine(emb, centroid) }));
	scored.sort((a, b) => b.score - a.score);
	const chosen = scored.slice(0, topK).map((s) => s.i).sort((a, b) => a - b);
	return chosen.map((i) => sentences[i]!).join(" ");
}

export function truncationSummary(text: string, maxChars = 200): string {
	const trimmed = text.trim();
	if (trimmed.length <= maxChars) return trimmed;
	return trimmed.slice(0, maxChars - 1).trimEnd() + "…";
}
