/**
 * Event-loop lag benchmark for indexing (the "TUI freezes while indexing"
 * investigation). Manual script — not part of `npm run check`: it needs the
 * real ONNX embedder (model cache) and takes seconds.
 *
 * What it measures: while a full reindex runs, a 20 ms interval timer samples
 * event-loop lag (actual tick time minus expected). If indexing starves the
 * loop — tokenization, ONNX inference and tree-sitter parsing all run on the
 * main thread — tick lag spikes, which is exactly the TUI freeze a user sees.
 *
 * Run:  npx tsx scripts/bench-event-loop.mts [fileCount]
 * Output: one JSON line { files, chunks, totalMs, maxLagMs, p95LagMs, stalls100ms }.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContextEngine } from "../src/engine.ts";
import { defaultConfig } from "../src/config.ts";
import { LocalBackend } from "../src/storage/local-backend.ts";
import { Embedder, LocalBackend as OnnxBackend } from "../src/indexer/embedder.ts";

const FILE_COUNT = Number(process.argv[2] ?? 200);

function makeRepo(dir: string, n: number): void {
	fs.mkdirSync(path.join(dir, "src"), { recursive: true });
	for (let i = 0; i < n; i++) {
		const fns: string[] = [];
		for (let j = 0; j < 8; j++) {
			fns.push(
				`export function worker_${i}_${j}(input: number, label: string): number {\n` +
					`\tconst acc = input * ${j + 1} + ${i};\n` +
					`\tlet total = acc;\n` +
					`\tfor (let k = 0; k < ${j + 3}; k++) {\n` +
					`\t\ttotal += Math.sqrt(Math.abs(total + k * acc));\n` +
					`\t}\n` +
					`\tif (label.length > ${j}) total += label.charCodeAt(0);\n` +
					`\treturn Math.floor(total);\n` +
					`}\n`,
			);
		}
		fs.writeFileSync(path.join(dir, "src", `mod_${i}.ts`), fns.join("\n"));
	}
}

async function main(): Promise<void> {
	const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pce-bench-repo-"));
	const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pce-bench-store-"));
	makeRepo(projectDir, FILE_COUNT);

	const config = {
		...defaultConfig(),
		storagePath: storageRoot,
		// Deterministic compression path: no Ollama in the bench.
		ollamaUrl: "http://127.0.0.1:1",
	};
	const onnx = new OnnxBackend();
	await onnx.init();
	const embedder = new Embedder(onnx);
	const engine = new ContextEngine({
		projectDir,
		config,
		runtime: { backend: new LocalBackend(storageRoot), embedder },
	});

	// Lag sampler: a 20 ms timer; lag = how late each tick fires.
	const SAMPLE_MS = 20;
	const lags: number[] = [];
	let expected = Date.now() + SAMPLE_MS;
	const sampler = setInterval(() => {
		const now = Date.now();
		lags.push(now - expected);
		expected = now + SAMPLE_MS;
	}, SAMPLE_MS);

	const t0 = Date.now();
	const result = await engine.reindex({});
	const totalMs = Date.now() - t0;
	clearInterval(sampler);

	lags.sort((a, b) => a - b);
	const p95 = lags[Math.min(lags.length - 1, Math.floor(lags.length * 0.95))] ?? 0;
	const maxLag = lags[lags.length - 1] ?? 0;
	const stalls100 = lags.filter((l) => l > 100).length;
	console.log(
		JSON.stringify({
			files: result.indexed,
			chunks: result.chunks,
			errors: result.errors.length,
			totalMs,
			maxLagMs: maxLag,
			p95LagMs: p95,
			stalls100ms: stalls100,
			samples: lags.length,
		}),
	);
	await engine.shutdown().catch(() => undefined);
	process.exit(0);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
