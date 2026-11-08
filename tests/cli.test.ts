import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
	USAGE,
	isDirectEntry,
	packageVersion,
	parseCliArgs,
	runCli,
	type CliEngine,
	type CliIO,
} from "../src/cli.js";

interface Capture {
	io: CliIO;
	out: string[];
	err: string[];
}

function capture(): Capture {
	const out: string[] = [];
	const err: string[] = [];
	return {
		io: { out: (t) => out.push(t), err: (t) => err.push(t) },
		out,
		err,
	};
}

/** Configurable fake engine + counters for every side effect the CLI drives. */
function fakeEngine(
	overrides: Partial<CliEngine> = {},
): { engine: CliEngine; state: { shutdowns: number; searches: unknown[]; reindexes: unknown[] } } {
	const state = { shutdowns: 0, searches: [] as unknown[], reindexes: [] as unknown[] };
	const engine: CliEngine = {
		projectName: "proj",
		chunkCount: () => 10,
		search: async (query, opts) => {
			state.searches.push({ query, opts });
			return { body: `BODY(${query})`, inline: [{}], overflow: [], droppedLowValue: 0 };
		},
		statusText: async () => "Index: 10 chunk(s)",
		sessionRecall: async (topic) => `RECALL(${topic})`,
		reindex: async (opts) => {
			state.reindexes.push(opts);
			opts.onProgress?.("Indexing…");
			return { indexed: 1, chunks: 5, deleted: 0, skipped: 0, errors: [] };
		},
		shutdown: async () => {
			state.shutdowns++;
		},
		...overrides,
	};
	return { engine, state };
}

function runner(engine: CliEngine) {
	const projects: string[] = [];
	const cap = capture();
	return {
		...cap,
		projects,
		run: (argv: string[]) => runCli(argv, cap.io, (dir) => (projects.push(dir), engine)),
	};
}

describe("parseCliArgs", () => {
	it("splits command, positionals and flags", () => {
		const p = parseCliArgs(["search", "how", "does", "x", "--top-k", "5", "--project", "/tmp/p"]);
		expect(p.command).toBe("search");
		expect(p.positional).toEqual(["how", "does", "x"]);
		expect(p.topK).toBe(5);
		expect(p.project).toBe("/tmp/p");
		expect(p.unknown).toBeNull();
	});

	it("flags unknown options and bad values", () => {
		expect(parseCliArgs(["search", "--bogus"]).unknown).toBe("--bogus");
		expect(parseCliArgs(["search", "--top-k", "x"]).unknown).toContain("--top-k");
		// A flag-looking token is the next option, not this option's value:
		// reported as THIS flag missing its value, not as a bad number.
		expect(parseCliArgs(["search", "--top-k", "--project", "/x"]).unknown).toBe("--top-k (missing value)");
		expect(parseCliArgs(["--project"]).unknown).toContain("--project");
	});

	it("recognizes help, version and --full", () => {
		expect(parseCliArgs(["-h"])).toMatchObject({ help: true, command: null });
		expect(parseCliArgs(["--version"])).toMatchObject({ version: true });
		expect(parseCliArgs(["index", "--full"])).toMatchObject({ command: "index", full: true });
	});
});

