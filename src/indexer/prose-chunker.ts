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
 * (index just after the `(`).
 *
 * Phase 1 reads the destination: backslash escapes never count toward paren
 * depth (`./guide\(v2\).md`), and whitespace ends the destination because a
 * title follows. Phase 2, only when that title zone was reached, skips a
 * quoted or parenthesised title and demands the link's closing `)`. The split
 * is what makes `[guide](./hub.md "Hub (draft")` work: a title's unmatched
 * `(` must not be counted before the destination is separated (round-2
 * review fix; the depth-only scan returned null there and lost the edge).
 * Supports the `<angle-bracket>` form. Returns null when the line never
 * closes the link (CommonMark: no link). Multi-line links are not followed;
 * that approximation is documented on `extractDocLinkTargets`.
 */
function readBalancedDest(line: string, start: number): string | null {
	const len = line.length;
	let i = start;
	while (i < len && /\s/.test(line[i]!)) i++;
	if (i >= len) return null;
	if (line[i] === "<") {
		const end = line.indexOf(">", i + 1);
		return end === -1 ? null : line.slice(i + 1, end);
	}

	// Phase 1: destination, until the closing paren or the first whitespace.
	const body = i;
	let depth = 1; // the opening `(` we were called after
	let destEnd = -1;
	let stoppedAtWs = false;
	while (i < len) {
		const ch = line[i]!;
		if (ch === "\\") {
			i += 2; // escaped char stays in the destination, never counts
			continue;
		}
		if (ch === "(") depth++;
		else if (ch === ")") {
			depth--;
			if (depth === 0) {
				destEnd = i;
				i++;
				break;
			}
		} else if (/\s/.test(ch)) {
			destEnd = i;
			stoppedAtWs = true;
			break;
		}
		i++;
	}
	if (destEnd === -1) return null;
	const dest = line.slice(body, destEnd);
	if (dest.length === 0) return null;
	if (!stoppedAtWs) return dest;

	// Phase 2: title zone — skip the quoted/parenthesised title, then `)`.
	while (i < len && /\s/.test(line[i]!)) i++;
	if (i >= len) return null;
	const q = line[i];
	if (q === '"' || q === "'") {
		let k = i + 1;
		while (k < len) {
			if (line[k] === "\\") {
				k += 2;
				continue;
			}
			if (line[k] === q) break;
			k++;
		}
		if (k >= len) return null;
		i = k + 1;
	} else if (q === "(") {
		let d = 1;
		i++;
		while (i < len && d > 0) {
			if (line[i] === "(") d++;
			else if (line[i] === ")") d--;
			i++;
		}
		if (d > 0) return null;
	} else {
		return null; // garbage after the destination: not a link
	}
	while (i < len && /\s/.test(line[i]!)) i++;
	return i < len && line[i] === ")" ? dest : null;
}

/**
 * Raw Markdown link destinations in `content` with their line numbers (WP3
 * doc-graph edges, docs/RESEARCH-COMPETITORS.md §4 P2.A): inline links and
 * images via `](` scanning, plus reference definitions, deduped per line.
 *
 * Block-level guards run first: frontmatter and fenced code are masked
 * (same state machine as `segmentMarkdown`). Inline guards follow: code
 * spans are stripped including MULTI-LINE spans (a span opened on one line
 * and closed later suppresses the lines between; it only exists if the
 * close precedes a blank or fenced line, per CommonMark's block
 * boundaries), indented code blocks after a blank line are literal, and an
 * escaped `\[` / `\]` is not a link delimiter. The pipeline runs this on
 * the RAW file and attributes each line to its chunk: scanning per chunk
 * would misread a fence that `packSegment` split into line windows
 * (continuation chunks start with no fence state), and line numbers only
 * make sense against raw content. Approximations: destinations must close
 * on their own line (no multi-line links), and a span that never closes is
 * treated as literal text (CommonMark's outcome).
 */
