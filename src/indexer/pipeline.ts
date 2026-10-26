/**
 * Indexing pipeline — port of upstream `indexer/pipeline.py` (MIT).
 * Streaming: embed + ingest per file-batch instead of accumulating the whole
 * project, so peak memory is one batch rather than one repo.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Config } from "../config.js";
import { projectStorageDir, sha256Hex, yieldToEventLoop } from "../utils.js";
import { Chunker, isAstLanguage, warmupLanguages } from "./chunker.js";
import { chunkProse, extractDocLinkTargets, isProseLanguage } from "./prose-chunker.js";
import { applyContextHeaderToChunk, stripContextHeader } from "./context-header.js";
import { Embedder, selectBackend } from "./embedder.js";
import { EmbeddingCache } from "./embedding-cache.js";
import { Manifest, CURRENT_SCHEMA_VERSION } from "./manifest.js";
import { loadIgnorePatterns, matchesAny } from "./ignorefile.js";
import { isSecretFile, redactSecrets } from "./secrets.js";
import { LocalBackend } from "../storage/local-backend.js";
import type { Chunk, ChunkType, GraphEdge, GraphNode, NodeType } from "../types.js";
import { resolveOllamaUrl, ROOT_ONLY_IGNORE } from "../config.js";

const execFileAsync = promisify(execFile);

const CHUNK_TO_NODE_TYPE: Record<ChunkType, NodeType> = {
	function: "function",
	class: "class",
	module: "module",
	doc: "doc",
	comment: "doc",
	commit: "commit",
	session: "session",
	decision: "decision",
};

const SKIP_EXTENSIONS = new Set([
	// Images
	".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".tiff", ".svg",
	// Compiled / bytecode
	".pyc", ".pyo", ".class", ".o", ".so", ".dylib", ".dll", ".exe", ".wasm",
	// Archives
	".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar", ".jar", ".war",
	// Data / binary
	".db", ".sqlite", ".sqlite3", ".bin", ".dat", ".pkl", ".pickle", ".parquet", ".arrow", ".lance",
	// Media
	".mp3", ".mp4", ".wav", ".avi", ".mov", ".flv", ".ogg", ".webm",
	// Fonts
	".ttf", ".otf", ".woff", ".woff2", ".eot",
	// Documents (non-text)
	".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
	// Package locks (huge, not useful for context)
	".lock",
	// Source maps
	".map",
]);

const LANGUAGE_MAP: Record<string, string> = {
	".py": "python",
	".js": "javascript",
	".ts": "typescript",
	".jsx": "javascript",
	".tsx": "tsx",
	".mjs": "javascript",
	".cjs": "javascript",
	".md": "markdown",
	".markdown": "markdown",
	".mdx": "markdown",
	".php": "php",
	".html": "html",
	".htm": "html",
	".css": "css",
	".scss": "css",
	".less": "css",
	".json": "json",
	".yaml": "yaml",
	".yml": "yaml",
	".toml": "toml",
	".sh": "bash",
	".bash": "bash",
	".zsh": "bash",
	".rb": "ruby",
	".go": "go",
	".rs": "rust",
	".java": "java",
	".c": "c",
	".cpp": "cpp",
	".h": "c",
	".hpp": "cpp",
	".swift": "swift",
	".kt": "kotlin",
	".kts": "kotlin",
	".sql": "sql",
	".graphql": "graphql",
	".gql": "graphql",
	".proto": "protobuf",
	".xml": "xml",
	".lua": "lua",
	".ex": "elixir",
	".exs": "elixir",
	".erl": "erlang",
	".hs": "haskell",
	".scala": "scala",
	".dart": "dart",
	".vue": "vue",
	".svelte": "svelte",
	".pl": "perl",
	".cs": "csharp",
	".fs": "fsharp",
	".zig": "zig",
	".tf": "terraform",
	".hcl": "hcl",
};

/** Skip any single file larger than this — protects from OOM on log dumps. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const BATCH = 50;
const MANIFEST_CHECKPOINT_MS = 5000;
const WALK_YIELD_FILES = 250;
const WALK_YIELD_MS = 50;

export class PathOutsideProjectError extends Error {}

/** Automatic full-project runs refuse workspaces above their configured file budget. */
export class AutomaticIndexFileLimitError extends Error {
	constructor(
		readonly limit: number,
		/** Exact manifest size, or limit + 1 when the capped walk stopped early. */
		readonly observedFiles: number,
	) {
		super(`Automatic indexing exceeds the ${limit}-file limit (found at least ${observedFiles})`);
		this.name = "AutomaticIndexFileLimitError";
	}
}

export interface IndexResult {
	indexedFiles: string[];
	skippedFiles: string[];
	deletedFiles: string[];
	totalChunks: number;
	errors: string[];
	cacheHits: number;
	cacheMisses: number;
}

export interface IndexCallbacks {
	log?: (msg: string) => void;
	progress?: (current: number, total: number) => void;
	phase?: (msg: string) => void;
}

function resolveWithin(projectDir: string, target: string): string {
	const resolved = path.resolve(projectDir, target);
	const rel = path.relative(path.resolve(projectDir), resolved);
	if (rel.startsWith("..") || path.isAbsolute(rel)) {
		throw new PathOutsideProjectError(`target path escapes project directory: ${target}`);
	}
	return resolved;
}

/** A directory target is excluded when it or any ancestor matches a dir rule (upstream #165b). */
function cceignoreMatchesDir(relPosix: string, patterns: string[]): boolean {
	const parts = relPosix.split("/");
	for (let i = 1; i <= parts.length; i++) {
		if (matchesAny(parts.slice(0, i).join("/"), true, patterns)) return true;
	}
	return false;
}

/**
 * Target-path policy gate, mirroring what the full walker enforces while
 * descending: every path segment must pass `indexer.ignore`, files must pass
 * the secret-filename check, and `.cceignore` is matched against the
 * project-relative path (dir rules for directories, file + ancestor rules for
 * files). The project root (`rel === ""`) is exempt — rules apply to entries
 * below the root, not to the root itself (a checkout named `build` must still
 * reindex via `path: "."`).
 */
