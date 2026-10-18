/**
 * Deterministic context headers for chunks — plan item R1
 * (docs/IMPLEMENTATION-PLAN.md).
 *
 * Why: a chunk used to carry only its own text, so a query like "how does the
 * retrieval module merge results" had no signal tying a hit to
 * `src/retrieval/`. Anthropic's contextual retrieval measured failed retrievals
 * dropping 49% from prepending this kind of path/unit context before embedding
 * and before FTS ingest. Ours is free: one line, no LLM, built from data the
 * indexer already has (path, language, enclosing unit, file imports).
 *
 * The header is prepended to `chunk.content` as the single source of truth, so
 * the embedder, the FTS ingest, compression and `expand_chunk` all see it
 * without four separate code paths. It is also indexed text: contextual BM25
 * was the larger half of Anthropic's gain.
 */
import type { Chunk } from "../types.js";

/** ~120 code tokens at 3.3 chars/token: context, never content. */
export const HEADER_BUDGET_CHARS = 400;
const MAX_IMPORTS = 8;
const HEADER_PREFIX = "// file: ";

export interface ContextHeaderInput {
	filePath: string;
	language: string;
	unit?: string | null;
	imports?: string[];
}

export function buildContextHeader(input: ContextHeaderInput): string {
	const parts = [`file: ${input.filePath}`, `lang: ${input.language}`];
	if (input.unit) parts.push(`unit: ${input.unit}`);
	const imports = (input.imports ?? []).filter(Boolean);
	if (imports.length > 0) {
		let list = imports.slice(0, MAX_IMPORTS).join(", ");
		if (imports.length > MAX_IMPORTS) list += `, +${imports.length - MAX_IMPORTS} more`;
		parts.push(`imports: ${list}`);
	}
	let header = `// ${parts.join(" | ")}`;
	if (header.length > HEADER_BUDGET_CHARS) {
		// Drop imports first: paths and units carry more signal per character.
		header = `// ${parts.filter((p) => !p.startsWith("imports:")).join(" | ")}`;
		if (header.length > HEADER_BUDGET_CHARS) {
			header = header.slice(0, HEADER_BUDGET_CHARS - 3) + "...";
		}
	}
	return header;
}

/** Prepend a header. Idempotent so re-processing a chunk cannot double it. */
export function applyContextHeader(content: string, input: ContextHeaderInput): string {
	if (content.startsWith(HEADER_PREFIX)) return content;
	return `${buildContextHeader(input)}\n${content}`;
}

/** Read the unit back out of a header-prefixed chunk (R2 symbol matching). */
export function parseContextHeaderUnit(content: string): string | null {
	if (!content.startsWith(HEADER_PREFIX)) return null;
	const firstLine = content.slice(0, content.indexOf("\n") < 0 ? undefined : content.indexOf("\n"));
	const match = firstLine.match(/\| unit: ([^|]+?)(?: \|.*|\s*)$/);
	return match ? match[1]!.trim() : null;
}

/** Apply the header to a chunk, reading the unit the chunker recorded. */
export function applyContextHeaderToChunk(chunk: Chunk, imports: string[]): void {
	const unit = typeof chunk.metadata["unit"] === "string" ? (chunk.metadata["unit"] as string) : null;
	chunk.content = applyContextHeader(chunk.content, {
		filePath: chunk.filePath,
		language: chunk.language,
		unit,
		imports,
	});
}

/**
 * Drop the context header line from stored chunk content (inverse of
 * `applyContextHeader`). Used when re-deriving call-graph identifiers from
 * backend-stored chunks, so header tokens (`file`, `unit`, `imports`, path
 * segments) cannot pollute the identifier set.
 */
export function stripContextHeader(content: string): string {
	if (!content.startsWith(HEADER_PREFIX)) return content;
	const nl = content.indexOf("\n");
	return nl === -1 ? "" : content.slice(nl + 1);
}
