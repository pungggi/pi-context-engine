/**
 * R13: linked memory (A-MEM style) — auto-linking threshold/cap behavior,
 * no self-links, explicit annotations, PII scrub before write, recall
 * surfacing, v4 schema migration.
 */
import { afterAll, describe, expect, it } from "vitest";
import { ContextEngine } from "../src/engine.js";
import { defaultConfig, type Config } from "../src/config.js";
import { LocalBackend } from "../src/storage/local-backend.js";
import { MemoryDb, memoryDbPath } from "../src/memory/db.js";
import { makeFakeEmbedder, makeTempDir, rmrf } from "./helpers.js";

const dirs: string[] = [];
const engines: ContextEngine[] = [];

afterAll(async () => {
	await Promise.all(engines.map((e) => e.shutdown().catch(() => undefined)));
	for (const d of dirs.splice(0)) rmrf(d);
});

async function freshEngine(configOver: Partial<Config> = {}): Promise<ContextEngine> {
	const projectDir = makeTempDir("pce-r13-");
	dirs.push(projectDir);
	const storageRoot = makeTempDir("pce-r13store-");
	dirs.push(storageRoot);
	const config: Config = { ...defaultConfig(), storagePath: storageRoot, ...configOver };
	const backend = new LocalBackend(storageRoot);
	const engine = new ContextEngine({ projectDir, config, runtime: { backend, embedder: makeFakeEmbedder() } });
	engines.push(engine);
	return engine;
}

describe("R13: linked memory", () => {
	it("migrates an existing v3 db to v4 (decision_links + columns)", () => {
		const dir = makeTempDir("pce-r13v3-");
		dirs.push(dir);
		const dbPath = memoryDbPath(dir);
		const memory = new MemoryDb(dbPath);
		expect(memory.schemaVersion()).toBe(4);
		memory.close();
		const reopened = new MemoryDb(dbPath);
		expect(reopened.schemaVersion()).toBe(4);
		const cols = (reopened.db.prepare("PRAGMA table_info(decisions)").all() as { name: string }[]).map((c) => c.name);
		expect(cols).toContain("tags");
		expect(cols).toContain("files");
		expect(
			reopened.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='decision_links'").get(),
		).toBeTruthy();
		reopened.close();
	});

	it("auto-links a new decision to similar past decisions, not to dissimilar ones", async () => {
		const engine = await freshEngine();
		await engine.recordDecision("Use vitest fake timers for clock tests", "because real timers are flaky");
		await engine.recordDecision("Vitest fake timers for the clock test runner", "because flakiness");
		const stored = await engine.recordDecision("Vitest fake timers for clock test setup", "because consistency");
		expect(stored).toContain("linked:");
		// And a completely unrelated decision links to nothing.
		const unrelated = await engine.recordDecision("Prefer teal for charts", "because brand says so");
		expect(unrelated).not.toContain("linked:");
	});

	it("refuses self-links, unknown ids, and enforces caps", () => {
		const dir = makeTempDir("pce-r13cap-");
		dirs.push(dir);
		const memory = new MemoryDb(memoryDbPath(dir));
		const ids = [1, 2, 3];
		for (const [i, d] of ["first decision", "second decision", "third decision"].entries()) {
			memory.db
				.prepare("INSERT INTO decisions (session_id, decision, reason, source, created_at_epoch, created_at) VALUES (NULL, ?, ?, 'manual', 0, 'x')")
				.run(d, "r" + i);
		}
		void ids;
		expect(memory.linkDecisions(1, 1, "related_to")).toBe(false); // self
		expect(memory.linkDecisions(1, 999, "related_to")).toBe(false); // unknown target
		expect(memory.linkDecisions(1, 2, "related_to")).toBe(true);
		expect(memory.linkDecisions(1, 2, "related_to")).toBe(false); // duplicate
		const links = memory.getDecisionLinks(2);
		expect(links.relatedFrom).toEqual([1]);
		memory.close();
	});

	it("explicit relatedTo annotates an earlier decision; original text immutable; notes scrubbed", async () => {
		const engine = await freshEngine();
		const first = await engine.recordDecision("Store config in yaml", "because users asked");
		void first;
		const memory = (engine as unknown as { getMemory(): MemoryDb | null }).getMemory();
		expect(memory).toBeTruthy();
		const firstId = (
			memory!.db.prepare("SELECT id FROM decisions ORDER BY id LIMIT 1").get() as { id: number }
		).id;
		const email = "alice@example.com";
		await engine.recordDecision("Config schema validated at load", "supersedes #" + firstId, {
			relatedTo: [firstId],
			tags: ["config"],
			files: ["src/config.ts"],
		});
		const secondRow = memory!.db.prepare("SELECT id FROM decisions ORDER BY id DESC LIMIT 1").get() as { id: number };
		const links = memory!.getDecisionLinks(firstId);
		expect(links.annotatedBy.map((a) => a.id)).toContain(secondRow.id);
		// PII never lands in the annotation note.
		const note = links.annotatedBy.find((a) => a.id === secondRow.id)!.note ?? "";
		expect(note).not.toContain(email);
		// Original text untouched by the annotation.
		const firstText = (memory!.db.prepare("SELECT decision FROM decisions WHERE id = ?").get(firstId) as { decision: string }).decision;
		expect(firstText).toBe("Store config in yaml");
		// Structured attributes stored.
		const tags = JSON.parse((memory!.db.prepare("SELECT tags FROM decisions WHERE id = ?").get(secondRow.id) as { tags: string }).tags) as string[];
		expect(tags).toContain("config");
	});

	it("session_recall surfaces the links", async () => {
		const engine = await freshEngine();
		await engine.recordDecision("Use sqlite storage for persistence", "zero config");
		await engine.recordDecision("Sqlite storage for persistence with wal", "durability");
		const out = await engine.sessionRecall("sqlite storage");
		expect(out).toMatch(/related:/);
	});
});
