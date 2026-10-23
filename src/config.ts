/**
 * Configuration loading — port of upstream `context_engine/config.py` (MIT).
 * Global config lives in `~/.pi-context-engine/config.yaml`; per-project
 * overrides in `.context-engine.yaml` (same filename upstream uses, so the
 * two tools can coexist in one repo).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

export const PCE_HOME = path.join(os.homedir(), ".pi-context-engine");
export const DEFAULT_GLOBAL_PATH = path.join(PCE_HOME, "config.yaml");
export const PROJECT_CONFIG_NAME = ".context-engine.yaml";

export const DEFAULT_IGNORE: string[] = [
	// Version control
	".git", ".svn", ".hg",
	// Dependencies (JS, PHP, Python, Ruby, Go, Rust, Java, .NET)
	"node_modules", "vendor", "bower_components",
	".pnpm-store", ".pnpm", ".yarn",
	".venv", "venv", ".env",
	".tox", ".nox", ".mypy_cache", ".pytest_cache",
	".ruff_cache", ".cache",
	"Pods",
	// Build output
	"dist", "build", "_build", "out", "target",
	"bin", "obj",
	".next", ".nuxt", ".output", ".vercel",
	".turbo", ".parcel-cache",
	// IDE / editor
	".idea", ".vscode", ".vs",
	// Coverage / test artifacts
	"coverage", ".coverage", "htmlcov", ".nyc_output",
	// OS files
	".DS_Store",
	// Compiled / generated
	"__pycache__", ".sass-cache", ".gradle",
	// Infra
	".terraform", ".vagrant",
	// Package locks (huge, not useful)
	"package-lock.json", "yarn.lock", "pnpm-lock.yaml",
	"composer.lock", "poetry.lock",
];

/**
 * Directory names that are ambiguous: equally plausible as junk at the project
 * root (`./storage`, `./logs`, `./tmp`) as they are as real source trees
 * nested below it (`src/storage/`, `app/logs/`). Matching them at any depth
 * silently hid whole source trees from the index — including this package's
 * own `src/storage/*.ts`. They are therefore ignored ONLY at the project root;
 * nested dirs with these names are indexed.
 */
export const ROOT_ONLY_IGNORE: string[] = ["storage", "logs", "tmp", "temp", "env"];

export interface Config {
	compressionLevel: "minimal" | "standard" | "full";
	compressionModel: string;
	/** R3: keep query-matching lines when truncating instead of the head. */
	compressionQueryAware: boolean;
	ollamaUrl: string;
	embeddingModel: string;
	ollamaEmbedModel: string;
	/**
	 * Inject the query-formulation guidance section into the system prompt
	 * while `context_search` is active. Default true: retrieval quality depends
	 * on how queries are written. Set false for the leanest possible prompt.
	 */
	guidanceEnabled: boolean;
	retrievalConfidenceThreshold: number;
	retrievalTopK: number;
	retrievalMarginalRatio: number;
	/** R6: attach a hit's module parent + adjacent chunk (small-to-big serving). */
	retrievalExpandContext: boolean;
	/** R8: composite quality score at/above which a query reports `high`. */
	retrievalConfidenceHigh: number;
	/** R8: composite quality score below which a query reports `low` + hints. */
	retrievalConfidenceLow: number;
	/** R8: deterministic query elaboration fused as an extra candidate source. */
	retrievalAutoElaborate: boolean;
	/** R9: append a `[refine: ...]` hint line to search results. */
	retrievalRefineHints: boolean;
	/** R10: opt-in reranking of the fused list. `off` (default) | `local`. */
	retrievalRerank: "off" | "local";
	/** R10: HF model id for the local cross-encoder reranker. */
	retrievalRerankModel: string;
	/** R10: how many fused candidates the reranker may reorder. */
	retrievalRerankTopn: number;
	/** R12: chunking strategy — `legacy` function/class walk (default) or `ast-density` split-merge. */
	indexerChunking: "legacy" | "ast-density";
	/** R12: non-whitespace char budget per ast-density chunk. */
	indexerChunkBudgetChars: number;
	indexerIgnore: string[];
	/** Prepend the R1 context header (path/lang/unit/imports) to chunk content. */
	indexerContextHeaders: boolean;
	/** Run an incremental reindex in the background shortly after session start. */
	indexerAutoIndex: boolean;
	/** Maximum files for automatic full-project indexing. Zero disables the guard; manual runs always bypass it. */
	indexerMaxAutoFiles: number;
	/**
	 * Watch the project tree while a session runs and reindex on changes
	 * (debounced, incremental). Independent of `indexerAutoIndex`, which only
	 * gates the session-start kick.
	 */
	indexerWatch: boolean;
	indexerRedactSecrets: boolean;
	memoryRedactPii: boolean;
	pricingModel: string;
	pricingInput: number | null;
	pricingOutput: number | null;
	storagePath: string;
}

