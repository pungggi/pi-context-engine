import { afterEach, describe, expect, it } from "vitest";
import { QueryParser } from "../src/retrieval/query-parser.js";
import { ConfidenceScorer } from "../src/retrieval/confidence.js";
import { HybridRetriever } from "../src/retrieval/retriever.js";
import { LocalBackend } from "../src/storage/local-backend.js";
import { makeChunk, type Chunk } from "../src/types.js";
import { FakeEmbeddingBackend, makeFakeEmbedder, makeTempDir, rmrf } from "./helpers.js";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmrf(d);
});

describe("QueryParser", () => {
	const parser = new QueryParser();

	it("classifies intents by pattern", () => {
		expect(parser.parse("what did we decide about auth").intent).toBe("decision_recall");
		expect(parser.parse("how does the payment system work").intent).toBe("architecture");
		expect(parser.parse("find the chargeCard function").intent).toBe("code_lookup");
		expect(parser.parse("hello there").intent).toBe("general");
	});

	it("keeps code-prefix verbs for code lookups but strips them in prose", () => {
		expect(parser.parse("find getUserById function").keywords).toContain("find");
		expect(parser.parse("tell me about getUserById").keywords).not.toContain("tell");
	});

	it("extracts file hints", () => {
		expect(parser.parse("what does src/payments.py do").fileHints).toContain("src/payments.py");
	});

	it("keeps CamelCase identifiers ahead of plain words", () => {
		const keywords = parser.parse("where is PaymentGateway defined").keywords;
		expect(keywords[0]).toBe("PaymentGateway");
	});
});

describe("ConfidenceScorer", () => {
	const scorer = new ConfidenceScorer();
	const chunk = (metadata: Record<string, unknown> = {}): Chunk => ({
		...makeChunk({
			id: "x",
			content: "content",
			chunkType: "function",
			filePath: "a.py",
			startLine: 1,
			endLine: 2,
			language: "python",
		}),
		metadata,
	});

	it("rewards exact vector matches and keyword hits", () => {
		const good = scorer.score(chunk(), 0, 0);
		const bad = scorer.score(chunk(), 1.5, 5);
		expect(good).toBeGreaterThan(bad);
		expect(good).toBeLessThanOrEqual(1);
		expect(bad).toBeGreaterThanOrEqual(0);
	});

	it("decays recency with a one-week half-life", () => {
		const now = Date.now() / 1000;
		const fresh = scorer.score(chunk({ modified_ts: now }), 0.5, 2);
		const week = scorer.score(chunk({ modified_ts: now - 7 * 86400 }), 0.5, 2);
		const stale = scorer.score(chunk({ modified_ts: now - 60 * 86400 }), 0.5, 2);
		expect(fresh).toBeGreaterThan(week);
		expect(week).toBeGreaterThan(stale);
	});
});

describe("HybridRetriever", () => {
	function setup() {
		const dir = makeTempDir("pce-retr-");
		dirs.push(dir);
		const backend = new LocalBackend(dir);
		const fake = new FakeEmbeddingBackend();
		const chunks: Chunk[] = [
			makeChunk({
				id: "pay1",
				content: "def charge_card(order_id, amount): return gateway.charge(order_id, amount)",
				chunkType: "function",
				filePath: "src/payments.py",
				startLine: 10,
				endLine: 12,
				language: "python",
				embedding: fake.vec("charge card order amount gateway"),
			}),
			makeChunk({
				id: "pay2",
				content: "def refund_payment(payment_id): return gateway.refund(payment_id)",
				chunkType: "function",
				filePath: "src/payments.py",
				startLine: 20,
				endLine: 22,
				language: "python",
				embedding: fake.vec("refund payment gateway"),
			}),
			makeChunk({
				id: "auth1",
				content: "def verify_token(token): return jwt.decode(token)",
				chunkType: "function",
				filePath: "src/auth.py",
				startLine: 5,
				endLine: 8,
				language: "python",
				embedding: fake.vec("verify token jwt decode"),
			}),
			makeChunk({
				id: "test1",
				content: "def test_charge_card(): assert charge_card(1, 2)",
				chunkType: "function",
				filePath: "tests/test_payments.py",
				startLine: 1,
				endLine: 3,
				language: "python",
				embedding: fake.vec("test charge card"),
			}),
		];
		backend.ingest(chunks, [], []);
		return { backend, retriever: new HybridRetriever(backend, makeFakeEmbedder()) };
	}

	it("ranks the semantically matching chunk first", async () => {
		const { backend, retriever } = setup();
		const results = await retriever.retrieve("charge card gateway", { topK: 3 });
		expect(results.length).toBeGreaterThan(0);
		expect(results[0]!.id).toBe("pay1");
		backend.close();
	});

	it("deprioritises test files so implementation wins ties", async () => {
		const { backend, retriever } = setup();
		const results = await retriever.retrieve("charge card", { topK: 4, confidenceThreshold: 0 });
		const payIndex = results.findIndex((c) => c.id === "pay1");
		const testIndex = results.findIndex((c) => c.id === "test1");
		if (payIndex !== -1 && testIndex !== -1) expect(payIndex).toBeLessThan(testIndex);
		backend.close();
	});

	it("caps chunks per file so one file cannot dominate", async () => {
		const { backend, retriever } = setup();
		const results = await retriever.retrieve("gateway payment", { topK: 10, confidenceThreshold: 0 });
		const perFile = new Map<string, number>();
		for (const c of results) perFile.set(c.filePath, (perFile.get(c.filePath) ?? 0) + 1);
		for (const count of perFile.values()) expect(count).toBeLessThanOrEqual(3);
		backend.close();
	});

	it("never returns an empty list for a matching query even with a tight threshold", async () => {
		const { backend, retriever } = setup();
		const results = await retriever.retrieve("charge card", { topK: 5, confidenceThreshold: 0.99 });
		expect(results.length).toBeGreaterThanOrEqual(1);
		backend.close();
	});

	it("respects a maxTokens budget and reports selection stats", async () => {
		const { backend, retriever } = setup();
		const stats: { candidates?: number; selected?: number; droppedLowValue?: number } = {};
		const results = await retriever.retrieve("charge card refund verify token", {
			topK: 4,
			confidenceThreshold: 0,
			maxTokens: 40,
			statsOut: stats,
		});
		expect(results.length).toBeLessThan(4);
		expect(stats.selected).toBe(results.length);
		backend.close();
	});

	it("returns nothing when the index is empty", async () => {
		const dir = makeTempDir("pce-empty-");
		dirs.push(dir);
		const backend = new LocalBackend(dir);
		const retriever = new HybridRetriever(backend, makeFakeEmbedder());
		expect(await retriever.retrieve("anything")).toEqual([]);
		backend.close();
	});
});