describe("runCli", () => {
	it("prints usage and exits 2 without a command", async () => {
		const r = runner(fakeEngine().engine);
		expect(await r.run([])).toBe(2);
		expect(r.err.join("")).toContain("Usage:");
	});

	it("serves --help and --version without constructing an engine", async () => {
		const help = runner(fakeEngine().engine);
		expect(await help.run(["--help"])).toBe(0);
		expect(help.out.join("")).toBe(USAGE);

		const version = runner(fakeEngine().engine);
		expect(await version.run(["-v"])).toBe(0);
		expect(version.out.join("").trim()).toBe(packageVersion());
		expect(version.projects).toHaveLength(0); // never built an engine
	});

	it("rejects unknown options and commands with exit 2", async () => {
		const flag = runner(fakeEngine().engine);
		expect(await flag.run(["search", "--bogus", "q"])).toBe(2);
		expect(flag.err.join("")).toContain("Unknown option: --bogus");

		const cmd = runner(fakeEngine().engine);
		expect(await cmd.run(["frobnicate"])).toBe(2);
		expect(cmd.err.join("")).toContain("Unknown command: frobnicate");
	});

	it("search: passes query and limits through, prints the body", async () => {
		const { engine, state } = fakeEngine();
		const r = runner(engine);
		expect(await r.run(["search", "how", "hybrid", "retrieval", "--top-k", "3", "--max-tokens", "2000"])).toBe(0);
		expect(state.searches).toEqual([
			{ query: "how hybrid retrieval", opts: { topK: 3, maxTokens: 2000 } },
		]);
		expect(r.out.join("")).toContain("BODY(how hybrid retrieval)");
		expect(state.shutdowns).toBe(1); // handles released on success
	});

	it("search: empty index is an operational failure (exit 1) with a hint", async () => {
		const { engine, state } = fakeEngine({ chunkCount: () => 0 });
		const r = runner(engine);
		expect(await r.run(["search", "anything"])).toBe(1);
		expect(r.err.join("")).toContain("pce index");
		expect(state.searches).toHaveLength(0);
		expect(state.shutdowns).toBe(1);
	});

	it("search: no hits → exit 1 with a note; dropped-low-value appends a hint", async () => {
		const empty = fakeEngine({
			search: async () => ({ body: "", inline: [], overflow: [], droppedLowValue: 0 }),
		});
		const r1 = runner(empty.engine);
		expect(await r1.run(["search", "nothing"])).toBe(1);
		expect(r1.err.join("")).toContain("(no results)");

		const dropped = fakeEngine({
			search: async () => ({ body: "B", inline: [{}], overflow: [], droppedLowValue: 2 }),
		});
		const r2 = runner(dropped.engine);
		expect(await r2.run(["search", "x"])).toBe(0);
		expect(r2.out.join("")).toContain("lower-confidence results omitted");
	});

	it("search: missing query → exit 2", async () => {
		const r = runner(fakeEngine().engine);
		expect(await r.run(["search"])).toBe(2);
		expect(r.err.join("")).toContain("needs a query");
	});

	it("status and recall print engine output", async () => {
		const r = runner(fakeEngine().engine);
		expect(await r.run(["status"])).toBe(0);
		expect(r.out.join("")).toContain("Index: 10 chunk(s)");

		expect(await r.run(["recall", "auth", "strategy"])).toBe(0);
		expect(r.out.join("")).toContain("RECALL(auth strategy)");
	});

	it("index: --full and --project flow through; progress lands on stderr", async () => {
		const { engine, state } = fakeEngine();
		const r = runner(engine);
		expect(await r.run(["index", "--full", "--project", "/tmp/proj"])).toBe(0);
		expect(r.projects).toEqual(["/tmp/proj"]);
		expect(state.reindexes).toHaveLength(1);
		expect(state.reindexes[0]).toMatchObject({ full: true });
		expect(r.err.join("")).toContain("Indexing…");
		expect(r.out.join("")).toContain("Indexed 1 file(s), 5 chunk(s)");
		expect(state.shutdowns).toBe(1);
	});

	it("index: incremental (no --full) stays incremental", async () => {
		const { engine, state } = fakeEngine();
		const r = runner(engine);
		expect(await r.run(["index"])).toBe(0);
		expect(state.reindexes[0]).toMatchObject({ full: false });
	});

	it("index: report errors → exit 1", async () => {
		const { engine } = fakeEngine({
			reindex: async () => ({ indexed: 0, chunks: 0, deleted: 0, skipped: 0, errors: ["boom"] }),
		});
		const r = runner(engine);
		expect(await r.run(["index"])).toBe(1);
		expect(r.err.join("")).toContain("boom");
	});

	it("runtime failures land on stderr as exit 1 and still shut down", async () => {
		const { engine, state } = fakeEngine({
			search: async () => {
				throw new Error("boom");
			},
		});
		const r = runner(engine);
		expect(await r.run(["search", "q"])).toBe(1);
		expect(r.err.join("")).toContain("pce: boom");
		expect(state.shutdowns).toBe(1);
	});
});

describe("isDirectEntry (bin main-guard, symlink regression)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pce-cli-entry-"));
	const real = path.join(dir, "real-entry.js");
	fs.writeFileSync(real, "// test fixture");
	// Reality check: node resolves the main module to its realpath, so the
	// comparison target must be the real path too.
	const realUrl = pathToFileURL(fs.realpathSync(real)).href;


	it("matches when argv points at the same real file", () => {
		expect(isDirectEntry(real, realUrl)).toBe(true);
	});

	it("matches when argv is a SYMLINK to the entry (npm/pnpm bin links)", () => {
		const link = path.join(dir, "link-entry.js");
		try {
			fs.symlinkSync(real, link);
		} catch {
			return; // symlink privilege unavailable on this host — covered by the realpath path above
		}
		// This is the exact shape that made the old string comparison
		// (`import.meta.url === pathToFileURL(argv[1]).href`) return false:
		// argv keeps the link, meta.url is the target.
		expect(isDirectEntry(link, realUrl)).toBe(true);
	});

	it("rejects a different file, a missing argv and an unreadable path", () => {
		const other = path.join(dir, "other.js");
		fs.writeFileSync(other, "// other");
		expect(isDirectEntry(other, realUrl)).toBe(false);
		expect(isDirectEntry(undefined, realUrl)).toBe(false);
		expect(isDirectEntry(path.join(dir, "nope.js"), realUrl)).toBe(false);
	});

	afterAll(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
