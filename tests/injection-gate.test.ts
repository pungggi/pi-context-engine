import { describe, expect, it } from "vitest";
import { contentDigest, createDigestGate } from "../src/injection-gate.js";

describe("contentDigest", () => {
	it("is stable for identical text and differs for different text", () => {
		expect(contentDigest("same text")).toBe(contentDigest("same text"));
		expect(contentDigest("same text")).not.toBe(contentDigest("same text "));
		expect(contentDigest("")).toMatch(/^[0-9a-f]{16}$/);
	});

	it("handles multibyte content without throwing", () => {
		expect(contentDigest("🔐 causé")).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe("createDigestGate", () => {
	it("delivers the first copy, then suppresses identical re-injection", () => {
		const gate = createDigestGate();
		expect(gate.changed("bootstrap", "v1")).toBe(true); // initial delivery
		expect(gate.changed("bootstrap", "v1")).toBe(false); // unchanged → gate it
		expect(gate.changed("bootstrap", "v1")).toBe(false); // and still
		expect(gate.changed("bootstrap", "v2")).toBe(true); // content changed → re-inject
	});

	it("keys are independent: one block changing does not re-arm another", () => {
		const gate = createDigestGate();
		expect(gate.changed("bootstrap", "v1")).toBe(true);
		expect(gate.changed("footer", "f1")).toBe(true);
		expect(gate.changed("bootstrap", "v1")).toBe(false);
		expect(gate.changed("footer", "f2")).toBe(true);
		expect(gate.changed("bootstrap", "v1")).toBe(false);
	});

	it("peek reports the last delivered digest without arming anything", () => {
		const gate = createDigestGate();
		expect(gate.peek("note")).toBeNull();
		gate.changed("note", "hello");
		expect(gate.peek("note")).toBe(contentDigest("hello"));
		expect(gate.peek("other")).toBeNull();
	});

	it("reset re-arms a single key or all keys", () => {
		const gate = createDigestGate();
		gate.changed("a", "v1");
		gate.changed("b", "v1");
		gate.reset("a");
		expect(gate.changed("a", "v1")).toBe(true); // re-armed
		expect(gate.changed("b", "v1")).toBe(false); // untouched
		gate.reset();
		expect(gate.changed("b", "v1")).toBe(true); // all cleared
	});
});
