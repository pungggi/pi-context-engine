// Wiring smoke test for the compaction-recovery lifecycle (review follow-up):
// the extension's session_compact → arm, context → per-request re-assert,
// and the two reset paths (session_start, and before_agent_start's persisted
// injection — the deterministic disarm) driven through a fake ExtensionAPI.
//
// The engine is REAL but sandboxed: a temp project dir whose
// .context-engine.yaml disables auto-indexing and the file watcher and points
// storage inside the temp dir, so nothing indexes, embeds, or touches the
// user's home. bootstrapText on an empty store is pure file/sqlite reads.
//
// This is deliberately a registration/lifecycle smoke test — the selection
// and reinjector logic itself is unit-tested in bootstrap-reinject.test.ts.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import contextEngineExtension from "../src/extension.js";
import { BOOTSTRAP_CUSTOM_TYPE } from "../src/bootstrap-reinject.js";

/** Minimal handler shape (the extension's handlers take (event, ctx)). */
type Handler = (event: unknown, ctx: unknown) => unknown;

interface FakePi {
	handlers: Map<string, Handler[]>;
	tools: unknown[];
	commands: string[];
}

/** Records pi.on registrations / tool + command defs; never invokes them. */
function makeFakePi(): FakePi {
	const pi: FakePi = {
		handlers: new Map(),
		tools: [],
		commands: [],
	};
	const fake = pi as unknown as {
		on: (event: string, handler: Handler) => () => void;
		registerTool: (def: unknown) => void;
		registerCommand: (name: string, def: unknown) => void;
	};
	fake.on = (event, handler) => {
		const list = pi.handlers.get(event) ?? [];
		list.push(handler);
		pi.handlers.set(event, list);
		return () => undefined; // pi.on returns an unsubscribe
	};
	fake.registerTool = (def) => pi.tools.push(def);
	fake.registerCommand = (name) => pi.commands.push(name);
	return pi;
}

/** Emit an event to the (single) registered handler and return its result. */
async function emit(pi: FakePi, event: string, ev: unknown, ctx: unknown): Promise<unknown> {
	const handler = pi.handlers.get(event)?.[0];
	return handler ? await handler(ev, ctx) : undefined;
}

/** Temp project dir with a sandboxing .context-engine.yaml (no indexing, no
 *  watcher, storage inside the temp dir — never the user's home). */
function sandboxProject(): string {
	const dir = mkdtempSync(join(tmpdir(), "pce-wiring-"));
	const yamlPath = join(dir, "storage").replaceAll("\\", "/");
	writeFileSync(
		join(dir, ".context-engine.yaml"),
		["indexer:", "  auto_index: false", "  watch: false", "storage:", `  path: ${yamlPath}`, ""].join(
			"\n",
		),
		"utf8",
	);
	return dir;
}

/** Live fake-pi/dir pairs, so afterEach can shut engines down and clean up. */
const live: Array<{ pi: FakePi; dir: string }> = [];

/** Windows: sqlite handles can lag release by a few ms after shutdown, which
 *  makes rmSync hit EPERM. Retry briefly, then give up silently — the dir is
 *  in the OS temp root, so a rare leftover is harmless in a test. */
function removeTempDir(dir: string): void {
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			rmSync(dir, { recursive: true, force: true });
			return;
		} catch {
			Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
		}
	}
}

afterEach(async () => {
	for (const { pi, dir } of live.splice(0)) {
		await emit(pi, "session_shutdown", {}, {});
		removeTempDir(dir);
	}
});

const sessionCtx = (dir: string) => ({
	cwd: dir,
	hasUI: false,
	ui: { notify: () => undefined },
});

const userPrompt = (text: string) => ({
	messageType: "user",
	prompt: text,
	systemPromptOptions: { selectedTools: [], sections: {} },
});

const plainMessages = () => [{ role: "user", content: "continue" }];