function targetExcluded(
	relPosix: string,
	opts: { isDir: boolean; ignoreSet: Set<string>; rootIgnoreSet: Set<string>; redactSecrets: boolean; patterns: string[] },
): boolean {
	if (relPosix === "") return false;
	const segments = relPosix.split("/");
	for (const seg of segments) {
		if (opts.ignoreSet.has(seg)) return true;
	}
	// Only the first segment is project-root level; root-only names must not
	// reject nested paths like `src/storage/x.ts`.
	if (opts.rootIgnoreSet.has(segments[0]!)) return true;
	// The walker only classifies secret names on file entries; a secret-named
	// directory's contents are still gated per file.
	if (!opts.isDir && opts.redactSecrets && isSecretFile(segments[segments.length - 1]!)) return true;
	if (opts.patterns.length === 0) return false;
	return opts.isDir ? cceignoreMatchesDir(relPosix, opts.patterns) : cceignoreMatchesFile(relPosix, opts.patterns);
}

function safeRead(filePath: string): string | null {
	try {
		if (fs.statSync(filePath).size > MAX_FILE_BYTES) return null;
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

function* iterProjectFiles(
	walkRoot: string,
	/** Project root: `.cceignore` patterns are matched against project-relative paths even when walking from a target. */
	relRoot: string,
	ignoreSet: Set<string>,
	rootIgnoreSet: Set<string>,
	opts: { redactSecrets: boolean; cceignorePatterns: string[] },
): Generator<string> {
	const seen = new Set<string>();
	// Sorted for deterministic output — port of upstream's sorted(directory.iterdir()).
	const walk = function* (directory: string): Generator<string> {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(directory, { withFileTypes: true });
		} catch {
			return;
		}
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			// Root-only names (`storage`, `logs`, ...) only match at the project
			// root — nested `src/storage/` is real source and must be indexed.
			const atProjectRoot = directory === relRoot;
			if (ignoreSet.has(entry.name) || (atProjectRoot && rootIgnoreSet.has(entry.name))) continue;
			const full = path.join(directory, entry.name);
			if (entry.isSymbolicLink()) continue;
			let resolved: string;
			try {
				resolved = fs.realpathSync(full);
			} catch {
				continue;
			}
			if (seen.has(resolved)) continue;
			seen.add(resolved);
			const rel = path.relative(relRoot, full).replace(/\\/g, "/");
			if (opts.cceignorePatterns.length > 0 && matchesAny(rel, entry.isDirectory(), opts.cceignorePatterns)) {
				continue;
			}
			if (entry.isDirectory()) {
				yield* walk(full);
			} else if (entry.isFile()) {
				if (SKIP_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
				if (opts.redactSecrets && isSecretFile(full)) continue;
				yield full;
			}
		}
	};
	yield* walk(walkRoot);
}

/**
 * Collect a directory walk without starving pi's input/render loop. The file
 * count covers cheap SSD walks; the time bound also covers slow filesystems.
 */
async function collectProjectFiles(files: Iterable<string>, maxAutoFiles?: number): Promise<string[]> {
	const collected: string[] = [];
	let lastYield = Date.now();
	for (const filePath of files) {
		if (maxAutoFiles !== undefined && collected.length >= maxAutoFiles) {
			throw new AutomaticIndexFileLimitError(maxAutoFiles, collected.length + 1);
		}
		collected.push(filePath);
		if (collected.length % WALK_YIELD_FILES === 0 || Date.now() - lastYield >= WALK_YIELD_MS) {
			await yieldToEventLoop();
			lastYield = Date.now();
		}
	}
	return collected;
}

/** `{embeddings, cacheHits, cacheMisses}` for a batch, using the content cache. */
async function embedChunks(
	chunks: Chunk[],
	embedder: Embedder,
	cache: EmbeddingCache,
): Promise<{ hits: number; misses: number }> {
	if (chunks.length === 0) return { hits: 0, misses: 0 };
	const hashes = chunks.map((c) => cache.contentHash(c.content));
	const cached = cache.getBatch(hashes);
	const missIndices: number[] = [];
	for (let i = 0; i < chunks.length; i++) {
		const hit = cached.get(hashes[i]!);
		if (hit) chunks[i]!.embedding = hit;
		else missIndices.push(i);
	}
	if (missIndices.length > 0) {
		const missChunks = missIndices.map((i) => chunks[i]!);
		const vectors = await embedder.embedTexts(missChunks.map((c) => c.content));
		missChunks.forEach((chunk, i) => {
			chunk.embedding = vectors[i] ?? null;
		});
		const entries: { hash: string; embedding: number[] }[] = [];
		missIndices.forEach((idx, i) => {
			const vec = chunks[idx]!.embedding;
			if (vec && vec.length > 0) entries.push({ hash: hashes[idx]!, embedding: vec });
		});
		if (entries.length > 0) cache.putBatch(entries);
	}
	return { hits: chunks.length - missIndices.length, misses: missIndices.length };
}

/** Parse recent git history into searchable chunks (upstream git_indexer.py). */
export async function indexCommits(
	projectDir: string,
	sinceSha: string | null,
	maxCommits = 200,
): Promise<{ chunks: Chunk[]; nodes: GraphNode[]; edges: GraphEdge[]; headSha: string | null }> {
	const rangeArg = sinceSha ? `${sinceSha}..HEAD` : `-${maxCommits}`;
	let metaOut: string;
	let filesOut: string;
	try {
		const meta = await execFileAsync(
			"git",
			["-c", "i18n.logOutputEncoding=UTF-8", "log", rangeArg, "--format=%H%n%an%n%ai%n%s%n%b%x00"],
			{ cwd: projectDir, maxBuffer: 32 * 1024 * 1024, encoding: "utf-8" },
		);
		metaOut = meta.stdout;
		const files = await execFileAsync(
			"git",
			["-c", "i18n.logOutputEncoding=UTF-8", "log", rangeArg, "--name-only", "--format=%H"],
			{ cwd: projectDir, maxBuffer: 32 * 1024 * 1024, encoding: "utf-8" },
		);
		filesOut = files.stdout;
	} catch {
		return { chunks: [], nodes: [], edges: [], headSha: null };
	}

	const changedFilesByHash = new Map<string, string[]>();
	let currentHash: string | null = null;
	for (const line of filesOut.split(/\r?\n/)) {
		const stripped = line.trim();
		if (!stripped) continue;
		if (/^[0-9a-f]{40}$/.test(stripped)) {
			currentHash = stripped;
			if (!changedFilesByHash.has(currentHash)) changedFilesByHash.set(currentHash, []);
		} else if (currentHash) {
			changedFilesByHash.get(currentHash)!.push(stripped);
		}
	}

	const chunks: Chunk[] = [];
	const nodes: GraphNode[] = [];
	const edges: GraphEdge[] = [];
	for (const record of metaOut.split("\x00")) {
		const trimmed = record.trim();
		if (!trimmed) continue;
		const lines = trimmed.split(/\r?\n/);
		if (lines.length < 4) continue;
		const commitHash = lines[0]!.trim();
		if (!/^[0-9a-f]{40}$/.test(commitHash)) continue;
		const author = lines[1]!.trim();
		const date = lines[2]!.trim();
		const subject = lines[3]!.trim();
		const body = lines.slice(4).join("\n").trim();
		const content = `${subject}\n\n${body}`.trim();
		const shortHash = commitHash.slice(0, 7);

		const metadata: Record<string, unknown> = { author, date, hash: commitHash, chunk_kind: "commit" };
		const parsedDate = Date.parse(date.replace(" ", "T"));
		if (!Number.isNaN(parsedDate)) metadata["modified_ts"] = parsedDate / 1000;

		chunks.push({
			id: `commit_${shortHash}`,
			content,
			chunkType: "commit",
			filePath: `git:${shortHash}`,
			startLine: 0,
			endLine: 0,
			language: "git",
			metadata,
			embedding: null,
			confidenceScore: 0,
			compressedContent: null,
		});
		nodes.push({
			id: `commit_${shortHash}`,
			nodeType: "commit",
			name: subject,
			filePath: `git:${shortHash}`,
			properties: {},
		});
		for (const fname of changedFilesByHash.get(commitHash) ?? []) {
			edges.push({
				sourceId: `commit_${shortHash}`,
				targetId: `file_${fname}`,
				edgeType: "modifies",
				properties: {},
			});
		}
	}

	let headSha: string | null = null;
	try {
		const head = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: projectDir, encoding: "utf-8" });
		headSha = head.stdout.trim() || null;
	} catch {
		headSha = null;
	}
	return { chunks, nodes, edges, headSha };
}

