/**
 * Engine — the stateful core behind every tool. Owns the storage backend,
 * embedder, memory db, session capture and savings accounting. Port of the
 * non-MCP parts of upstream `integration/mcp_server.py` (MIT).
 */
import fs from "node:fs";
import path from "node:path";
import type { Config } from "./config.js";
import { loadConfigForProject, resolveOllamaUrl } from "./config.js";
import { atomicWriteText, epochSeconds, humaniseRelativeTime, projectStorageDir, sha256Hex } from "./utils.js";
import { LocalBackend } from "./storage/local-backend.js";
import { Embedder, selectBackend } from "./indexer/embedder.js";
import { HybridRetriever } from "./retrieval/retriever.js";
import { LocalReranker } from "./retrieval/reranker.js";
import { assessQuery, type QueryAssessment } from "./retrieval/confidence.js";
import { QueryParser } from "./retrieval/query-parser.js";
import { Compressor } from "./compression/compressor.js";
import { MemoryDb, memoryDbPath, scrubPii, setPiiRedaction, type Bucket } from "./memory/db.js";
import { SessionCapture } from "./memory/session-capture.js";
import { drainOne, enqueueSessionRollup, enqueueTurn, type CompressionDeps } from "./memory/compressor.js";
import { compress, expand, compressWithCounts, DEFAULT_LEVEL } from "./memory/grammar.js";
import { cosine } from "./memory/extractive.js";
import { runIndexing } from "./indexer/pipeline.js";
import { getModelPricing } from "./pricing.js";
import type { Chunk } from "./types.js";

const CHARS_PER_TOKEN = 4;
const JSON_CHARS_PER_TOKEN = 6;
const MAX_QUERY_CHARS = 10_000;
const MAX_TOP_K = 100;
const SESSION_RECALL_WINDOW = 50;
const SESSION_RECALL_MIN_SIM = 0.55;
const FTS_RECALL_LIMIT = 100;
const VEC_RECALL_K = 30;
const RRF_K = 60;
const TLDR_TOP_N = 10;
const RECALL_DISPLAY_CAP_DEFAULT = 7;
const EVENT_PAYLOAD_READ_CAP = 4_000;

/** Files this extension itself creates — never worth returning as "code". */
const PCE_CONFIG_PREFIXES = [".pi/", ".mcp.json", ".context-engine.yaml"];
const PCE_CONFIG_FILES = new Set(["AGENTS.md"]);

export function isPceConfig(filePath: string): boolean {
	if (PCE_CONFIG_FILES.has(filePath)) return true;
	return PCE_CONFIG_PREFIXES.some((p) => filePath.startsWith(p));
}

export function countTokens(text: string): number {
	return Math.max(1, Math.floor(text.length / CHARS_PER_TOKEN));
}

const FTS_STOP_WORDS = new Set([
	"a", "an", "the", "this", "that", "these", "those", "some", "any",
	"no", "all", "both", "each", "every", "other", "another", "such",
	"is", "are", "was", "were", "be", "been", "being", "am",
	"have", "has", "had", "having",
	"do", "does", "did", "doing", "done",
	"will", "would", "shall", "should", "can", "could", "may", "might",
	"must", "ought",
	"i", "we", "you", "he", "she", "it", "they", "me", "us", "him", "her",
	"them", "my", "our", "your", "his", "its", "their", "mine", "ours",
	"yours", "hers", "theirs",
	"of", "in", "on", "at", "to", "for", "with", "by", "from", "as",
	"into", "onto", "upon", "about", "above", "below", "under", "over",
	"between", "among", "through", "during", "before", "after", "since",
	"until", "while", "and", "or", "but", "nor", "so", "if", "than",
	"then", "because", "though", "although", "unless",
	"how", "what", "when", "where", "which", "who", "whom", "whose",
	"why", "here", "there",
	"just", "only", "even", "also", "very", "too", "still", "now",
	"today", "tomorrow", "yesterday",
	"get", "got", "make", "made", "go", "went", "see", "saw", "let",
]);

export function stripStopWords(topic: string): string {
	const tokens = topic.split(/\s+/).filter(Boolean);
	const content = tokens.filter((t) => !FTS_STOP_WORDS.has(t.toLowerCase()));
	return content.length > 0 ? content.join(" ") : topic;
}

function ftMatchQuery(topic: string): string {
	const content = stripStopWords(topic).split(/\s+/).filter(Boolean);
	if (content.length === 0) return "";
	return content.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}

/** Reciprocal rank fusion of ranked string lists, deduping on content key. */
export function rrfMerge(rankedLists: string[][], top: number): string[] {
	const scores = new Map<string, number>();
	const reprForKey = new Map<string, string>();
	for (const items of rankedLists) {
		items.forEach((item, rank) => {
			const key = contentKey(item);
			scores.set(key, (scores.get(key) ?? 0) + 1 / (RRF_K + rank + 1));
			const existing = reprForKey.get(key);
			if (existing === undefined || (item.length > existing.length && item.includes(" · "))) {
				reprForKey.set(key, item);
			}
		});
	}
	return [...scores.entries()]
		.sort((a, b) => b[1] - a[1])
		.slice(0, top)
		.map(([key]) => reprForKey.get(key)!);
}

const TAG_PREFIX_RE = /^\[[^\]]*\]\s*/;
const AFFORDANCE_TAIL_RE = /\s*·\s+(?:just now|\d+[mhdy]o? ago|\d+[mhd] ago)(?:\s*·\s+→\s+session_(?:timeline|event)\([^)]*\))?\s*$/;

/** Stable dedup key: strips tag prefix, affordance tail, and articles. */
export function contentKey(text: string): string {
	let body = text.replace(TAG_PREFIX_RE, "");
	body = body.replace(AFFORDANCE_TAIL_RE, "");
	return compress(body.trim(), "lite");
}

export interface SessionStats {
	queries: number;
	rawTokens: number;
	servedTokens: number;
	fullFileTokens: number;
}

export interface EngineOptions {
	projectDir: string;
	config?: Config;
	/** Test seam: reuse an existing backend/embedder instead of auto-detecting. */
	runtime?: { backend: LocalBackend; embedder: Embedder };
}

/** R13: cheap keyword extraction for decision tags (no LLM): distinctive
 * lowercased tokens, stopwords stripped, longest first for stability. */
