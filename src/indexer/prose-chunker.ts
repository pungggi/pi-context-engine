/**
 * Prose chunking for non-code text — "Prose P0"
 * (docs/RESEARCH-COMPETITORS.md §4).
 *
 * Why: the pipeline's whole-file fallback turned every Markdown/note file into
 * a single chunk, and the embedder only sees a chunk's first ~2000 chars, so
 * semantic search went blind past the file header while small-to-big had
 * nothing finer to expand to. Header-aware sectioning is the best-measured
 * vanilla strategy for prose (Snowflake RAG study), and each section carries
 * its heading path as `unit`, which the R1 context header turns into
 * deterministic contextual retrieval (Anthropic measured −49% failed
 * retrievals for that pattern, docs/RESEARCH-RETRIEVAL.md §1.7).
 *
 * Design notes:
 * - **ATX headings only** (`## Title`): setext underlines (`Title\n---`) are
 *   ambiguous with thematic breaks and YAML frontmatter, so v1 skips them;
 *   such text stays inside its surrounding section.
 * - **Fenced code is not headings**: `# comment` inside ```python must not
 *   split the document, so the scanner tracks ``` / ~~~ fences.
 * - **Files that pack to one chunk keep the old shape**: they return the
 *   byte-identical whole-file `module` chunk (same id as the legacy
 *   fallback), so retrieval only changes for files that gain structure.
 * - **No overlap between chunks**: `dedupeOverlaps` drops overlapping
 *   non-module chunks at serve time, so boundary overlap would silently never
 *   be served. Cuts land at paragraph boundaries instead.
 */
import { sha256Hex } from "../utils.js";
import { makeChunk, type Chunk } from "../types.js";

/** Outline-parent budget, mirroring MODULE_CHUNK_BUDGET_CHARS in chunker.ts. */
const OUTLINE_BUDGET_CHARS = 3000;

/** Languages that take the prose path instead of the whole-file fallback. */
export function isProseLanguage(language: string): boolean {
	return language === "markdown" || language === "plaintext";
}

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** A 1-based inclusive line range with its heading path (null = preamble). */
interface Segment {
	startLine: number;
	endLine: number;
	unit: string | null;
}

interface Heading {
	level: number;
	text: string;
	line: number;
}

function nonWsLength(text: string): number {
	let n = 0;
	for (const ch of text) if (!/\s/.test(ch)) n++;
	return n;
}

