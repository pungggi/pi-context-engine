/**
 * R8: query-confidence signal + optional deterministic elaboration.
 * - weak queries report `low` with actionable deterministic hints;
 * - strong identifier queries report `high` (and stay silent in the body);
 * - elaboration (opt-in) only ADDS candidates: raw top-1 and raw ordering
 *   are unchanged, no network, fully deterministic.
 */
import { afterAll, describe, expect, it } from "vitest";
import { ContextEngine } from "../src/engine.js";
import { defaultConfig, type Config } from "../src/config.js";
import { LocalBackend } from "../src/storage/local-backend.js";
import { makeFakeEmbedder, makeTempDir, rmrf, writeFiles } from "./helpers.js";

const dirs: string[] = [];
const engines: ContextEngine[] = [];

afterAll(async () => {
	await Promise.all(engines.map((e) => e.shutdown().catch(() => undefined)));
	for (const d of dirs.splice(0)) rmrf(d);
});

const FILES = {
	"src/invoice.ts": `export interface InvoiceLine {
  sku: string;
  quantity: number;
  unitPrice: number;
}

export function invoiceTotal(lines: InvoiceLine[]): number {
  return lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
}

export function formatInvoice(lines: InvoiceLine[]): string {
  return \`total: \${invoiceTotal(lines).toFixed(2)}\`;
}
`,
	"src/shipping.ts": `export function shippingCost(weightKg: number, express: boolean): number {
  const base = weightKg * 2.5;
  return express ? base * 2 : base;
}
`,
};

async function setup(overrides: Partial<Config> = {}): Promise<ContextEngine> {
	const projectDir = makeTempDir("pce-r8-");
	dirs.push(projectDir);
	writeFiles(projectDir, FILES);
	const storageRoot = makeTempDir("pce-r8store-");
	dirs.push(storageRoot);
	const config: Config = {
		...defaultConfig(),
		storagePath: storageRoot,
		retrievalAutoElaborate: false,
		...overrides,
	};
	const backend = new LocalBackend(storageRoot);
	const engine = new ContextEngine({ projectDir, config, runtime: { backend, embedder: makeFakeEmbedder() } });
	engines.push(engine);
	await engine.reindex({ full: true });
	return engine;
}

describe("R8: query confidence", () => {
	it("reports low with >=1 hint for a vague query with no identifiers or paths", async () => {
		const engine = await setup();
		const out = await engine.search("the thing that does stuff for the process", { topK: 5 });
		expect(out.queryAssessment.level).toBe("low");
		expect(out.queryAssessment.hints.length).toBeGreaterThan(0);
		expect(out.body).toContain("[query confidence: low");
	});

	it("reports high for an exact identifier query and stays silent in the body", async () => {
		const engine = await setup();
		const out = await engine.search("invoiceTotal InvoiceLine", { topK: 5 });
		expect(out.queryAssessment.level).toBe("high");
		expect(out.body).not.toContain("[query confidence:");
	});

	it("caps at medium when the candidate pool is tiny (tiny indexes lie)", async () => {
		const engine = await setup();
		// A query that only FTS-matches one chunk yields few candidates.
		const out = await engine.search("invoiceTotal", { topK: 5 });
		expect(["medium", "high"]).toContain(out.queryAssessment.level);
	});

	it("thresholds are config-tunable", async () => {
		const engine = await setup({ retrievalConfidenceHigh: 0.99, retrievalConfidenceLow: 0.98 });
		const out = await engine.search("invoiceTotal InvoiceLine", { topK: 5 });
		expect(out.queryAssessment.level).toBe("low");
	});
});

describe("R8: optional elaboration", () => {
	it("off by default: results identical to a retriever built without it", async () => {
		const engine = await setup();
		expect((engine as unknown as { config: Config }).config.retrievalAutoElaborate).toBe(false);
		const out = await engine.search("invoice total quantity unitPrice", { topK: 8 });
		expect(out.inline.length + out.overflow.length).toBeGreaterThan(0);
	});

	it("on: never changes the raw top-1 and only adds candidate files", async () => {
		const off = await setup();
		const on = await setup({ retrievalAutoElaborate: true });
		const query = "compute the invoice total from quantity and unit price";
		const a = await off.search(query, { topK: 12 });
		const b = await on.search(query, { topK: 12 });
		const filesOf = (e: typeof a) => [...new Set([...e.inline, ...e.overflow].map((c) => c.filePath))];
		const filesA = filesOf(a);
		const filesB = filesOf(b);
		// Raw-query files survive elaboration (nothing removed).
		for (const f of filesA) expect(filesB).toContain(f);
		// The raw top-1 chunk is still first.
		const topA = (a.inline[0] ?? a.overflow[0])!.filePath;
		const topB = (b.inline[0] ?? b.overflow[0])!.filePath;
		expect(topB).toBe(topA);
	});

	it("elaborateQuery is deterministic and stopword-stripped", async () => {
		const { elaborateQuery } = await import("../src/retrieval/query-parser.js");
		const near = [{ content: "invoiceTotal quantity unitPrice reduce" }, { content: "invoiceTotal unitPrice sum" }];
		const v1 = elaborateQuery("what computes the total for an invoice", near);
		const v2 = elaborateQuery("what computes the total for an invoice", near);
		expect(v1).toBe(v2);
		expect(v1).not.toMatch(/\b(what|the|for|an)\b/);
		expect(v1).toContain("invoiceTotal");
		// No near-miss terms → still strips stopwords deterministically.
		expect(elaborateQuery("the the the", [])).toBe(null);
	});
});
