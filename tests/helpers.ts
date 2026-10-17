/**
 * Test helpers: deterministic fake embedder so tests never touch Ollama or
 * download a model. Vectors are normalized token hashes, so cosine similarity
 * tracks real token overlap — retrieval behaviour is meaningful.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Embedder, type EmbeddingBackend } from "../src/indexer/embedder.js";

const DIM = 64;

function tokenize(text: string): string[] {
	return text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

function hashToken(token: string): number {
	let h = 2166136261;
	for (let i = 0; i < token.length; i++) {
		h ^= token.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return Math.abs(h) % DIM;
}

export class FakeEmbeddingBackend implements EmbeddingBackend {
	readonly name = "fake";
	readonly modelName = "fake-embed";
	dimension = DIM;

	async init(): Promise<void> {
		this.dimension = DIM;
	}

	vec(text: string): number[] {
		const v = new Array<number>(DIM).fill(0);
		for (const token of tokenize(text)) v[hashToken(token)]! += 1;
		const norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0)) || 1;
		return v.map((x) => x / norm);
	}

	async embedTexts(texts: string[]): Promise<number[][]> {
		return texts.map((t) => this.vec(t));
	}

	async embedQuery(query: string): Promise<number[]> {
		return this.vec(query);
	}
}

export function makeFakeEmbedder(): Embedder {
	return new Embedder(new FakeEmbeddingBackend());
}

export function makeTempDir(prefix = "pce-test-"): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeFiles(root: string, files: Record<string, string>): void {
	for (const [rel, content] of Object.entries(files)) {
		const full = path.join(root, rel);
		fs.mkdirSync(path.dirname(full), { recursive: true });
		fs.writeFileSync(full, content, "utf-8");
	}
}

export function rmrf(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

export const SAMPLE_REPO: Record<string, string> = {
	"src/payments.py": `"""Payment processing."""

def charge_card(order_id, amount):
    """Charge a card for an order."""
    validate_amount(amount)
    return gateway.charge(order_id, amount)


def refund_payment(payment_id):
    """Refund a payment."""
    return gateway.refund(payment_id)
`,
	"src/auth.py": `"""Authentication helpers."""

import jwt


def verify_token(token):
    """Validate a JWT token and return the claims."""
    return jwt.decode(token, options={"verify_signature": True})


class SessionStore:
    """In-memory session store."""

    def get(self, key):
        return self._data.get(key)
`,
	"src/orders.js": `export function createOrder(items) {
  return { items, total: items.reduce((a, i) => a + i.price, 0) };
}

export function cancelOrder(orderId) {
  return fetch(\`/orders/\${orderId}/cancel\`, { method: "POST" });
}
`,
	"docs/readme.md": `# Docs\n\nThis document explains the payment flow.\n`,
};
