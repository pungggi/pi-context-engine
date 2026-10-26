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

// CR tolerance: lines are split on `\n`, so a CRLF file keeps `\r` at line
// ends. JS `.` does not match `\r` and `$` does not forgive it, so every
// end-anchored pattern must allow it — otherwise Windows-authored Markdown
// silently loses all heading detection.
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t\r]*$/;
// CommonMark: a backtick fence's info string may not contain backticks
// (```` ```example``` ```` is an inline code span, not a fence), and the same
// guard for tildes keeps ``~example~`` from opening one.
const FENCE_OPEN_BT = /^ {0,3}(`{3,})([^`]*)$/;
const FENCE_OPEN_TL = /^ {0,3}(~{3,})[^~]*$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t\r]*$/;

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
		// Frontmatter wins over everything below: a YAML literal block
		// (`example: |` + `  ~~~`) must not open a fence that then swallows
		// every heading after the closing `---`.
		if (i <= frontmatterEnd) continue;
		if (fence !== null) {
			const close = line.match(FENCE_CLOSE);
			if (close && close[1]!.startsWith(fence[0]!) && close[1]!.length >= fence.length) fence = null;
			continue;
		}
		const openMatch = line.match(FENCE_OPEN_BT) ?? line.match(FENCE_OPEN_TL);
		if (openMatch) {
			fence = openMatch[1]!;
			continue;
		}
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

/** Reference definition `[label]: dest` at the start of a line. */
const LINK_REFDEF = /^ {0,3}\[[^\]]+\]:\s*(<[^>\n]*>|\S+)/;

/** One raw link destination and the 1-based raw-file line it sits on. */
export interface DocLinkTarget {
	/** Raw destination as written (unresolved, fragment intact). */
	target: string;
	/** Line in the RAW file, so the pipeline can attribute it to a chunk. */
	line: number;
}

/**
 * Read the destination of an inline link whose `](` starts at `start`
 * (index just after the `(`). Tracks paren depth so balanced destinations
 * (`./guide(v2).md`) survive intact (review fix: a regex stops at the first
 * `)`), supports the `<angle-bracket>` form, and takes the destination up to
 * the first whitespace so a trailing title (`./a.md "Title"`) falls away.
 * Returns null when the parens never balance on this line (CommonMark: no
 * link). Multi-line links are not followed; that approximation is documented
 * on `extractDocLinkTargets`.
 */
function readBalancedDest(line: string, start: number): string | null {
	let i = start;
	while (i < line.length && /\s/.test(line[i]!)) i++;
	if (i >= line.length) return null;
	if (line[i] === "<") {
		const end = line.indexOf(">", i + 1);
		return end === -1 ? null : line.slice(i + 1, end);
	}
	const body = i;
	let depth = 1; // the opening `(` we were called after
	while (i < line.length) {
		const ch = line[i];
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) break;
		}
		i++;
	}
	if (depth !== 0) return null;
	const inner = line.slice(body, i);
	const ws = inner.search(/\s/);
	const dest = ws === -1 ? inner : inner.slice(0, ws);
	return dest.length > 0 ? dest : null;
}

/**
 * Raw Markdown link destinations in `content` with their line numbers (WP3
 * doc-graph edges, docs/RESEARCH-COMPETITORS.md §4 P2.A): inline links and
 * images via `](` scanning, plus reference definitions, deduped per line.
 *
 * The scan mirrors `segmentMarkdown`'s fence/frontmatter state machine and
 * strips code spans first (including multi-backtick forms: `` ``[x](y)`` ``
 * is one span, not two empty ones), so example links in fenced blocks or code
 * spans never become graph edges. The pipeline runs this on the RAW file and
 * attributes each line to its chunk: scanning per chunk would misread a fence
 * that `packSegment` split into line windows (continuation chunks start with
 * no fence state), and line numbers only make sense against raw content.
 * Approximation: destinations must close on their own line (no multi-line
 * links).
 */
export function extractDocLinkTargets(content: string): DocLinkTarget[] {
	const lines = content.split("\n");

	// Frontmatter: same guard as segmentMarkdown — a YAML literal block must
	// not feed `example: | [x](y.md)` lines to the extractor.
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

	const out: DocLinkTarget[] = [];
	const seen = new Set<string>();
	const push = (raw: string, line: number): void => {
		const target = raw.trim();
		if (target.length === 0) return;
		const key = `${line}\u0000${target}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ target, line });
	};

	let fence: string | null = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (i <= frontmatterEnd) continue;
		if (fence !== null) {
			const close = line.match(FENCE_CLOSE);
			if (close && close[1]!.startsWith(fence[0]!) && close[1]!.length >= fence.length) fence = null;
			continue;
		}
		const openMatch = line.match(FENCE_OPEN_BT) ?? line.match(FENCE_OPEN_TL);
		if (openMatch) {
			fence = openMatch[1]!;
			continue;
		}
		// Inline code spans are literal text. The lazy backreference matches a
		// whole span whatever its delimiter length (`a` or ``a``), where
		// pairing single backticks independently would re-expose the content of
		// a double-backtick span (review fix).
		const text = line.replace(/(`+).*?\1/g, "");
		const ref = text.match(LINK_REFDEF);
		if (ref) push(ref[1]!, i + 1);
		let search = 0;
		for (;;) {
			const idx = text.indexOf("](", search);
			if (idx === -1) break;
			search = idx + 2;
			if (text.lastIndexOf("[", idx) === -1) continue; // no opener bracket
			const dest = readBalancedDest(text, idx + 2);
			if (dest !== null) push(dest, i + 1);
		}
	}
	return out;
}
