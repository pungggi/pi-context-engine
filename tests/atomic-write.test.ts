/**
 * atomicWriteText Windows hardening: the tempfile→rename final step fails
 * with EPERM/EACCES/EBUSY while antivirus scanners, search indexers or
 * backup tools momentarily hold the temp or destination file open without
 * share-delete. The write must retry through those blips instead of failing
 * the whole indexing run (the "watcher reindex failed (EPERM: … rename
 * .manifest.json.xxx)" warning).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs, { renameSync as realRename } from "node:fs";
import os from "node:os";
import path from "node:path";
import { atomicWriteText } from "../src/utils.js";

function tempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "pce-atomic-"));
}

function errWithCode(code: string): Error {
	return Object.assign(new Error(code.toLowerCase()), { code });
}

/** Patch fs.renameSync with a flaky implementation backed by the real one. */
function flakyRename(failTimes: number, code: string): void {
	let failures = 0;
	vi.spyOn(fs, "renameSync").mockImplementation(((oldPath: string, newPath: string) => {
		if (failures < failTimes) {
			failures++;
			throw errWithCode(code);
		}
		return realRename(oldPath, newPath);
	}) as typeof fs.renameSync);
}

function alwaysFailRename(code: string): { calls(): number } {
	let calls = 0;
	vi.spyOn(fs, "renameSync").mockImplementation((() => {
		calls++;
		throw errWithCode(code);
	}) as typeof fs.renameSync);
	return { calls: () => calls };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("atomicWriteText", () => {
	it("writes content via rename, leaving no temp files behind", () => {
		const dir = tempDir();
		const file = path.join(dir, "data.json");
		atomicWriteText(file, JSON.stringify({ ok: true }));
		expect(fs.readFileSync(file, "utf-8")).toBe(JSON.stringify({ ok: true }));
		expect(fs.readdirSync(dir)).toEqual(["data.json"]);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("retries through transient EPERM blips and then succeeds", () => {
		const dir = tempDir();
		const file = path.join(dir, "manifest.json");
		flakyRename(2, "EPERM");

		atomicWriteText(file, "payload");
		expect(fs.readFileSync(file, "utf-8")).toBe("payload");
		expect(fs.readdirSync(dir)).toEqual(["manifest.json"]);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("also retries EBUSY and EACCES", () => {
		const dir = tempDir();
		const file = path.join(dir, "stats.json");
		let failures = 0;
		vi.spyOn(fs, "renameSync").mockImplementation(((oldPath: string, newPath: string) => {
			const code = ["EBUSY", "EACCES"][failures++];
			if (code) throw errWithCode(code);
			return realRename(oldPath, newPath);
		}) as typeof fs.renameSync);

		atomicWriteText(file, "n=1");
		expect(fs.readFileSync(file, "utf-8")).toBe("n=1");
		expect(fs.readdirSync(dir)).toEqual(["stats.json"]);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("fails immediately on non-transient errors and cleans up the temp file", () => {
		const dir = tempDir();
		const file = path.join(dir, "manifest.json");
		const flaky = alwaysFailRename("ENOENT");

		expect(() => atomicWriteText(file, "x")).toThrow(/enoent/);
		expect(flaky.calls()).toBe(1);
		expect(fs.readdirSync(dir)).toEqual([]);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("gives up after the retry budget when EPERM persists, without leaving the temp file", () => {
		const dir = tempDir();
		const file = path.join(dir, "manifest.json");
		const flaky = alwaysFailRename("EPERM");

		expect(() => atomicWriteText(file, "x")).toThrow(/eperm/);
		expect(flaky.calls()).toBe(8);
		expect(fs.readdirSync(dir)).toEqual([]);
		fs.rmSync(dir, { recursive: true, force: true });
	});
});
