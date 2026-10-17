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

/** Minimal structural type — avoids depending on @types packages. */
export interface SqliteHandle {
	exec(sql: string): this;
	prepare(sql: string): SqliteStatement;
	pragma(source: string, options?: { simple?: boolean }): unknown;
	loadExtension(file: string, entrypoint?: string): void;
	transaction<F extends (...args: never[]) => unknown>(fn: F): F;
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

/** Open a database and load sqlite-vec. Returns whether vec is available. */
export function openDatabase(file: string): { db: SqliteHandle; hasVec: boolean } {
	const db = new Database(file);
	db.pragma("journal_mode = WAL");
	db.pragma("synchronous = NORMAL");
	db.pragma("busy_timeout = 5000");
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