/**
 * Per-storage-dir indexing lock so concurrent reindex runs (auto-index kick,
 * lazy search kick, file watcher, manual /context-index) can't interleave.
 */
const pipelineLocks = new Map<string, Promise<unknown>>();

/**
 * Queue work behind every indexing run already registered for this storage
 * dir, and keep later runs queued until the work finishes. Reset uses this
 * instead of a one-shot idle wait: a reindex queued during that wait must not
 * open the stores while deletion is in progress.
 */
export async function withPipelineLock<T>(storageBase: string, work: () => T | Promise<T>): Promise<T> {
	const previous = pipelineLocks.get(storageBase) ?? Promise.resolve();
	const current = previous.then(() => work());
	pipelineLocks.set(
		storageBase,
		current.catch(() => undefined),
	);
	return current;
}

export async function runIndexing(
	config: Config,
	projectDirInput: string,
	options: {
		full?: boolean;
		targetPath?: string | null;
		/** Automatic full-project runs only. Stop before migrations when the workspace exceeds this budget. */
		maxAutoFiles?: number;
		callbacks?: IndexCallbacks;
		/** Reuse an already-constructed backend/embedder (the long-lived server path);
		 * a null backend falls through to a fresh LocalBackend (used by resetIndex). */
		runtime?: { backend?: LocalBackend | null; embedder: Embedder };
	} = {},
): Promise<IndexResult> {
	const projectDir = fs.realpathSync(path.resolve(projectDirInput));
	const storageBase = projectStorageDir(config.storagePath, projectDir);
	fs.mkdirSync(storageBase, { recursive: true });

	return withPipelineLock(storageBase, () =>
		runIndexingLocked(config, projectDir, storageBase, options, options.runtime),
	);
}

