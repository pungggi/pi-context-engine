/**
 * P2-C: semantic chunking for heading-less unstructured prose
 * (docs/RESEARCH-COMPETITORS.md §3/§4-C).
 *
 * Evidence: embedding-similarity breakpoints help unstructured text with no
 * headings, at the cost of an extra embedding pass per file — so it is a
 * fallback behind `indexer.chunking: semantic-prose`, never the default, and
 * only engages when the file has NO heading structure (header-aware section
 * chunking stays the markdown default) and is large enough that packing by
 * budget alone would blur topics.
 *
 * Deterministic given the unit embeddings: breakpoints sit at consecutive-unit
 * cosine distances above the 75th percentile of the file's own distances, so a
 * homogeneous file yields no breakpoints and the budget packing takes over.
 * Small groups merge into the closer neighbour — the R12 lesson (trivia tiling
 * dilutes fixed-size result sets) means we never emit a trail of tiny chunks.
 */
import { createHash } from "node:crypto";
import type { Chunk } from "../types.js";
import { makeChunk } from "../types.js";

/** Breakpoint percentile over the file's own consecutive-unit distances. */
export const SEMANTIC_BREAK_PERCENTILE = 0.75;
/** Groups below this non-ws size merge into a neighbour when the budget allows. */
export const MIN_SEMANTIC_CHUNK_CHARS = 320;

/** A paragraph-level unit: 1-based inclusive raw-file line range. */
export interface SemanticUnit {
	startLine: number;
	endLine: number;
	/** Raw text of the range (`lines.slice(start-1, end).join("\n")`). */
	text: string;
	/** Non-whitespace char count (budget currency, matches packSegment). */
	nwChars: number;
}

/**
 * Split source into paragraph units on blank lines. Consecutive units cover
 * the file contiguously: each unit consumes its trailing blank lines (same
 * convention as packSegment), so chunk ranges tile without gaps or overlaps.
 */
export function splitParagraphUnits(source: string): SemanticUnit[] {
	const lines = source.split("\n");
	const nw = (s: string): number => s.replace(/\s/g, "").length;
	const units: SemanticUnit[] = [];
	let i = 0;
	while (i < lines.length) {
		while (i < lines.length && lines[i]!.trim().length === 0) i++;
		if (i >= lines.length) break;
		const start = i;
		let chars = 0;
		while (i < lines.length && lines[i]!.trim().length > 0) {
			chars += nw(lines[i]!);
			i++;
		}
		// Consume trailing blanks into this unit so ranges stay contiguous.
		while (i < lines.length && lines[i]!.trim().length === 0) i++;
		units.push({
			startLine: start + 1,
			endLine: i, // i is now the line AFTER the last consumed one → inclusive end
			text: lines.slice(start, i).join("\n"),
			nwChars: chars,
		});
	}
	return units;
}

/** Cosine distance (1 − cosine similarity); identical → 0, orthogonal → 1. */
export function cosineDistance(a: readonly number[], b: readonly number[]): number {
	let dot = 0;
	let na = 0;
	let nb = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		dot += a[i]! * b[i]!;
		na += a[i]! * a[i]!;
		nb += b[i]! * b[i]!;
	}
	if (na === 0 || nb === 0) return 1; // zero vector: no signal, treat as far
	return 1 - dot / Math.sqrt(na * nb);
}

/** Percentile (linear interpolation) of a non-empty array, ascending. */
export function quantile(sortedAsc: readonly number[], p: number): number {
	if (sortedAsc.length === 0) return 0;
	if (sortedAsc.length === 1) return sortedAsc[0]!;
	const idx = (sortedAsc.length - 1) * p;
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	const frac = idx - lo;
	return sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * frac;
}

/**
 * Breakpoint decision per consecutive-unit boundary i (between unit i and
 * i+1): true when the boundary's distance is strictly above the file's own
 * `SEMANTIC_BREAK_PERCENTILE` quantile. Uniform distances → threshold equals
 * every distance → strict `>` keeps every boundary closed (no split), which
 * is the desired homogeneous-file fallback to plain budget packing.
 */
export function semanticBreakpoints(distances: readonly number[]): boolean[] {
	if (distances.length === 0) return [];
	const threshold = quantile([...distances].sort((x, y) => x - y), SEMANTIC_BREAK_PERCENTILE);
	return distances.map((d) => d > threshold);
}

/** Internal build unit: contiguous line range plus the units it spans. */
interface Group {
	startLine: number;
	endLine: number;
	nwChars: number;
	firstUnit: number;
	lastUnit: number;
}

/**
 * Group units into chunks. Passes:
 *  1. close a group at a breakpoint, or when the next unit would exceed the
 *     budget;
 *  2. split any group still over budget on its own line boundaries (a single
 *     huge paragraph has no smaller semantic unit we can afford);
 *  3. merge groups under `minChars` into the neighbour with the smaller
 *     connecting distance, when the merged size stays within budget.
 */
