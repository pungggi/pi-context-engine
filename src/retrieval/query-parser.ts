/**
 * Query understanding — port of upstream `retrieval/query_parser.py` (MIT).
 */
import type { ChunkType } from "../types.js";

export type QueryIntent = "code_lookup" | "decision_recall" | "architecture" | "general";

const DECISION_PATTERNS = [
	/what did we decide/,
	/decision about/,
	/why did we/,
	/last session/,
	/previous discussion/,
	/agreed on/,
];
const ARCHITECTURE_PATTERNS = [
	/how is .+ structured/,
	/architecture/,
	/module.+structure/,
	/component.+design/,
	/how does .+ work/,
	/overview of/,
	/explain the .+ system/,
];
const CODE_PATTERNS = [
	/find .+ function/,
	/show me .+ class/,
	/where is .+ defined/,
	/implementation of/,
	/\.py|\.js|\.ts/,
	/function|class|method|def |import /,
];
const FILE_PATH_RE = /[a-zA-Z0-9_./-]+\.[a-zA-Z]{1,10}/g;

const STOP_WORDS = new Set([
	"the", "a", "an", "is", "are", "was", "were", "do", "does", "did",
	"what", "how", "why", "where", "when", "who", "which",
	"in", "on", "at", "to", "for", "of", "with", "about",
	"me", "my", "we", "our", "it", "its", "i", "you",
	"tell", "give",
]);
const CODE_PREFIX_WORDS = new Set(["show", "find", "get", "set", "fetch", "save", "validate", "create", "update", "delete"]);

export interface ParsedQuery {
	original: string;
	intent: QueryIntent;
	keywords: string[];
	fileHints: string[];
}

export class QueryParser {
	parse(query: string): ParsedQuery {
		const lower = query.toLowerCase();
		const intent = this.classifyIntent(lower);
		const keywords = this.extractKeywords(query, intent);
		const fileHints = query.match(FILE_PATH_RE) ?? [];
		return { original: query, intent, keywords, fileHints };
	}

	private classifyIntent(query: string): QueryIntent {
		for (const p of DECISION_PATTERNS) if (p.test(query)) return "decision_recall";
		for (const p of ARCHITECTURE_PATTERNS) if (p.test(query)) return "architecture";
		for (const p of CODE_PATTERNS) if (p.test(query)) return "code_lookup";
		return "general";
	}

	private extractKeywords(query: string, intent: QueryIntent): string[] {
		const identifiers = query.match(/[A-Z][a-zA-Z0-9]+/g) ?? [];
		const words = query.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) ?? [];
		const stop = intent === "code_lookup" ? STOP_WORDS : new Set([...STOP_WORDS, ...CODE_PREFIX_WORDS]);
		const meaningful = words.filter((w) => !stop.has(w.toLowerCase()) && w.length > 2);
		const seen = new Set<string>();
		const result: string[] = [];
		for (const kw of [...identifiers, ...meaningful]) {
			if (!seen.has(kw)) {
				seen.add(kw);
				result.push(kw);
			}
		}
		return result;
	}
}

/**
 * R8: deterministic query elaboration. Strips stopwords, caps the raw terms,
 * and injects up to three identifier-like words that appear in ≥2 of the
 * near-miss FTS hits. No LLM, no network, fully reproducible — the raw
 * query's own ranking is never modified (callers fuse the variant as an
 * additional, lower-weighted candidate source only).
 */
export function elaborateQuery(query: string, nearMissChunks: { content: string }[]): string | null {
	const words = query.match(/[a-zA-Z_$][a-zA-Z0-9_$]*/g) ?? [];
	const kept: string[] = [];
	for (const w of words) {
		if (STOP_WORDS.has(w.toLowerCase()) || w.length < 3) continue;
		if (!kept.includes(w)) kept.push(w);
	}
	const freq = new Map<string, number>();
	for (const chunk of nearMissChunks) {
		const local = new Set<string>();
		for (const m of chunk.content.matchAll(/[A-Za-z_$][A-Za-z0-9_$]{3,}/g)) {
			const w = m[0];
			if (!kept.includes(w)) local.add(w);
		}
		for (const w of local) freq.set(w, (freq.get(w) ?? 0) + 1);
	}
	const extras = [...freq.entries()]
		.filter(([, n]) => n >= 2)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 3)
		.map(([w]) => w);
	const variant = [...kept.slice(0, 8), ...extras].join(" ");
	if (variant.length < 3 || variant === query.trim()) return null;
	return variant;
}