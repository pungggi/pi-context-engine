/**
 * Cross-process indexing lock.
 *
 * `withPipelineLock` serializes indexing runs within ONE process (auto-index
 * kick, lazy search kick, watcher, manual /context-index), but multiple pi
 * sessions on the same project are separate processes, each with their own
 * engine and their own sqlite handles on the same files. Without a
 * cross-process gate every session runs its own full incremental pass at
 * session start: duplicated embedding work plus maximal sqlite write
 * contention ("database is locked" storms on cold builds).
 *
 * The lock is a lockfile (`index.lock`) inside the storage dir, created with
 * the exclusive-create flag ('wx') so acquisition is atomic across processes.
 * Crash safety: a lock left behind by a dead process is stolen when its PID
 * is no longer alive, or when the lock is older than STALE_LOCK_MS regardless
 * (PID reuse on long-lived systems, foreign PIDs we cannot signal).
 */
import fs from "node:fs";
import path from "node:path";

const LOCK_FILE = "index.lock";

/** Any lock older than this is stale and gets stolen, even if the PID is alive. */
const STALE_LOCK_MS = 15 * 60_000;

interface LockContents {
	pid: number;
	acquiredAtEpoch: number;
}

export interface IndexLock {
	release(): void;
}

/** True when the process existed at check time (EPERM = alive, just not ours to signal). */
function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function lockPath(storageBase: string): string {
	return path.join(storageBase, LOCK_FILE);
}

function createLockFile(file: string): boolean {
	try {
		const fd = fs.openSync(file, "wx");
		try {
			fs.writeSync(fd, JSON.stringify({ pid: process.pid, acquiredAtEpoch: Date.now() } satisfies LockContents));
		} finally {
			fs.closeSync(fd);
		}
		return true;
	} catch {
		return false; // EEXIST (held) or unwritable storage — both mean "not acquired"
	}
}

function readLockContents(file: string): LockContents | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as LockContents;
	} catch {
		return null;
	}
}

/**
 * Steal the lock when its owner cannot still legitimately hold it: owner
 * process is gone, or the lock outlived STALE_LOCK_MS. Stealing is
 * remove-then-recreate; the recreate uses 'wx' so two stealers race safely
 * (one wins the create, the other reports busy).
 */
function stealIfStale(storageBase: string): void {
	const file = lockPath(storageBase);
	const contents = readLockContents(file);
	if (contents && pidAlive(contents.pid)) {
		const age = Date.now() - contents.acquiredAtEpoch;
		if (Number.isFinite(age) && age < STALE_LOCK_MS) return; // legitimately held
	}
	try {
		fs.rmSync(file, { force: true });
	} catch {
		// raced away already
	}
}

export type AcquireResult = { lock: IndexLock } | { busy: { holderPid: number | null; ageMs: number | null } };

/** The lockfile location — exported for tests and for diagnosing a stuck holder. */
export function indexLockPath(storageBase: string): string {
	return lockPath(storageBase);
}

/**
 * Try to acquire the indexing lock for `storageBase`, waiting up to `waitMs`
 * for the current holder to release. `waitMs = 0` = single-shot try (the
 * automatic path); manual runs pass a short wait before giving up.
 */
export function acquireIndexLock(storageBase: string, waitMs = 0): AcquireResult {
	const file = lockPath(storageBase);
	const deadline = Date.now() + Math.max(0, waitMs);
	for (;;) {
		if (createLockFile(file)) {
			return {
				lock: {
					release: (): void => {
						try {
							fs.rmSync(file, { force: true });
						} catch {
							// already gone
						}
					},
				},
			};
		}
		const contents = readLockContents(file);
		if (Date.now() >= deadline) {
			return {
				busy: {
					holderPid: contents?.pid ?? null,
					ageMs: contents?.acquiredAtEpoch != null ? Date.now() - contents.acquiredAtEpoch : null,
				},
			};
		}
		stealIfStale(storageBase);
		const sleepMs = Math.min(250, Math.max(1, deadline - Date.now()));
		// Synchronous sleep: pi extension code is sync here anyway (better-sqlite3
		// is), and a blocking poll keeps the lock logic free of async ordering bugs.
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
	}
}
