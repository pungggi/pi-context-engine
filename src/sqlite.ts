/**
 * Native module interop.
 *
 * `better-sqlite3` and `sqlite-vec` are CommonJS. Under pi's jiti loader,
 * vitest, and plain node ESM the default export lands in different places
 * (`mod`, `mod.default`, or `mod.default.default`), so a bare `import x from`
 * quietly yields the wrong object — which for sqlite-vec means
 * `getLoadablePath()` is undefined and the extension never loads (search then
 * degrades to FTS-only with no error). Resolving through `createRequire` once
 * keeps every consumer on the same, working path.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

type SqliteCtor = new (file: string) => SqliteHandle;

/** better-sqlite3 attaches these variants to the transaction function itself. */
export interface SqliteTransactionFn<F extends (...args: never[]) => unknown> {
	(...args: Parameters<F>): ReturnType<F>;
	immediate(...args: Parameters<F>): ReturnType<F>;
	deferred(...args: Parameters<F>): ReturnType<F>;
	exclusive(...args: Parameters<F>): ReturnType<F>;
}

/** Minimal structural type — avoids depending on @types packages. */
export interface SqliteHandle {
	exec(sql: string): this;
	prepare(sql: string): SqliteStatement;
	pragma(source: string, options?: { simple?: boolean }): unknown;
	loadExtension(file: string, entrypoint?: string): void;
	transaction<F extends (...args: never[]) => unknown>(fn: F): SqliteTransactionFn<F>;
	close(): void;
}

export interface SqliteStatement {
	run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
}

interface SqliteVecModule {
	getLoadablePath(): string;
	load(db: unknown): void;
}

function unwrap<T>(mod: unknown): T {
	// CJS interop can nest one level (esm wrapper -> cjs module.exports).
	const first = (mod as { default?: unknown }).default ?? mod;
	return ((first as { default?: unknown }).default ?? first) as T;
}

export const Database = unwrap<SqliteCtor>(require("better-sqlite3"));

let cachedVecPath: string | null | undefined;

/** Path to the sqlite-vec shared library, or null when unavailable. */
export function sqliteVecPath(): string | null {
	if (cachedVecPath !== undefined) return cachedVecPath;
	try {
		const mod = unwrap<SqliteVecModule>(require("sqlite-vec"));
		cachedVecPath = mod.getLoadablePath();
	} catch {
		cachedVecPath = null;
	}
	return cachedVecPath;
}

/**
 * Wait this long for a competing writer before giving up with SQLITE_BUSY.
 * Multiple pi sessions share one project's sqlite files, so writer waits are
 * normal during concurrent indexing; 5s was too short for cold-start builds.
 * Overridable for tests and slow-storage setups.
 */
export const BUSY_TIMEOUT_MS = Math.max(
	0,
	Number(process.env.PCE_BUSY_TIMEOUT_MS ?? 15_000) || 15_000,
);

/** Open a database and load sqlite-vec. Returns whether vec is available. */
export function openDatabase(file: string): { db: SqliteHandle; hasVec: boolean } {
	const db = new Database(file);
	db.pragma("journal_mode = WAL");
	db.pragma("synchronous = NORMAL");
	db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
	let hasVec = false;
	const vecPath = sqliteVecPath();
	if (vecPath) {
		try {
			db.loadExtension(vecPath);
			hasVec = true;
		} catch {
			hasVec = false;
		}
	}
	return { db, hasVec };
}

/**
 * Write transaction that takes the write lock up front (BEGIN IMMEDIATE).
 *
 * better-sqlite3's `db.transaction()` defaults to DEFERRED: a tx that reads
 * first and writes later must UPGRADE its lock, and when another connection
 * grabbed the write lock in between SQLite returns SQLITE_BUSY immediately —
 * busy_timeout is deliberately bypassed for that upgrade (it could deadlock),
 * so "database is locked" fires instantly even with a generous timeout.
 * IMMEDIATE serializes at BEGIN and its wait IS covered by busy_timeout,
 * which is what makes multi-session writes queue instead of error.
 */
export function immediateTransaction<F extends (...args: never[]) => unknown>(
	db: SqliteHandle,
	fn: F,
): (...args: Parameters<F>) => ReturnType<F> {
	const run = db.transaction(fn);
	return (...args: Parameters<F>) => run.immediate(...args);
}
