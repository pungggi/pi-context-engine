import { describe, expect, it } from "vitest";
import {
	BOOTSTRAP_CUSTOM_TYPE,
	bootstrapReinjectMessage,
	createBootstrapReinjector,
	hasPersistedBootstrap,
} from "../src/bootstrap-reinject.js";

const userMessage = { role: "user", content: "fix the retry logic" };
const assistantMessage = { role: "assistant", content: [{ type: "text", text: "on it" }] };
const persistedBootstrap = {
	role: "custom",
	customType: BOOTSTRAP_CUSTOM_TYPE,
	content: "# Project context: demo",
	display: false,
	timestamp: 1,
};
const otherCustom = { ...persistedBootstrap, customType: "something-else" };

describe("hasPersistedBootstrap", () => {
	it("is false for an empty conversation", () => {
		expect(hasPersistedBootstrap([])).toBe(false);
	});

	it("is false for plain user/assistant traffic", () => {
		expect(hasPersistedBootstrap([userMessage, assistantMessage])).toBe(false);
	});

	it("is false for custom messages of other types", () => {
		expect(hasPersistedBootstrap([userMessage, otherCustom])).toBe(false);
	});

	it("is true for the persisted bootstrap message", () => {
		expect(hasPersistedBootstrap([userMessage, persistedBootstrap])).toBe(true);
	});

	it("tolerates junk shapes (null, primitives) from the host", () => {
		expect(hasPersistedBootstrap([null, 42, "str", { role: "custom" }])).toBe(false);
	});
});

describe("bootstrapReinjectMessage", () => {
	it("carries the bootstrap type, hidden display and the content", () => {
		const msg = bootstrapReinjectMessage("# hello");
		expect(msg.role).toBe("custom");
		expect(msg.customType).toBe(BOOTSTRAP_CUSTOM_TYPE);
		expect(msg.display).toBe(false);
		expect(msg.content).toBe("# hello");
		expect(typeof msg.timestamp).toBe("number");
	});
});

describe("createBootstrapReinjector", () => {
	it("is a no-op while disarmed", async () => {
		const r = createBootstrapReinjector(async () => "x");
		expect(r.armed).toBe(false);
		expect(await r.handle("/p", [userMessage])).toBeUndefined();
	});

	it("appends the regenerated bootstrap while armed", async () => {
		const r = createBootstrapReinjector(async () => "fresh text");
		r.arm();
		const result = await r.handle("/p", [userMessage, assistantMessage]);
		expect(result).toBeDefined();
		expect(result!.messages).toHaveLength(3);
		expect(result!.messages[2]).toMatchObject({ customType: BOOTSTRAP_CUSTOM_TYPE, content: "fresh text" });
		// non-destructive: the input list is copied, not mutated
		expect([userMessage, assistantMessage]).toHaveLength(2);
	});

	it("disarms when a persisted bootstrap is already present", async () => {
		const r = createBootstrapReinjector(async () => "fresh text");
		r.arm();
		expect(await r.handle("/p", [userMessage, persistedBootstrap])).toBeUndefined();
		expect(r.armed).toBe(false);
		// and stays a no-op afterwards
		expect(await r.handle("/p", [userMessage])).toBeUndefined();
	});

	it("passes cwd through to the builder", async () => {
		let seen: string | null = null;
		const r = createBootstrapReinjector(async (cwd) => {
			seen = cwd;
			return "x";
		});
		r.arm();
		await r.handle("/some/project", [userMessage]);
		expect(seen).toBe("/some/project");
	});

	it("skips a request when the builder fails but stays armed", async () => {
		let fail = true;
		const r = createBootstrapReinjector(async () => {
			if (fail) throw new Error("db locked");
			return "recovered";
		});
		r.arm();
		// failed build: no output this request, armed window stays open
		expect(await r.handle("/p", [userMessage])).toBeUndefined();
		expect(r.armed).toBe(true);
		// transient failure passes: next request succeeds
		fail = false;
		const result = await r.handle("/p", [userMessage]);
		expect(result).toBeDefined();
		expect(result!.messages[1]).toMatchObject({ content: "recovered" });
	});

	it("reset drops a pending re-assertion", () => {
		const r = createBootstrapReinjector(async () => "x");
		r.arm();
		expect(r.armed).toBe(true);
		r.reset();
		expect(r.armed).toBe(false);
	});
});

describe("createBootstrapReinjector — onBuildFailure (once per armed window)", () => {
	it("notifies on the first failure per window, not on subsequent ones", async () => {
		const failures: unknown[] = [];
		let n = 0;
		const r = createBootstrapReinjector(
			async () => {
				throw new Error(`boom ${++n}`);
			},
			{ onBuildFailure: (err) => failures.push(err) },
		);
		r.arm();
		expect(await r.handle("/p", [userMessage])).toBeUndefined(); // failure 1 → notify
		expect(await r.handle("/p", [userMessage])).toBeUndefined(); // failure 2 → silent
		expect(await r.handle("/p", [userMessage])).toBeUndefined(); // failure 3 → silent
		expect(failures).toHaveLength(1);
		expect((failures[0] as Error).message).toBe("boom 1");
		expect(r.armed).toBe(true); // still retrying quietly
	});

	it("a successful build never notifies; a later failure in the same window does (once)", async () => {
		const failures: unknown[] = [];
		let fail = false;
		const r = createBootstrapReinjector(
			async () => {
				if (fail) throw new Error("late boom");
				return "ok";
			},
			{ onBuildFailure: (err) => failures.push(err) },
		);
		r.arm();
		const ok = await r.handle("/p", [userMessage]);
		expect(ok).toBeDefined(); // success, no notify
		fail = true;
		await r.handle("/p", [userMessage]);
		await r.handle("/p", [userMessage]);
		expect(failures).toHaveLength(1);
	});

	it("re-arming opens a fresh window (a persistent failure notifies again)", async () => {
		const failures: unknown[] = [];
		const r = createBootstrapReinjector(
			async () => {
				throw new Error("boom");
			},
			{ onBuildFailure: (err) => failures.push(err) },
		);
		r.arm();
		await r.handle("/p", [userMessage]); // window 1: notify
		r.reset();
		r.arm();
		await r.handle("/p", [userMessage]); // window 2: notify again
		expect(failures).toHaveLength(2);
	});

	it("a throwing onBuildFailure callback never breaks recovery", async () => {
		const r = createBootstrapReinjector(
			async () => {
				throw new Error("boom");
			},
			{
				onBuildFailure: () => {
					throw new Error("observer bug");
				},
			},
		);
		r.arm();
		expect(await r.handle("/p", [userMessage])).toBeUndefined();
		expect(r.armed).toBe(true); // recovery unaffected
	});
});
