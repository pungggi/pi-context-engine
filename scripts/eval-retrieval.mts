/**
 * Retrieval eval harness — plan item R4 (docs/IMPLEMENTATION-PLAN.md).
 *
 * Why it exists: the package's smoke run measures tokens and latency, never
 * retrieval *quality*. Every retrieval change in the plan needs a before/after
 * number, and a regression gate that fails CI-style when quality drops.
 *
 * Design decisions:
 * - **Deterministic by default**: a token-hash fake embedder and an
 *   unreachable Ollama URL, so scores are reproducible on any machine with no
 *   model download. `--local` swaps in the real ONNX embedder to sanity-check
 *   that conclusions transfer.
 * - **Labels are validated first**: every `expect` file must exist and every
 *   `verify` snippet must appear in it, so a refactor that moves code fails
 *   loudly with a stale-label error instead of silently scoring 0.
 * - **Gate on recall + distraction**: top-k file recall (did we find the right
 *   files), nDCG@10 (are they ranked first), distraction@10 (how much of the
 *   served set is irrelevant). Distraction matters because a retriever that
 *   returns many loosely-related chunks scores fine on recall while wasting
 *   the agent's tokens.
 *
 * Usage:
 *   npm run eval                    # run + gate against tests/eval/baseline.json
 *   npm run eval -- --write-baseline
 *   npm run eval -- --local         # real ONNX embedder (downloads once)
 *   npm run eval -- --json          # machine-readable summary line
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContextEngine } from "../src/engine.ts";
import { DEFAULT_IGNORE, defaultConfig } from "../src/config.ts";
import { LocalBackend } from "../src/storage/local-backend.ts";
import { Embedder, LocalBackend as OnnxBackend } from "../src/indexer/embedder.ts";
import { FakeEmbeddingBackend } from "../tests/helpers.ts";

const EVAL_DIR = path.join("tests", "eval");
const QUERIES_PATH = path.join(EVAL_DIR, "queries.jsonl");
const BASELINE_PATH = path.join(EVAL_DIR, "baseline.json");

/** Regression tolerance (absolute points) before the gate fails. */
const TOLERANCE = 0.05;
const TOP_K = 10;

type QueryKind = "identifier" | "nl" | "bug-report" | "file-name" | "cross-file";

interface EvalQuery {
	id: string;
	kind: QueryKind;
	query: string;
	expect: string[];
	verify?: { file: string; text: string }[];
}

interface QueryScore {
	id: string;
	kind: QueryKind;
	fileRecall5: number;
	fileRecall10: number;
	ndcg10: number;
	distraction10: number;
	inlineTokens: number;
	servedTokens: number;
	ms: number;
	retrieved: number;
}

interface Metrics {
	fileRecall5: number;
	fileRecall10: number;
	ndcg10: number;
	distraction10: number;
	servedTokens: number;
	p50Ms: number;
	p95Ms: number;
	n: number;
}

function fail(message: string): never {
	console.error(`\nEVAL FAILED: ${message}`);
	process.exit(1);
}

function loadQueries(repoRoot: string): EvalQuery[] {
	const raw = fs.readFileSync(path.join(repoRoot, QUERIES_PATH), "utf-8");
	const queries: EvalQuery[] = [];
	const seenIds = new Set<string>();
	raw.split(/\r?\n/).forEach((line, i) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		let parsed: EvalQuery;
		try {
			parsed = JSON.parse(trimmed) as EvalQuery;
		} catch (err) {
			fail(`${QUERIES_PATH}:${i + 1} is not valid JSON: ${(err as Error).message}`);
		}
		if (!parsed.id || !parsed.query || !Array.isArray(parsed.expect) || parsed.expect.length === 0) {
			fail(`${QUERIES_PATH}:${i + 1} needs id, query and a non-empty expect list`);
		}
		if (seenIds.has(parsed.id)) fail(`duplicate query id: ${parsed.id}`);
		seenIds.add(parsed.id);
		queries.push(parsed);
	});
	return queries;
}

/** Validate labels against the live repo so stale labels fail loudly. */
function validateLabels(repoRoot: string, queries: EvalQuery[]): void {
	const problems: string[] = [];
	for (const q of queries) {
		for (const file of q.expect) {
			if (!fs.existsSync(path.join(repoRoot, file))) {
				problems.push(`${q.id}: expected file does not exist: ${file}`);
			}
		}
		for (const v of q.verify ?? []) {
			const full = path.join(repoRoot, v.file);
			if (!fs.existsSync(full)) {
				problems.push(`${q.id}: verify file does not exist: ${v.file}`);
				continue;
			}
			const text = fs.readFileSync(full, "utf-8");
			if (!text.includes(v.text)) {
				problems.push(`${q.id}: expected to find ${JSON.stringify(v.text)} in ${v.file}`);
			}
		}
	}
	if (problems.length > 0) {
		for (const p of problems) console.error(`  - ${p}`);
		fail(`${problems.length} stale label problem(s) in ${QUERIES_PATH} — update the labels`);
	}
}