export function groupSemanticUnits(
	units: readonly SemanticUnit[],
	breakAt: readonly boolean[],
	embeddings: readonly (readonly number[])[],
	lines: readonly string[],
	budget: number,
	minChars: number,
): { startLine: number; endLine: number; nwChars: number }[] {
	const nwOf = (s: string): number => s.replace(/\s/g, "").length;

	// Pass 1: unit-level grouping honoring breakpoints and budget.
	const raw: Group[] = [];
	let cur: Group | null = null;
	for (let i = 0; i < units.length; i++) {
		const u = units[i]!;
		if (cur && i > 0 && breakAt[i - 1] === true) {
			raw.push(cur);
			cur = null;
		}
		if (cur && cur.nwChars + u.nwChars > budget) {
			raw.push(cur);
			cur = null;
		}
		if (!cur) cur = { startLine: u.startLine, endLine: u.endLine, nwChars: u.nwChars, firstUnit: i, lastUnit: i };
		else {
			cur.endLine = u.endLine;
			cur.nwChars += u.nwChars;
			cur.lastUnit = i;
		}
	}
	if (cur) raw.push(cur);

	// Pass 2: line-greedy split for oversize groups (single huge paragraphs).
	const split: Group[] = [];
	for (const g of raw) {
		if (g.nwChars <= budget) {
			split.push(g);
			continue;
		}
		const start0 = g.startLine - 1;
		let chunkStart = start0;
		let size = 0;
		let opened = false;
		for (let li = start0; li < g.endLine; li++) {
			const w = nwOf(lines[li] ?? "");
			if (opened && size + w > budget) {
				split.push({
					startLine: chunkStart + 1,
					endLine: li, // exclusive 0-based end == inclusive 1-based end
					nwChars: size,
					firstUnit: g.firstUnit,
					lastUnit: g.firstUnit,
				});
				chunkStart = li;
				size = 0;
				opened = false;
			}
			size += w;
			opened = true;
		}
		split.push({
			startLine: chunkStart + 1,
			endLine: g.endLine,
			nwChars: size,
			firstUnit: g.firstUnit,
			lastUnit: g.lastUnit,
		});
	}

	// Pass 3: merge undersize groups into the closer neighbour.
	const groups: Group[] = split.map((g) => ({ ...g }));
	for (let i = 0; i < groups.length; i++) {
		const g = groups[i]!;
		if (g.nwChars >= minChars || groups.length <= 1) continue;
		const prev = groups[i - 1];
		const next = groups[i + 1];
		let target: number | null = null;
		if (prev && prev.nwChars + g.nwChars <= budget) target = i - 1;
		if (next && next.nwChars + g.nwChars <= budget) {
			if (target === null) target = i + 1;
			else {
				// Boundary distances use the unit embeddings at each edge.
				const dPrev = cosineDistance(
					embeddings[groups[i - 1]!.lastUnit] ?? [],
					embeddings[groups[i]!.firstUnit] ?? [],
				);
				const dNext = cosineDistance(
					embeddings[groups[i]!.lastUnit] ?? [],
					embeddings[groups[i + 1]!.firstUnit] ?? [],
				);
				if (dNext < dPrev) target = i + 1;
			}
		}
		if (target === null) continue;
		const t = groups[target]!;
		t.startLine = Math.min(t.startLine, g.startLine);
		t.endLine = Math.max(t.endLine, g.endLine);
		t.nwChars += g.nwChars;
		t.firstUnit = Math.min(t.firstUnit, g.firstUnit);
		t.lastUnit = Math.max(t.lastUnit, g.lastUnit);
		groups.splice(i, 1);
		i--; // re-examine the merged range from this index
	}
	return groups.map(({ startLine, endLine, nwChars }) => ({ startLine, endLine, nwChars }));
}

/** Embedding provider for unit texts (pipeline: cache + embedder, tests: stub). */
export type EmbedTexts = (texts: string[]) => Promise<number[][]>;

/**
 * Chunk heading-less prose by embedding-similarity breakpoints. Returns []
 * (caller falls back to `chunkProse`) when the file is too small to benefit,
 * has fewer than 3 paragraph units, or the embedding pass fails.
 */
export async function chunkSemanticProse(
	source: string,
	filePath: string,
	language: string,
	budget: number,
	embedTexts: EmbedTexts,
): Promise<Chunk[]> {
	const units = splitParagraphUnits(source);
	const totalNw = units.reduce((acc, u) => acc + u.nwChars, 0);
	// Too small or too fragmented to gain anything: budget packing is already
	// one chunk, or breakpoints cannot separate anything meaningful.
	if (units.length < 3 || totalNw <= budget) return [];

	let embeddings: number[][];
	try {
		embeddings = await embedTexts(units.map((u) => u.text));
	} catch {
		return []; // embedder unavailable → deterministic fallback path
	}
	if (embeddings.length !== units.length) return [];
	if (embeddings.some((e) => !Array.isArray(e) || e.length === 0)) return [];

	const distances: number[] = [];
	for (let i = 0; i + 1 < units.length; i++) distances.push(cosineDistance(embeddings[i]!, embeddings[i + 1]!));
	const breakAt = semanticBreakpoints(distances);
	const groups = groupSemanticUnits(units, breakAt, embeddings, source.split("\n"), budget, MIN_SEMANTIC_CHUNK_CHARS);

	const lines = source.split("\n");
	const chunks: Chunk[] = [];
	for (const g of groups) {
		const content = lines.slice(g.startLine - 1, g.endLine).join("\n");
		if (content.trim().length === 0) continue;
		const id = createHash("sha256")
			.update(`${filePath}:sem:${g.startLine}:${g.endLine}:${content.slice(0, 100)}`)
			.digest("hex")
			.slice(0, 16);
		chunks.push(
			makeChunk({
				id,
				content,
				chunkType: "doc",
				filePath,
				startLine: g.startLine,
				endLine: g.endLine,
				language,
				metadata: { semantic: true },
			}),
		);
	}
	return chunks;
}