function headingText(raw: string | undefined): string {
	// Strip a closing run of hashes (`## Title ##`) and trim.
	return (raw ?? "").replace(/[ \t]+#+$/, "").trim();
}

/**
 * Split markdown into heading segments. Returns segments plus every heading
 * line so the outline parent reuses the same scan (fence/frontmatter aware).
 */
function segmentMarkdown(lines: string[]): { segments: Segment[]; headings: Heading[] } {
	const segments: Segment[] = [];
	const headings: Heading[] = [];
	const stack: { level: number; text: string }[] = [];

	// Frontmatter: skip heading detection between a leading `---` and its close
	// so YAML `# comments` cannot masquerade as document headings.
	let frontmatterEnd = -1;
	if (lines.length > 0 && lines[0]!.trim() === "---") {
		for (let i = 1; i < lines.length; i++) {
			const t = lines[i]!.trim();
			if (t === "---" || t === "...") {
				frontmatterEnd = i;
				break;
			}
		}
	}

	let fence: string | null = null;
	let segStart = 0; // 0-based first line of the open segment

	const closeSegment = (endIdx: number): void => {
		if (endIdx < segStart) return;
		let anyText = false;
		for (let i = segStart; i <= endIdx; i++) {
			if (lines[i]!.trim().length > 0) {
				anyText = true;
				break;
			}
		}
		if (!anyText) return;
		segments.push({
			startLine: segStart + 1,
			endLine: endIdx + 1,
			unit: stack.length > 0 ? stack.map((h) => h.text).join(" > ") : null,
		});
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (fence !== null) {
			const close = line.match(FENCE_CLOSE);
			if (close && close[1]!.startsWith(fence[0]!) && close[1]!.length >= fence.length) fence = null;
			continue;
		}
		const openMatch = line.match(FENCE_OPEN);
		if (openMatch) {
			fence = openMatch[1]!;
			continue;
		}
		if (i <= frontmatterEnd) continue;
		const m = line.match(ATX);
		if (!m) continue;
		const level = m[1]!.length;
		const text = headingText(m[2]);
		if (!text) continue; // a bare `#####` line is not a useful boundary
		closeSegment(i - 1);
		// The heading line opens its own section: pop deeper/equal levels first.
		while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
		stack.push({ level, text });
		headings.push({ level, text, line: i + 1 });
		segStart = i;
	}
	closeSegment(lines.length - 1);
	return { segments, headings };
}

/**
 * Pack one segment's paragraphs into ≤ budget chunks (non-whitespace chars).
 * Paragraphs are runs of non-blank lines; trailing blank lines travel with the
 * paragraph they follow, so adjacent chunks are line-contiguous.
 */
function packSegment(
	lines: string[],
	lineNw: number[],
	segment: Segment,
	budget: number,
	filePath: string,
	language: string,
	out: Chunk[],
): void {
	const first = segment.startLine - 1;
	const last = segment.endLine - 1;

	type Para = { start: number; end: number; nw: number }; // 0-based inclusive
	const paras: Para[] = [];
	let i = first;
	while (i <= last) {
		while (i <= last && lines[i]!.trim().length === 0) i++; // leading blanks
		if (i > last) break;
		const start = i;
		let nw = 0;
		while (i <= last && lines[i]!.trim().length > 0) {
			nw += lineNw[i]!;
			i++;
		}
		const endText = i - 1;
		while (i <= last && lines[i]!.trim().length === 0) i++; // trailing blanks
		paras.push({ start, end: i - 1, nw });
		void endText;
	}

	const emit = (start: number, end: number): void => {
		const content = lines.slice(start, end + 1).join("\n");
		if (content.trim().length === 0) return;
		const startLine = start + 1;
		const endLine = end + 1;
		const id = sha256Hex(`${filePath}:${startLine}:${endLine}:${content.slice(0, 100)}`).slice(0, 16);
		out.push(
			makeChunk({
				id,
				content,
				chunkType: "doc",
				filePath,
				startLine,
				endLine,
				language,
				metadata: segment.unit ? { unit: segment.unit } : {},
			}),
		);
	};

	/** Line windows inside one oversize paragraph (or one oversize line). */
	const splitParagraph = (start: number, end: number): void => {
		let winStart = start;
		let used = 0;
		for (let j = start; j <= end; j++) {
			if (used > 0 && used + lineNw[j]! > budget) {
				emit(winStart, j - 1);
				winStart = j;
				used = 0;
			}
			used += lineNw[j]!;
		}
		if (winStart <= end) emit(winStart, end);
	};

	let chunkStart = -1;
	let chunkEnd = -1;
	let chunkNw = 0;
	const flush = (): void => {
		if (chunkStart >= 0) emit(chunkStart, chunkEnd);
		chunkStart = -1;
		chunkEnd = -1;
		chunkNw = 0;
	};

	for (const para of paras) {
		if (para.nw > budget) {
			// A paragraph bigger than the budget breaks at line boundaries;
			// flush first so oversize text does not glue onto small paragraphs.
			flush();
			splitParagraph(para.start, para.end);
			continue;
		}
		if (chunkStart >= 0 && chunkNw + para.nw > budget) flush();
		if (chunkStart < 0) {
			chunkStart = para.start;
			chunkEnd = para.end;
			chunkNw = para.nw;
		} else {
			chunkEnd = para.end;
			chunkNw += para.nw;
		}
	}
	flush();
}

/** Whole-file module chunk: byte-identical to the legacy fallback. */
function wholeFileModuleChunk(source: string, filePath: string, language: string): Chunk {
	return makeChunk({
		id: sha256Hex(`${filePath}:module`).slice(0, 16),
		content: source,
		chunkType: "module",
		filePath,
		startLine: 1,
		endLine: Math.max(1, source.trim().split("\n").length),
		language,
		metadata: {},
	});
}

/**
 * Parent chunk for a sectioned markdown file: the heading outline, indented
 * by depth. It is the small-to-big context (what the document covers) without
 * duplicating every section's text into a second whole-file chunk.
 */
function buildOutlineParent(
	lines: string[],
	headings: Heading[],
	filePath: string,
	language: string,
): Chunk | null {
	if (headings.length === 0) return null;
	let body = headings.map((h) => `${"  ".repeat(h.level - 1)}${"#".repeat(h.level)} ${h.text}`).join("\n");
	if (body.length > OUTLINE_BUDGET_CHARS) {
		body = `${body.slice(0, OUTLINE_BUDGET_CHARS - 24)}\n…[outline truncated]`;
	}
	const base = filePath.split("/").pop()!.replace(/\.[^.]+$/, "");
	const endLine = Math.max(1, lines.length - (lines[lines.length - 1] === "" ? 1 : 0));
	return makeChunk({
		id: sha256Hex(`${filePath}:module`).slice(0, 16),
		content: body,
		chunkType: "module",
		filePath,
		startLine: 1,
		endLine,
		language,
		metadata: { unit: base, tier: "parent" },
	});
}

/**
 * Chunk a prose file. Returns either:
 * - one whole-file `module` chunk (the file packs to a single chunk — same
 *   shape and id as the legacy fallback), or
 * - `doc` paragraph/section chunks with heading-path `unit` metadata, plus a
 *   markdown outline `module` parent for small-to-big expansion.
 */
export function chunkProse(source: string, filePath: string, language: string, budget: number): Chunk[] {
	if (source.trim().length === 0) return [];
	const lines = source.split("\n");

	let segments: Segment[];
	let headings: Heading[] = [];
	if (language === "markdown") {
		({ segments, headings } = segmentMarkdown(lines));
	} else {
		segments = [{ startLine: 1, endLine: lines.length, unit: null }];
	}

	const chunks: Chunk[] = [];
	const lineNw = lines.map(nonWsLength); // once per file, not per segment
	for (const segment of segments) packSegment(lines, lineNw, segment, budget, filePath, language, chunks);
	if (chunks.length <= 1) {
		// No internal structure to exploit: keep the legacy whole-file shape.
		return [wholeFileModuleChunk(source, filePath, language)];
	}
	if (language === "markdown") {
		const parent = buildOutlineParent(lines, headings, filePath, language);
		if (parent) chunks.push(parent);
	}
	return chunks;
}