export function extractDocLinkTargets(content: string): DocLinkTarget[] {
	const lines = content.split("\n");

	// Block-level mask (round 2): frontmatter and fenced code never reach the
	// inline scanner, and the code-span lookahead below stops at exactly these
	// boundaries. Frontmatter first — a YAML literal block must not feed
	// `example: | [x](y.md)` lines to the extractor.
	const blocked = new Array<boolean>(lines.length).fill(false);
	{
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
		for (let i = 0; i < lines.length; i++) {
			if (i <= frontmatterEnd) {
				blocked[i] = true;
				continue;
			}
			const line = lines[i]!;
			if (fence !== null) {
				blocked[i] = true;
				const close = line.match(FENCE_CLOSE);
				if (close && close[1]!.startsWith(fence[0]!) && close[1]!.length >= fence.length) fence = null;
				continue;
			}
			const openMatch = line.match(FENCE_OPEN_BT) ?? line.match(FENCE_OPEN_TL);
			if (openMatch) {
				blocked[i] = true;
				fence = openMatch[1]!;
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

	// Run of exactly `n` backticks at/after `from`; longer/shorter runs never
	// close a span (CommonMark matches opening/closing lengths exactly).
	const findExactRun = (str: string, from: number, n: number): { end: number } | null => {
		let p = from;
		while (p < str.length) {
			if (str[p] !== "`") {
				p++;
				continue;
			}
			let e = p;
			while (e < str.length && str[e] === "`") e++;
			if (e - p === n) return { end: e };
			p = e;
		}
		return null;
	};
	// Close of a span opened on `fromLine`: search later lines, stopping at a
	// blank line (paragraph break) or a blocked line (fence/frontmatter wins),
	// so a span can never tunnel through a block boundary.
	const findSpanClose = (fromLine: number, n: number): { line: number; col: number } | null => {
		for (let k = fromLine + 1; k < lines.length; k++) {
			if (blocked[k]) return null;
			const l = lines[k]!;
			if (l.trim() === "") return null;
			const hit = findExactRun(l, 0, n);
			if (hit !== null) return { line: k, col: hit.end };
		}
		return null;
	};
	// CommonMark backslash escape: `\` before punctuation makes it literal.
	const isEscaped = (str: string, pos: number): boolean => {
		let n = 0;
		for (let k = pos - 1; k >= 0 && str[k] === "\\"; k--) n++;
		return n % 2 === 1;
	};

	let suppress: { line: number; col: number } | null = null;
	let prevBlank = true; // start of file: an indented line there starts code
	let indentedCode: boolean = false;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (blocked[i]) {
			prevBlank = line.trim() === "";
			indentedCode = false;
			continue;
		}

		let text: string;
		if (suppress !== null) {
			if (i < suppress.line) continue; // inside a multi-line span: literal
			text = line.slice(suppress.col); // line holding the close: suffix is live
			suppress = null;
		} else {
			text = line;
		}

		// Indented code blocks (round 2): 4-space/tab indent after a blank line,
		// or continuing such a block, is literal. A lazy paragraph continuation
		// (indent with a non-blank line above) stays live.
		const indented = line.startsWith("    ") || line.startsWith("\t");
		const inIndentedCode: boolean = indented && (prevBlank || indentedCode);
		indentedCode = inIndentedCode;
		prevBlank = line.trim() === "";
		if (inIndentedCode) continue;

		// Strip inline code spans; a span that opens here and closes on a later
		// line suppresses the rest of this line plus the lines up to its close
		// (round 2: per-line stripping leaked links out of multi-line spans).
		// An unclosed span anywhere is literal text, per CommonMark.
		let pos = 0;
		let live = "";
		for (;;) {
			const bt = text.indexOf("`", pos);
			if (bt === -1) {
				live += text.slice(pos);
				break;
			}
			let runEnd = bt;
			while (runEnd < text.length && text[runEnd] === "`") runEnd++;
			const n = runEnd - bt;
			const close = findExactRun(text, runEnd, n);
			if (close !== null) {
				live += text.slice(pos, bt);
				pos = close.end;
				continue;
			}
			const later = findSpanClose(i, n);
			if (later !== null) {
				live += text.slice(pos, bt);
				suppress = later;
				break;
			}
			live += text.slice(pos, runEnd); // no close here or later: literal
			pos = runEnd;
		}
		text = live;

		const ref = text.match(LINK_REFDEF);
		if (ref) push(ref[1]!, i + 1);
		let search = 0;
		for (;;) {
			const idx = text.indexOf("](", search);
			if (idx === -1) break;
			search = idx + 2;
			const openIdx = text.lastIndexOf("[", idx);
			if (openIdx === -1) continue; // no opener bracket
			if (isEscaped(text, idx) || isEscaped(text, openIdx)) continue; // \] or \[
			const dest = readBalancedDest(text, idx + 2);
			if (dest !== null) push(dest, i + 1);
		}
	}
	return out;
}