async function runIndexingLocked(
	config: Config,
	projectDir: string,
	storageBase: string,
	options: { full?: boolean; targetPath?: string | null; maxAutoFiles?: number; callbacks?: IndexCallbacks },
	runtime?: { backend?: LocalBackend | null; embedder: Embedder },
): Promise<IndexResult> {
	let { full = false, targetPath = null } = options;
	const { callbacks = {} } = options;
	const { log, progress, phase } = callbacks;

	// The caller only owns the backend it actually passed in; a null backend
	// (resetIndex dropped its closed handle) means the pipeline built its own
	// and must close it — otherwise its sqlite handles leak until exit.
	const ownsBackend = !runtime?.backend;
	const chunker = new Chunker();
	const manifest = new Manifest(path.join(storageBase, "manifest.json"));
	const result: IndexResult = {
		indexedFiles: [],
		skippedFiles: [],
		deletedFiles: [],
		totalChunks: 0,
		errors: [],
		cacheHits: 0,
		cacheMisses: 0,
	};

	const ignoreSet = new Set(config.indexerIgnore);
	const rootIgnoreSet = new Set(ROOT_ONLY_IGNORE);
	const cceignorePatterns = loadIgnorePatterns(projectDir);
	if (cceignorePatterns.length > 0) log?.(`  [.cceignore] ${cceignorePatterns.length} pattern(s) loaded`);

	// PR #7 review fix: migrations below call manifest.clearEntries(), which
	// also erases the file list pruneFilesNotIn() needs to detect files that
	// vanished BEFORE this run. Snapshot the paths first so the prune step
	// can still delete their indexed chunks instead of orphaning them.
	const preMigrationPaths = Object.keys(manifest.fileEntries);
	// Checkpoints (below) persist the in-memory manifest mid-run. A run that
	// wiped or invalidated existing entries must NOT do that: the on-disk
	// manifest is what a resumed run derives its migration context from
	// (pre-migration paths, old schema version, git pointer). Checkpointing
	// after clearEntries() would persist the emptied state, so an interrupted
	// migration would resume as a plain incremental run and orphan FTS/graph
	// rows of vanished files or skip the git-history rebuild (Augment review,
	// PR #21). Migration runs save once at the end, exactly as before
	// checkpoints existed — losing resume progress there is fine; correctness
	// is not.
	let migrationRun = false;

	// The automatic file budget rides on the walk we already need. No second
	// directory scan or per-file stat pass is required. Reuse the completed
	// walk below, and stop at limit + 1 before any store migration can wipe an
	// existing index. A large manifest is an even cheaper early refusal.
	let precheckedFileList: string[] | null = null;
	if (options.maxAutoFiles !== undefined && targetPath === null) {
		if (preMigrationPaths.length > options.maxAutoFiles) {
			throw new AutomaticIndexFileLimitError(options.maxAutoFiles, preMigrationPaths.length);
		}
		precheckedFileList = await collectProjectFiles(
			iterProjectFiles(projectDir, projectDir, ignoreSet, rootIgnoreSet, {
				redactSecrets: config.indexerRedactSecrets,
				cceignorePatterns,
			}),
			options.maxAutoFiles,
		);
	}

	// Open stores only after the automatic guard has passed, so a refusal
	// cannot leak SQLite handles on the session's long-lived process.
	const backend = runtime?.backend ?? new LocalBackend(storageBase);

	// Refuse unrecognized index formats outright (no compat reading): a
	// manifest we can't recognize — pre-versioning, corrupt, or a future
	// format — wipes every store and rebuilds from source below. The same gate
	// covers format changes (e.g. v3 added R1 context headers) that alter chunk
	// content WITHOUT changing the file on disk, which the content hash alone
	// would never catch.
	if (manifest.needsStoreReset) {
		log?.(
			`  [rebuild] index format v${manifest.schemaVersion} → v${CURRENT_SCHEMA_VERSION} — wiping stores, reindexing all files`,
		);
		backend.clear();
		manifest.clearEntries();
		// The wipe dropped the git-history chunks too; without resetting the
		// pointer the next full run would only fetch NEW commits and the old
		// ones would never come back.
		manifest.lastGitSha = null;
		// A wipe must rebuild everything in THIS run — a targeted run would
		// leave the index empty except for the one target file.
		if (targetPath !== null) {
			log?.("  [rebuild] escalating targeted run to full reindex after store reset");
			targetPath = null;
		}
		full = true;
		migrationRun = true;
	}

	// ── Determine the file set ─────────────────────────────────────────────
	/**
	 * A file the inclusion policy now rejects must not leave stale chunks
	 * behind (upstream #127): purge its manifest entry and indexed rows so a
	 * targeted reindex is enough to enforce a new secret/ignore rule.
	 */
	const purgeIndexed = (rels: string[]): void => {
		const indexed = rels.filter((rel) => manifest.getHash(rel) !== undefined);
		if (indexed.length === 0) return;
		backend.deleteByFiles(indexed);
		for (const rel of indexed) {
			manifest.remove(rel);
			result.deletedFiles.push(rel);
			log?.(`  [delete] ${rel} (excluded by policy)`);
		}
		manifest.save();
	};
	let fileList: string[];
	if (targetPath) {
		const target = resolveWithin(projectDir, targetPath);
		if (fs.existsSync(target) && fs.statSync(target).isFile()) {
			const rel = path.relative(projectDir, target).replace(/\\/g, "/");
			if (SKIP_EXTENSIONS.has(path.extname(target).toLowerCase())) {
				purgeIndexed([rel]);
				fileList = [];
			} else if (
				targetExcluded(rel, {
					isDir: false,
					ignoreSet,
					rootIgnoreSet,
					redactSecrets: config.indexerRedactSecrets,
					patterns: cceignorePatterns,
				})
			) {
				// Ancestor segments included: the full walker would have pruned
				// the path before reaching this file (upstream #165b parity).
				result.skippedFiles.push(rel);
				purgeIndexed([rel]);
				fileList = [];
			} else {
				fileList = [target];
			}
		} else if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
			// Upstream #165b: the walk starts inside the target, so the target
			// path itself must first pass the same policy the full walker
			// enforces while descending — every segment vs `indexer.ignore`
			// (e.g. `dist/nested` is rejected because `dist` is), plus
			// `.cceignore` dir rules for the target and its ancestors.
			const rel = path.relative(projectDir, target).replace(/\\/g, "/");
			const excluded = targetExcluded(rel, {
				isDir: true,
				ignoreSet,
				rootIgnoreSet,
				redactSecrets: config.indexerRedactSecrets,
				patterns: cceignorePatterns,
			});
			if (excluded) {
				result.skippedFiles.push(rel);
				fileList = [];
			} else {
				fileList = await collectProjectFiles(
					iterProjectFiles(target, projectDir, ignoreSet, rootIgnoreSet, {
						redactSecrets: config.indexerRedactSecrets,
						cceignorePatterns,
					}),
				);
			}
			// Targeted runs skip the full-run prune below, so purge manifest
			// entries under this subtree the walk no longer yields: newly
			// excluded files, secret files, and deleted files (upstream
			// #127/#165b). Scoped to the target so siblings are untouched.
			const yielded = new Set(fileList.map((f) => path.relative(projectDir, f).replace(/\\/g, "/")));
			const underScope = (p: string): boolean => (rel === "" ? true : p === rel || p.startsWith(`${rel}/`));
			purgeIndexed(Object.keys(manifest.fileEntries).filter((p) => underScope(p) && !yielded.has(p)));
		} else {
			// Target vanished between runs (deleted file, or a branch switch removed it):
// prune instead of erroring out.
			const rel = path.relative(projectDir, target).replace(/\\/g, "/");
			if (manifest.getHash(rel) !== undefined) {
				backend.deleteByFiles([rel]);
				manifest.remove(rel);
				manifest.save();
				result.deletedFiles.push(rel);
				return result;
			}
			result.errors.push(`Target path not found: ${targetPath}`);
			return result;
		}
	} else {
		fileList = precheckedFileList ?? (await collectProjectFiles(
			iterProjectFiles(projectDir, projectDir, ignoreSet, rootIgnoreSet, {
				redactSecrets: config.indexerRedactSecrets,
				cceignorePatterns,
			}),
		));
	}

	// Warm up every AST grammar we're about to need (async, once).
	const languages = new Set<string>();
	for (const file of fileList) {
		const lang = LANGUAGE_MAP[path.extname(file).toLowerCase()];
		if (lang && isAstLanguage(lang)) languages.add(lang);
	}
	if (languages.size > 0) await warmupLanguages(languages);

	// R7: every rel path this run touches (changed or not) plus everything
	// already indexed forms the resolution universe for import specifiers.
	const knownFiles = new Set<string>(Object.keys(manifest.fileEntries));
	for (const f of fileList) knownFiles.add(path.relative(projectDir, f).replace(/\\/g, "/"));
	// R7: cross-file call-graph state, filled during the batch loop, emitted
	// as chunk-to-chunk `calls` edges after ALL batches (so early files can
	// call symbols defined in late ones — order-independent).
	const runChunks: { id: string; filePath: string; identifiers: string[] }[] = [];
	const symbolOwners = new Map<string, { id: string; filePath: string }[]>();
	// PR #7 review: files whose chunks were (re)built this run, across ALL batches.
	const changedRelPaths = new Set<string>();

	// ── Lazy embedder + cache ─────────────────────────────────────────────
	const holders: { embedder: Embedder | null; cache: EmbeddingCache | null } = {
		embedder: runtime?.embedder ?? null,
		cache: null,
	};
	const ensureEmbedder = async (): Promise<{ embedder: Embedder; cache: EmbeddingCache }> => {
		if (!holders.embedder) {
			const backendImpl = await selectBackend({
				model: config.embeddingModel,
				ollamaModel: config.ollamaEmbedModel,
				ollamaUrl: resolveOllamaUrl(config),
			});
			holders.embedder = new Embedder(backendImpl);
		}
		if (!holders.cache) {
			holders.cache = new EmbeddingCache(path.join(storageBase, "embedding_cache.db"), {
				modelSalt: holders.embedder.cacheSalt,
			});
		}
		return { embedder: holders.embedder, cache: holders.cache };
	};

	// Everything after this point can reject (embed failures, backend
	// crashes, IO). The finally at the end of the function releases the
	// cache/backend handles on every path: an open handle wedges re-runs
	// and tests (on Windows an open handle makes the storage directory
	// undeletable, which is how this was caught).
	try {

		// Dimension migration: a backend swap invalidates every stored vector.
		if (fileList.length > 0 && manifest.embeddingDim !== null && manifest.hasEntries) {
			const { embedder: emb } = await ensureEmbedder();
			if (manifest.embeddingDim !== emb.dimension) {
				log?.(
					`  [migration] embedding dim changed (${manifest.embeddingDim} → ${emb.dimension}, backend=${emb.backendName}) — forcing full reindex`,
				);
				manifest.clearEntries();
				// The dim swap dropped stored vectors (git history included); reset
				// the pointer so the next full run re-fetches those commits too.
				manifest.lastGitSha = null;
				migrationRun = true;
			}
		}

		const currentRelPaths = new Set<string>();
		const totalBatches = Math.max(1, Math.ceil(fileList.length / BATCH));
		let announced = false;
		let totalCacheHits = 0;
		let totalCacheMisses = 0;
		// The first successful batch checkpoints immediately; later writes are
		// rate-limited. An interrupted run can therefore skip completed batches
		// without paying a manifest write for every file. Migration runs are
		// exempt (see migrationRun above): their manifest stays untouched on
		// disk until the run completes.
		let lastManifestCheckpoint = 0;
		const checkpointManifest = () => {
			if (migrationRun) return;
			const now = Date.now();
			if (now - lastManifestCheckpoint < MANIFEST_CHECKPOINT_MS) return;
			manifest.save();
			lastManifestCheckpoint = now;
		};

		for (let batchIndex = 0; batchIndex < fileList.length; batchIndex += BATCH) {
			// Cooperative yield: the loops below do sync I/O, tree-sitter parsing
			// and ONNX inference on the main thread. Without a breather per unit
			// of work the pi UI starves for the whole run (bench-event-loop.mts:
			// ~0.5-0.9 s event-loop stalls per batch before this).
			await yieldToEventLoop();
			const batchPaths = fileList.slice(batchIndex, batchIndex + BATCH);
			const toChunk: { filePath: string; relPath: string; content: string; contentHash: string; language: string }[] = [];

			for (const filePath of batchPaths) {
				await yieldToEventLoop();
				const relPath = path.relative(projectDir, filePath).replace(/\\/g, "/");
				currentRelPaths.add(relPath);
				let content = safeRead(filePath);
				if (content === null) {
					result.skippedFiles.push(relPath);
					log?.(`  [skip] ${relPath} (binary or unreadable)`);
					continue;
				}
				if (config.indexerRedactSecrets) {
					const redacted = redactSecrets(content);
					if (redacted.labels.length > 0) {
						content = redacted.text;
						log?.(`  [redact] ${relPath} (${redacted.labels.length} secret(s))`);
					}
				}
				const contentHash = sha256Hex(content);
				if (!full && !manifest.hasChanged(relPath, contentHash)) {
					log?.(`  [skip] ${relPath} (unchanged)`);
					continue;
				}
				toChunk.push({
					filePath,
					relPath,
					content,
					contentHash,
					language: LANGUAGE_MAP[path.extname(filePath).toLowerCase()] ?? "plaintext",
				});
			}

			const batchChunks: Chunk[] = [];
			const batchNodes: GraphNode[] = [];
			const batchEdges: GraphEdge[] = [];
			const batchFilesToReplace: string[] = [];
			const batchManifestUpdates: [string, string][] = [];
			const batchIndexed: string[] = [];

			for (const item of toChunk) {
				await yieldToEventLoop();
				changedRelPaths.add(item.relPath);
				let chunks: Chunk[] = [];
				let importedModules: string[] = [];
				let importSpecs: string[] = [];
				try {
					if (isAstLanguage(item.language)) {
						const out = chunker.chunkWithImports(item.content, item.relPath, item.language, {
								chunking: config.indexerChunking,
								budgetChars: config.indexerChunkBudgetChars,
							});
						chunks = out.chunks;
						importedModules = out.imports;
						importSpecs = out.importSpecs;
					}
					if (chunks.length === 0 && isProseLanguage(item.language)) {
						// Prose P0: heading/paragraph sections instead of one whole-file
						// chunk (docs/RESEARCH-COMPETITORS.md §4). Yields [] for empty
						// files, which fall through to the legacy whole-file fallback.
						chunks = chunkProse(item.content, item.relPath, item.language, config.indexerChunkBudgetChars);
					}
					if (chunks.length === 0) {
						// Fallback: module-level chunk (upstream _fallback_chunk).
						// Structured non-AST files (JSON, YAML, ...) still land here.
						chunks = [
							{
								id: sha256Hex(`${item.relPath}:module`).slice(0, 16),
								content: item.content,
								chunkType: "module",
								filePath: item.relPath,
								startLine: 1,
								endLine: Math.max(1, item.content.trim().split("\n").length),
								language: item.language,
								metadata: {},
								embedding: null,
								confidenceScore: 0,
								compressedContent: null,
							},
						];
					}
				} catch (err) {
					result.errors.push(`Chunking failed for ${item.relPath}: ${(err as Error).message}`);
					continue;
				}

				// Stamp mtime so the recency weight has real signal.
				let mtime: number | null = null;
				try {
					mtime = fs.statSync(item.filePath).mtimeMs / 1000;
				} catch {
					mtime = null;
				}
				if (mtime !== null) for (const c of chunks) c.metadata["modified_ts"] = mtime;

				batchFilesToReplace.push(item.relPath);
				const fileNodeId = `file_${item.relPath}`;
				batchNodes.push({
					id: fileNodeId,
					nodeType: "file",
					name: path.basename(item.filePath),
					filePath: item.relPath,
					properties: {},
				});
				for (const spec of importSpecs) {
					// R7: resolve relative specifiers to a real indexed file. Before this,
					// edges pointed at `module_<spec>` nodes that were never created, so
					// every imports-edge JOIN silently produced nothing and
					// related_context / getRelatedFilePaths were dead code. Bare package
					// imports ("react", "node:fs") stay out: they resolve to nothing in
					// the index and would only add noise.
					const resolved = resolveImportPath(spec, item.relPath, knownFiles);
					if (resolved) {
						batchEdges.push({
							sourceId: fileNodeId,
							targetId: `file_${resolved}`,
							edgeType: "imports",
							properties: {},
						});
					}
				}
				for (const chunk of chunks) {
					const nodeName =
						(typeof chunk.metadata["unit"] === "string" && chunk.metadata["unit"]) ||
						(chunk.content.includes("(") ? chunk.content.split("(")[0]!.split(":").pop()!.trim() : chunk.id);
					batchNodes.push({
						id: chunk.id,
						nodeType: CHUNK_TO_NODE_TYPE[chunk.chunkType] ?? "module",
						name: nodeName,
						filePath: item.relPath,
						properties: {},
					});
					batchEdges.push({
						sourceId: fileNodeId,
						targetId: chunk.id,
						edgeType: "defines",
						properties: {},
					});
					// R7 calls-graph collection (raw content, before the context header
					// prepends file paths and `defines:` lists that would pollute the
					// identifier set).
					const unit = typeof chunk.metadata["unit"] === "string" ? chunk.metadata["unit"] : "";
					if (chunk.chunkType === "function" || chunk.chunkType === "class") {
						const short = unit.includes(".") ? unit.slice(unit.lastIndexOf(".") + 1) : unit;
						if (short.length >= 3 && !CALL_GRAPH_STOPLIST.has(short)) {
							let owners = symbolOwners.get(short);
							if (!owners) symbolOwners.set(short, (owners = []));
							owners.push({ id: chunk.id, filePath: item.relPath });
						}
					}
					// Prose sections carry prose words, not call-graph identifiers:
					// only chunks of parsed code feed the calls derivation, or shared
					// vocabulary between two documents would become `calls` edges.
					if (chunk.chunkType !== "module" && isAstLanguage(item.language)) {
						runChunks.push({
							id: chunk.id,
							filePath: item.relPath,
							identifiers: extractIdentifiers(chunk.content),
						});
					}
				}
				// R1 context headers go on LAST: graph node names above derive from raw
				// content, and every downstream consumer (embed, FTS, compression,
				// expand_chunk) reads `chunk.content`, so one prepend covers them all.
				if (config.indexerContextHeaders) {
					for (const chunk of chunks) applyContextHeaderToChunk(chunk, importedModules);
				}
				batchChunks.push(...chunks);
				batchManifestUpdates.push([item.relPath, item.contentHash]);
				batchIndexed.push(item.relPath);
			}

			progress?.(Math.min(batchIndex + batchPaths.length, fileList.length), fileList.length);

			if (batchChunks.length > 0) {
				const { embedder: emb, cache: cch } = await ensureEmbedder();
				manifest.embeddingDim = emb.dimension;
				if (phase && !announced) {
					phase(`Embedding ${batchChunks.length.toLocaleString()} chunks${totalBatches > 1 ? ` (batch ${Math.floor(batchIndex / BATCH) + 1}/${totalBatches})` : ""}…`);
					announced = true;
				}
				const stats = await embedChunks(batchChunks, emb, cch);
				totalCacheHits += stats.hits;
				totalCacheMisses += stats.misses;
				// Per-batch deletes happen AFTER embed succeeds, so an embed failure
				// can never wipe previously-indexed rows.
				backend.deleteByFiles(batchFilesToReplace);
				backend.ingest(batchChunks, batchNodes, batchEdges);
				for (const [rel, hash] of batchManifestUpdates) manifest.update(rel, hash);
				result.indexedFiles.push(...batchIndexed);
				result.totalChunks += batchChunks.length;
			} else if (batchFilesToReplace.length > 0) {
				backend.deleteByFiles(batchFilesToReplace);
				for (const [rel, hash] of batchManifestUpdates) manifest.update(rel, hash);
				result.indexedFiles.push(...batchIndexed);
			}
			if (batchManifestUpdates.length > 0) checkpointManifest();
			result.skippedFiles.push(...toChunk.filter((t) => !batchIndexed.includes(t.relPath)).map((t) => t.relPath));
		}

		// ── R7: emit chunk→chunk calls edges ──────────────────────────────────
		// Runs AFTER all batches so the symbol table is complete regardless of
		// batch order. Cross-file only: intra-file structure is already covered
		// by file/defines edges. Capped per chunk — a retrieval prior, not a
		// faithful call graph.
		{
			// PR #7 review fix (incremental call graph): derive over ALL indexed
			// files, not just this run's changes. deleteByFiles(changed) removes
			// call edges touching changed chunk nodes in BOTH directions, so a
			// run-only derivation silently dropped (a) changed files' calls into
			// unchanged files and (b) unchanged callers' edges into changed files.
			// Re-deriving from every indexed file recreates exactly the deleted
			// edges; unchanged→unchanged duplicates collapse on the edge PK
			// (INSERT OR REPLACE).
			const callsEdges: GraphEdge[] = [];
			const derivationSources = [...runChunks];
			const changedThisRun = changedRelPaths;
			for (const rel of Object.keys(manifest.fileEntries)) {
				if (changedThisRun.has(rel)) continue;
				for (const stored of backend.chunksByFile(rel, 500)) {
					if (stored.chunkType === "module") continue;
					// Same gate as the run-only path above: prose sections are no
					// more call-graph material when read back from storage.
					if (!isAstLanguage(stored.language)) continue;
					derivationSources.push({
						id: stored.id,
						filePath: rel,
						// Stored content carries the R1 context header; strip it so
						// header tokens cannot pollute the identifier set.
						identifiers: extractIdentifiers(stripContextHeader(stored.content)),
					});
				}
			}
			// Symbol owners over all files: run chunks first (fresh), then graph
			// nodes of files that did not change (they are still valid).
			for (const node of backend.listSymbolNodes()) {
				if (changedThisRun.has(node.filePath)) continue;
				const short = node.name.includes(".") ? node.name.slice(node.name.lastIndexOf(".") + 1) : node.name;
				if (short.length < 3 || CALL_GRAPH_STOPLIST.has(short)) continue;
				let owners = symbolOwners.get(short);
				if (!owners) symbolOwners.set(short, (owners = []));
				owners.push({ id: node.id, filePath: node.filePath });
			}
			for (const src of derivationSources) {
				let out = 0;
				for (const ident of src.identifiers) {
					if (out >= CALLS_EDGES_PER_CHUNK) break;
					for (const owner of symbolOwners.get(ident) ?? []) {
						if (owner.filePath === src.filePath) continue;
						callsEdges.push({ sourceId: src.id, targetId: owner.id, edgeType: "calls", properties: {} });
						out += 1;
						if (out >= CALLS_EDGES_PER_CHUNK) break;
					}
				}
			}
			if (callsEdges.length > 0) {
					backend.ingest([], [], callsEdges);
					log?.(`  [graph] ${callsEdges.length} cross-file call edge(s)`);
				}
		}

		// ── WP3: markdown reference edges ────────────────────────────────────
		// Runs AFTER all batches and over ALL indexed prose files, for the same
		// order-independence reasons as the calls derivation above:
		// - line attribution comes from a fence/frontmatter-aware scan of the
		//   RAW file, so a fenced block that packSegment split into line windows
		//   cannot leak example links (a continuation chunk starts with no fence
		//   state) nor hide real links after a stray closing fence;
		// - links resolve against the CURRENT file set, so a target created after
		//   the source was indexed self-heals on the next run instead of waiting
		//   for a source edit or full rebuild (incremental review fix);
		// - prose only: code files keep their calls/imports graph, and a doc-link
		//   string inside code must not become an edge.
		{
			const refEdges: GraphEdge[] = [];
			for (const rel of Object.keys(manifest.fileEntries)) {
				const stored = backend.chunksByFile(rel, 500);
				if (stored.length === 0 || !isProseLanguage(stored[0]!.language)) continue;
				let raw: string;
				try {
					raw = fs.readFileSync(path.join(projectDir, rel), "utf-8");
				} catch {
					continue; // unreadable now: keep the edges it already contributed
				}
				for (const link of extractDocLinkTargets(raw)) {
					const resolved = resolveDocLink(link.target, rel, knownFiles);
					if (resolved === null || resolved === rel) continue;
					// Sections cover every line contiguously; the fallback catches
					// trailing-line drift from the legacy endLine = trim() count.
					const owner =
						stored.find((c) => link.line >= c.startLine && link.line <= c.endLine) ??
						stored[stored.length - 1]!;
					refEdges.push({
						sourceId: owner.id,
						targetId: `file_${resolved}`,
						edgeType: "references",
						properties: {},
					});
				}
			}
			if (refEdges.length > 0) {
				backend.ingest([], [], refEdges);
				log?.(`  [graph] ${refEdges.length} doc reference edge(s)`);
			}
		}

		// ── Git history on full runs ──────────────────────────────────────────
		if (full && !targetPath && fs.existsSync(path.join(projectDir, ".git"))) {
			try {
				const git = await indexCommits(projectDir, manifest.lastGitSha);
				if (git.chunks.length > 0) {
					const { embedder: emb, cache: cch } = await ensureEmbedder();
					manifest.embeddingDim = emb.dimension;
					phase?.(`Embedding ${git.chunks.length} git commits…`);
					const stats = await embedChunks(git.chunks, emb, cch);
					totalCacheHits += stats.hits;
					totalCacheMisses += stats.misses;
					backend.ingest(git.chunks, git.nodes, git.edges);
					result.totalChunks += git.chunks.length;
					if (git.headSha) manifest.lastGitSha = git.headSha;
					log?.(`  [git] ${git.chunks.length} commit(s) indexed`);
				}
			} catch (err) {
				result.errors.push(`git history indexing failed: ${(err as Error).message}`);
			}
		}

		// ── Prune files that vanished from disk ───────────────────────────────
		if (!targetPath) {
			const previousPaths = new Set([...Object.keys(manifest.fileEntries), ...preMigrationPaths]);
			const removed = [...previousPaths].filter((rel) => !currentRelPaths.has(rel));
			if (removed.length > 0) {
				backend.deleteByFiles(removed);
				for (const rel of removed) {
					manifest.remove(rel);
					result.deletedFiles.push(rel);
					log?.(`  [delete] ${rel} (no longer on disk)`);
				}
			}
		}

		if (holders.cache) {
			result.cacheHits = holders.cache.hitCount;
			result.cacheMisses = holders.cache.missCount;
		} else {
			result.cacheHits = totalCacheHits;
			result.cacheMisses = totalCacheMisses;
		}

		if (holders.embedder) manifest.embeddingDim = holders.embedder.dimension;
		manifest.save();
		return result;
	} finally {
		// Release handles on EVERY path: a mid-run rejection (embed failure,
		// backend crash) must not leak them. Success-path bookkeeping above
		// reads the live counters before this closes the cache.
		if (holders.cache) holders.cache.close();
		if (ownsBackend) backend.close();
	}
}

