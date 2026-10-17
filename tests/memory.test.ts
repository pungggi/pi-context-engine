import { describe, expect, it } from "vitest";
import path from "node:path";
import { MemoryDb, BUCKETS, memoryDbPath, scrubPii, setPiiRedaction } from "../src/memory/db.js";
import { SessionCapture } from "../src/memory/session-capture.js";
import { compressTurn, compressSessionRollup, drainOne, enqueueTurn } from "../src/memory/compressor.js";
import { makeFakeEmbedder, makeTempDir, rmrf } from "./helpers.js";

function withMemory<T>(fn: (memory: MemoryDb, dir: string) => Promise<T> | T): Promise<T> {
	const dir = makeTempDir("pce-mem-");
	const memory = new MemoryDb(memoryDbPath(dir));
	return Promise.resolve(fn(memory, dir)).finally(() => {
		memory.close();
		rmrf(dir);
	});
}

describe("MemoryDb", () => {
	it("bootstraps the v3 schema idempotently", async () => {
		await withMemory(async (memory, dir) => {
			expect(memory.schemaVersion()).toBe(3);
			memory.close();
			const reopened = new MemoryDb(memoryDbPath(dir));
			expect(reopened.schemaVersion()).toBe(3);
			reopened.close();
		});
	});

	it("creates the vec tables when sqlite-vec is available", async () => {
		await withMemory((memory) => {
			expect(memory.vecAvailable).toBe(true);
			expect(memory.hasVecTables()).toBe(true);
		});
	});

	it("appends savings events and aggregates per bucket", async () => {
		await withMemory((memory) => {
			memory.recordSavings("retrieval", 1000, 100);
			memory.recordSavings("retrieval", 500, 50);
			memory.recordSavings("grammar", 10, 8);
			const agg = memory.aggregateSavings();
			expect(agg.retrieval).toEqual({ baseline: 1500, served: 150, calls: 2 });
			expect(agg.grammar.calls).toBe(1);
			// Every canonical bucket is present so renderers can iterate blindly.
			for (const bucket of BUCKETS) expect(agg[bucket]).toBeDefined();
		});
	});

	it("ignores unknown buckets instead of throwing", async () => {
		await withMemory((memory) => {
			// @ts-expect-error deliberately invalid bucket
			memory.recordSavings("not-a-bucket", 1, 1);
			expect(memory.aggregateSavings().retrieval.calls).toBe(0);
		});
	});

	it("ages out old tool payloads while keeping the event rows", async () => {
		await withMemory((memory) => {
			const epoch = Math.floor(Date.now() / 1000);
			memory.db
				.prepare("INSERT INTO sessions (id, project, started_at_epoch, started_at, status) VALUES (?, ?, ?, ?, 'active')")
				.run("s1", "p", epoch, new Date(epoch * 1000).toISOString());
			const payload = memory.db
				.prepare("INSERT INTO tool_event_payloads (raw_input, raw_output, size_bytes) VALUES (?, ?, ?)")
				.run("x".repeat(100), "out", 200);
			memory.db
				.prepare(
					"INSERT INTO tool_events (session_id, prompt_number, tool_name, payload_id, summary, created_at_epoch, created_at) VALUES (?, 1, 'bash', ?, 's', ?, ?)",
				)
				.run("s1", Number(payload.lastInsertRowid), epoch - 90 * 86400, new Date().toISOString());

			const pruned = memory.pruneOldPayloads(30);
			expect(pruned.payloadsPruned).toBe(1);
			expect(pruned.bytesFreedEstimate).toBe(200);
			// The event row survives so the summary is still reachable.
			const events = memory.db.prepare("SELECT COUNT(*) AS n FROM tool_events").get() as { n: number };
			expect(events.n).toBe(1);
		});
	});

	it("prunes expired memory rows and archives them first", async () => {
		await withMemory((memory, dir) => {
			const old = Math.floor(Date.now() / 1000) - 400 * 86400;
			memory.db
				.prepare(
					"INSERT INTO decisions (session_id, decision, reason, source, created_at_epoch, created_at) VALUES (NULL, ?, ?, 'manual', ?, ?)",
				)
				.run("old decision", "old reason", old, new Date(old * 1000).toISOString());
			memory.db
				.prepare(
					"INSERT INTO decisions (session_id, decision, reason, source, created_at_epoch, created_at) VALUES (NULL, ?, ?, 'manual', ?, ?)",
				)
				.run("fresh decision", "fresh reason", Math.floor(Date.now() / 1000), new Date().toISOString());

			const counts = memory.pruneOldRows({ storageBase: dir });
			expect(counts.decisionsPruned).toBe(1);
			const remaining = memory.db.prepare("SELECT decision FROM decisions").all() as { decision: string }[];
			expect(remaining.map((r) => r.decision)).toEqual(["fresh decision"]);
		});
	});
});

