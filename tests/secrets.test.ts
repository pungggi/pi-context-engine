import { describe, expect, it } from "vitest";
import { isSecretFile, redactPii, redactSecrets } from "../src/indexer/secrets.js";

describe("isSecretFile", () => {
	it("skips dotenv family including prefixed and suffixed variants", () => {
		expect(isSecretFile("/repo/.env")).toBe(true);
		expect(isSecretFile("/repo/.env.local")).toBe(true);
		expect(isSecretFile("/repo/prod.env")).toBe(true);
		expect(isSecretFile("/repo/config/credentials.json")).toBe(true);
	});

	it("skips key/cert extensions and bare SSH keys", () => {
		expect(isSecretFile("/repo/server.pem")).toBe(true);
		expect(isSecretFile("/repo/keystore.jks")).toBe(true);
		expect(isSecretFile("/home/u/.ssh/id_ed25519")).toBe(true);
	});

	it("does not skip ordinary source files", () => {
		expect(isSecretFile("/repo/src/payments.py")).toBe(false);
		expect(isSecretFile("/repo/README.md")).toBe(false);
		// `env.ts` is a config module, not a dotenv file.
		expect(isSecretFile("/repo/src/env.ts")).toBe(false);
	});
});

describe("redactSecrets", () => {
	it("redacts an AWS access key and reports the label", () => {
		const { text, labels } = redactSecrets("key = AKIAIOSFODNN7EXAMPLE");
		expect(text).toContain("[REDACTED:AWS_ACCESS_KEY]");
		expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
		expect(labels).toContain("AWS_ACCESS_KEY");
	});

	it("redacts a GitHub PAT and a Stripe live key", () => {
		const gh = redactSecrets(`token: ghp_${"a".repeat(36)}`);
		expect(gh.labels).toContain("GITHUB_PAT");
		const stripe = redactSecrets(`STRIPE_KEY=sk_live_${"b".repeat(24)}`);
		expect(stripe.labels).toContain("STRIPE_LIVE_KEY");
	});

	it("keeps surrounding syntax when a capture group holds the credential", () => {
		const { text } = redactSecrets(`password = "hunter2hunter2hunter2"`);
		expect(text).toContain("password = ");
		expect(text).toContain("[REDACTED:GENERIC_CREDENTIAL]");
		expect(text).not.toContain("hunter2hunter2hunter2");
	});

	it("leaves placeholder values alone", () => {
		const { text, labels } = redactSecrets(`api_key = "your-api-key-here"`);
		expect(labels).toHaveLength(0);
		expect(text).toContain("your-api-key-here");
	});

	it("does not match Stripe test keys (safe to commit)", () => {
		const { labels } = redactSecrets(`sk_test_${"c".repeat(24)}`);
		expect(labels).not.toContain("STRIPE_LIVE_KEY");
	});

	it("returns the input untouched when nothing matches", () => {
		const input = "def charge_card(order_id, amount):\n    return amount";
		expect(redactSecrets(input)).toEqual({ text: input, labels: [] });
	});
});

describe("redactPii", () => {
	it("redacts emails and SSNs", () => {
		const { text, labels } = redactPii("contact alice@example.com or 123-45-6789");
		expect(text).not.toContain("alice@example.com");
		expect(text).toContain("[REDACTED:EMAIL]");
		expect(labels).toContain("SSN");
	});

	it("only redacts Luhn-valid card numbers", () => {
		const valid = redactPii("card 4242424242424242");
		expect(valid.labels).toContain("CREDIT_CARD");
		const invalid = redactPii("order 1234567890123456");
		expect(invalid.labels).not.toContain("CREDIT_CARD");
	});

	it("keeps localhost addresses out of IP redaction", () => {
		const { labels } = redactPii("server listening on 127.0.0.1:8080");
		expect(labels).not.toContain("IPV4");
	});
});
