/**
 * Cross-process index lock (src/indexer/index-lock.ts) and its pipeline
 * integration: when another pi session on the same project is indexing,
 * automatic runs skip instantly, manual runs wait briefly then skip, and
 * resetIndex reports the holder instead of deleting under it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { ContextEngine } from "../src/engine.js";
import { LocalBackend } from "../src/storage/local-backend.js";
import { defaultConfig, type Config } from "../src/config.js";
import { acquireIndexLock, indexLockPath } from "../src/indexer/index-lock.js";
import { makeFakeEmbedder, makeTempDir, rmrf, writeFiles, SAMPLE_REPO } from "./helpers.js";

const engines: ContextEngine[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
	// Close sqlite handles before deleting directories — Windows refuses to
	// unlink a file that still has an open handle.
	for (const engine of engines.splice(0)) {
		try {
			await engine.shutdown();
		} catch {
			// already closed
		}
	}
	for (const dir of tempDirs.splice(0)) rmrf(dir);
	vi.unstubAllEnvs();
});

async function harness(): Promise<{ engine: ContextEngine; storageBase: string }> {
	const projectDir = makeTempDir("pce-lock-");
	const storageRoot = makeTempDir("pce-lock-store-");
	tempDirs.push(projectDir, storageRoot);
	writeFiles(projectDir, SAMPLE_REPO);
	const config: Config = { ...defaultConfig(), storagePath: storageRoot, indexerAutoIndex: true };
	const engine = new ContextEngine({ projectDir, config });
	const embedder = makeFakeEmbedder();
	const backend = new LocalBackend(engine.storageBase);
	engines.push(engine);
	const internals = engine as unknown as {
		backendInstance: LocalBackend | null;
		embedderInstance: unknown;
		injectedRuntime: unknown;
	};
	internals.backendInstance = backend;
	internals.embedderInstance = embedder;
	internals.injectedRuntime = { backend, embedder };
	return { engine, storageBase: engine.storageBase };
}

/** Write a lockfile as a foreign holder would (used to simulate holders). */
function forgeLock(storageBase: string, contents: { pid: number; acquiredAtEpoch: number }): void {
	fs.mkdirSync(storageBase, { recursive: true });
	fs.writeFileSync(indexLockPath(storageBase), JSON.stringify(contents), "utf-8");
}

describe("acquireIndexLock", () => {
	it("is exclusive, and release frees it for the next acquirer", async () => {
		const dir = makeTempDir("pce-lock-unit-");
		tempDirs.push(dir);
		const first = await acquireIndexLock(dir);
		if (!("lock" in first)) throw new Error("first acquire must succeed");
		// Held by THIS process: busy report names it.
		const second = await acquireIndexLock(dir);
		expect("busy" in second).toBe(true);
		if ("busy" in second) expect(second.busy.holderPid).toBe(process.pid);
		first.lock.release();
		expect(fs.existsSync(indexLockPath(dir))).toBe(false);
		expect("lock" in (await acquireIndexLock(dir))).toBe(true);
	});

	it("waits for the holder up to waitMs, then reports busy", async () => {
		const dir = makeTempDir("pce-lock-unit-");
		tempDirs.push(dir);
		const first = await acquireIndexLock(dir);
		if (!("lock" in first)) throw new Error("first acquire must succeed");
		const started = Date.now();
		const second = await acquireIndexLock(dir, 300);
		expect(Date.now() - started).toBeGreaterThanOrEqual(250);
		expect("busy" in second).toBe(true);
		first.lock.release();
	});

	it("steals a lock whose holder process is gone", async () => {
		const dir = makeTempDir("pce-lock-unit-");
		tempDirs.push(dir);
		// spawnSync returns after the child exited, so its pid is dead.
		const child = spawnSync(process.execPath, ["-e", ""], { timeout: 10_000 });
		expect(child.pid).toBeGreaterThan(0);
		forgeLock(dir, { pid: child.pid!, acquiredAtEpoch: Date.now() });
		const acquired = await acquireIndexLock(dir, 200);
		expect("lock" in acquired).toBe(true);
	});

	it("steals a lock past the stale age even when the pid is alive", async () => {
		const dir = makeTempDir("pce-lock-unit-");
		tempDirs.push(dir);
		// Our own pid is definitely alive — only the age makes it stale.
		forgeLock(dir, { pid: process.pid, acquiredAtEpoch: Date.now() - 16 * 60_000 });
		const acquired = await acquireIndexLock(dir, 200);
		expect("lock" in acquired).toBe(true);
	});

	it("never steals a fresh lock held by a live pid", async () => {
		const dir = makeTempDir("pce-lock-unit-");
		tempDirs.push(dir);
		forgeLock(dir, { pid: process.pid, acquiredAtEpoch: Date.now() });
		const acquired = await acquireIndexLock(dir, 150);
		expect("busy" in acquired).toBe(true);
	});
});