function boot(dir: string): FakePi {
	const pi = makeFakePi();
	live.push({ pi, dir });
	contextEngineExtension(pi as unknown as ExtensionAPI);
	return pi;
}

describe("extension wiring — compaction recovery lifecycle", () => {
	it("registers the lifecycle hooks (tools/commands recorded, handlers wired)", () => {
		const pi = boot(sandboxProject());
		expect(pi.tools.length).toBeGreaterThan(0);
		expect(pi.commands.length).toBeGreaterThan(0);
		for (const hook of [
			"session_start",
			"before_agent_start",
			"session_compact",
			"context",
			"session_shutdown",
		]) {
			expect(pi.handlers.has(hook), `pi.on("${hook}") registered`).toBe(true);
		}
	});

	it("session_compact arms the context re-assertion; session_start resets it", async () => {
		const dir = sandboxProject();
		const pi = boot(dir);
		await emit(pi, "session_start", {}, sessionCtx(dir));

		// Before any compaction the context handler is an O(1) no-op.
		expect(await emit(pi, "context", { messages: plainMessages() }, { cwd: dir })).toBeUndefined();

		// Compaction dropped the persisted bootstrap → the next request gets a
		// regenerated per-request copy appended.
		await emit(pi, "session_compact", {}, {});
		const armed = (await emit(pi, "context", { messages: plainMessages() }, { cwd: dir })) as {
			messages: Array<Record<string, unknown>>;
		};
		expect(armed).toBeDefined();
		expect(armed.messages).toHaveLength(2);
		expect(armed.messages[1]).toMatchObject({
			role: "custom",
			customType: BOOTSTRAP_CUSTOM_TYPE,
			display: false,
		});
		expect(typeof armed.messages[1]?.["content"]).toBe("string");

		// A fresh session (session_start) closes the armed window. Shut the
		// current engine down first so exactly one engine exists at a time
		// (each session_start constructs a new one; the old one must release
		// its sqlite handles or Windows cleanup below hits EPERM).
		await emit(pi, "session_shutdown", {}, {});
		await emit(pi, "session_start", {}, sessionCtx(dir));
		expect(await emit(pi, "context", { messages: plainMessages() }, { cwd: dir })).toBeUndefined();
	});

	it("mid-run window: per-request copies flow until the next user prompt lands the persisted copy (deterministic disarm)", async () => {
		const dir = sandboxProject();
		const pi = boot(dir);
		await emit(pi, "session_start", {}, sessionCtx(dir));

		// First user prompt: before_agent_start injects the persisted copy.
		const injected = (await emit(pi, "before_agent_start", userPrompt("first"), {
			cwd: dir,
		})) as { message: Record<string, unknown> };
		expect(injected).toMatchObject({
			message: { customType: BOOTSTRAP_CUSTOM_TYPE, display: false },
		});

		// Mid-run compaction (threshold/overflow recovery): armed, and requests
		// before the next user prompt — which cannot see any persisted copy —
		// keep getting the re-asserted block.
		await emit(pi, "session_compact", {}, {});
		const r1 = await emit(pi, "context", { messages: plainMessages() }, { cwd: dir });
		expect(r1).toBeDefined();
		const r2 = await emit(pi, "context", { messages: plainMessages() }, { cwd: dir });
		expect(r2).toBeDefined();

		// Next user prompt: the persisted copy is re-injected AND the reinjector
		// is disarmed deterministically (not via observing the copy later).
		const reinjected = (await emit(pi, "before_agent_start", userPrompt("second"), {
			cwd: dir,
		})) as { message: Record<string, unknown> };
		expect(reinjected).toMatchObject({ message: { customType: BOOTSTRAP_CUSTOM_TYPE } });

		// So the very next request — still with no persisted copy visible —
		// must be a no-op. Without the deterministic reset this would append.
		expect(await emit(pi, "context", { messages: plainMessages() }, { cwd: dir })).toBeUndefined();
	});
});