/** Directory patterns need re-checking against every ancestor for single files. */
function cceignoreMatchesFile(relPosix: string, patterns: string[]): boolean {
	if (matchesAny(relPosix, false, patterns)) return true;
	const parts = relPosix.split("/");
	for (let i = 1; i < parts.length; i++) {
		if (matchesAny(parts.slice(0, i).join("/"), true, patterns)) return true;
	}
	return false;
}

// ── R7 helpers: import resolution + call-graph vocabulary ─────────────────

/** Cap per chunk for calls edges: a prior, not a faithful call graph. */
const CALLS_EDGES_PER_CHUNK = 8;
/** Max unique identifiers kept per chunk (first occurrences win). */
const IDENTIFIERS_PER_CHUNK = 60;

/** Words that name a chunk never worth a calls edge. */
const CALL_GRAPH_STOPLIST = new Set([
	"const", "let", "var", "function", "class", "return", "string", "number", "boolean", "object",
	"void", "null", "undefined", "true", "false", "this", "import", "export", "default", "type",
	"interface", "extends", "implements", "constructor", "static", "readonly", "public", "private",
	"protected", "async", "await", "Promise", "Object", "Array", "String", "Number", "Boolean",
	"Math", "JSON", "Error", "console", "process", "require", "module", "exports", "Map", "Set",
	"Date", "Symbol", "Buffer", "path", "fs", "os", "unknown", "never", "text", "params", "options",
	"value", "values", "result", "results", "data", "content", "item", "items", "name", "file", "files",
	"line", "lines", "index", "length", "score", "query", "chunk", "chunks",
]);