const KEYWORD_STOPWORDS = new Set([
	"the", "and", "for", "with", "that", "this", "from", "into", "use", "using", "was", "are",
	"when", "then", "than", "will", "shall", "should", "would", "could", "have", "has", "been",
	"because", "since", "given", "instead", "only", "also", "just", "like", "over", "under",
]);
function keywordsOf(text: string, max = 5): string[] {
	const tokens = text
		.toLowerCase()
		.replace(/[^a-z0-9_.-]+/g, " ")
		.split(" ")
		.filter((w) => w.length >= 4 && !KEYWORD_STOPWORDS.has(w));
	return [...new Set(tokens)].sort((a, b) => b.length - a.length).slice(0, max);
}

export class ContextEngine {
	readonly projectDir: string;
	readonly projectName: string;
	readonly storageBase: string;
	config: Config;
	private readonly injectedRuntime: { backend: LocalBackend; embedder: Embedder } | undefined;
	private backendInstance: LocalBackend | null = null;
	private embedderInstance: Embedder | null = null;
	private retrieverInstance: HybridRetriever | null = null;
	private compressorInstance: Compressor | null = null;
	private memoryInstance: MemoryDb | null = null;
	private memoryFailed = false;
	readonly sessionCapture: SessionCapture;
	sessionId: string;
	private stats: SessionStats;
	private statsPath: string;
	private drainTimer: NodeJS.Timeout | null = null;
	draining = false;
	private searchesSinceDecision = 0;
	private hasRecordedDecision = false;
	private vecBackfillStarted = false;

	constructor(options: EngineOptions) {
		this.projectDir = fs.realpathSync(path.resolve(options.projectDir));
		this.projectName = path.basename(this.projectDir);
		this.config = options.config ?? loadConfigForProject(this.projectDir);
		this.injectedRuntime = options.runtime;
		if (options.runtime) {
			this.backendInstance = options.runtime.backend;
			this.embedderInstance = options.runtime.embedder;
		}
		this.storageBase = projectStorageDir(this.config.storagePath, this.projectDir);
		fs.mkdirSync(this.storageBase, { recursive: true });
		setPiiRedaction(this.config.memoryRedactPii);
		this.sessionCapture = new SessionCapture(path.join(this.storageBase, "sessions"));
		this.sessionId = this.sessionCapture.startSession(this.projectName);
		this.statsPath = path.join(this.storageBase, "stats.json");
		this.stats = this.loadStats();
	}

	// ── Lazy resources ────────────────────────────────────────────────────

	get backend(): LocalBackend {
		this.backendInstance ??= new LocalBackend(this.storageBase);
		return this.backendInstance;
	}

	private async getEmbedder(): Promise<Embedder> {
		if (!this.embedderInstance) {
			const impl = await selectBackend({
				model: this.config.embeddingModel,
				ollamaModel: this.config.ollamaEmbedModel,
				ollamaUrl: resolveOllamaUrl(this.config),
			});
			this.embedderInstance = new Embedder(impl);
		}
		return this.embedderInstance;
	}

	async getRetriever(): Promise<HybridRetriever> {
		if (!this.retrieverInstance) {
			this.retrieverInstance = new HybridRetriever(this.backend, await this.getEmbedder(), {
				expandContext: this.config.retrievalExpandContext,
				autoElaborate: this.config.retrievalAutoElaborate,
				reranker:
					this.config.retrievalRerank === "local"
						? new LocalReranker(this.config.retrievalRerankModel)
						: null,
			});
		}
		return this.retrieverInstance;
	}

	async getCompressor(): Promise<Compressor> {
		if (!this.compressorInstance) {
			this.compressorInstance = new Compressor(
				resolveOllamaUrl(this.config),
				this.config.compressionModel,
				this.backend,
			);
		}
		return this.compressorInstance;
	}

	/** Memory db, or null when it can't be opened (recall degrades to JSON sessions). */
	getMemory(): MemoryDb | null {
		if (this.memoryInstance) return this.memoryInstance;
		if (this.memoryFailed) return null;
		try {
			this.memoryInstance = new MemoryDb(memoryDbPath(this.storageBase));
			this.ensureSessionRow();
			return this.memoryInstance;
		} catch {
			this.memoryFailed = true;
			return null;
		}
	}

	private ensureSessionRow(): void {
		if (!this.memoryInstance) return;
		const epoch = epochSeconds();
		this.memoryInstance.db
			.prepare(
				"INSERT OR IGNORE INTO sessions (id, project, started_at_epoch, started_at, status) VALUES (?, ?, ?, ?, 'active')",
			)
			.run(this.sessionId, this.projectName, epoch, new Date(epoch * 1000).toISOString());
	}

	// ── Stats / savings ───────────────────────────────────────────────────

	private loadStats(): SessionStats {
		try {
			if (fs.existsSync(this.statsPath)) {
				const data = JSON.parse(fs.readFileSync(this.statsPath, "utf-8")) as Partial<SessionStats>;
				return {
					queries: data.queries ?? 0,
					rawTokens: data.rawTokens ?? 0,
					servedTokens: data.servedTokens ?? 0,
					fullFileTokens: data.fullFileTokens ?? 0,
				};
			}
		} catch {
			// fall through to defaults
		}
		return { queries: 0, rawTokens: 0, servedTokens: 0, fullFileTokens: 0 };
	}

	private saveStats(): void {
		try {
			atomicWriteText(this.statsPath, JSON.stringify(this.stats));
		} catch {
			// stats are best-effort
		}
	}

	getStats(): SessionStats {
		return { ...this.stats };
	}

	recordBucket(bucket: Bucket, baseline: number, served: number, meta?: Record<string, unknown>): void {
		const memory = this.getMemory();
		memory?.recordSavings(bucket, baseline, served, meta);
	}

	/** Split a retrieval into the retrieval + chunk_compression buckets. */
	recordQuery(rawTokens: number, servedTokens: number, fullFileTokens: number): void {
		this.stats.queries += 1;
		this.stats.rawTokens += rawTokens;
		this.stats.servedTokens += servedTokens;
		this.stats.fullFileTokens += fullFileTokens;
		if (fullFileTokens > 0) this.recordBucket("retrieval", fullFileTokens, rawTokens);
		if (rawTokens > 0) this.recordBucket("chunk_compression", rawTokens, servedTokens);
		this.saveStats();
	}

	aggregateSavings(): Record<Bucket, { baseline: number; served: number; calls: number }> | null {
		return this.getMemory()?.aggregateSavings() ?? null;
	}

	// ── Index status / reindex ────────────────────────────────────────────

	chunkCount(): number {
		return this.backend.countChunks();
	}

