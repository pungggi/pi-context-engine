/**
 * Real-world smoke test: index this package's own source with the LOCAL
 * (transformers.js / ONNX) embedder and run a few queries.
 *
 * Not part of the unit suite — the first run downloads a model.
 *   node scripts-smoke/real-world.mjs [repoPath]
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { ContextEngine } from "../src/engine.ts";
import { defaultConfig } from "../src/config.ts";

const repoPath = process.argv[2] ?? process.cwd();
const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pce-realworld-"));

const config = { ...defaultConfig(), storagePath: storageRoot };
const engine = new ContextEngine({ projectDir: repoPath, config });

const t0 = Date.now();
console.log(`Indexing ${repoPath} with the local ONNX embedder…`);
const result = await engine.reindex({
	onProgress: (msg) => console.log(`  ${msg}`),
});
const indexMs = Date.now() - t0;
console.log(
	`Indexed ${result.indexed} files / ${result.chunks} chunks in ${indexMs}ms` +
		(result.errors.length ? ` · ${result.errors.length} error(s): ${result.errors.slice(0, 3).join("; ")}` : ""),
);
console.log(`Backend: ${engine.backend.constructor.name} · chunks in store: ${engine.chunkCount()}`);

const queries = [
	"how does hybrid retrieval merge vector and keyword results",
	"where is the embedding cache keyed by content hash",
	"secret redaction patterns for API keys",
	"session memory savings ledger",
];
for (const query of queries) {
	const tq = Date.now();
	const out = await engine.search(query, { topK: 4 });
	const files = [...new Set(out.inline.map((c) => `${c.filePath}:${c.startLine}`))];
	console.log(`\nQ: ${query}`);
	console.log(`   ${out.inline.length} inline / ${out.overflow.length} overflow · ${Date.now() - tq}ms`);
	for (const f of files) console.log(`   → ${f}`);
}

console.log("\n--- status ---");
console.log(await engine.statusText());

// Incremental re-index should be near-instant (embedding cache hits).
const t1 = Date.now();
const second = await engine.reindex({});
console.log(`\nIncremental re-index: ${second.indexed} file(s) changed in ${Date.now() - t1}ms`);

await engine.shutdown();
fs.rmSync(storageRoot, { recursive: true, force: true });
console.log("\nSmoke test complete.");
