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
import { projectStorageDir, sha256Hex } from "../utils.js";
import { Chunker, isAstLanguage, warmupLanguages } from "./chunker.js";
import { Embedder, selectBackend } from "./embedder.js";
import { EmbeddingCache } from "./embedding-cache.js";
import { Manifest } from "./manifest.js";
import { loadIgnorePatterns, matchesAny } from "./ignorefile.js";
import { isSecretFile, redactSecrets } from "./secrets.js";
import { LocalBackend } from "../storage/local-backend.js";
import type { Chunk, ChunkType, GraphEdge, GraphNode, NodeType } from "../types.js";
import { resolveOllamaUrl } from "../config.js";

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

export class PathOutsideProjectError extends Error {}

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

function safeRead(filePath: string): string | null {
	try {
		if (fs.statSync(filePath).size > MAX_FILE_BYTES) return null;
		return fs.readFileSync(filePath, "utf-8");
	} catch {
		return null;
	}
}

function* iterProjectFiles(
	root: string,
	ignoreSet: Set<string>,
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
			if (ignoreSet.has(entry.name)) continue;
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
			const rel = path.relative(root, full).replace(/\\/g, "/");
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
	yield* walk(root);
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

/** Per-storage-dir indexing lock so watcher + manual reindex can't interleave. */
const pipelineLocks = new Map<string, Promise<unknown>>();

export async function runIndexing(
	config: Config,
	projectDirInput: string,
	options: {
		full?: boolean;
		targetPath?: string | null;
		callbacks?: IndexCallbacks;
		/** Reuse an already-constructed backend/embedder (the long-lived server path). */
		runtime?: { backend: LocalBackend; embedder: Embedder };
	} = {},
): Promise<IndexResult> {
	const projectDir = fs.realpathSync(path.resolve(projectDirInput));
	const storageBase = projectStorageDir(config.storagePath, projectDir);
	fs.mkdirSync(storageBase, { recursive: true });

	const previous = pipelineLocks.get(storageBase) ?? Promise.resolve();
	const current = previous.then(() =>
		runIndexingLocked(config, projectDir, storageBase, options, options.runtime),
	);
	pipelineLocks.set(
		storageBase,
		current.catch(() => undefined),
	);
	return current;
}

async function runIndexingLocked(
	config: Config,
	projectDir: string,
	storageBase: string,
	options: { full?: boolean; targetPath?: string | null; callbacks?: IndexCallbacks },
	runtime?: { backend: LocalBackend; embedder: Embedder },
): Promise<IndexResult> {
	const { full = false, targetPath = null, callbacks = {} } = options;
	const { log, progress, phase } = callbacks;

	const ownsBackend = runtime === undefined;
	const backend = runtime?.backend ?? new LocalBackend(storageBase);
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

	if (backend.metricRebuilt) {
		manifest.clearEntries();
		log?.("  [migration] vector index rebuilt (cosine metric) — reindexing all files");
	}

	const ignoreSet = new Set(config.indexerIgnore);
	const cceignorePatterns = loadIgnorePatterns(projectDir);
	if (cceignorePatterns.length > 0) log?.(`  [.cceignore] ${cceignorePatterns.length} pattern(s) loaded`);

	// ── Determine the file set ─────────────────────────────────────────────
	let fileList: string[];
	if (targetPath) {
		const target = resolveWithin(projectDir, targetPath);
		if (fs.existsSync(target) && fs.statSync(target).isFile()) {
			const rel = path.relative(projectDir, target).replace(/\\/g, "/");
			if (SKIP_EXTENSIONS.has(path.extname(target).toLowerCase())) {
				fileList = [];
			} else if (ignoreSet.has(path.basename(target))) {
				result.skippedFiles.push(rel);
				fileList = [];
			} else if (config.indexerRedactSecrets && isSecretFile(target)) {
				result.skippedFiles.push(rel);
				fileList = [];
			} else if (cceignorePatterns.length > 0 && cceignoreMatchesFile(rel, cceignorePatterns)) {
				result.skippedFiles.push(rel);
				fileList = [];
			} else {
				fileList = [target];
			}
		} else if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
			fileList = [
				...iterProjectFiles(target, ignoreSet, {
					redactSecrets: config.indexerRedactSecrets,
					cceignorePatterns,
				}),
			];
		} else {
			// Watcher deletion path: prune instead of erroring out.
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
		fileList = [
			...iterProjectFiles(projectDir, ignoreSet, {
				redactSecrets: config.indexerRedactSecrets,
				cceignorePatterns,
			}),
		];
	}

	// Warm up every AST grammar we're about to need (async, once).
	const languages = new Set<string>();
	for (const file of fileList) {
		const lang = LANGUAGE_MAP[path.extname(file).toLowerCase()];
		if (lang && isAstLanguage(lang)) languages.add(lang);
	}
	if (languages.size > 0) await warmupLanguages(languages);

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

	// Dimension migration: a backend swap invalidates every stored vector.
	if (fileList.length > 0 && manifest.embeddingDim !== null && manifest.hasEntries) {
		const { embedder: emb } = await ensureEmbedder();
		if (manifest.embeddingDim !== emb.dimension) {
			log?.(
				`  [migration] embedding dim changed (${manifest.embeddingDim} → ${emb.dimension}, backend=${emb.backendName}) — forcing full reindex`,
			);
			manifest.clearEntries();
		}
	}

	const currentRelPaths = new Set<string>();
	const totalBatches = Math.max(1, Math.ceil(fileList.length / BATCH));
	let announced = false;
	let totalCacheHits = 0;
	let totalCacheMisses = 0;

	for (let batchIndex = 0; batchIndex < fileList.length; batchIndex += BATCH) {
		const batchPaths = fileList.slice(batchIndex, batchIndex + BATCH);
		const toChunk: { filePath: string; relPath: string; content: string; contentHash: string; language: string }[] = [];

		for (const filePath of batchPaths) {
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
			let chunks: Chunk[] = [];
			let importedModules: string[] = [];
			try {
				if (isAstLanguage(item.language)) {
					const out = chunker.chunkWithImports(item.content, item.relPath, item.language);
					chunks = out.chunks;
					importedModules = out.imports;
				}
				if (chunks.length === 0) {
					// Fallback: module-level chunk (upstream _fallback_chunk).
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
			for (const module of importedModules) {
				batchEdges.push({
					sourceId: fileNodeId,
					targetId: `module_${module}`,
					edgeType: "imports",
					properties: {},
				});
			}
			for (const chunk of chunks) {
				const nodeName = chunk.content.includes("(")
					? chunk.content.split("(")[0]!.split(":").pop()!.trim()
					: chunk.id;
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
			}
			batchChunks.push(...chunks);
			batchManifestUpdates.push([item.relPath, item.contentHash]);
			batchIndexed.push(item.relPath);
		}

		progress?.(Math.min(batchIndex + batchPaths.length, fileList.length), fileList.length);

		if (batchChunks.length > 0) {
			const { embedder: emb, cache: cch } = await ensureEmbedder();
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
		result.skippedFiles.push(...toChunk.filter((t) => !batchIndexed.includes(t.relPath)).map((t) => t.relPath));
	}

	// ── Git history on full runs ──────────────────────────────────────────
	if (full && !targetPath && fs.existsSync(path.join(projectDir, ".git"))) {
		try {
			const git = await indexCommits(projectDir, manifest.lastGitSha);
			if (git.chunks.length > 0) {
				const { embedder: emb, cache: cch } = await ensureEmbedder();
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
		const previousPaths = new Set(Object.keys(manifest.fileEntries));
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
		holders.cache.close();
	} else {
		result.cacheHits = totalCacheHits;
		result.cacheMisses = totalCacheMisses;
	}

	if (holders.embedder) manifest.embeddingDim = holders.embedder.dimension;
	manifest.save();
	if (ownsBackend) backend.close();
	return result;
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
