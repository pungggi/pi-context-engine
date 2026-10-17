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
const jitiPath = path.join(
	process.env.APPDATA ?? "",
	"npm",
	"node_modules",
	"@earendil-works",
	"pi-coding-agent",
	"node_modules",
	"jiti",
);
const { createJiti } = require(jitiPath);
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
		fs.rmSync(fixture, { recursive: true, force: true });
		fs.rmSync(storageRoot, { recursive: true, force: true });
	}
}

console.log(`tools (${tools.size}): ${[...tools.keys()].join(", ")}`);
console.log(`commands (${commands.length}): ${commands.map((c) => `/${c}`).join(", ")}`);
console.log(`events (${events.size}): ${[...events].join(", ")}`);

if (problems.length > 0) {
	console.error("\nPROBLEMS:");
	for (const p of problems) console.error(`  - ${p}`);
	process.exit(1);
}
console.log("\nloader smoke OK (registration + tool execution)");
