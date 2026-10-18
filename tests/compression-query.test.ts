/**
 * R3 query-aware compression: truncation must keep the lines that answer the
 * query, never grow the serving budget, never leak a stale cached selection,
 * and stay fully revertable (`compression.query_aware: false`).
 */
import { afterAll, describe, expect, it } from "vitest";
import { ContextEngine } from "../src/engine.js";
import { defaultConfig, type Config } from "../src/config.js";
import { LocalBackend } from "../src/storage/local-backend.js";
import { Compressor } from "../src/compression/compressor.js";
import { makeChunk, type Chunk } from "../src/types.js";
import { makeFakeEmbedder, makeTempDir, rmrf, writeFiles } from "./helpers.js";

const dirs: string[] = [];
const engines: ContextEngine[] = [];

afterAll(async () => {
	await Promise.all(engines.map((engine) => engine.shutdown().catch(() => undefined)));
	for (const d of dirs.splice(0)) rmrf(d);
});

/** A long function whose interesting line sits far beyond the head cut. */
function bigChunk(id = "big"): Chunk {
	const head = [
		"// file: src/ledger/wiring.ts | lang: typescript | unit: wireAccounts",
		"export function wireAccounts(accounts: Account[]): Result {",
		"  const plan = buildPlan(accounts);",
		"  for (const entry of plan.entries) {",
		"    validateEntry(entry);",
		"  }",
	];
	const filler = Array.from({ length: 40 }, (_, i) => `  const step${i} = { index: ${i}, state: "pending" };`);
	const deep = [
		"  // wireTransferLedger: the actual cross-book transfer with hash check",
		'  const receipt = wireTransferLedger(plan, { requireHash: true });',
		"  return { ok: true, receipt };",
		"}",
	];
	return makeChunk({
		id,
		content: [...head, ...filler, ...deep].join("\n"),
		chunkType: "function",
		filePath: "src/ledger/wiring.ts",
		startLine: 1,
		endLine: 50,
		language: "typescript",
		embedding: [0.1],
	});
}

const query = "where does wireTransferLedger apply the hash check";

describe("query-aware truncation (R3)", () => {
	it("keeps the lines that answer the query inside the level budget", async () => {
		const [out] = await new Compressor("http://127.0.0.1:1").compress([bigChunk()], "standard", query);
		const text = out!.compressedContent!;
		expect(text).toContain("wireTransferLedger");
		expect(text.length).toBeLessThanOrEqual(300);
		// The R1 header is stripped from serving text: the formatter already
		// prints [path:start], and the header would eat most of a 300-char cap.
		expect(text).not.toContain("// file:");
	});

	it("preserves source order in the selection", async () => {
		const [out] = await new Compressor("http://127.0.0.1:1").compress([bigChunk()], "standard", query);
		const lines = out!.compressedContent!.split("\n");
		const positions = lines
			.map((l, i) => (l.includes("wireTransferLedger") ? i : -1))
			.filter((i) => i >= 0);
		expect(positions.length).toBeGreaterThan(0);
		// The comment line and the code line keep their relative order.
		expect(positions[positions.length - 1]!).toBeGreaterThan(positions[0]!);
	});

	it("falls back to plain truncation without a query (old behaviour intact)", async () => {
		const [out] = await new Compressor("http://127.0.0.1:1").compress([bigChunk()], "standard");
		const text = out!.compressedContent!;
		expect(text).not.toContain("wireTransferLedger");
		expect(text.startsWith("export function wireAccounts")).toBe(true);
	});

	it("falls back when the query has no usable terms", async () => {
		const [out] = await new Compressor("http://127.0.0.1:1").compress([bigChunk()], "standard", "of to it");
		expect(out!.compressedContent).not.toContain("wireTransferLedger");
	});

	it("can be disabled per call (config compression.query_aware=false)", async () => {
		const [out] = await new Compressor("http://127.0.0.1:1").compress([bigChunk()], "standard", query, false);
		expect(out!.compressedContent).not.toContain("wireTransferLedger");
	});

	it("never exceeds the level cap at minimal either", async () => {
		const [out] = await new Compressor("http://127.0.0.1:1").compress([bigChunk()], "minimal", query);
		expect(out!.compressedContent!.length).toBeLessThanOrEqual(100);
	});

	it("serves the whole chunk at full (budget-driven, no fixed cap)", async () => {
		const chunk = bigChunk();
		const [out] = await new Compressor("http://127.0.0.1:1").compress([chunk], "full", query);
		expect(out!.compressedContent).toBe(chunk.content);
		// ...and without a query too: full never truncates.
		const [plain] = await new Compressor("http://127.0.0.1:1").compress([bigChunk()], "full");
		expect(plain!.compressedContent).toBe(chunk.content);
	});
});

describe("compression cache vs query-aware selection", () => {
	it("never lets a cached (chunk, level) value override a query selection", async () => {
		const dir = makeTempDir("pce-qcache-");
		dirs.push(dir);
		const backend = new LocalBackend(dir);
		const compressor = new Compressor("http://127.0.0.1:1", "phi3:mini", backend);
		backend.putCachedCompression("cached1", "standard", "STALE CACHED TEXT");

		// Query-aware path bypasses the cache...
		const [withQuery] = await compressor.compress([bigChunk("cached1")], "standard", query);
		expect(withQuery!.compressedContent).toContain("wireTransferLedger");
		expect(withQuery!.compressedContent).not.toContain("STALE CACHED TEXT");

		// ...while the query-less path keeps using it (cache stays valid there).
		const [noQuery] = await compressor.compress([bigChunk("cached1")], "standard");
		expect(noQuery!.compressedContent).toBe("STALE CACHED TEXT");
		backend.close();
	});
});

describe("engine wiring: search passes the query to the compressor", () => {
	async function harness(): Promise<{ engine: ContextEngine }> {
		const projectDir = makeTempDir("pce-qcomp-");
		dirs.push(projectDir);
		// The function source without a header line: the indexer adds it.
		writeFiles(projectDir, { "src/ledger/wiring.ts": bigChunk().content.split("\n").slice(1).join("\n") + "\n" });
		const storageRoot = makeTempDir("pce-store-");
		dirs.push(storageRoot);
		const config: Config = { ...defaultConfig(), storagePath: storageRoot, compressionLevel: "standard" };
		const engine = new ContextEngine({ projectDir, config });
		const embedder = makeFakeEmbedder();
		const backend = new LocalBackend(engine.storageBase);
		engines.push(engine);
		const internals = engine as unknown as {
			backendInstance: LocalBackend | null;
			embedderInstance: unknown;
			injectedRuntime: unknown;
		};
		internals.backendInstance = backend;
		internals.embedderInstance = embedder;
		internals.injectedRuntime = { backend, embedder };
		await engine.reindex({});
		return { engine };
	}

	it("serves the deep symbol for a query naming it", async () => {
		const { engine } = await harness();
		const out = await engine.search(query, { topK: 5 });
		const served = out.inline.map((c) => c.compressedContent || c.content).join("\n");
		expect(served).toContain("wireTransferLedger");
	});
});