	async reindex(options: { full?: boolean; targetPath?: string | null; onProgress?: (msg: string) => void } = {}): Promise<{
		indexed: number;
		chunks: number;
		deleted: number;
		skipped: number;
		errors: string[];
	}> {
		const result = await runIndexing(this.config, this.projectDir, {
			full: options.full,
			targetPath: options.targetPath ?? null,
			callbacks: { phase: options.onProgress },
			runtime: this.injectedRuntime,
		});
		// R7: graph edges changed → refresh the PageRank prior and force the
		// retriever to pick it up on the next query.
		this.backend.recomputePriors();
		this.retrieverInstance = null;
		return {
			indexed: result.indexedFiles.length,
			chunks: result.totalChunks,
			deleted: result.deletedFiles.length,
			skipped: result.skippedFiles.length,
			errors: result.errors,
		};
	}

	// ── Memory writes ─────────────────────────────────────────────────────

	async recordDecision(
		decisionInput: string,
		reasonInput: string,
		opts: { relatedTo?: number[]; tags?: string[]; files?: string[] } = {},
	): Promise<string> {
		const decision = scrubPii(decisionInput.trim());
		const reason = scrubPii(reasonInput.trim());
		// R13: structured attributes - scrubbed before any write, like the text.
		const tags = (opts.tags ?? []).map((x) => scrubPii(x.trim())).filter(Boolean).slice(0, 8);
		const files = (opts.files ?? []).map((x) => scrubPii(x.trim())).filter(Boolean).slice(0, 8);
		this.sessionCapture.recordDecision(this.sessionId, decision, reason);
		this.sessionCapture.persist(this.sessionId);
		this.searchesSinceDecision = 0;
		this.hasRecordedDecision = true;

		const memory = this.getMemory();
		if (memory) {
			const epoch = epochSeconds();
			const stored = compressWithCounts(decision, DEFAULT_LEVEL);
			const storedReason = compressWithCounts(reason, DEFAULT_LEVEL);
			this.recordBucket("grammar", stored.rawTokens + storedReason.rawTokens, stored.compressedTokens + storedReason.compressedTokens);
			const result = memory.db
				.prepare(
					"INSERT INTO decisions (session_id, decision, reason, source, created_at_epoch, created_at, tags, files) VALUES (?, ?, ?, 'manual', ?, ?, ?, ?)",
				)
				.run(
					this.sessionId,
					stored.text,
					storedReason.text,
					epoch,
					new Date(epoch * 1000).toISOString(),
					JSON.stringify([...tags, ...keywordsOf(decision)].slice(0, 8)),
					JSON.stringify(files),
				);
			const newId = Number(result.lastInsertRowid);
			const embedder = await this.getEmbedder();
			await memory.recordDecisionVec(embedder, newId, stored.text, storedReason.text);
			// R13 auto-linking: connect similar past decisions with related_to edges.
			const linked = await memory.autoLinkDecision(embedder, newId, stored.text + " - " + storedReason.text, { cap: 3 });
			// R13 memory evolution: an explicit relatedTo annotates an earlier
			// decision (original text stays immutable; the note lives on the edge).
			for (const target of opts.relatedTo ?? []) {
				memory.linkDecisions(newId, Number(target), "annotates", reason || null);
			}
			if (linked.length > 0) {
				const heads = linked.map((id) => memory.decisionHeadline(id)).filter(Boolean).join("; ");
				if (heads) return decision + " (linked: " + heads + ")";
			}
		}
		return decision;
	}

	async recordCodeArea(filePath: string, descriptionInput: string): Promise<void> {
		const description = scrubPii(descriptionInput.trim());
		this.sessionCapture.recordCodeArea(this.sessionId, filePath, description);
		this.sessionCapture.persist(this.sessionId);
		const memory = this.getMemory();
		if (memory) {
			memory.db
				.prepare(
					"INSERT INTO code_areas (session_id, file_path, description, source, created_at_epoch) VALUES (?, ?, ?, 'manual', ?)",
				)
				.run(this.sessionId, filePath, description, epochSeconds());
		}
	}

	// ── Session capture from pi events ────────────────────────────────────

	recordPrompt(promptText: string): number {
		const memory = this.getMemory();
		if (!memory) return 0;
		const row = memory.db
			.prepare("SELECT COALESCE(MAX(prompt_number), 0) AS n FROM prompts WHERE session_id = ?")
			.get(this.sessionId) as { n: number };
		const promptNumber = (row?.n ?? 0) + 1;
		const epoch = epochSeconds();
		try {
			memory.db
				.prepare(
					"INSERT OR REPLACE INTO prompts (session_id, prompt_number, prompt_text, created_at_epoch, created_at) VALUES (?, ?, ?, ?, ?)",
				)
				.run(this.sessionId, promptNumber, scrubPii(promptText).slice(0, 4000), epoch, new Date(epoch * 1000).toISOString());
			memory.db.prepare("UPDATE sessions SET prompt_count = ? WHERE id = ?").run(promptNumber, this.sessionId);
		} catch {
			// capture is best-effort
		}
		return promptNumber;
	}

