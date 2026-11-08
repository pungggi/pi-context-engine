#!/usr/bin/env node
/**
 * pce — standalone CLI over the context engine (issue #32.4).
 *
 * Why: the package ships only the pi extension, so debugging retrieval today
 * requires a pi session. `pce` drives the SAME engine.ts and the SAME store
 * the extension uses (loadConfigForProject), which makes it usable for
 * scripted sanity checks in CI and for power users without a host.
 *
 * Design: thin argument layer over ContextEngine — no reimplementation of
 * retrieval/status logic, so what the CLI prints is what the tools print.
 * Engines run `ephemeral` (no session row/snapshot), so CLI runs never
 * pollute session history.
 *
 * The file is built to dist/cli.js at pack time (tsconfig.build.json) and
 * exposed as the `pce` bin; importing it (tests) never executes main.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ContextEngine } from "./engine.js";

const require = createRequire(import.meta.url);

export const USAGE = `pce — pi-context-engine CLI (reads the same index and memory as the pi extension)

Usage:
  pce search <query> [--top-k N] [--max-tokens N]   hybrid retrieval over the index
  pce status                                        index health and token savings
  pce recall <topic>                                past decisions and notes by topic
  pce index [--full]                                build or refresh the index

Options:
  --project <dir>   project directory (default: current directory)
  -h, --help        show this help
  -v, --version     show the package version

Exit codes: 0 ok · 1 operational failure (no index, index errors, runtime error) · 2 usage error`;

/** Text sink the CLI writes to — injected so tests capture output. */
export interface CliIO {
	out(text: string): void;
	err(text: string): void;
}

/** The slice of ContextEngine the CLI actually uses (tests inject fakes). */
export interface CliEngine {
	readonly projectName: string;
	chunkCount(): number;
	search(
		query: string,
		opts: { topK?: number; maxTokens?: number },
	): Promise<{ body: string; inline: unknown[]; overflow: unknown[]; droppedLowValue: number }>;
	statusText(): Promise<string>;
	sessionRecall(topic: string): Promise<string>;
	reindex(opts: {
		full?: boolean;
		onProgress?: (msg: string) => void;
	}): Promise<{ indexed: number; chunks: number; deleted: number; skipped: number; errors: string[] }>;
	shutdown(): Promise<void>;
}

export function packageVersion(): string {
	return (require("../package.json") as { version: string }).version;
}

interface ParsedArgs {
	command: string | null;
	positional: string[];
	project: string | null;
	full: boolean;
	topK: number | null;
	maxTokens: number | null;
	help: boolean;
	version: boolean;
	unknown: string | null;
}

/** Minimal flag parser: long flags only, `--project <dir>` takes a value,
 * unknown flags land in `unknown` and surface as a usage error. */
export function parseCliArgs(argv: string[]): ParsedArgs {
	const out: ParsedArgs = {
		command: null,
		positional: [],
		project: null,
		full: false,
		topK: null,
		maxTokens: null,
		help: false,
		version: false,
		unknown: null,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "-h" || arg === "--help") out.help = true;
		else if (arg === "-v" || arg === "--version") out.version = true;
		else if (arg === "--full") out.full = true;
		else if (arg === "--project") {
			const value = argv[++i];
			if (value === undefined) out.unknown = "--project (missing value)";
			else out.project = value;
		} else if (arg === "--top-k" || arg === "--max-tokens") {
			const value = argv[i + 1];
			const parsedValue = Number(value);
			// A flag-looking token is the NEXT flag, not this flag's value.
			if (value === undefined || value.startsWith("-")) out.unknown = `${arg} (missing value)`;
			else if (!Number.isFinite(parsedValue) || parsedValue <= 0) out.unknown = `${arg} (needs a positive number)`;
			else {
				i++;
				if (arg === "--top-k") out.topK = parsedValue;
				else out.maxTokens = parsedValue;
			}
		} else if (arg.startsWith("-") && arg !== "-") out.unknown = arg;
		else if (out.command === null) out.command = arg;
		else out.positional.push(arg);
	}
	return out;
}

/**
 * Run one CLI invocation. Returns the process exit code; never throws
 * (operational errors land on stderr, code 1). The engine is always shut
 * down before returning so sqlite handles release (Windows file locks).
 */