function mean(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[idx]!;
}

function scoreOne(q: EvalQuery, rankedIds: { filePath: string }[], inlineTokens: number, servedTokens: number, ms: number): QueryScore {
	const expect = new Set(q.expect);
	const top5 = rankedIds.slice(0, 5);
	const top10 = rankedIds.slice(0, TOP_K);

	const recall = (hits: typeof top5): number => {
		const files = new Set(hits.map((c) => c.filePath));
		let found = 0;
		for (const f of expect) if (files.has(f)) found++;
		return found / expect.size;
	};

	// nDCG@10 over a file-level ranking (unique files by first appearance,
	// binary relevance): chunk-level double-counts when one expected file
	// contributes several chunks, which can push nDCG above 1.
	const fileRank: string[] = [];
	for (const c of top10) if (!fileRank.includes(c.filePath)) fileRank.push(c.filePath);
	let dcg = 0;
	fileRank.forEach((fp, i) => {
		if (expect.has(fp)) dcg += 1 / Math.log2(i + 2);
	});
	const ideal = Math.min(TOP_K, expect.size);
	let idcg = 0;
	for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
	const ndcg = idcg > 0 ? dcg / idcg : 0;

	const irrelevant = top10.filter((c) => !expect.has(c.filePath)).length;
	const distraction = top10.length > 0 ? irrelevant / top10.length : 0;

	return {
		id: q.id,
		kind: q.kind,
		fileRecall5: recall(top5),
		fileRecall10: recall(top10),
		ndcg10: ndcg,
		distraction10: distraction,
		inlineTokens,
		servedTokens,
		ms,
		retrieved: rankedIds.length,
	};
}

function aggregate(scores: QueryScore[]): Metrics {
	const latencies = scores.map((s) => s.ms).sort((a, b) => a - b);
	return {
		fileRecall5: mean(scores.map((s) => s.fileRecall5)),
		fileRecall10: mean(scores.map((s) => s.fileRecall10)),
		ndcg10: mean(scores.map((s) => s.ndcg10)),
		distraction10: mean(scores.map((s) => s.distraction10)),
		servedTokens: mean(scores.map((s) => s.servedTokens)),
		p50Ms: percentile(latencies, 50),
		p95Ms: percentile(latencies, 95),
		n: scores.length,
	};
}

