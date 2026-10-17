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
const FULL_PASSTHROUGH_THRESHOLD = 0.8;
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

	async compress(chunks: Chunk[], level = "standard"): Promise<Chunk[]> {
		const ollamaAvailable = await this.isOllamaAvailable();
		for (const chunk of chunks) {
			if (level === "full" && this.isFullPassthrough(chunk)) {
				chunk.compressedContent = chunk.content;
				continue;
			}
			const cached = this.cache?.getCachedCompression(chunk.id, level);
			if (cached !== null && cached !== undefined) {
				chunk.compressedContent = cached;
				continue;
			}
			if (ollamaAvailable && level !== "minimal") {
				chunk.compressedContent = await this.llmCompress(chunk, level);
			} else {
				chunk.compressedContent = this.fallbackCompress(chunk, level);
			}
			if (this.cache && chunk.compressedContent) {
				this.cache.putCachedCompression(chunk.id, level, chunk.compressedContent);
			}
		}
		return chunks;
	}

	private isFullPassthrough(chunk: Chunk): boolean {
		if (chunk.confidenceScore > FULL_PASSTHROUGH_THRESHOLD) return true;
		return chunk.embedding === null;
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
		if (chunk.chunkType === "function" || chunk.chunkType === "class") {
			return this.extractSignature(chunk.content, limit);
		}
		if (chunk.content.length <= limit) return chunk.content;
		return chunk.content.slice(0, limit) + "...";
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