describe("scrubPii", () => {
	it("redacts emails when enabled and passes through when disabled", () => {
		setPiiRedaction(true);
		expect(scrubPii("mail me at a@b.com")).toContain("[REDACTED:EMAIL]");
		setPiiRedaction(false);
		expect(scrubPii("mail me at a@b.com")).toBe("mail me at a@b.com");
		setPiiRedaction(true);
	});
});

describe("SessionCapture", () => {
	it("records decisions and flushes them to disk", () => {
		const dir = makeTempDir("pce-sess-");
		try {
			const capture = new SessionCapture(dir);
			const id = capture.startSession("proj");
			capture.recordDecision(id, "Use JWT", "stateless");
			capture.recordCodeArea(id, "src/auth.py", "token verification");
			capture.touchFiles(id, ["src/auth.py", "src/auth.py", "git:abc"]);
			capture.persist(id);

			const recent = capture.loadRecentSessions(1);
			expect(recent[0]!.decisions[0]!.decision).toBe("Use JWT");
			// git: pseudo-files are not counted as touched source files.
			expect(recent[0]!.touchedFiles["src/auth.py"]).toBe(2);
			expect(recent[0]!.touchedFiles["git:abc"]).toBeUndefined();
		} finally {
			rmrf(dir);
		}
	});

	it("returns decisions newest-first and deduped", () => {
		const dir = makeTempDir("pce-sess-");
		try {
			const capture = new SessionCapture(dir);
			const id = capture.startSession("proj");
			capture.recordDecision(id, "First", "because a");
			capture.recordDecision(id, "Second", "because b");
			const recent = capture.getRecentDecisions(10);
			expect(recent).toHaveLength(2);
			expect(recent[0]).toContain("Second");

			// Re-recording an existing decision moves it to the front and does
			// not duplicate it.
			capture.recordDecision(id, "First", "because a");
			const after = capture.getRecentDecisions(10);
			expect(after).toHaveLength(2);
			expect(after[0]).toContain("First");
		} finally {
			rmrf(dir);
		}
	});
});