export async function runCli(
	argv: string[],
	io: CliIO,
	createEngine: (projectDir: string) => CliEngine,
): Promise<number> {
	const parsed = parseCliArgs(argv);
	const say = (line: string): void => io.out(line);

	if (parsed.unknown) {
		io.err(`Unknown option: ${parsed.unknown}\n\n${USAGE}`);
		return 2;
	}
	if (parsed.help || parsed.command === "help") {
		say(USAGE);
		return 0;
	}
	if (parsed.version) {
		say(packageVersion());
		return 0;
	}
	if (!parsed.command) {
		io.err(USAGE);
		return 2;
	}

	const projectDir = parsed.project ?? process.cwd();
	let engine: CliEngine | null = null;
	try {
		switch (parsed.command) {
			case "search": {
				const query = parsed.positional.join(" ").trim();
				if (!query) {
					io.err(`search needs a query.\n\n${USAGE}`);
					return 2;
				}
				engine = createEngine(projectDir);
				if (engine.chunkCount() === 0) {
					io.err(
						`Index for ${engine.projectName} is empty — run \`pce index\` to build it first.`,
					);
					return 1;
				}
				const result = await engine.search(query, {
					topK: parsed.topK ?? undefined,
					maxTokens: parsed.maxTokens ?? undefined,
				});
				say(result.body);
				if (result.droppedLowValue > 0) {
					io.out(
						"[note: lower-confidence results omitted — lower retrieval.marginal_ratio or retrieval.confidence_threshold to include them]",
					);
				}
				if (result.inline.length === 0 && result.overflow.length === 0) {
					io.err("(no results)");
					return 1;
				}
				return 0;
			}
			case "status": {
				engine = createEngine(projectDir);
				say(await engine.statusText());
				return 0;
			}
			case "recall": {
				const topic = parsed.positional.join(" ").trim();
				if (!topic) {
					io.err(`recall needs a topic.\n\n${USAGE}`);
					return 2;
				}
				engine = createEngine(projectDir);
				say(await engine.sessionRecall(topic));
				return 0;
			}
			case "index": {
				engine = createEngine(projectDir);
				const result = await engine.reindex({
					full: parsed.full,
					onProgress: (msg) => io.err(msg), // stdout stays machine-readable
				});
				const parts = [`Indexed ${result.indexed} file(s), ${result.chunks} chunk(s)`];
				if (result.deleted > 0) parts.push(`pruned stale: ${result.deleted}`);
				if (result.skipped > 0) parts.push(`skipped: ${result.skipped}`);
				say(`✓ Index complete — ${parts.join(" · ")}`);
				if (result.errors.length > 0) {
					io.err(`Errors (${result.errors.length}):`);
					for (const err of result.errors.slice(0, 5)) io.err(`  - ${err}`);
					return 1;
				}
				return 0;
			}
			default:
				io.err(`Unknown command: ${parsed.command}\n\n${USAGE}`);
				return 2;
		}
	} catch (err) {
		io.err(`pce: ${err instanceof Error ? err.message : String(err)}`);
		return 1;
	} finally {
		if (engine) await engine.shutdown().catch(() => undefined);
	}
}

/**
 * True when this module is the process entry (bin invocation), false when it
 * is imported (tests). Compares REAL paths: `process.argv[1]` keeps the
 * symlink/short-name path it was invoked through while `import.meta.url` is
 * the resolved target, so a naive string comparison makes symlinked bins
 * (npm/pnpm on POSIX link `node_modules/.bin/pce` → `dist/cli.js`) silently
 * do nothing. Exported for tests.
 */
export function isDirectEntry(argv1: string | undefined, metaUrl: string): boolean {
	if (!argv1) return false;
	try {
		return fs.realpathSync(argv1) === fileURLToPath(metaUrl);
	} catch {
		return false; // vanished/unreadable argv path: never auto-run
	}
}

async function main(): Promise<void> {
	const code = await runCli(
		process.argv.slice(2),
		{
			out: (text) => process.stdout.write(text.endsWith("\n") ? text : `${text}\n`),
			err: (text) => process.stderr.write(text.endsWith("\n") ? text : `${text}\n`),
		},
		(projectDir) => new ContextEngine({ projectDir, ephemeral: true }),
	);
	// exitCode (not process.exit) so buffered stdout flushes before the
	// process ends.
	process.exitCode = code;
}

// Direct execution only (bin entry); importing from tests never runs main.
// realpath-guarded: see isDirectEntry for why a plain string compare breaks
// symlinked bins.
if (isDirectEntry(process.argv[1], import.meta.url)) {
	main().catch((err: unknown) => {
		process.stderr.write(`pce: ${err instanceof Error ? err.message : String(err)}\n`);
		process.exitCode = 1;
	});
}
