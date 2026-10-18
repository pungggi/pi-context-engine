import { beforeAll, describe, expect, it } from "vitest";
import { Chunker, isAstLanguage, warmupLanguages } from "../src/indexer/chunker.js";

const PY = `"""Payments module."""

import requests
from decimal import Decimal


def charge_card(order_id, amount):
    """Charge a card."""
    validate_amount(amount)
    return gateway.charge(order_id, amount)


class PaymentGateway:
    """Gateway wrapper."""

    def __init__(self, api_key):
        self.api_key = api_key

    def refund(self, payment_id):
        return requests.post("/refund", json={"id": payment_id})
`;

const JS = `import { fetchJson } from "./http.js";

export function createOrder(items) {
  return { items };
}

export class OrderService {
  cancel(orderId) {
    return fetchJson(\`/orders/\${orderId}/cancel\`);
  }
}
`;

describe("Chunker", () => {
	beforeAll(async () => {
		await warmupLanguages(["python", "javascript", "typescript"]);
	});

	it("recognizes the languages it has WASM grammars for", () => {
		expect(isAstLanguage("python")).toBe(true);
		expect(isAstLanguage("typescript")).toBe(true);
		expect(isAstLanguage("csharp")).toBe(true);
		expect(isAstLanguage("markdown")).toBe(false);
		expect(isAstLanguage("haskell")).toBe(false);
	});

	it("splits Python into function and class chunks", () => {
		const chunks = new Chunker().chunk(PY, "payments.py", "python");
		const types = chunks.map((c) => c.chunkType);
		expect(types).toContain("function");
		expect(types).toContain("class");

		const charge = chunks.find((c) => c.content.includes("charge_card"));
		expect(charge).toBeDefined();
		expect(charge!.content).toContain("validate_amount");
		// 1-based line numbers pointing into the original source.
		expect(charge!.startLine).toBeGreaterThan(1);
		expect(charge!.endLine).toBeGreaterThanOrEqual(charge!.startLine);
	});

	it("produces deterministic ids for identical input", () => {
		const a = new Chunker().chunk(PY, "payments.py", "python");
		const b = new Chunker().chunk(PY, "payments.py", "python");
		expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
	});

	it("splits JavaScript functions and classes", () => {
		const chunks = new Chunker().chunk(JS, "orders.js", "javascript");
		expect(chunks.some((c) => c.content.includes("createOrder"))).toBe(true);
		expect(chunks.some((c) => c.chunkType === "class")).toBe(true);
	});

	it("extracts import module names, deduped and normalized", () => {
		const { imports } = new Chunker().chunkWithImports(PY, "payments.py", "python");
		expect(imports).toContain("requests");
		expect(imports).toContain("decimal");

		// Relative specifiers resolve to a real segment, not "."
		const js = new Chunker().chunkWithImports(JS, "orders.js", "javascript");
		expect(js.imports).toContain("http.js");
	});

	it("handles scoped npm imports as two segments", () => {
		const source = `import { x } from "@scope/pkg/sub";\nexport function useX() { return x; }\n`;
		const { imports } = new Chunker().chunkWithImports(source, "a.js", "javascript");
		expect(imports).toContain("@scope/pkg");
	});

	it("returns nothing for a language without a grammar (caller falls back)", () => {
		expect(new Chunker().chunk("x = 1", "a.rb", "ruby")).toEqual([]);
	});

	it("keeps distinct chunks for two same-line spans (no id collision)", () => {
		// Two one-line arrows sharing a line range: hashing on lines alone made
		// these collide, so the second silently overwrote the first in the index.
		const source = ["const a = () => 1;", "const b = () => 2;", "export const pair = [a, b];"].join("\n");
		const chunks = new Chunker().chunk(source, "pair.ts", "typescript");
		const ids = chunks.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("never emits duplicate ids even when the parser reports a span twice", () => {
		const chunks = new Chunker().chunk(JS, "orders.js", "javascript");
		const ids = chunks.map((c) => c.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("chunks generator functions (generator_function_declaration)", () => {
		// Bug found by the R4 eval: `function*` produced NO chunk at all, so
		// the definition was invisible to every retrieval path.
		const source = [
			"export function* batchedParams<T>(items: readonly T[], size = 500): Generator<T[]> {",
			"  for (let i = 0; i < items.length; i += size) {",
			"    yield items.slice(i, i + size);",
			"  }",
			"}",
			"",
			"export function plain(): number {",
			"  return 1;",
			"}",
		].join("\n");
		const chunks = new Chunker().chunk(source, "gen.ts", "typescript");
		const generator = chunks.find((c) => c.content.includes("batchedParams"));
		expect(generator).toBeDefined();
		expect(generator!.metadata["unit"]).toBe("batchedParams");
		expect(chunks.find((c) => c.content.includes("plain"))).toBeDefined();
	});

	it("chunks generator methods inside classes", () => {
		const source = [
			"class Stream {",
			"  *lines() {",
			"    yield 1;",
			"  }",
			"}",
		].join("\n");
		const chunks = new Chunker().chunk(source, "gen-method.ts", "typescript");
		expect(chunks.some((c) => c.content.includes("*lines"))).toBe(true);
	});
});