/** Unique identifier-ish words in a chunk, capped (first occurrences win). */
function extractIdentifiers(content: string): string[] {
	const seen = new Set<string>();
	const re = /[A-Za-z_$][A-Za-z0-9_$]*/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(content)) !== null && seen.size < IDENTIFIERS_PER_CHUNK) {
		const w = m[0];
		if (w.length >= 3 && !CALL_GRAPH_STOPLIST.has(w)) seen.add(w);
	}
	return [...seen];
}

/**
 * Resolve a relative import specifier against the set of indexed files.
 * Handles extensionless specs ("./chunker"), .js to .ts rewrites (TypeScript
 * emits .js specifiers), and directory index files. Returns null for bare
 * package imports and unresolvable specs.
 */
function resolveImportPath(spec: string, importerRel: string, knownFiles: Set<string>): string | null {
	if (!spec.startsWith(".") && !spec.startsWith("/")) return null;
	const dir = importerRel.includes("/") ? importerRel.slice(0, importerRel.lastIndexOf("/")) : "";
	const joined = spec.startsWith("/") ? spec.slice(1) : `${dir}/${spec}`;
	const stack = joined.split("/");
	const outStack: string[] = [];
	for (const part of stack) {
		if (part === "" || part === ".") continue;
		if (part === "..") outStack.pop();
		else outStack.push(part);
	}
	const base = outStack.join("/");
	if (base === "") return null;
	const candidates = [base];
	const lower = base.toLowerCase();
	if (lower.endsWith(".js")) {
		candidates.push(base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx");
	} else if (lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
		candidates.push(base.slice(0, -4) + ".ts");
	} else if (!/\.[a-z]+$/i.test(base)) {
		candidates.push(base + ".ts", base + ".tsx", base + ".mts", base + ".js");
	}
	for (const c of candidates) {
		if (knownFiles.has(c)) return c;
	}
	for (const ext of ["/index.ts", "/index.tsx", "/index.js"]) {
		if (knownFiles.has(base + ext)) return base + ext;
	}
	return null;
}

/**
 * WP3 doc-graph edges: resolve a raw Markdown link destination to an indexed
 * project file (docs/RESEARCH-COMPETITORS.md §4 P2). Strips `#fragment` and
 * `?query`, decodes %-escapes, treats a leading `/` as project-root relative
 * and everything else as relative to the linking file. Returns null for URL
 * schemes (`http:`, `mailto:`, … also `C:`), pure anchors (`#top`), paths
 * that never resolve to an indexed file, and self-links.
 */
function resolveDocLink(target: string, sourceRel: string, knownFiles: Set<string>): string | null {
	let dest = target;
	if (dest.startsWith("<") && dest.endsWith(">")) dest = dest.slice(1, -1);
	dest = dest.split("#")[0]!;
	dest = dest.split("?")[0]!;
	if (dest === "") return null; // pure anchor: same-file, nothing to link
	try {
		dest = decodeURIComponent(dest);
	} catch {
		// malformed escape: keep the raw target
	}
	if (/^[a-z][a-z0-9+.-]*:/i.test(dest)) return null; // scheme
	const dir = sourceRel.includes("/") ? sourceRel.slice(0, sourceRel.lastIndexOf("/")) : "";
	const joined = dest.startsWith("/") ? dest.slice(1) : `${dir}/${dest}`;
	// Same stack walk as resolveImportPath: `..` pops (a pop off an empty
	// stack is a silent no-op there too), so behavior stays consistent.
	const outStack: string[] = [];
	for (const part of joined.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") outStack.pop();
		else outStack.push(part);
	}
	const rel = outStack.join("/");
	if (rel === "") return null;
	return knownFiles.has(rel) ? rel : null;
}
