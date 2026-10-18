/**
 * Chunk compression — signatures + docstrings by default, optional LLM
 * summaries via Ollama. Port of upstream `compression/*` (MIT).
 */
import type { Chunk, ChunkType } from "../types.js";

export const CODE_PROMPT =
	"Summarize this code. Include: function/class name, purpose, inputs/outputs, key side effects. Be concise (2-3 sentences max).\n\nCode:\n{content}";
export const DECISION_PROMPT =
	"Summarize this decision. Include: what was decided, why, and what the outcome/action was. One paragraph max.\n\nDecision:\n{content}";
export const ARCHITECTURE_PROMPT =
	"Summarize this component. Include: what it does, its role in the system, and its key dependencies. Be concise (2-3 sentences).\n\nComponent:\n{content}";
export const DOC_PROMPT =
	"Summarize this documentation. Keep the key information, remove boilerplate. Be concise.\n\nDocumentation:\n{content}";

const PROMPT_MAP: Partial<Record<ChunkType, string>> = {
	function: CODE_PROMPT,
	class: CODE_PROMPT,
	module: ARCHITECTURE_PROMPT,
	doc: DOC_PROMPT,
	decision: DECISION_PROMPT,
	session: DOC_PROMPT,
	commit: DOC_PROMPT,
	comment: DOC_PROMPT,
};

const TRUNCATION_LIMITS: Record<string, number> = { minimal: 100, standard: 300, full: 800 };
// Query-aware selection: keep matched lines within the level budget, never more.
const MAX_QUERY_LINES = 40;
/** Words that must not win the line budget just because they recur. */
const QUERY_NOISE_TERMS = new Set([
	"the", "and", "for", "with", "that", "this", "from", "are", "was", "not",
	"you", "all", "can", "has", "its", "but", "how", "what", "when", "where",
	"which", "who", "why", "does", "did", "should", "would", "into", "than",
	"then", "them", "they", "use", "used", "using", "show", "find", "call",
	"calls", "make", "made", "need", "needs", "get", "set", "returns", "return",
]);
// TTL for the Ollama liveness probe so compress() calls don't all pay it.
const OLLAMA_PROBE_TTL_MS = 30_000;

export class OllamaSummarizeClient {
	private baseUrl: string;
	private model: string;

	constructor(baseUrl = "http://localhost:11434", model = "phi3:mini") {
		this.baseUrl = baseUrl.replace(/\/$/, "");
		this.model = model;
	}

	async isAvailable(): Promise<boolean> {
		try {
			const resp = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(1500) });
			return resp.status === 200;
		} catch {
			return false;
		}
	}

	async summarize(content: string, promptTemplate: string): Promise<string> {
		const prompt = promptTemplate.replace("{content}", content);
		const resp = await fetch(`${this.baseUrl}/api/generate`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				model: this.model,
				prompt,
				stream: false,
				options: { temperature: 0.2, num_predict: 256 },
			}),
			signal: AbortSignal.timeout(60_000),
		});
		if (!resp.ok) throw new Error(`Ollama generate failed: HTTP ${resp.status}`);
		const data = (await resp.json()) as { response?: string };
		return (data.response ?? "").trim();
	}
}

/** Lossy detection — verify summaries preserve key identifiers. Port of upstream quality.py. */
export class QualityChecker {
	private static readonly MIN_IDENTIFIER_RATIO = 0.4;
	private static readonly MIN_IDENTIFIER_LEN = 3;

	check(original: string, summary: string): boolean {
		const identifiers = this.extractIdentifiers(original);
		if (identifiers.length === 0) return true;
		const summaryLower = summary.toLowerCase();
		const preserved = identifiers.filter((ident) => summaryLower.includes(ident.toLowerCase())).length;
		return preserved / identifiers.length >= QualityChecker.MIN_IDENTIFIER_RATIO;
	}

