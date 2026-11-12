import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listPiSessions } from "../src/dashboard/pi-sessions.js";

let root: string;

const writeSession = (fileName: string, cwd: string, entries: unknown[], mtimeMs?: number): string => {
	// listAll(root) reads *.jsonl directly inside root (only the no-arg form
	// recurses into per-project subdirs), so fixtures are flat.
	const file = path.join(root, fileName);
	const header = JSON.stringify({ type: "session", version: 3, id: fileName.replace(/\.jsonl$/, ""), timestamp: "2026-01-01T00:00:00Z", cwd });
	fs.writeFileSync(file, [header, ...entries.map((e) => JSON.stringify(e))].join("\n") + "\n", "utf8");
	if (mtimeMs !== undefined) fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
	return file;
};

const msg = (role: string, usage?: unknown, extra: Record<string, unknown> = {}) => ({
	type: "message",
	id: Math.random().toString(16).slice(2, 10),
	parentId: null,
	timestamp: "2026-01-01T00:01:00Z",
	message: { role, usage, content: role === "user" ? "hi" : [{ type: "text", text: "x" }], ...extra },
});

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "pce-pi-sessions-"));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("listPiSessions", () => {
	it("lists sessions, most recent first, with parsed tokens and cost", async () => {
		writeSession("aaa.jsonl", "C:\\proj-a", [
			msg("user"),
			msg("assistant", {
				input: 100,
				output: 20,
				cacheRead: 800,
				cacheWrite: 50,
				totalTokens: 970,
				cost: { total: 0.5 },
			}),
		], 1000);
		writeSession("bbb.jsonl", "C:\\proj-b", [
			msg("user"),
			msg("assistant", {
				input: 10,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 12,
				cost: { total: 0.25 },
			}),
		], 2000);
		// Reverse direction: POSIX cwds must parse identically on every platform
		// (and Windows-style cwds must split on Linux CI — path.basename() is
		// platform-dependent and returned the whole path there before the fix).
		writeSession("ccc.jsonl", "/home/user/proj-c", [
			msg("user"),
			msg("assistant", {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { total: 0.1 },
			}),
		], 3000);
		const payload = await listPiSessions(root, 100, 0);
		expect(payload.total).toBe(3);
		expect(payload.sessions.map((s) => s.id)).toEqual(["ccc", "bbb", "aaa"]); // mtime desc
		const newest = payload.sessions[0]!;
		expect(newest.project).toBe("proj-c"); // POSIX cwd
		expect(payload.sessions[1]!.project).toBe("proj-b"); // Windows cwd — CI regression: Linux must split on `\\`
		expect(newest.tokens).toBe(0);
		expect(newest.cost).toBeCloseTo(0.1, 6);
		expect(newest.messageCount).toBe(2);
	});

	it("paginates without parsing out-of-window files", async () => {
		for (let i = 0; i < 5; i++) {
			writeSession(`s${i}.jsonl`, "C:\\p", [msg("user")], i * 1000);
		}
		const page = await listPiSessions(root, 2, 2);
		expect(page.total).toBe(5);
		expect(page.offset).toBe(2);
		expect(page.sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
		expect(page.sessions.every((s) => s.cost === 0 && s.tokens === 0)).toBe(true);
	});

	it("survives unreadable files (falls back to zero summary)", async () => {
		writeSession("good.jsonl", "C:\\p", [msg("user")], 1000);
		// A directory named like a session file makes pi's own info builder skip
		// it, so it never even reaches our parser.
		fs.mkdirSync(path.join(root, "weird.jsonl"), { recursive: true });
		const payload = await listPiSessions(root, 100, 0);
		expect(payload.total).toBe(1);
		expect(payload.sessions[0]!.id).toBe("good");
	});

	it("updates a cached summary after the file changes (mtime+size key)", async () => {
		const file = writeSession("grow.jsonl", "C:\\p", [msg("user")], 1000);
		const before = await listPiSessions(root, 100, 0);
		expect(before.sessions[0]!.tokens).toBe(0);
		// Wait: listAll sorts by activity and our cache keys on mtimeMs:size —
		// append usage and bump mtime.
		fs.writeFileSync(
			file,
			fs.readFileSync(file, "utf8") +
				JSON.stringify(msg("assistant", { input: 5, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { total: 1 } })) +
				"\n",
			"utf8",
		);
		const future = new Date(Date.now() + 5000);
		fs.utimesSync(file, future, future);
		const after = await listPiSessions(root, 100, 0);
		expect(after.sessions[0]!.tokens).toBe(10);
		expect(after.sessions[0]!.cost).toBeCloseTo(1, 6);
	});
});
