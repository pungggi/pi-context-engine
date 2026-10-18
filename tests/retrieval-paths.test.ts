/**
 * R5 multi-path retrieval: exact symbol hits (graph node names) and explicit
 * file hints become their own RRF lists, so identifier queries reach the
 * definition and path queries reach the file even when prose/vector signals
 * are weak.
 */
import { afterEach, describe, expect, it } from "vitest";
import { HybridRetriever } from "../src/retrieval/retriever.js";
import { LocalBackend } from "../src/storage/local-backend.js";
import { GraphStore } from "../src/storage/graph-store.js";
import { makeChunk, type Chunk, type GraphNode } from "../src/types.js";
import { FakeEmbeddingBackend, makeFakeEmbedder, makeTempDir, rmrf } from "./helpers.js";

const dirs: string[] = [];
const backends: LocalBackend[] = [];
const stores: GraphStore[] = [];

afterEach(() => {
	for (const s of stores.splice(0)) {
		try {
			s.close();
		} catch {
			// already closed
		}
	}
	for (const b of backends.splice(0)) {
		try {
			b.close();
		} catch {
			// already closed by the test
		}
	}
	for (const d of dirs.splice(0)) rmrf(d);
});

describe("GraphStore.findSymbols", () => {
	function store(): GraphStore {
		const dir = makeTempDir("pce-symdb-");
		dirs.push(dir);
		const s = new GraphStore(dir + "/graph");
		stores.push(s);
		s.ingest(
			[
				{ id: "c1", nodeType: "class", name: "PaymentGateway", filePath: "src/pay.py", properties: {} },
				{ id: "c2", nodeType: "function", name: "PaymentGateway.charge", filePath: "src/pay.py", properties: {} },
				{ id: "c3", nodeType: "function", name: "PaymentGateway.refund", filePath: "src/pay.py", properties: {} },
				{ id: "c4", nodeType: "function", name: "unrelatedThing", filePath: "src/other.ts", properties: {} },
				{ id: "f1", nodeType: "file", name: "pay.py", filePath: "src/pay.py", properties: {} },
			] satisfies GraphNode[],
			[],
		);
		return s;
	}

	it("matches exact, suffix and prefix forms, exact first", () => {
		const s = store();
		const byLeaf = s.findSymbols(["charge"]).map((n) => n.id);
		expect(byLeaf).toEqual(["c2"]);

		const byClass = s.findSymbols(["PaymentGateway"]).map((n) => n.id);
		// Exact node first, then its methods (prefix matches), never files.
		expect(byClass[0]).toBe("c1");
		expect(byClass).toContain("c2");
		expect(byClass).toContain("c3");
		expect(byClass).not.toContain("f1");
	});

	it("is case-insensitive and ignores short/blank names", () => {
		const s = store();
		expect(s.findSymbols(["CHARGE"]).map((n) => n.id)).toEqual(["c2"]);
		expect(s.findSymbols(["", "a", "  "])).toEqual([]);
		expect(s.findSymbols([])).toEqual([]);
	});

	it("caps the result list deterministically", () => {
		const s = store();
		expect(s.findSymbols(["PaymentGateway"], 2).map((n) => n.id)).toEqual(["c1", "c2"]);
	});
});

describe("HybridRetriever structured paths", () => {
	function setup(): { backend: LocalBackend; retriever: HybridRetriever } {
		const dir = makeTempDir("pce-paths-");
		dirs.push(dir);
		const backend = new LocalBackend(dir);
		backends.push(backend);
		const fake = new FakeEmbeddingBackend();
		const definer: Chunk = makeChunk({
			id: "gw-charge",
			content: "return gateway.charge(order_id, amount);",
			chunkType: "function",
			filePath: "src/pay.py",
			startLine: 10,
			endLine: 12,
			language: "python",
			embedding: fake.vec("return gateway charge order amount"),
		});
		const prose: Chunk = makeChunk({
			id: "prose-note",
			content: "notes about payment flow and gateway behaviour in general",
			chunkType: "doc",
			filePath: "docs/payments.md",
			startLine: 1,
			endLine: 5,
			language: "markdown",
			embedding: fake.vec("notes payment flow gateway behaviour general"),
		});
		const hidden: Chunk = makeChunk({
			id: "config-x",
			content: "x = compute_value()\ny = normalize(x)",
			chunkType: "module",
			filePath: "src/config.py",
			startLine: 1,
			endLine: 2,
			language: "python",
			embedding: fake.vec("compute normalize value"),
		});
		backend.ingest(
			[definer, prose, hidden],
			[
				{ id: "gw-charge", nodeType: "function", name: "PaymentGateway.charge", filePath: "src/pay.py", properties: {} },
			],
			[],
		);
		return { backend, retriever: new HybridRetriever(backend, makeFakeEmbedder()) };
	}

	it("reaches the defining chunk via an exact symbol even when prose outranks it", async () => {
		const { backend, retriever } = setup();
		// The doc chunk shares 'gateway/payment' words; only the symbol path
		// knows that PaymentGateway.charge IS the definition.
		const results = await retriever.retrieve("PaymentGateway charge definition", {
			topK: 5,
			confidenceThreshold: 0,
		});
		expect(results[0]!.id).toBe("gw-charge");
		backend.close();
	});

	it("surfaces the file a query names outright", async () => {
		const { backend, retriever } = setup();
		const results = await retriever.retrieve("src/config.py compute normalize", {
			topK: 6,
			confidenceThreshold: 0,
		});
		expect(results.some((c) => c.filePath === "src/config.py")).toBe(true);
		backend.close();
	});

	it("stays empty on an empty index (no structured-path crashes)", async () => {
		const dir = makeTempDir("pce-empty2-");
		dirs.push(dir);
		const backend = new LocalBackend(dir);
		backends.push(backend);
		const retriever = new HybridRetriever(backend, makeFakeEmbedder());
		expect(await retriever.retrieve("PaymentGateway src/anything.py", { confidenceThreshold: 0 })).toEqual([]);
	});
});