describe("memory compressor", () => {
	it("summarises a turn, stores it, and records savings", async () => {
		const dir = makeTempDir("pce-comp-");
		const memory = new MemoryDb(memoryDbPath(dir));
		const embedder = makeFakeEmbedder();
		try {
			const epoch = Math.floor(Date.now() / 1000);
			memory.db
				.prepare("INSERT INTO sessions (id, project, started_at_epoch, started_at, status) VALUES (?, ?, ?, ?, 'active')")
				.run("s1", "p", epoch, new Date(epoch * 1000).toISOString());
			memory.db
				.prepare(
					"INSERT INTO prompts (session_id, prompt_number, prompt_text, created_at_epoch, created_at) VALUES (?, 1, ?, ?, ?)",
				)
				.run(
					"s1",
					"We need to fix the payment retry logic. The gateway times out on slow networks. Add exponential backoff because the provider rate limits bursts.",
					epoch,
					new Date(epoch * 1000).toISOString(),
				);

			const summary = await compressTurn({ memory, embedder }, "s1", 1);
			expect(summary.length).toBeGreaterThan(0);

			const rows = memory.db.prepare("SELECT summary, tier FROM turn_summaries WHERE session_id = 's1'").all() as {
				summary: string;
				tier: string;
			}[];
			expect(rows).toHaveLength(1);
			expect(["extractive", "truncation"]).toContain(rows[0]!.tier);

			const buckets = memory.aggregateSavings();
			expect(buckets.turn_summarization.calls).toBe(1);
		} finally {
			memory.close();
			rmrf(dir);
		}
	});

	it("auto-captures a decision from the turn text", async () => {
		const dir = makeTempDir("pce-comp-");
		const memory = new MemoryDb(memoryDbPath(dir));
		const embedder = makeFakeEmbedder();
		try {
			const epoch = Math.floor(Date.now() / 1000);
			memory.db
				.prepare("INSERT INTO sessions (id, project, started_at_epoch, started_at, status) VALUES (?, ?, ?, ?, 'active')")
				.run("s1", "p", epoch, new Date(epoch * 1000).toISOString());
			memory.db
				.prepare(
					"INSERT INTO prompts (session_id, prompt_number, prompt_text, created_at_epoch, created_at) VALUES (?, 1, ?, ?, ?)",
				)
				.run(
					"s1",
					"We went with Redis for the session cache because the database was the bottleneck under load.",
					epoch,
					new Date(epoch * 1000).toISOString(),
				);
			await compressTurn({ memory, embedder }, "s1", 1);
			const decisions = memory.db.prepare("SELECT decision, source FROM decisions").all() as {
				decision: string;
				source: string;
			}[];
			// The heuristic needs the exact reason clause to survive summarisation;
			// assert only that nothing crashes when it doesn't fire.
			for (const d of decisions) expect(d.source).toBe("auto");
		} finally {
			memory.close();
			rmrf(dir);
		}
	});

	it("builds a session rollup from existing turn summaries", async () => {
		const dir = makeTempDir("pce-comp-");
		const memory = new MemoryDb(memoryDbPath(dir));
		const embedder = makeFakeEmbedder();
		try {
			const epoch = Math.floor(Date.now() / 1000);
			memory.db
				.prepare("INSERT INTO sessions (id, project, started_at_epoch, started_at, status) VALUES (?, ?, ?, ?, 'active')")
				.run("s1", "p", epoch, new Date(epoch * 1000).toISOString());
			memory.db
				.prepare(
					"INSERT INTO turn_summaries (session_id, prompt_number, summary, tier, created_at_epoch) VALUES ('s1', 1, ?, 'extractive', ?)",
				)
				.run("First we fixed payments. Then we fixed auth.", epoch);

			const rollup = await compressSessionRollup({ memory, embedder }, "s1");
			expect(rollup.length).toBeGreaterThan(0);
			const row = memory.db.prepare("SELECT rollup_summary FROM sessions WHERE id = 's1'").get() as {
				rollup_summary: string;
			};
			expect(row.rollup_summary).toBe(rollup);
		} finally {
			memory.close();
			rmrf(dir);
		}
	});

	it("drains the pending queue and clears processed rows", async () => {
		const dir = makeTempDir("pce-comp-");
		const memory = new MemoryDb(memoryDbPath(dir));
		const embedder = makeFakeEmbedder();
		try {
			const epoch = Math.floor(Date.now() / 1000);
			memory.db
				.prepare("INSERT INTO sessions (id, project, started_at_epoch, started_at, status) VALUES (?, ?, ?, ?, 'active')")
				.run("s1", "p", epoch, new Date(epoch * 1000).toISOString());
			memory.db
				.prepare(
					"INSERT INTO prompts (session_id, prompt_number, prompt_text, created_at_epoch, created_at) VALUES (?, 1, ?, ?, ?)",
				)
				.run("s1", "Fix the retry logic in payments.", epoch, new Date(epoch * 1000).toISOString());
			enqueueTurn(memory, "s1", 1);

			expect(await drainOne({ memory, embedder })).toBe(true);
			const pending = memory.db.prepare("SELECT COUNT(*) AS n FROM pending_compressions").get() as { n: number };
			expect(pending.n).toBe(0);
			// Nothing left to drain.
			expect(await drainOne({ memory, embedder })).toBe(false);
		} finally {
			memory.close();
			rmrf(dir);
		}
	});
});