	extractIdentifiers(code: string): string[] {
		const identifiers = new Set<string>();
		const patterns = [
			/(?:def|class|function)\s+([a-zA-Z_][a-zA-Z0-9_]*)/g,
			/([a-zA-Z_][a-zA-Z0-9_]*)\s*[=:(]/g,
			/self\.([a-zA-Z_][a-zA-Z0-9_]*)/g,
		];
		for (const pattern of patterns) {
			for (const m of code.matchAll(pattern)) {
				const name = m[1]!;
				if (
					name.length >= QualityChecker.MIN_IDENTIFIER_LEN &&
					!["self", "None", "True", "False"].includes(name)
				) {
					identifiers.add(name);
				}
			}
		}
		for (const m of code.matchAll(/(?:def|function)\s+\w+\s*\(([^)]*)\)/g)) {
			for (const param of m[1]!.split(/[,\s]+/)) {
				const clean = param.trim().split(":")[0]!.split("=")[0]!.trim();
				if (clean.length >= QualityChecker.MIN_IDENTIFIER_LEN && !["self", "cls", "None", "True", "False"].includes(clean)) {
					identifiers.add(clean);
				}
			}
		}
		for (const m of code.matchAll(/\b([A-Z][a-zA-Z0-9]+)\b/g)) {
			identifiers.add(m[1]!);
		}
		return [...identifiers].sort();
	}
}

export interface CompressionCache {
	getCachedCompression(chunkId: string, level: string): string | null;
	putCachedCompression(chunkId: string, level: string, compressed: string): void;
}

export class Compressor {
	private client: OllamaSummarizeClient;
	private quality = new QualityChecker();
	private cache: CompressionCache | null;
	private ollamaAvailable: boolean | null = null;
	private ollamaProbedAt = 0;
	private probeInFlight: Promise<boolean> | null = null;

	constructor(ollamaUrl = "http://localhost:11434", model = "phi3:mini", cache: CompressionCache | null = null) {
		this.client = new OllamaSummarizeClient(ollamaUrl, model);
		this.cache = cache;
	}

	private isOllamaAvailable(): Promise<boolean> {
		const now = Date.now();
		if (this.ollamaAvailable !== null && now - this.ollamaProbedAt < OLLAMA_PROBE_TTL_MS) {
			return Promise.resolve(this.ollamaAvailable);
		}
		// Single-flight the probe.
		this.probeInFlight ??= this.client
			.isAvailable()
			.then((ok) => {
				this.ollamaAvailable = ok;
				this.ollamaProbedAt = Date.now();
				this.probeInFlight = null;
				return ok;
			})
			.catch(() => {
				this.ollamaAvailable = false;
				this.ollamaProbedAt = Date.now();
				this.probeInFlight = null;
				return false;
			});
		return this.probeInFlight;
	}

	/**
	 * Compress chunks for serving.
	 *
	 * `query` enables R3 query-aware selection: when a truncation would cut
	 * lines (minimal/standard without the LLM path), keep the lines that
	 * mention the query's terms within the same character budget instead of
	 * the first N lines. That stops the compressor from deleting the only
	 * line that answers the question, which fixed head-cuts did routinely.
	 *
	 * `queryAware=false` preserves the old head-truncation behaviour. `full`
	 * never truncates: the retrieval token budget decides (plan R3), so
	 * there is nothing for the query to protect at that level.
	 */
	async compress(chunks: Chunk[], level = "standard", query?: string, queryAware = true): Promise<Chunk[]> {
		const ollamaAvailable = await this.isOllamaAvailable();
		const queryText = (query ?? "").trim();
		// Query selection only applies where truncation would otherwise cut.
		// An LLM summary is query-independent (and therefore cacheable), so it
		// keeps precedence when Ollama is up at standard/full.
		const querySelection =
			queryAware && queryText.length > 0 && level !== "full" && !(ollamaAvailable && level !== "minimal");
		for (const chunk of chunks) {
			if (level === "full") {
				// Budget-driven: the engine's maxTokens packing trims, not us.
				chunk.compressedContent = chunk.content;
				continue;
			}
			if (!querySelection) {
				const cached = this.cache?.getCachedCompression(chunk.id, level);
				if (cached !== null && cached !== undefined) {
					chunk.compressedContent = cached;
					continue;
				}
			}
			let compressed: string;
			if (querySelection) {
				// Never read or write the cache here: its key is (chunk, level)
				// and would leak a stale selection from another query.
				compressed = this.queryAwareFallback(chunk, level, queryText);
			} else if (ollamaAvailable && level !== "minimal") {
				compressed = await this.llmCompress(chunk, level);
			} else {
				compressed = this.fallbackCompress(chunk, level);
			}
			chunk.compressedContent = compressed;
			if (this.cache && compressed && !querySelection) {
				this.cache.putCachedCompression(chunk.id, level, compressed);
			}
		}
		return chunks;
	}