	recordToolEvent(toolName: string, rawInput: string, rawOutput: string | null, promptNumber: number): void {
		const memory = this.getMemory();
		if (!memory) return;
		try {
			const epoch = epochSeconds();
			const payload = memory.db
				.prepare("INSERT INTO tool_event_payloads (raw_input, raw_output, size_bytes) VALUES (?, ?, ?)")
				.run(rawInput.slice(0, 4000), rawOutput, rawInput.length + (rawOutput?.length ?? 0));
			memory.db
				.prepare(
					"INSERT INTO tool_events (session_id, prompt_number, tool_name, payload_id, summary, created_at_epoch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				)
				.run(
					this.sessionId,
					promptNumber,
					toolName,
					Number(payload.lastInsertRowid),
					`${toolName} (${Math.round((rawInput.length + (rawOutput?.length ?? 0)) / 1024)}KB)`,
					epoch,
					new Date(epoch * 1000).toISOString(),
				);
		} catch {
			// capture is best-effort
		}
	}

	enqueueTurnCompression(promptNumber: number): void {
		const memory = this.getMemory();
		if (!memory) return;
		enqueueTurn(memory, this.sessionId, promptNumber);
	}

	/** Drain the compression queue once (called on a timer while the session is live). */
	async drainCompressionQueue(maxItems = 5): Promise<void> {
		if (this.draining) return;
		const memory = this.getMemory();
		if (!memory) return;
		this.draining = true;
		try {
			const deps: CompressionDeps = { memory, embedder: await this.getEmbedder() };
			for (let i = 0; i < maxItems; i++) {
				const did = await drainOne(deps);
				if (!did) break;
			}
		} catch {
			// never let background compression break a turn
		} finally {
			this.draining = false;
		}
	}

	startBackgroundWork(): void {
		if (this.drainTimer) return;
		this.drainTimer = setInterval(() => {
			void this.drainCompressionQueue();
		}, 5000);
		this.drainTimer.unref?.();
		void this.backfillMemoryVec().catch(() => undefined);
	}

	/**
	 * One-shot semantic-memory backfill (upstream #137 lesson). After an
	 * embedder change the vec tables are recreated empty; without this, old
	 * decisions silently lose semantic recall (FTS still works, so the loss is
	 * easy to miss). Guarded by a cheap missing-row count so the steady state
	 * never initialises an embedder for this. Recall also self-heals via
	 * `MemoryDb.healVecTables`, covering wipes that happen after this runs.
	 */
	private async backfillMemoryVec(): Promise<void> {
		if (this.vecBackfillStarted) return;
		this.vecBackfillStarted = true;
		const memory = this.getMemory();
		if (!memory || !memory.vecAvailable || !memory.hasVecTables()) return;
		const pending = memory.vecBackfillPending();
		if (pending.decisions + pending.turnSummaries === 0) return;
		await memory.backfillVecTables(await this.getEmbedder());
	}

	async shutdown(): Promise<void> {
		if (this.drainTimer) {
			clearInterval(this.drainTimer);
			this.drainTimer = null;
		}
		// Every step below is best-effort: shutdown runs from a lifecycle hook
		// where a throw would surface as a pi error, and it must still release
		// the sqlite handles (Windows keeps files locked otherwise).
		try {
			const memory = this.getMemory();
			if (memory) {
				enqueueSessionRollup(memory, this.sessionId);
				await this.drainCompressionQueue(200);
				memory.db
					.prepare("UPDATE sessions SET status = 'completed', ended_at_epoch = ?, ended_at = ? WHERE id = ?")
					.run(epochSeconds(), new Date().toISOString(), this.sessionId);
			}
		} catch {
			// compression/flush failures must not block cleanup
		}
		try {
			this.sessionCapture.endSession(this.sessionId);
		} catch {
			// ignore
		}
		try {
			this.memoryInstance?.close();
		} catch {
			// ignore
		}
		this.memoryInstance = null;
		try {
			this.backendInstance?.close();
		} catch {
			// ignore
		}
		this.backendInstance = null;
	}

	// ── Search ────────────────────────────────────────────────────────────

	async search(query: string, opts: { topK?: number; maxTokens?: number } = {}): Promise<{
		body: string;
		inline: Chunk[];
		overflow: Chunk[];
		droppedLowValue: number;
		/** R8: query-level confidence assessment for this call. */
		queryAssessment: QueryAssessment;
	}> {
		const retriever = await this.getRetriever();
		const compressor = await this.getCompressor();
		const topK = Math.max(1, Math.min(opts.topK ?? 10, MAX_TOP_K));
		const maxTokens = Math.max(500, Math.min(opts.maxTokens ?? 8000, 50_000));

		const stats: {
		candidates?: number;
		selected?: number;
		droppedLowValue?: number;
		querySignals?: import("./retrieval/retriever.js").QuerySignals;
		nearMissFiles?: string[];
	} = {};
		let chunks = await retriever.retrieve(query, {
			topK: topK * 2,
			confidenceThreshold: this.config.retrievalConfidenceThreshold,
			marginalRatio: this.config.retrievalMarginalRatio,
			maxTokens: null,
			statsOut: stats,
		});
		// R3: the compressor keeps lines that answer THIS query when it has to
		// truncate. Query-agnostic setups (or `compression.query_aware: false`)
		// keep the old head-truncation behaviour.
		chunks = await compressor.compress(
			chunks,
			this.config.compressionLevel,
			this.config.compressionQueryAware ? query : undefined,
		);
		chunks = chunks.filter((c) => !isPceConfig(c.filePath));

		const inline: Chunk[] = [];
		const overflow: Chunk[] = [];
		let budget = maxTokens;
		for (const chunk of chunks) {
			const tokens = countTokens(chunk.compressedContent || chunk.content);
			if (tokens <= budget) {
				inline.push(chunk);
				budget -= tokens;
			} else {
				overflow.push(chunk);
			}
		}

		// Accounting, capped per file so overlapping chunks can't over-count.
		const perFileRaw = new Map<string, number>();
		const perFileServed = new Map<string, number>();
		const seenFiles = new Set<string>();
		for (const chunk of inline) {
			const served = chunk.compressedContent || chunk.content;
			perFileRaw.set(chunk.filePath, (perFileRaw.get(chunk.filePath) ?? 0) + countTokens(chunk.content));
			perFileServed.set(chunk.filePath, (perFileServed.get(chunk.filePath) ?? 0) + countTokens(served));
			seenFiles.add(chunk.filePath);
		}
		for (const chunk of overflow) {
			perFileRaw.set(chunk.filePath, (perFileRaw.get(chunk.filePath) ?? 0) + countTokens(chunk.content));
			perFileServed.set(chunk.filePath, (perFileServed.get(chunk.filePath) ?? 0) + 30);
			seenFiles.add(chunk.filePath);
		}

		let fullFileTokens = 0;
		const caps = new Map<string, number>();
		for (const fp of seenFiles) {
			if (fp.startsWith("git:")) continue;
			try {
				const size = fs.statSync(path.join(this.projectDir, fp)).size;
				const tokens = Math.max(1, Math.floor(size / CHARS_PER_TOKEN));
				caps.set(fp, tokens);
				fullFileTokens += tokens;
			} catch {
				// file may be gone
			}
		}

		let rawTokens = 0;
		let servedTokens = 0;
		for (const fp of seenFiles) {
			const cap = caps.get(fp);
			const raw = perFileRaw.get(fp) ?? 0;
			const served = perFileServed.get(fp) ?? 0;
			rawTokens += cap !== undefined ? Math.min(raw, cap) : raw;
			servedTokens += cap !== undefined ? Math.min(served, cap) : served;
		}

		this.sessionCapture.touchFiles(this.sessionId, seenFiles);
		this.sessionCapture.persist(this.sessionId);
		this.searchesSinceDecision += 1;

		const body = formatResults(inline, overflow);
		// R8: query-confidence line — silent when high, actionable hints when the
		// evidence says the query was weak (predicted query performance tracks
		// answer quality; telling the agent beats silently serving junk).
		const assessment = assessQuery(
			stats.querySignals ?? { topScore: 0, margin: 0, agreement: 0, candidates: 0 },
			new QueryParser().parse(query),
			{ high: this.config.retrievalConfidenceHigh, low: this.config.retrievalConfidenceLow },
		);
		const bodyWithConfidence =
			assessment.level === "high" || (inline.length === 0 && overflow.length === 0)
				? body
				: `${body}\n[query confidence: ${assessment.level}${assessment.hints.length > 0 ? ` — ${assessment.hints.join("; ")}` : ""}]`;
		// R9: one `refine:` line — the next query candidates the retriever can
		// already see (sibling symbol, just-missed file, an alternate term), so
		// the search tool becomes a guided loop instead of a one-shot.
		const refine = this.buildRefineLine(query, inline, stats.nearMissFiles ?? []);
		const finalBody = refine ? `${bodyWithConfidence}\n${refine}` : bodyWithConfidence;
		this.recordQuery(rawTokens, servedTokens, fullFileTokens);
		return {
			body: finalBody,
			inline,
			overflow,
			droppedLowValue: stats.droppedLowValue ?? 0,
			queryAssessment: assessment,
		};
	}

	/** Chunker fallback node names that are never useful refine hints. */
	private static readonly REFINE_JUNK_NAMES = new Set([
		"function",
		"class",
		"module",
		"const",
		"export",
		"import",
		"interface",
		"return",
		"async",
	]);

	/**
	 * R9: deterministic refine suggestions from what the retriever already
	 * knows: a sibling symbol from the top hit's file (graph defines), a file
	 * that ranked 11-15 but was not served, and a term frequent across the
	 * top hits but absent from the query. Capped at 3 items and 160 chars
	 * (≤40 tokens) per call.
	 */
	private buildRefineLine(query: string, hits: Chunk[], nearMissFiles: string[]): string | null {
		if (!this.config.retrievalRefineHints) return null;
		const items: string[] = [];
		const top = hits[0];
		if (top) {
			try {
				const units = new Set(
					hits
						.filter((h) => h.filePath === top.filePath)
						.map((h) => {
							const u = h.metadata["unit"];
							return typeof u === "string" && u.includes(".") ? u.slice(u.lastIndexOf(".") + 1) : typeof u === "string" ? u : "";
						}),
				);
				const sibling = this.backend
					.getNodesByFile(top.filePath)
					.filter((n) => n.nodeType === "function" || n.nodeType === "class")
					.map((n) => n.name)
					.filter((n) => !ContextEngine.REFINE_JUNK_NAMES.has(n) && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n))
					.find((n) => !units.has(n));
				if (sibling) items.push(`"${sibling}"`);
			} catch {
				// graph lookup is best-effort
			}
		}
		const servedFiles = new Set(hits.map((h) => h.filePath));
		for (const f of nearMissFiles.slice(0, 1)) {
			if (!servedFiles.has(f)) items.push(`file:${f}`);
		}
		const termFreq = new Map<string, number>();
		for (const chunk of hits.slice(0, 3)) {
			const text = chunk.compressedContent || chunk.content;
			const local = new Set<string>();
			for (const m of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]{4,}/g)) {
				const w = m[0];
				if (!query.includes(w)) local.add(w);
			}
			for (const w of local) termFreq.set(w, (termFreq.get(w) ?? 0) + 1);
		}
		const alt = [...termFreq.entries()]
			.filter(([w, n]) => n >= 2 && !ContextEngine.REFINE_JUNK_NAMES.has(w))
			.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([w]) => `"${w}"`)
		.find((w) => !items.includes(w));
		if (alt) items.push(alt);
		if (items.length === 0) return null;
		const line = `[refine: ${items.slice(0, 3).join(" · ")}]`;
		return line.length <= 160 ? line : null;
	}

	/** Memory nudge appended to search results when the agent never records. */
	buildNudge(): string {
		const threshold = this.hasRecordedDecision ? 8 : 4;
		const parts: string[] = [];
		if (this.searchesSinceDecision >= threshold) {
			const count = this.sessionCapture.getSnapshot(this.sessionId)?.decisions.length ?? 0;
			parts.push(
				`[pi-context-engine] ${this.searchesSinceDecision} context searches this session, ${count} decision(s) recorded.\n` +
					`If you chose a library, resolved an ambiguity, or established a convention, call record_decision(decision="...", reason="...").\n` +
					`Skip if this session is just exploration/reading.`,
			);
		}
		const snapshot = this.sessionCapture.getSnapshot(this.sessionId);
		if (snapshot) {
			const touched = new Set(Object.keys(snapshot.touchedFiles));
			const recorded = new Set(snapshot.codeAreas.map((c) => c.filePath));
			const unrecorded = [...touched].filter((f) => !recorded.has(f)).sort();
			if (unrecorded.length >= 3) {
				const shown = unrecorded.slice(0, 5);
				const suffix = unrecorded.length > shown.length ? ` (+${unrecorded.length - shown.length} more)` : "";
				parts.push(
					`[pi-context-engine] ${unrecorded.length} files explored but not recorded: ${shown.join(", ")}${suffix}\n` +
						`If you modified or traced a non-obvious flow, call record_code_area(file_path="...", description="...").\n` +
						`Skip for files you only glanced at.`,
				);
			}
		}
		return parts.length > 0 ? "\n\n---\n" + parts.join("\n\n") : "";
	}

	// ── Recall ────────────────────────────────────────────────────────────

	async sessionRecall(topicInput: string): Promise<string> {
		const topic = topicInput.trim();
		if (!topic) return "topic is required.";
		const matches = await this.searchSessions(topic);
		if (matches.length === 0) {
			return (
				`No recorded decisions or code-area notes matching '${topic}'. ` +
				"Use record_decision or record_code_area to capture notes during the session."
			);
		}
		const body = await this.formatRecall(topic, matches);
		const baseline = matches.reduce((acc, m) => acc + countTokens(m), 0);
		if (baseline > 0) {
			this.recordBucket("memory_recall", baseline, countTokens(body), {
				matches: matches.length,
				topic_len: topic.length,
			});
		}
		return body;
	}

	private async formatRecall(topic: string, matches: string[]): Promise<string> {
		const cap = Number(process.env.PCE_RECALL_DISPLAY_CAP ?? RECALL_DISPLAY_CAP_DEFAULT) || RECALL_DISPLAY_CAP_DEFAULT;
		const head = matches.slice(0, Math.max(1, cap));
		let tldrLines: string[] = [];
		if (head.length >= 3) {
			try {
				const cleaned = head.slice(0, TLDR_TOP_N).map((m) => contentKey(m)).filter(Boolean);
				if (cleaned.length > 0) {
					const embedder = await this.getEmbedder();
					const vecs: number[][] = [];
					for (const c of cleaned) vecs.push(await embedder.embedQuery(c));
					const dim = vecs[0]!.length;
					const centroid = new Array<number>(dim).fill(0);
					for (const vec of vecs) for (let i = 0; i < dim; i++) centroid[i]! += vec[i]!;
					for (let i = 0; i < dim; i++) centroid[i]! /= vecs.length;
					tldrLines = cleaned
						.map((text, i) => ({ text, score: cosine(vecs[i]!, centroid) }))
						.sort((a, b) => b.score - a.score)
						.slice(0, 3)
						.map((x) => x.text);
				}
			} catch {
				tldrLines = [];
			}
		}
		const bodyLines = head.map((m) => `- ${m}`);
		if (tldrLines.length > 0) {
			const n = matches.length;
			const header =
				`TL;DR (${n} match${n === 1 ? "" : "es"} for '${topic}'):\n` +
				tldrLines.map((line) => `  • ${line}`).join("\n");
			return header + "\n\nSource matches:\n" + bodyLines.join("\n");
		}
		return bodyLines.join("\n");
	}

	private async searchSessions(topic: string): Promise<string[]> {
		const needle = topic.toLowerCase();
		const jsonCandidates = this.collectJsonCandidates();
		const jsonRanked = await this.rankJsonCandidates(topic, jsonCandidates);
		const memoryLists = await this.collectMemoryDbCandidates(topic);
		const ranked = rrfMerge([jsonRanked, ...memoryLists], 50);
		if (ranked.length > 0) return ranked;
		// Total fallback: tolerant substring match so callers always get something.
		const all = [...jsonCandidates, ...memoryLists.flat()];
		return all.filter((t) => t.toLowerCase().includes(needle));
	}

	private collectJsonCandidates(): string[] {
		const sessions = [];
		const current = this.sessionCapture.getSnapshot(this.sessionId);
		if (current) sessions.push(current);
		sessions.push(...this.sessionCapture.loadRecentSessions(SESSION_RECALL_WINDOW));

		const out: string[] = [];
		const seen = new Set<string>();
		for (const session of sessions) {
			for (const d of session.decisions ?? []) {
				const text = `[decision] ${d.decision} — ${d.reason}`;
				if (!seen.has(text)) {
					seen.add(text);
					out.push(text);
				}
			}
			for (const a of session.codeAreas ?? []) {
				const text = `[code_area] ${a.filePath} — ${a.description}`;
				if (!seen.has(text)) {
					seen.add(text);
					out.push(text);
				}
			}
		}
		for (const d of this.sessionCapture.loadConsolidatedDecisions()) {
			const text = `[decision] ${d.decision} — ${d.reason}`;
			if (!seen.has(text)) {
				seen.add(text);
				out.push(text);
			}
		}
		return out;
	}

	private async rankJsonCandidates(topic: string, candidates: string[]): Promise<string[]> {
		if (candidates.length === 0) return [];
		const topicForEmbed = stripStopWords(topic) || topic;
		let topicVec: number[];
		try {
			topicVec = await (await this.getEmbedder()).embedQuery(topicForEmbed);
		} catch {
			return candidates;
		}
		const scored: { sim: number; text: string }[] = [];
		const embedder = await this.getEmbedder();
		for (const text of candidates) {
			try {
				const vec = await embedder.embedQuery(contentKey(text));
				const sim = cosine(topicVec, vec);
				if (sim >= SESSION_RECALL_MIN_SIM) scored.push({ sim, text });
			} catch {
				continue;
			}
		}
		scored.sort((a, b) => b.sim - a.sim);
		return scored.map((s) => s.text);
	}

	private async collectMemoryDbCandidates(topic: string): Promise<string[][]> {
		const memory = this.getMemory();
		if (!memory) return [];
		const embedder = await this.getEmbedder();
		const ftsQuery = ftMatchQuery(topic);
		const likeNeedle = `%${topic.trim()}%`;

		let ftsDecisions: string[] = [];
		let ftsTurns: string[] = [];
		let vecDecisions: string[] = [];
		let vecTurns: string[] = [];
		const codeAreaHits: string[] = [];

		try {
			if (ftsQuery) {
				const decisionIds = (
					memory.db
						.prepare(
							`SELECT d.id FROM decisions d JOIN decisions_fts f ON f.rowid = d.id
							 WHERE decisions_fts MATCH ? ORDER BY rank LIMIT ?`,
						)
						.all(ftsQuery, FTS_RECALL_LIMIT) as { id: number }[]
				).map((r) => r.id);
				ftsDecisions = this.formatDecisionsInIdOrder(decisionIds);

				const turnIds = (
					memory.db
						.prepare(
							`SELECT t.id FROM turn_summaries t JOIN turn_summaries_fts f ON f.rowid = t.id
							 WHERE turn_summaries_fts MATCH ? ORDER BY rank LIMIT ?`,
						)
						.all(ftsQuery, FTS_RECALL_LIMIT) as { id: number }[]
				).map((r) => r.id);
				ftsTurns = this.formatTurnsInIdOrder(turnIds);
			}

			const vecTopic = stripStopWords(topic) || topic;
			const vecDecisionIds = await memory.searchDecisionsVec(embedder, vecTopic, VEC_RECALL_K);
			if (vecDecisionIds.length > 0) vecDecisions = this.formatDecisionsInIdOrder(vecDecisionIds);
			const vecTurnIds = await memory.searchTurnSummariesVec(embedder, vecTopic, VEC_RECALL_K);
			if (vecTurnIds.length > 0) vecTurns = this.formatTurnsInIdOrder(vecTurnIds);

			const rows = memory.db
				.prepare(
					`SELECT file_path, description, source, session_id FROM code_areas
					 WHERE file_path LIKE ? OR description LIKE ?
					 ORDER BY created_at_epoch DESC LIMIT ?`,
				)
				.all(likeNeedle, likeNeedle, FTS_RECALL_LIMIT) as {
				file_path: string;
				description: string;
				source: string;
				session_id: string | null;
			}[];
			for (const row of rows) {
				codeAreaHits.push(
					`[code_area src=${row.source}|sid:${row.session_id ?? "-"}] ${row.file_path} — ${row.description}`,
				);
			}
		} catch {
			// partial lists are acceptable
		}
		return [ftsDecisions, ftsTurns, vecDecisions, vecTurns, codeAreaHits];
	}

	private formatDecisionsInIdOrder(ids: number[]): string[] {
		const memory = this.getMemory();
		if (!memory || ids.length === 0) return [];
		const placeholders = ids.map(() => "?").join(",");
		const rows = new Map(
			(
				memory.db
					.prepare(
						`SELECT id, decision, reason, source, session_id, created_at_epoch FROM decisions WHERE id IN (${placeholders})`,
					)
					.all(...ids) as {
					id: number;
					decision: string;
					reason: string;
					source: string;
					session_id: string | null;
					created_at_epoch: number;
				}[]
			).map((r) => [r.id, r]),
		);
		const out: string[] = [];
		for (const id of ids) {
			const r = rows.get(id);
			if (!r) continue;
			const recency = humaniseRelativeTime(r.created_at_epoch);
			let tail = recency ? ` · ${recency}` : "";
			// R13: surface linked decisions so the agent can walk the graph.
			const links = memory.getDecisionLinks(r.id);
			if (links.relatedTo.length > 0) {
				tail += ` · related: ${links.relatedTo.join(", ")}`;
			}
			if (links.relatedFrom.length > 0) {
				tail += ` · relatedFrom: ${links.relatedFrom.join(", ")}`;
			}
			for (const ann of links.annotatedBy.slice(0, 2)) {
				tail += ` · annotation #${ann.id}${ann.note ? ": " + ann.note.slice(0, 80) : ""}`;
			}
			if (r.session_id) tail += ` · → session_timeline("${r.session_id}")`;
			out.push(
				`[decision src=${r.source}|sid:${r.session_id ?? "-"}] ${expand(r.decision)} — ${expand(r.reason)}${tail}`,
			);
		}
		return out;
	}

	private formatTurnsInIdOrder(ids: number[]): string[] {
		const memory = this.getMemory();
		if (!memory || ids.length === 0) return [];
		const placeholders = ids.map(() => "?").join(",");
		const rows = new Map(
			(
				memory.db
					.prepare(
						`SELECT id, session_id, prompt_number, summary, created_at_epoch FROM turn_summaries WHERE id IN (${placeholders})`,
					)
					.all(...ids) as {
					id: number;
					session_id: string;
					prompt_number: number;
					summary: string;
					created_at_epoch: number;
				}[]
			).map((r) => [r.id, r]),
		);
		const out: string[] = [];
		for (const id of ids) {
			const r = rows.get(id);
			if (!r) continue;
			const recency = humaniseRelativeTime(r.created_at_epoch);
			let tail = recency ? ` · ${recency}` : "";
			tail += ` · → session_event(id=${r.id})`;
			out.push(`[turn sid:${r.session_id}|n:${r.prompt_number}] ${expand(r.summary)}${tail}`);
		}
		return out;
	}

	sessionTimeline(sessionId: string, limit = 20): string {
		const memory = this.getMemory();
		if (!memory) return "Memory store not available.";
		const rows = memory.db
			.prepare(
				"SELECT prompt_number, summary, tier FROM turn_summaries WHERE session_id = ? ORDER BY prompt_number ASC LIMIT ?",
			)
			.all(sessionId, Math.max(1, Math.min(limit, 200))) as {
			prompt_number: number;
			summary: string;
			tier: string;
		}[];
		if (rows.length === 0) return `No turn summaries for session ${sessionId} yet.`;

		const meta = memory.db
			.prepare(
				"SELECT project, started_at, ended_at, status, prompt_count, rollup_summary FROM sessions WHERE id = ?",
			)
			.get(sessionId) as
			| {
					project: string;
					started_at: string;
					ended_at: string | null;
					status: string;
					rollup_summary: string | null;
			  }
			| undefined;

		const header: string[] = [];
		if (meta) {
			header.push(`session: ${sessionId} · ${meta.project} · ${meta.status}`);
			header.push(`started: ${meta.started_at}  ended: ${meta.ended_at ?? "—"}`);
			if (meta.rollup_summary) header.push(`rollup: ${expand(meta.rollup_summary)}`);
		}
		const body = rows
			.map((r) => `  turn ${String(r.prompt_number).padStart(3)} [${r.tier}] ${expand(r.summary ?? "")}`)
			.join("\n");
		const text = header.length > 0 ? header.join("\n") + "\n\n" + body : body;

		// progressive_disclosure: counterfactual is a full payload dump.
		try {
			const row = memory.db
				.prepare(
					`SELECT COALESCE(SUM(p.size_bytes), 0) AS total FROM tool_events te
					 LEFT JOIN tool_event_payloads p ON p.id = te.payload_id WHERE te.session_id = ?`,
				)
				.get(sessionId) as { total: number };
			const payloadBytes = Number(row?.total ?? 0);
			if (payloadBytes > 0) {
				this.recordBucket("progressive_disclosure", Math.floor(payloadBytes / JSON_CHARS_PER_TOKEN), countTokens(text), {
					layer: "timeline",
					session_id: sessionId,
				});
			}
		} catch {
			// accounting is best-effort
		}
		return text;
	}

	sessionEvent(eventId: number): string {
		const memory = this.getMemory();
		if (!memory) return "Memory store not available.";
		const row = memory.db
			.prepare(
				`SELECT te.tool_name, te.session_id, te.prompt_number, te.created_at, te.payload_id, p.raw_input, p.raw_output
				 FROM tool_events te LEFT JOIN tool_event_payloads p ON p.id = te.payload_id WHERE te.id = ?`,
			)
			.get(eventId) as
			| {
					tool_name: string;
					session_id: string;
					prompt_number: number;
					created_at: string;
					payload_id: number | null;
					raw_input: string | null;
					raw_output: string | null;
			  }
			| undefined;
		if (!row) return `No event with id=${eventId}.`;
		if (row.payload_id === null) {
			return `Event ${eventId} (${row.tool_name}) has no captured payload — only its descriptor was recorded.`;
		}
		if (!row.raw_input && row.raw_output === null) {
			return `Event ${eventId} (${row.tool_name}) was retained as a summary only — its raw payload aged out of the retention window.`;
		}
		const truncate = (text: string | null): string => {
			if (text === null) return "<no value>";
			if (text.length <= EVENT_PAYLOAD_READ_CAP) return text;
			return text.slice(0, EVENT_PAYLOAD_READ_CAP) + `\n…[truncated, ${text.length - EVENT_PAYLOAD_READ_CAP} more chars]`;
		};
		const body =
			`event ${eventId} · ${row.tool_name} · session ${row.session_id} · turn ${row.prompt_number} · ${row.created_at}\n\n` +
			`input:\n${truncate(row.raw_input)}\n\noutput:\n${truncate(row.raw_output)}`;

		try {
			const sibling = memory.db
				.prepare(
					`SELECT COALESCE(SUM(p.size_bytes), 0) AS total FROM tool_events te
					 LEFT JOIN tool_event_payloads p ON p.id = te.payload_id WHERE te.session_id = ?`,
				)
				.get(row.session_id) as { total: number };
			const sessionBytes = Number(sibling?.total ?? 0);
			if (sessionBytes > 0) {
				this.recordBucket("progressive_disclosure", Math.floor(sessionBytes / JSON_CHARS_PER_TOKEN), countTokens(body), {
					layer: "event",
					event_id: eventId,
				});
			}
		} catch {
			// best-effort
		}
		return body;
	}

	async expandChunk(chunkId: string): Promise<string> {
		const chunk = this.backend.getChunkById(chunkId);
		if (!chunk) return "Chunk not found.";
		this.sessionCapture.touchFiles(this.sessionId, [chunk.filePath]);
		this.sessionCapture.persist(this.sessionId);
		return `[${chunk.filePath}:${chunk.startLine}-${chunk.endLine}]\n${chunk.content}`;
	}

	relatedContext(chunkId: string): string {
		// R7: with real calls edges, a chunk's outgoing calls are genuine
		// neighbours. Node ids that are not calls sources (e.g. file nodes,
		// whose DEFINES edges point at their chunks) keep working via the
		// unfiltered lookup, then file-level imports as the last resort.
		// Before R7 all of this was dead: imports edges pointed at nodes that
		// never existed.
		const render = (ns: { nodeType: string; name: string; filePath: string }[]): string =>
			ns.map((n) => `- ${n.nodeType}: ${n.name} (${n.filePath})`).join("\n");
		const callTargets = this.backend.graphNeighbors(chunkId, "calls");
		if (callTargets.length > 0) return render(callTargets);
		const any = this.backend.graphNeighbors(chunkId);
		if (any.length > 0) return render(any);
		const chunk = this.backend.getChunkById(chunkId);
		if (chunk) {
			const related = this.backend.getRelatedFilePaths([chunk.filePath]);
			if (related.length > 0) {
				return related.map((fp) => `- file: ${fp}`).join("\n");
			}
		}
		return "No related context found for this chunk.";
	}

	/** Cost note like ", $4.37 saved" for the status line. */
	async costSaved(tokensSaved: number): Promise<string> {
		if (tokensSaved <= 0) return "";
		try {
			const pricing = await getModelPricing(false);
			const model = this.config.pricingModel.toLowerCase();
			const rate = pricing[model] ?? pricing["opus"] ?? { input: 15, output: 75 };
			const cost = (tokensSaved * rate.input) / 1_000_000;
			if (cost >= 0.01) return `, $${cost.toFixed(2)} saved`;
		} catch {
			// no pricing available
		}
		return "";
	}

	/** One-line-per-fact status for the index_status tool and /context-status. */
	async statusText(): Promise<string> {
		const chunks = this.chunkCount();
		const stats = this.getStats();
		const saved = Math.max(0, stats.rawTokens - stats.servedTokens);
		const parts = [
			`Index: ${chunks.toLocaleString()} chunk(s) · ${this.storageBase}`,
			`Queries this project: ${stats.queries}`,
		];
		if (stats.queries > 0 && stats.fullFileTokens > 0) {
			const fullSaved = Math.max(0, stats.fullFileTokens - stats.servedTokens);
			const pct = stats.fullFileTokens > 0 ? Math.floor((fullSaved / stats.fullFileTokens) * 100) : 0;
			parts.push(
				`Token savings: ${stats.fullFileTokens.toLocaleString()} full-file baseline → ${stats.servedTokens.toLocaleString()} served (${pct}% saved${await this.costSaved(fullSaved)})`,
			);
		} else if (stats.queries > 0) {
			const pct = stats.rawTokens > 0 ? Math.floor((saved / stats.rawTokens) * 100) : 0;
			parts.push(
				`Token savings: ${stats.rawTokens.toLocaleString()} raw → ${stats.servedTokens.toLocaleString()} served (${saved.toLocaleString()} saved, ${pct}%${await this.costSaved(saved)})`,
			);
		} else {
			parts.push("Token savings: waiting for the first context_search call.");
		}
		return parts.join("\n");
	}

	// ── Bootstrap for session start ───────────────────────────────────────

	async bootstrapText(): Promise<string> {
		const lines: string[] = [`# Project context: ${this.projectName}`, ""];
		const decisions = this.sessionCapture.getRecentDecisions(8);
		if (decisions.length > 0) {
			lines.push("## Prior decisions");
			for (const d of decisions) lines.push(`- ${d.replace(/^\[decision\]\s*/, "")}`);
			lines.push("");
		}
		const recent = this.sessionCapture.loadRecentSessions(1)[0];
		if (recent) {
			const touched = Object.entries(recent.touchedFiles ?? {})
				.sort((a, b) => b[1] - a[1])
				.slice(0, 5);
			if (touched.length > 0) {
				lines.push("## Recently touched files (prior session)");
				for (const [fp, n] of touched) lines.push(`- ${fp} (${n})`);
				lines.push("");
			}
		}
		const chunks = this.chunkCount();
		lines.push("## Index");
		lines.push(
			chunks > 0
				? `${chunks.toLocaleString()} chunks indexed and searchable via context_search.`
				: "Index is empty — run /context-index (or call reindex) to build it.",
		);
		return lines.join("\n");
	}

	/** SHA of the indexed state, for cheap change detection in the footer. */
	projectKey(): string {
		return sha256Hex(this.projectDir).slice(0, 8);
	}
}

export function formatResults(inline: Chunk[], overflow: Chunk[]): string {
	const parts: string[] = [];
	for (const chunk of inline) {
		const served = chunk.compressedContent || chunk.content;
		parts.push(
			`[${chunk.filePath}:${chunk.startLine}] (confidence: ${chunk.confidenceScore.toFixed(2)})\n${served}`,
		);
	}
	if (overflow.length > 0) {
		const lines = [`\n---\n${overflow.length} more result(s) available (not shown to save tokens):`];
		for (const chunk of overflow) {
			lines.push(
				`  expand_chunk(chunk_id="${chunk.id}")  → ${chunk.filePath}:${chunk.startLine} (confidence: ${chunk.confidenceScore.toFixed(2)})`,
			);
		}
		parts.push(lines.join("\n"));
	}
	return parts.length > 0 ? parts.join("\n\n---\n\n") : "No results found.";
}
