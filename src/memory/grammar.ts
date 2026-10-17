/**
 * Deterministic, model-free prose compression for memory rows — port of
 * upstream `memory/grammar.py` (MIT). Structured tokens (code, paths, URLs,
 * versions, identifiers) survive byte-for-byte; only prose words are
 * transformed. Same input + level always yields the same output.
 */

export type GrammarLevel = "lite" | "full" | "ultra";

/** Single source of truth for the storage level (upstream uses "lite"). */
export const DEFAULT_LEVEL: GrammarLevel = "lite";

type TokenKind =
	| "fence"
	| "inline_code"
	| "url"
	| "datetime"
	| "version"
	| "path"
	| "number_unit"
	| "identifier"
	| "prose";

const FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]+?`/g;
const URL_RE = /https?:\/\/\S+|www\.\S+/g;
const DATETIME_RE = /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:Z|[+\-]\d{2}:?\d{2})?)?/g;
const VERSION_RE = /v?\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.]+)?/g;
const PATH_RE = /(?:\.{1,2}\/|\/)[A-Za-z0-9_\-]{2,}(?:\/[A-Za-z0-9_./\-]+)*|[A-Za-z0-9_\-]{2,}\/[A-Za-z0-9_\-]{2,}(?:\/[A-Za-z0-9_./\-]+)*|[A-Za-z0-9_\-]{2,}\/[A-Za-z0-9_\-]+\.[A-Za-z]{1,5}\b/g;
const NUMBER_UNIT_RE = /\d+(?:\.\d+)?[A-Za-z]{1,4}\b/g;
const IDENT_RE = /[A-Za-z][A-Za-z0-9]*(?:[._][A-Za-z0-9]+)+|[A-Za-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*|[A-Za-z]+_[A-Za-z0-9_]+/g;

const PATTERNS: { kind: TokenKind; regex: RegExp }[] = [
	{ kind: "fence", regex: FENCE_RE },
	{ kind: "inline_code", regex: INLINE_CODE_RE },
	{ kind: "url", regex: URL_RE },
	{ kind: "datetime", regex: DATETIME_RE },
	{ kind: "version", regex: VERSION_RE },
	{ kind: "path", regex: PATH_RE },
	{ kind: "number_unit", regex: NUMBER_UNIT_RE },
	{ kind: "identifier", regex: IDENT_RE },
];

const ARTICLES = new Set(["a", "an", "the"]);

const FILLERS = new Set([
	...ARTICLES,
	"is", "are", "was", "were", "be", "been", "being", "am",
	"have", "has", "had",
	"will", "would", "shall", "should", "may", "might", "must",
	"of", "to", "as", "by", "on", "in", "at", "for", "with", "from",
	"and", "or", "but", "if", "than", "then",
	"that", "this", "these", "those",
	"just", "very", "quite", "really", "actually", "basically",
]);

const FILLERS_ULTRA = new Set([
	...FILLERS,
	"also", "still", "now", "when", "while", "since",
	"i", "we", "you", "he", "she", "it", "they", "them",
	"our", "their", "its", "my", "your", "his", "her",
	"me", "us", "him",
	"do", "does", "did",
	"via", "into", "onto", "upon", "over", "under", "through",
	"much", "more", "most", "less", "least", "some", "any", "all",
	"such", "both", "each", "every", "other", "another",
	"here", "there",
	"let", "get", "got", "take", "took", "give", "gave",
	"truly", "absolutely", "completely", "totally", "entirely",
]);

const ABBREVIATE: Record<string, string> = {
	because: "b/c",
	however: "but",
	therefore: "so",
	additionally: "+",
	approximately: "~",
	particularly: "esp",
	specifically: "esp",
	currently: "now",
	previously: "before",
	subsequently: "then",
	throughout: "thru",
	instead: "vs",
	without: "w/o",
	with: "w/",
	between: "btwn",
	probably: "likely",
	configuration: "config",
	implementation: "impl",
	documentation: "docs",
	repository: "repo",
	performance: "perf",
	production: "prod",
	development: "dev",
	environment: "env",
	infrastructure: "infra",
	architecture: "arch",
	framework: "fw",
	function: "fn",
	variable: "var",
	parameter: "param",
	argument: "arg",
	request: "req",
	response: "resp",
	database: "db",
	language: "lang",
	directory: "dir",
	execution: "exec",
	operation: "op",
	management: "mgmt",
	deployment: "deploy",
	synchronisation: "sync",
	synchronization: "sync",
	asynchronous: "async",
	synchronous: "sync",
	concurrent: "conc",
	optimisation: "opt",
	optimization: "opt",
	automatically: "auto",
	available: "avail",
	compatibility: "compat",
	incompatible: "incompat",
	information: "info",
	reference: "ref",
	different: "diff",
	specific: "spec",
	important: "imp",
	consider: "cons",
	additional: "extra",
	responsible: "resp",
};

const EXPAND: Record<string, string> = Object.fromEntries(
	Object.entries(ABBREVIATE).map(([word, abbr]) => [abbr, word]),
);

interface Token {
	kind: TokenKind;
	text: string;
}

function tokenise(text: string): Token[] {
	if (!text) return [];
	const occupied = new Array<boolean>(text.length).fill(false);
	const spans: { start: number; end: number; kind: TokenKind }[] = [];
	for (const { kind, regex } of PATTERNS) {
		regex.lastIndex = 0;
		for (const m of text.matchAll(regex)) {
			const s = m.index;
			const e = s + m[0].length;
			let overlaps = false;
			for (let i = s; i < e; i++) {
				if (occupied[i]) {
					overlaps = true;
					break;
				}
			}
			if (overlaps) continue;
			spans.push({ start: s, end: e, kind });
			for (let i = s; i < e; i++) occupied[i] = true;
		}
	}
	spans.sort((a, b) => a.start - b.start);

	const tokens: Token[] = [];
	let cursor = 0;
	for (const span of spans) {
		if (cursor < span.start) tokens.push({ kind: "prose", text: text.slice(cursor, span.start) });
		tokens.push({ kind: span.kind, text: text.slice(span.start, span.end) });
		cursor = span.end;
	}
	if (cursor < text.length) tokens.push({ kind: "prose", text: text.slice(cursor) });
	return tokens;
}

function transformProse(text: string, level: GrammarLevel): string {
	if (!text.trim()) return text;
	let dropSet: Set<string>;
	let doAbbreviate: boolean;
	if (level === "lite") {
		dropSet = ARTICLES;
		doAbbreviate = false;
	} else if (level === "full") {
		dropSet = FILLERS;
		doAbbreviate = false;
	} else {
		dropSet = FILLERS_ULTRA;
		doAbbreviate = true;
	}

	const out: string[] = [];
	const parts = text.split(/(\s+)/);
	for (const part of parts) {
		if (!part) continue;
		if (/^\s+$/.test(part)) {
			out.push(part);
			continue;
		}
		const leadingMatch = /^[^\w]*/.exec(part);
		const trailingMatch = /[^\w]*$/.exec(part);
		const leading = leadingMatch ? leadingMatch[0] : "";
		const trailing = trailingMatch ? trailingMatch[0] : "";
		const core = part.slice(leading.length, part.length - trailing.length);
		if (!core) {
			out.push(part);
			continue;
		}
		const lower = core.toLowerCase();
		if (dropSet.has(lower)) {
			const kept = leading + trailing;
			if (kept) out.push(kept);
			continue;
		}
		if (doAbbreviate && lower in ABBREVIATE) {
			let replaced = ABBREVIATE[lower]!;
			if (/^[A-Z]/.test(core)) replaced = replaced.charAt(0).toUpperCase() + replaced.slice(1);
			out.push(leading + replaced + trailing);
			continue;
		}
		out.push(part);
	}

	let result = out.join("");
	// Collapse internal whitespace runs from drops; newlines survive.
	const leadingWs = /^\s*/.exec(result)![0];
	const trailingWs = /\s*$/.exec(result)![0];
	const middle = result.slice(leadingWs.length, result.length - trailingWs.length);
	const collapsedMiddle = middle.replace(/\s+/g, " ");
	const collapsedLeading = leadingWs.replace(/[ \t]{2,}/g, " ");
	const collapsedTrailing = trailingWs.replace(/[ \t]{2,}/g, " ");
	return collapsedLeading + collapsedMiddle + collapsedTrailing;
}

export function compress(text: string, level: GrammarLevel = "full"): string {
	if (!text) return text;
	return tokenise(text)
		.map((t) => (t.kind === "prose" ? transformProse(t.text, level) : t.text))
		.join("");
}

export function compressWithCounts(text: string, level: GrammarLevel = "full"): { text: string; rawTokens: number; compressedTokens: number } {
	const out = compress(text, level);
	const rawTokens = text ? Math.max(1, Math.floor(text.length / 4)) : 0;
	const compressedTokens = out ? Math.max(1, Math.floor(out.length / 4)) : 0;
	return { text: out, rawTokens, compressedTokens };
}

export function expand(text: string): string {
	if (!text) return text;
	const out: string[] = [];
	for (const token of tokenise(text)) {
		if (token.kind !== "prose") {
			out.push(token.text);
			continue;
		}
		const parts = token.text.split(/(\s+)/);
		for (const part of parts) {
			if (!part || /^\s+$/.test(part)) {
				out.push(part);
				continue;
			}
			const leadingMatch = /^[^\w/]*/.exec(part);
			const trailingMatch = /[^\w/]*$/.exec(part);
			const leading = leadingMatch ? leadingMatch[0] : "";
			const trailing = trailingMatch ? trailingMatch[0] : "";
			const core = part.slice(leading.length, part.length - trailing.length);
			const lower = core.toLowerCase();
			if (lower in EXPAND) {
				let full = EXPAND[lower]!;
				if (/^[A-Z]/.test(core)) full = full.charAt(0).toUpperCase() + full.slice(1);
				out.push(leading + full + trailing);
			} else {
				out.push(part);
			}
		}
	}
	return out.join("");
}

export function compressionRatio(original: string, compressed: string): number {
	if (!original) return 0;
	return 1 - compressed.length / original.length;
}