	private async llmCompress(chunk: Chunk, level: string): Promise<string> {
		const prompt = PROMPT_MAP[chunk.chunkType] ?? CODE_PROMPT;
		try {
			const summary = await this.client.summarize(chunk.content, prompt);
			if (this.quality.check(chunk.content, summary)) return summary;
		} catch {
			// fall through to truncation
		}
		return this.fallbackCompress(chunk, level);
	}

	private fallbackCompress(chunk: Chunk, level: string): string {
		const limit = TRUNCATION_LIMITS[level] ?? 300;
		// The R1 header is retrieval context, not serving context: the result
		// formatter already prints `[path:start]`, so paying for it again inside
		// a 100-char signature would waste most of the budget.
		const content = stripContextHeader(chunk.content);
		if (chunk.chunkType === "function" || chunk.chunkType === "class") {
			return this.extractSignature(content, limit);
		}
		if (content.length <= limit) return content;
		return content.slice(0, limit) + "...";
	}

	/**
	 * R3: keep the lines that answer the query instead of the first N lines.
	 *
	 * The level's character cap still bounds the output, so serving size never
	 * grows: matched lines simply win the budget over leading boilerplate, then
	 * the selection is restored to source order for readability. When nothing
	 * matches (a vague query), plain truncation is returned — a weak query must
	 * not blank the result.
	 */
	private queryAwareFallback(chunk: Chunk, level: string, query: string): string {
		const limit = TRUNCATION_LIMITS[level] ?? 300;
		const terms = queryTerms(query);
		const body = stripContextHeader(chunk.content);
		if (terms.length === 0) return this.fallbackCompress(chunk, level);

		const lines = body.split("\n");
		const matches: { line: string; idx: number; hits: number }[] = [];
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]!;
			if (line.trim().length === 0) continue;
			const lower = line.toLowerCase();
			let hits = 0;
			for (const t of terms) if (lower.includes(t)) hits++;
			if (hits > 0) matches.push({ line, idx: i, hits });
		}
		if (matches.length === 0) return this.fallbackCompress(chunk, level);

		matches.sort((a, b) => b.hits - a.hits || a.idx - b.idx);
		let budget = limit;
		const selected: typeof matches = [];
		let used = 0;
		for (const m of matches) {
			if (used + m.line.length + 1 > budget) continue;
			selected.push(m);
			used += m.line.length + 1;
			if (selected.length >= MAX_QUERY_LINES) break;
		}
		if (selected.length === 0) return this.fallbackCompress(chunk, level);
		selected.sort((a, b) => a.idx - b.idx);
		return selected.map((m) => m.line).join("\n");
	}

	private extractSignature(content: string, limit: number): string {
		const lines = content.split("\n");
		const resultLines: string[] = [];
		let inDocstring = false;
		let charCount = 0;
		for (const line of lines) {
			if (charCount + line.length > limit && resultLines.length > 0) break;
			resultLines.push(line);
			charCount += line.length + 1;
			if (line.includes('"""') || line.includes("'''")) {
				if (inDocstring) break;
				inDocstring = true;
			}
			if (!inDocstring && line.trim().endsWith(":") && resultLines.length > 1) break;
		}
		return resultLines.join("\n");
	}
}

/** Drop the R1 `// file: …` header line (serving shows `[path:start]` already). */
function stripContextHeader(content: string): string {
	if (!content.startsWith("// file: ")) return content;
	const nl = content.indexOf("\n");
	return nl < 0 ? content : content.slice(nl + 1);
}

/** Distinct query terms (>=3 chars, non-boilerplate) for line matching. */
function queryTerms(query: string): string[] {
	const tokens = query.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const t of tokens) {
		if (t.length < 3 || QUERY_NOISE_TERMS.has(t) || seen.has(t)) continue;
		seen.add(t);
		out.push(t);
		if (out.length >= 40) break;
	}
	return out;
}
