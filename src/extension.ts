/**
 * pi-context-engine — semantic code context for pi.
 *
 * A native port of code-context-engine (MIT, elara-labs): tree-sitter
 * indexing, hybrid vector + BM25 retrieval, chunk compression and
 * cross-session memory, exposed as pi tools and lifecycle hooks instead of
 * an MCP server.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import fs from "node:fs";
import path from "node:path";
import { ContextEngine, isPceConfig } from "./engine.js";
import { applyContextSearchGuidance } from "./guidance.js";

/** Tools whose payloads are worth capturing for session timelines. */
const CAPTURED_TOOLS = new Set(["bash", "read", "edit", "write", "grep", "find", "ls"]);

export default function contextEngineExtension(pi: ExtensionAPI) {
	let engine: ContextEngine | null = null;
	let currentCwd = process.cwd();
	let promptNumber = 0;
	let lazyIndexStarted = false;
	let bootstrapSent = false;

	const getEngine = (cwd?: string): ContextEngine => {
		const dir = cwd ?? currentCwd;
		if (engine && engine.projectDir === fs.realpathSync(path.resolve(dir))) return engine;
		if (engine) {
			// Best-effort: a cross-project switch must not leak sqlite handles.
			void engine.shutdown().catch(() => undefined);
		}
		// Always track the live engine so `session_shutdown` closes it even when
		// a tool ran before `session_start` (tests, mid-reload edge cases).
		engine = new ContextEngine({ projectDir: dir });
		return engine;
	};

	const text = (body: string, details?: unknown) => ({
		content: [{ type: "text" as const, text: body }],
		details: details ?? {},
	});

	/* ── Tools ───────────────────────────────────────────────────────────── */

	pi.registerTool({
		name: "context_search",
		label: "Context Search",
		description:
			"PREFERRED tool for ANY question about this project's code, structure, or behavior. " +
			"Use INSTEAD OF read, grep, or find when exploring the codebase, locating functions, " +
			"or answering 'how does X work / where is Y' questions. Returns the most relevant code " +
			"chunks with confidence scores from a hybrid vector + BM25 index, so you don't pay " +
			"tokens for files you don't need. Reserve read for opening a known path you intend to edit.",
		promptSnippet: "Search the indexed codebase semantically (use instead of grep/read for exploration)",
		promptGuidelines: [
			"Use context_search before grep/read whenever you are exploring unfamiliar code or answering 'where/how' questions.",
			"Call expand_chunk only when the compressed snippet is insufficient; it returns the full source.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Natural language or identifier query" }),
			top_k: Type.Optional(Type.Integer({ description: "Max results (1-100, default 10)", minimum: 1, maximum: 100 })),
			max_tokens: Type.Optional(Type.Integer({ description: "Inline token budget (500-50000, default 8000)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const eng = getEngine(ctx.cwd);
			const query = (params.query ?? "").trim();
			if (!query) return text("Query cannot be empty.");
			if (query.length > 10_000) return text("Query too long (max 10000 characters).");

			// Lazy index on first search: kick off in the background and tell the
			// caller to retry instead of blocking for a multi-minute first index.
			if (eng.chunkCount() === 0 && !lazyIndexStarted) {
				lazyIndexStarted = true;
				void eng.reindex({}).catch(() => undefined);
				return text(
					`Index for ${eng.projectName} is empty — indexing started in the background. ` +
						"Retry this search in a few seconds, or run /context-index for a synchronous index.",
				);
			}

			const result = await eng.search(query, { topK: params.top_k, maxTokens: params.max_tokens });
			let body = result.body;
			const nudge = eng.buildNudge();
			if (nudge) body += nudge;
			if (result.droppedLowValue > 0) {
				body +=
					"\n[note: lower-confidence results omitted — lower retrieval.marginal_ratio or retrieval.confidence_threshold to include them]";
			}
			return text(body, { inline: result.inline.length, overflow: result.overflow.length });
		},
	});

	pi.registerTool({
		name: "expand_chunk",
		label: "Expand Chunk",
		description: "Get the full original source for a compressed search result.",
		parameters: Type.Object({
			chunk_id: Type.String({ description: "Chunk id from a context_search result" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const chunkId = (params.chunk_id ?? "").trim();
			if (!chunkId) return text("chunk_id is required.");
			return text(await getEngine(ctx.cwd).expandChunk(chunkId));
		},
	});

	pi.registerTool({
		name: "related_context",
		label: "Related Context",
		description: "Find code related to a chunk via graph edges (imports, defines, modifies).",
		parameters: Type.Object({
			chunk_id: Type.String({ description: "Chunk id from a context_search result" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const chunkId = (params.chunk_id ?? "").trim();
			if (!chunkId) return text("chunk_id is required.");
			return text(getEngine(ctx.cwd).relatedContext(chunkId));
		},
	});

	pi.registerTool({
		name: "session_recall",
		label: "Session Recall",
		description:
			"Recall past decisions, code-area notes, and turn summaries by topic. " +
			"Returns compact hits across project history (FTS + semantic + JSON archive).",
		parameters: Type.Object({
			topic: Type.String({ description: "Topic to recall, e.g. 'auth strategy'" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return text(await getEngine(ctx.cwd).sessionRecall(params.topic ?? ""));
		},
	});

	pi.registerTool({
		name: "session_timeline",
		label: "Session Timeline",
		description:
			"List turn summaries for a session, oldest first. Layer 2 of progressive disclosure — " +
			"drill into a session id returned by session_recall.",
		parameters: Type.Object({
			session_id: Type.String({ description: "Session id (from a session_recall hit)" }),
			limit: Type.Optional(Type.Integer({ description: "Max turns (default 20)", minimum: 1, maximum: 200 })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const sessionId = (params.session_id ?? "").trim();
			if (!sessionId) return text("session_id is required.");
			return text(getEngine(ctx.cwd).sessionTimeline(sessionId, params.limit ?? 20));
		},
	});

	pi.registerTool({
		name: "session_event",
		label: "Session Event",
		description:
			"Return the raw captured input/output for one tool event. Layer 3 of progressive " +
			"disclosure — drill into an event id from session_timeline.",
		parameters: Type.Object({
			event_id: Type.Integer({ description: "Event id (from a session_timeline turn)" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const eventId = Number(params.event_id);
			if (!Number.isFinite(eventId)) return text("event_id must be an integer.");
			return text(getEngine(ctx.cwd).sessionEvent(eventId));
		},
	});

	pi.registerTool({
		name: "record_decision",
		label: "Record Decision",
		description:
			"Record a decision (with its reason) so future sessions can recall it. " +
			"Use when you choose a library, resolve an ambiguity, or establish a convention.",
		promptGuidelines: [
			"Call record_decision when you make a choice that a future session would otherwise have to re-derive.",
		],
		parameters: Type.Object({
			decision: Type.String({ description: "What was decided" }),
			reason: Type.String({ description: "Why — the constraint or tradeoff" }),
			related_to: Type.Optional(
				Type.Array(Type.Integer(), {
					description: "Ids of earlier decisions this one annotates (memory evolution; original texts stay immutable)",
				}),
			),
			tags: Type.Optional(Type.Array(Type.String(), { description: "Short labels for later filtering" })),
			files: Type.Optional(Type.Array(Type.String(), { description: "Affected file paths (relative)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const decision = (params.decision ?? "").trim();
			const reason = (params.reason ?? "").trim();
			if (!decision) return text("decision is required.");
			const stored = await getEngine(ctx.cwd).recordDecision(decision, reason, {
				relatedTo: params.related_to,
				tags: params.tags,
				files: params.files,
			});
			return text(`✓ Decision recorded: ${stored}`);
		},
	});

	pi.registerTool({
		name: "record_code_area",
		label: "Record Code Area",
		description: "Record a file you worked in, with a short description, for future session_recall.",
		parameters: Type.Object({
			file_path: Type.String({ description: "Path relative to the project root" }),
			description: Type.String({ description: "What this area does / what you changed" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const filePath = (params.file_path ?? "").trim();
			if (!filePath) return text("file_path is required.");
			await getEngine(ctx.cwd).recordCodeArea(filePath, (params.description ?? "").trim());
			return text(`✓ Code area noted: ${filePath} — ${params.description ?? ""}`);
		},
	});

	pi.registerTool({
		name: "index_status",
		label: "Index Status",
		description: "Check index health, chunk count, and token savings for this project.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			return text(await getEngine(ctx.cwd).statusText());
		},
	});

	pi.registerTool({
		name: "reindex",
		label: "Reindex",
		description: "Re-index the project (incremental by default) or a single path.",
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: "Restrict to one file or subtree" })),
			full: Type.Optional(Type.Boolean({ description: "Ignore the manifest and re-index everything" })),
		}),
		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const eng = getEngine(ctx.cwd);
			onUpdate?.({
				content: [{ type: "text" as const, text: "Indexing…" }],
				details: {},
			});
			const result = await eng.reindex({
				full: params.full,
				targetPath: params.path ?? null,
				onProgress: (msg) => onUpdate?.({ content: [{ type: "text" as const, text: msg }], details: {} }),
			});
			const lines = [
				"✓ Re-index complete",
				`  Indexed: ${result.indexed} file(s), ${result.chunks} chunk(s)`,
			];
			if (result.deleted > 0) lines.push(`  Pruned stale: ${result.deleted}`);
			if (result.skipped > 0) lines.push(`  Skipped: ${result.skipped}`);
			if (result.errors.length > 0) {
				lines.push(`  Errors: ${result.errors.length}`);
				for (const err of result.errors.slice(0, 5)) lines.push(`    - ${err}`);
			}
			return text(lines.join("\n"));
		},
	});

	/* ── Commands ────────────────────────────────────────────────────────── */

	pi.registerCommand("context-index", {
		description: "Build or refresh the semantic code index: /context-index [--full]",
		handler: async (args, ctx) => {
			const eng = getEngine(ctx.cwd);
			const full = args.includes("--full");
			ctx.ui.notify(full ? "Re-indexing everything…" : "Indexing (incremental)…", "info");
			const result = await eng.reindex({ full });
			ctx.ui.notify(
				`Indexed ${result.indexed} file(s), ${result.chunks} chunk(s)` +
					(result.errors.length > 0 ? ` · ${result.errors.length} error(s)` : ""),
				result.errors.length > 0 ? "warning" : "info",
			);
		},
	});

	pi.registerCommand("context-status", {
		description: "Show index health and token savings for this project",
		handler: async (_args, ctx) => {
			ctx.ui.notify(await getEngine(ctx.cwd).statusText(), "info");
		},
	});

	pi.registerCommand("context-savings", {
		description: "Show the per-bucket token savings ledger",
		handler: async (_args, ctx) => {
			const eng = getEngine(ctx.cwd);
			const buckets = eng.aggregateSavings();
			if (!buckets) {
				ctx.ui.notify("No memory database yet — run a search first.", "warning");
				return;
			}
			const rows = Object.entries(buckets)
				.filter(([, v]) => v.calls > 0)
				.map(([bucket, v]) => `${bucket.padEnd(22)} ${String(v.calls).padStart(5)} calls  ${(v.baseline - v.served).toLocaleString()} tokens saved`);
			const stats = eng.getStats();
			const saved = Math.max(0, stats.rawTokens - stats.servedTokens);
			const header = `${eng.projectName} · ${stats.queries} queries · ${saved.toLocaleString()} tokens saved`;
			ctx.ui.notify([header, "", ...(rows.length > 0 ? rows : ["(no bucket events yet)"])].join("\n"), "info");
		},
	});

	/* ── Lifecycle hooks (replace upstream's curl-based hooks) ───────────── */

	pi.on("session_start", async (_event, ctx) => {
		currentCwd = ctx.cwd;
		engine = new ContextEngine({ projectDir: ctx.cwd });
		engine.startBackgroundWork();
		lazyIndexStarted = false;
		bootstrapSent = false;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (event.messageType !== "user") return;
		const eng = getEngine(ctx.cwd);
		promptNumber = eng.recordPrompt(event.prompt ?? "");
		eng.enqueueTurnCompression(promptNumber);

		// Query-formulation guidance for context_search: gated on the tool being
		// active and on `guidance.enabled` (config), so prompt-lean setups pay
		// nothing. Section, not a forced prompt override: pi diffs it like any
		// other section and the transcript stays stable.
		applyContextSearchGuidance(event.systemPromptOptions, eng.config.guidanceEnabled);

		// First prompt of the session: inject a compact "where you left off"
		// block as a non-displayed custom message (upstream's SessionStart hook).
		if (!bootstrapSent) {
			bootstrapSent = true;
			try {
				const bootstrap = await eng.bootstrapText();
				return {
					message: {
						customType: "context-engine-bootstrap",
						content: bootstrap,
						display: false,
					},
				};
			} catch {
				return;
			}
		}
		return;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!CAPTURED_TOOLS.has(event.toolName)) return;
		if (isPceConfig(String(event.input?.["file_path"] ?? event.input?.["path"] ?? ""))) return;
		const eng = getEngine(ctx.cwd);
		const output = event.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		eng.recordToolEvent(event.toolName, JSON.stringify(event.input ?? {}), output.slice(0, 1500), promptNumber);
	});

	pi.on("session_shutdown", async () => {
		await engine?.shutdown().catch(() => undefined);
		engine = null;
	});
}