const KINDS: QueryKind[] = ["identifier", "nl", "bug-report", "file-name", "cross-file"];

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const writeBaseline = args.includes("--write-baseline");
	const useLocal = args.includes("--local");
	const jsonOnly = args.includes("--json");
	// R11: `--model <hf-id>` overrides the local embedder (requires --local).
	const modelIdx = args.indexOf("--model");
	const modelOverride = modelIdx >= 0 ? args[modelIdx + 1] : undefined;
	// R12: `--ast-density` runs the A/B with the new chunking strategy.
	const useAstDensity = args.includes("--ast-density");
	const repoRoot = fs.realpathSync(process.cwd());

	const queries = loadQueries(repoRoot);
	validateLabels(repoRoot, queries);

	const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pce-eval-"));
	const config = {
		...defaultConfig(),
		storagePath: storageRoot,
		// Never index the label files themselves: their content contains every
		// query verbatim, which would make FTS rank them first and poison scores.
		// (Basename match — the walker checks `indexer.ignore` per path segment.)
		indexerIgnore: [...DEFAULT_IGNORE, ".pi", "queries.jsonl", "baseline.json"],
		// Deterministic compression: an unreachable Ollama forces the
		// signature/truncation fallback on every machine.
		ollamaUrl: "http://127.0.0.1:1",
		compressionLevel: "standard" as const,
		...(useAstDensity ? { indexerChunking: "ast-density" as const } : {}),
	};

	let embedder: Embedder;
	if (useLocal) {
		const backend = new OnnxBackend(modelOverride);
		await backend.init();
		embedder = new Embedder(backend);
	} else {
		embedder = new Embedder(new FakeEmbeddingBackend());
	}
	const backendName = `${embedder.backendName}/${embedder.modelName}`;

	const engine = new ContextEngine({
		projectDir: repoRoot,
		config,
		runtime: { backend: new LocalBackend(storageRoot), embedder },
	});
	await engine.reindex({});

	// Warmup absorbs one-time costs (Ollama probe, prepared statements).
	await engine.search("warmup query for the eval harness", { topK: 5 });

	const scores: QueryScore[] = [];
	for (const q of queries) {
		const t0 = Date.now();
		const out = await engine.search(q.query, { topK: TOP_K });
		const ms = Date.now() - t0;
		const ranked = [...out.inline, ...out.overflow];
		const inlineTokens = out.inline.reduce(
			(acc, c) => acc + Math.max(1, Math.floor((c.compressedContent || c.content).length / 4)),
			0,
		);
		const servedTokens = inlineTokens + out.overflow.length * 30;
		scores.push(scoreOne(q, ranked, inlineTokens, servedTokens, ms));
	}

	const overall = aggregate(scores);
	const perKind: Record<string, Metrics> = {};
	for (const kind of KINDS) {
		const subset = scores.filter((s) => s.kind === kind);
		if (subset.length > 0) perKind[kind] = aggregate(subset);
	}
	const identifierRecall5 = perKind["identifier"]?.fileRecall5 ?? 0;

	const stamp = {
		backend: backendName,
		generatedAt: new Date().toISOString(),
		queries: queries.length,
	};

	if (writeBaseline) {
		fs.writeFileSync(BASELINE_PATH, JSON.stringify({ ...stamp, overall, perKind }, null, 2) + "\n");
		console.log(`baseline written to ${BASELINE_PATH}`);
	}

	await engine.shutdown();
	fs.rmSync(storageRoot, { recursive: true, force: true });

	if (jsonOnly) {
		console.log(JSON.stringify({ ...stamp, overall, perKind }));
	}

	const fmt = (n: number): string => n.toFixed(3);
	console.log(`\nBackend: ${backendName} · ${queries.length} queries · gate tolerance ±${TOLERANCE}`);
	console.log(`  ${"metric".padEnd(16)}${"score".padStart(8)}   (fileRecall = share of expected files found in top-k)`);
	console.log(`  ${"fileRecall@5".padEnd(16)}${fmt(overall.fileRecall5).padStart(8)}`);
	console.log(`  ${"fileRecall@10".padEnd(16)}${fmt(overall.fileRecall10).padStart(8)}`);
	console.log(`  ${"nDCG@10".padEnd(16)}${fmt(overall.ndcg10).padStart(8)}   (file-level ranking)`);
	console.log(`  ${"distraction@10".padEnd(16)}${fmt(overall.distraction10).padStart(8)}   (lower is better)`);
	console.log(`  ${"identifier R@5".padEnd(16)}${fmt(identifierRecall5).padStart(8)}`);
	console.log(`  ${"served tokens".padEnd(16)}${String(Math.round(overall.servedTokens)).padStart(8)}`);
	console.log(`  ${"latency p50/p95".padEnd(16)}${`${overall.p50Ms}/${overall.p95Ms}ms`.padStart(8)}`);
	console.log("  by kind:");
	for (const kind of KINDS) {
		const m = perKind[kind];
		if (!m) continue;
		console.log(
			`    ${kind.padEnd(12)} n=${String(m.n).padStart(2)}  R@10=${fmt(m.fileRecall10)}  nDCG=${fmt(m.ndcg10)}  distract=${fmt(m.distraction10)}`,
		);
	}

	// Weakest results first — these are the queries to look at when a number moves.
	const worst = [...scores].sort((a, b) => a.fileRecall10 - b.fileRecall10 || b.distraction10 - a.distraction10).slice(0, 5);
	if (worst.length > 0 && !jsonOnly) {
		console.log("  weakest queries:");
		for (const w of worst) {
			console.log(`    ${w.id.padEnd(28)} R@10=${fmt(w.fileRecall10)} distract=${fmt(w.distraction10)}  (${w.kind})`);
		}
	}

	if (writeBaseline) return;

	if (!fs.existsSync(BASELINE_PATH)) {
		fail(`no baseline at ${BASELINE_PATH} — run \`npm run eval -- --write-baseline\` first`);
	}
	const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf-8")) as {
		backend: string;
		generatedAt?: string;
		overall: Metrics;
		perKind?: Record<string, Metrics>;
	};
	if (baseline.backend !== backendName) {
		fail(`baseline was recorded with backend ${baseline.backend}, this run used ${backendName} — re-record or match backends`);
	}

	const regressions: string[] = [];
	const check = (label: string, actual: number, limit: number, direction: "down" | "up"): void => {
		const bad = direction === "down" ? actual < limit - TOLERANCE : actual > limit + TOLERANCE;
		if (bad) {
			regressions.push(`${label}: ${fmt(actual)} vs baseline ${fmt(limit)} (tolerance ±${TOLERANCE})`);
		}
	};
	check("fileRecall@10", overall.fileRecall10, baseline.overall.fileRecall10, "down");
	check("nDCG@10", overall.ndcg10, baseline.overall.ndcg10, "down");
	check("distraction@10", overall.distraction10, baseline.overall.distraction10, "up");
	check("identifier fileRecall@5", identifierRecall5, baseline.perKind?.["identifier"]?.fileRecall5 ?? 0, "down");

	if (regressions.length > 0) {
		for (const r of regressions) console.error(`  REGRESSION  ${r}`);
		fail(`${regressions.length} retrieval quality regression(s) vs ${BASELINE_PATH}`);
	}
	console.log(`\nGate passed vs baseline recorded ${baseline.generatedAt ?? ""}`.trim());
}

await main();
