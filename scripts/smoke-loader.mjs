/**
 * Load the extension through pi's real loader (jiti), register everything, and
 * then actually invoke a tool end-to-end against a fixture repo. This is the
 * smoke test that catches ESM/CJS interop and runtime-import problems that
 * tsx/vitest can mask.
 *
 *   node scripts/smoke-loader.mjs
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

// ── Load the extension exactly the way pi does ─────────────────────────────
// `exports` restrictions block `require.resolve("jiti")` through pi's entry
// point, so locate jiti by walking up from candidate paths instead: this works
// whether jiti is hoisted into the project or nested under pi's own
// node_modules, and on any OS.
function findJiti(startDir) {
	let dir = startDir;
	for (;;) {
		const candidate = path.join(dir, "node_modules", "jiti");
		if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function resolveJitiModule() {
	const candidates = [root];
	try {
		candidates.push(path.dirname(require.resolve("@earendil-works/pi-coding-agent")));
	} catch {
		// global npm install — fall through to the layout fallback below
	}
	if (process.env.APPDATA) {
		candidates.push(path.join(process.env.APPDATA, "npm", "node_modules", "@earendil-works", "pi-coding-agent"));
	}
	for (const start of candidates) {
		const found = findJiti(start);
		// Resolve the package by name *from inside* the directory containing it:
		// `require(<dir>)` ignores the exports map, which jiti relies on.
		if (found) return createRequire(path.join(found, "noop.js"))("jiti");
	}
	throw new Error("jiti not found — install pi or the pi-context-engine dev dependencies first");
}

const { createJiti } = resolveJitiModule();
const jiti = createJiti(path.join(root, "src", "extension.ts"), { interopDefault: true });

const mod = await jiti.import(path.join(root, "src", "extension.ts"));
const factory = mod.default ?? mod;
if (typeof factory !== "function") throw new Error(`default export is not a function (${typeof factory})`);

const tools = new Map();
const commands = [];
const events = new Set();
const handlers = new Map();
const fakePi = {
	registerTool: (tool) => tools.set(tool.name, tool),
	registerCommand: (name) => commands.push(name),
	on: (event, handler) => {
		events.add(event);
		handlers.set(event, handler);
	},
};
factory(fakePi);

const problems = [];
for (const tool of tools.values()) {
	for (const field of ["name", "label", "description", "parameters"]) {
		if (!tool[field]) problems.push(`${tool.name} missing ${field}`);
	}
	if (typeof tool.execute !== "function") problems.push(`${tool.name} missing execute`);
}
if (tools.size !== 10) problems.push(`expected 10 tools, got ${tools.size}`);
for (const required of ["session_start", "before_agent_start", "tool_result", "session_shutdown"]) {
	if (!events.has(required)) problems.push(`missing event handler: ${required}`);
}

// ── Exercise the tools against a fixture project ───────────────────────────
if (problems.length === 0) {
	const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pce-fixture-"));
	const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pce-loader-store-"));
	fs.mkdirSync(path.join(fixture, "src"), { recursive: true });
	fs.writeFileSync(
		path.join(fixture, "src", "auth.py"),
		'"""Auth helpers."""\n\nimport jwt\n\n\ndef verify_token(token):\n    """Decode a JWT and return claims."""\n    return jwt.decode(token)\n',
		"utf-8",
	);
	fs.writeFileSync(
		path.join(fixture, "src", "payments.py"),
		'"""Payments."""\n\n\ndef charge_card(order_id, amount):\n    """Charge a card for an order."""\n    return gateway.charge(order_id, amount)\n',
		"utf-8",
	);
	// Point storage at a temp dir so the smoke run never touches real config.
	fs.writeFileSync(path.join(fixture, ".context-engine.yaml"), `storage:\n  path: ${storageRoot.replace(/\\/g, "/")}\n`, "utf-8");

	const ctx = { cwd: fixture, ui: { notify: () => undefined }, mode: "cli", hasUI: false };
	const textOf = (result) => result.content.map((c) => c.text).join("\n");
	/** Second-fixture artifacts for the cold-start check, cleaned in finally. */
	const extraCleanup = [];

	try {
		const reindex = await tools.get("reindex").execute("t1", {}, undefined, undefined, ctx);
		if (!textOf(reindex).includes("Re-index complete")) problems.push(`reindex: ${textOf(reindex)}`);

		const status = await tools.get("index_status").execute("t1", {}, undefined, undefined, ctx);
		if (!/Index: \d[\d,]* chunk/.test(textOf(status))) problems.push(`index_status: ${textOf(status)}`);

		const search = await tools.get("context_search").execute(
			"t2",
			{ query: "verify jwt token claims" },
			undefined,
			undefined,
			ctx,
		);
		const searchBody = textOf(search);
		if (!searchBody.includes("auth.py")) problems.push(`context_search missed auth.py:\n${searchBody}`);

		const decision = await tools.get("record_decision").execute(
			"t3",
			{ decision: "Use JWT for auth", reason: "stateless sessions" },
			undefined,
			undefined,
			ctx,
		);
		if (!textOf(decision).includes("Decision recorded")) problems.push(`record_decision: ${textOf(decision)}`);

		const recall = await tools.get("session_recall").execute("t4", { topic: "jwt auth" }, undefined, undefined, ctx);
		if (!textOf(recall).includes("JWT")) problems.push(`session_recall missed the decision:\n${textOf(recall)}`);

		// Guidance wiring: fire before_agent_start like pi does and verify the
		// package's guidance section lands (tool active + config default on).
		const beforeAgent = handlers.get("before_agent_start");
		if (!beforeAgent) {
			problems.push("before_agent_start handler missing");
		} else {
			const promptOptions = { selectedTools: ["context_search", "read"], sections: {}, appendSystemPrompt: "" };
			await beforeAgent(
				{ type: "before_agent_start", messageType: "user", prompt: "hi", systemPrompt: "", systemPromptOptions: promptOptions },
				ctx,
			);
			const section = promptOptions.sections["context_search_guidelines"];
			if (!section) problems.push("guidance section not injected while context_search selected");
			else if (!section.includes("/context-index")) problems.push("guidance section missing index lifecycle text");
		}

		// ── Cold-start visibility (follow-up to #11) ─────────────────────────
		// session_start on a FRESH project (empty index) must announce the
		// background build and close the loop with a result line — the one
		// background run that can take minutes used to stay invisible until
		// completion. Runs AFTER the tool tests behind an explicit shutdown, so
		// the project switch goes through the normal lifecycle (the previous
		// engine's sqlite handles close before the cleanup below).
		await handlers.get("session_shutdown")?.({}, {});

		const fixture2 = fs.mkdtempSync(path.join(os.tmpdir(), "pce-fixture-cold-"));
		const storage2 = fs.mkdtempSync(path.join(os.tmpdir(), "pce-loader-cold-"));
		extraCleanup.push(fixture2, storage2);
		fs.mkdirSync(path.join(fixture2, "src"), { recursive: true });
		fs.writeFileSync(
			path.join(fixture2, "src", "app.ts"),
			"export function greet(name: string): string {\n  return `hi ${name}`;\n}\n",
			"utf-8",
		);
		fs.writeFileSync(
			path.join(fixture2, ".context-engine.yaml"),
			`storage:\n  path: ${storage2.replace(/\\/g, "/")}\n`,
			"utf-8",
		);

		const notes = [];
		const coldCtx = {
			cwd: fixture2,
			ui: { notify: (msg, level) => notes.push(`${level}: ${msg}`) },
			mode: "cli",
			hasUI: true,
		};
		await handlers.get("session_start")?.({}, coldCtx);

		// The kick fires AUTO_INDEX_DELAY_MS (2 s) after session start; poll
		// until both lines land (model download on a cold CI cache included).
		const announced = () => notes.some((m) => m.includes("building the first index"));
		const closed = () => notes.some((m) => m.includes("Context index updated:") || m.includes("no files to index"));
		const deadline = Date.now() + 120_000;
		while (Date.now() < deadline && !(announced() && closed())) {
			await new Promise((r) => setTimeout(r, 250));
		}
		if (!announced()) problems.push(`cold-start: missing start notification — got ${JSON.stringify(notes)}`);
		else if (!closed()) problems.push(`cold-start: missing result notification — got ${JSON.stringify(notes)}`);
		else console.log(`cold-start: start + result notifications verified (${notes.length} total): ${notes.join(" | ")}`);

		// ── Automatic workspace size guard ─────────────────────────────
		// A full-project background run must refuse a workspace above the
		// configured budget, warn clearly, and make lazy search explain the
		// pause instead of immediately retrying the same expensive walk.
		await handlers.get("session_shutdown")?.({}, {});
		const fixture3 = fs.mkdtempSync(path.join(os.tmpdir(), "pce-fixture-limit-"));
		const storage3 = fs.mkdtempSync(path.join(os.tmpdir(), "pce-loader-limit-"));
		extraCleanup.push(fixture3, storage3);
		fs.mkdirSync(path.join(fixture3, "src"), { recursive: true });
		fs.writeFileSync(path.join(fixture3, "src", "a.txt"), "alpha\n", "utf-8");
		fs.writeFileSync(path.join(fixture3, "src", "b.txt"), "beta\n", "utf-8");
		fs.writeFileSync(
			path.join(fixture3, ".context-engine.yaml"),
			`storage:\n  path: ${storage3.replace(/\\/g, "/")}\nindexer:\n  max_auto_files: 1\n`,
			"utf-8",
		);
		const limitNotes = [];
		const limitCtx = {
			cwd: fixture3,
			ui: { notify: (msg, level) => limitNotes.push(`${level}: ${msg}`) },
			mode: "cli",
			hasUI: true,
		};
		await handlers.get("session_start")?.({}, limitCtx);
		const paused = () => limitNotes.some((m) => m.includes("automatic indexing and watcher paused"));
		const limitDeadline = Date.now() + 10_000;
		while (Date.now() < limitDeadline && !paused()) {
			await new Promise((r) => setTimeout(r, 100));
		}
		if (!paused()) problems.push(`auto file limit: missing pause warning — got ${JSON.stringify(limitNotes)}`);
		else {
			const limitedSearch = await tools.get("context_search").execute(
				"t-limit",
				{ query: "alpha" },
				undefined,
				undefined,
				limitCtx,
			);
			if (!textOf(limitedSearch).includes("Automatic indexing is paused")) {
				problems.push(`auto file limit: lazy search retried or hid the pause: ${textOf(limitedSearch)}`);
			} else console.log("auto file limit: pause warning + lazy-search explanation verified");

			// A manual build (the reindex tool bypasses the budget) leaves the
			// pause active over a NON-empty index: every served result must then
			// carry the stale-note, and index_status must lead with the pause —
			// otherwise "why is my index not updating?" stays unanswered.
			const manual = await tools.get("reindex").execute("t-limit-manual", {}, undefined, undefined, limitCtx);
			if (!textOf(manual).includes("Re-index complete")) {
				problems.push(`auto file limit: manual reindex failed: ${textOf(manual)}`);
			}
			const staleSearch = await tools
				.get("context_search")
				.execute("t-limit-stale", { query: "alpha" }, undefined, undefined, limitCtx);
			if (
				!textOf(staleSearch).includes("automatic indexing is paused") ||
				!textOf(staleSearch).includes("may be stale")
			) {
				problems.push(`auto file limit: stale index served without the pause note: ${textOf(staleSearch)}`);
			}
			const statusBody = textOf(
				await tools.get("index_status").execute("t-limit-status", {}, undefined, undefined, limitCtx),
			);
			if (!statusBody.startsWith("Automatic indexing paused:")) {
				problems.push(`auto file limit: index_status hides the pause: ${statusBody}`);
			} else console.log("auto file limit: stale-note on results + pause line in index_status verified");
		}

		// The watcher has its own reindex call. Keep auto_index off so ONLY a
		// real filesystem event can prove that this path enforces the budget too.
		await handlers.get("session_shutdown")?.({}, {});
		fs.writeFileSync(
			path.join(fixture3, ".context-engine.yaml"),
			`storage:\n  path: ${storage3.replace(/\\/g, "/")}\nindexer:\n  auto_index: false\n  max_auto_files: 1\n`,
			"utf-8",
		);
		limitNotes.length = 0;
		await handlers.get("session_start")?.({}, limitCtx);
		fs.writeFileSync(path.join(fixture3, "src", "b.txt"), "beta changed\n", "utf-8");
		const watcherDeadline = Date.now() + 10_000;
		while (Date.now() < watcherDeadline && !paused()) {
			await new Promise((r) => setTimeout(r, 100));
		}
		if (!paused()) problems.push(`watcher file limit: missing pause warning — got ${JSON.stringify(limitNotes)}`);
		else console.log("watcher file limit: filesystem trigger paused with a warning");
	} catch (err) {
		problems.push(`tool invocation threw: ${err.stack ?? err}`);
	} finally {
		// Fire the shutdown hook so sqlite handles are released before rmSync;
		// Windows refuses to delete a directory with open database files.
		try {
			await handlers.get("session_shutdown")?.({}, {});
		} catch (err) {
			problems.push(`session_shutdown threw: ${err}`);
		}
		// Windows transient EBUSY/EPERM: an sqlite file can still be locked for
		// a while after close (defender/indexer grabbing the fresh file), so
		// retry for a few seconds instead of failing the whole CI job on a
		// cleanup hiccup. A persistent failure lands in `problems` instead of
		// throwing, so the report below still prints.
		const removeRecursive = (target) => {
			for (let attempt = 0; ; attempt++) {
				try {
					fs.rmSync(target, { recursive: true, force: true });
					return;
				} catch (err) {
					if (attempt >= 30 || (err.code !== "EBUSY" && err.code !== "EPERM")) {
						problems.push(`cleanup failed for ${target}: ${err.code ?? err.message}`);
						return;
					}
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); // sync sleep
				}
			}
		};
		removeRecursive(fixture);
		removeRecursive(storageRoot);
		for (const dir of extraCleanup) removeRecursive(dir);
	}
}

console.log(`tools (${tools.size}): ${[...tools.keys()].join(", ")}`);
console.log(`commands (${commands.length}): ${commands.map((c) => `/${c}`).join(", ")}`);
console.log(`events (${events.size}): ${[...events].join(", ")}`);
console.log("guidance: injected through before_agent_start (validated above)");

if (problems.length > 0) {
	console.error("\nPROBLEMS:");
	for (const p of problems) console.error(`  - ${p}`);
	process.exit(1);
}
console.log("\nloader smoke OK (registration + tool execution)");