describe("runIndexing × cross-process lock", () => {
	it("automatic runs skip instantly and un-consume the one-shot while another session holds the lock", async () => {
		const { engine, storageBase } = await harness();
		const held = await acquireIndexLock(storageBase, 0);
		if (!("lock" in held)) throw new Error("holding the lock must succeed");

		const skipped = await engine.autoIndexOnce();
		expect(skipped).not.toBeNull();
		expect(skipped!.skippedByOtherSession).toBe(true);
		expect(skipped!.indexed).toBe(0);
		expect(engine.chunkCount()).toBe(0);

		// The one-shot is un-consumed: a later kick retries (still skipped while
		// the lock is held) instead of being burned on the contention window.
		expect(await engine.autoIndexOnce()).not.toBeNull();

		held.lock.release();
		const now = await engine.autoIndexOnce();
		expect(now!.skippedByOtherSession).toBeFalsy();
		expect(now!.indexed).toBeGreaterThanOrEqual(3);
	});

	it("manual runs wait for the configured window, then skip", async () => {
		vi.stubEnv("PCE_INDEX_LOCK_WAIT_MS", "250");
		const { engine, storageBase } = await harness();
		const held = await acquireIndexLock(storageBase, 0);
		if (!("lock" in held)) throw new Error("holding the lock must succeed");
		const started = Date.now();
		const result = await engine.reindex({});
		expect(Date.now() - started).toBeGreaterThanOrEqual(200);
		expect(result.skippedByOtherSession).toBe(true);
		expect(result.indexed).toBe(0);
		expect(engine.chunkCount()).toBe(0);
		held.lock.release();
	});

	it("releases the lock after a successful run so the next acquirer proceeds", async () => {
		const { engine, storageBase } = await harness();
		const first = await engine.reindex({ automatic: true });
		expect(first.skippedByOtherSession).toBeFalsy();
		expect(fs.existsSync(indexLockPath(storageBase))).toBe(false);
		// The storage dir is free: an unrelated acquirer gets it immediately.
		const probe = await acquireIndexLock(storageBase, 0);
		expect("lock" in probe).toBe(true);
		if ("lock" in probe) probe.lock.release();
	});

	it("resetIndex reports the holder instead of deleting under it", async () => {
		const { engine, storageBase } = await harness();
		const held = await acquireIndexLock(storageBase, 0);
		if (!("lock" in held)) throw new Error("holding the lock must succeed");
		const report = await engine.resetIndex();
		expect(report.deletedFiles).toBe(0);
		expect(report.errors).toHaveLength(1);
		expect(report.errors[0]).toContain("index lock");
		held.lock.release();
	});

	it("statusText shows the lock holder and the skip counter", async () => {
		const { engine, storageBase } = await harness();
		const held = await acquireIndexLock(storageBase, 0);
		if (!("lock" in held)) throw new Error("holding the lock must succeed");

		const held1 = await engine.autoIndexOnce();
		expect(held1!.skippedByOtherSession).toBe(true);

		const whileHeld = await engine.statusText();
		expect(whileHeld).toContain(`Index lock: held by pid ${process.pid}`);
		expect(whileHeld).toContain("skipped for the other session's lock: 1");

		held.lock.release();
		const afterRelease = await engine.statusText();
		expect(afterRelease).toContain("Index lock: free");
	});
});