export function defaultConfig(): Config {
	return {
		compressionLevel: "standard",
		compressionModel: "phi3:mini",
		compressionQueryAware: true,
		ollamaUrl: "http://localhost:11434",
		embeddingModel: "local",
		ollamaEmbedModel: "nomic-embed-text",
		guidanceEnabled: true,
		retrievalConfidenceThreshold: 0.2,
		retrievalTopK: 20,
		retrievalMarginalRatio: 0.75,
		retrievalExpandContext: true,
		retrievalConfidenceHigh: 0.55,
		retrievalConfidenceLow: 0.45,
		retrievalAutoElaborate: false,
		retrievalRefineHints: true,
		retrievalRerank: "off",
		retrievalRerankModel: "Xenova/ms-marco-MiniLM-L-6-v2",
		retrievalRerankTopn: 30,
		indexerChunking: "legacy",
		indexerChunkBudgetChars: 1200,
		indexerIgnore: [...DEFAULT_IGNORE],
		indexerContextHeaders: true,
		indexerAutoIndex: true,
		indexerMaxAutoFiles: 10_000,
		indexerWatch: true,
		indexerRedactSecrets: true,
		memoryRedactPii: true,
		pricingModel: "opus",
		pricingInput: null,
		pricingOutput: null,
		storagePath: path.join(PCE_HOME, "projects"),
	};
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const MAPPING: Record<string, keyof Config> = {
	"compression.level": "compressionLevel",
	"compression.model": "compressionModel",
	"compression.query_aware": "compressionQueryAware",
	"compression.ollama_url": "ollamaUrl",
	"guidance.enabled": "guidanceEnabled",
	"embedding.model": "embeddingModel",
	"embedding.ollama_model": "ollamaEmbedModel",
	"retrieval.confidence_threshold": "retrievalConfidenceThreshold",
	"retrieval.top_k": "retrievalTopK",
	"retrieval.marginal_ratio": "retrievalMarginalRatio",
	"retrieval.expand_context": "retrievalExpandContext",
	"retrieval.confidence_high": "retrievalConfidenceHigh",
	"retrieval.confidence_low": "retrievalConfidenceLow",
	"retrieval.auto_elaborate": "retrievalAutoElaborate",
	"retrieval.refine_hints": "retrievalRefineHints",
	"retrieval.rerank": "retrievalRerank",
	"retrieval.rerank_model": "retrievalRerankModel",
	"retrieval.rerank_topn": "retrievalRerankTopn",
	"indexer.chunking": "indexerChunking",
	"indexer.chunk_budget_chars": "indexerChunkBudgetChars",
	"indexer.ignore": "indexerIgnore",
	"indexer.context_headers": "indexerContextHeaders",
	"indexer.auto_index": "indexerAutoIndex",
	"indexer.max_auto_files": "indexerMaxAutoFiles",
	"indexer.watch": "indexerWatch",
	"indexer.redact_secrets": "indexerRedactSecrets",
	"memory.redact_pii": "memoryRedactPii",
	"storage.path": "storagePath",
	"pricing.model": "pricingModel",
	"pricing.input": "pricingInput",
	"pricing.output": "pricingOutput",
};

function deepMerge(base: any, override: any): any {
	const result = { ...base };
	for (const key of Object.keys(override ?? {})) {
		const value = override[key];
		if (value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) {
			result[key] = deepMerge(result[key], value);
		} else {
			result[key] = value;
		}
	}
	return result;
}

function applyDict(config: Config, data: any): void {
	const flat: Record<string, any> = {};
	const walk = (obj: any, prefix: string) => {
		for (const key of Object.keys(obj ?? {})) {
			const value = obj[key];
			const p = prefix ? `${prefix}.${key}` : key;
			if (value && typeof value === "object" && !Array.isArray(value)) walk(value, p);
			else flat[p] = value;
		}
	};
	walk(data, "");
	for (const [dotted, attr] of Object.entries(MAPPING)) {
		if (!(dotted in flat)) continue;
		const value = flat[dotted];
		if (attr === "indexerIgnore") {
			if (!Array.isArray(value)) throw new Error(`config indexer.ignore must be a list, got ${typeof value}`);
			const merged = [...DEFAULT_IGNORE];
			for (const item of value) {
				if (typeof item === "string" && !merged.includes(item)) merged.push(item);
			}
			config.indexerIgnore = merged;
		} else if (attr === "indexerMaxAutoFiles") {
			if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
				throw new Error(`config ${dotted} must be a non-negative integer`);
			}
			config.indexerMaxAutoFiles = value;
		} else if (attr === "pricingInput" || attr === "pricingOutput") {
			if (value !== null && typeof value !== "number") throw new Error(`config ${dotted} must be a number or null`);
			(config as any)[attr] = value;
		} else {
			(config as any)[attr] = value;
		}
	}
}

function readYaml(filePath: string): any {
	if (!fs.existsSync(filePath)) return {};
	try {
		return YAML.parse(fs.readFileSync(filePath, "utf-8")) ?? {};
	} catch (err) {
		throw new Error(`failed to parse ${filePath}: ${(err as Error).message}`);
	}
}

export function loadConfig(globalPath: string = DEFAULT_GLOBAL_PATH, projectPath?: string): Config {
	const config = defaultConfig();
	const globalData = readYaml(globalPath);
	const projectData = projectPath ? readYaml(projectPath) : {};
	applyDict(config, deepMerge(globalData, projectData));
	return config;
}

/** Load config for a project directory, auto-discovering the project config file. */
export function loadConfigForProject(projectDir: string): Config {
	return loadConfig(DEFAULT_GLOBAL_PATH, path.join(projectDir, PROJECT_CONFIG_NAME));
}

/** Env var `PCE_OLLAMA_URL` wins over config, mirroring upstream `CCE_OLLAMA_URL`. */
export function resolveOllamaUrl(config: Config): string {
	return process.env.PCE_OLLAMA_URL?.trim() || config.ollamaUrl;
}
