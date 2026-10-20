/**
 * Shared utilities — port of upstream `context_engine/utils.py` (MIT).
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** SQLite SQLITE_MAX_VARIABLE_NUMBER defaults to 999; stay safely under. */
export const SQL_PARAM_BATCH = 500;

export function* batchedParams<T>(items: readonly T[], size = SQL_PARAM_BATCH): Generator<T[]> {
	for (let i = 0; i < items.length; i += size) {
		yield items.slice(i, i + size);
	}
}

/** Write `data` to `path` via tempfile + rename so a crash can't leave a truncated file. */
export function atomicWriteText(filePath: string, data: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tmp = path.join(
		path.dirname(filePath),
		`.${path.basename(filePath)}.${randomBytes(4).toString("hex")}.tmp`,
	);
	try {
		fs.writeFileSync(tmp, data, "utf-8");
		fs.renameSync(tmp, filePath);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// best effort
		}
		throw err;
	}
}

/** Stable per-directory slug: `<sanitised-basename>-<6hex>`. */
export function projectSlug(projectDir: string): string {
	const resolved = path.resolve(projectDir);
	const h = createHash("sha256").update(resolved).digest("hex").slice(0, 6);
	const safe =
		Array.from(path.basename(resolved))
			.map((c) => (/^[a-zA-Z0-9_-]$/.test(c) ? c : "-"))
			.join("") || "project";
	return `${safe}-${h}`;
}

/** Per-project storage directory under the configured storage root. */
export function projectStorageDir(storageRoot: string, projectDir: string): string {
	return path.join(storageRoot, projectSlug(projectDir));
}

export function sha256Hex(input: string): string {
	return createHash("sha256").update(input, "utf-8").digest("hex");
}

/** Random session id, same shape as upstream (12 hex chars). */
export function newSessionId(): string {
	return randomBytes(6).toString("hex");
}

/** `3m ago` / `5h ago` style relative time. Empty string on missing input. */
export function humaniseRelativeTime(epochSeconds: number | null | undefined): string {
	if (epochSeconds == null) return "";
	const delta = Math.max(0, Math.floor(Date.now() / 1000) - Math.floor(epochSeconds));
	if (delta < 60) return "just now";
	if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
	if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
	if (delta < 30 * 86400) return `${Math.floor(delta / 86400)}d ago`;
	if (delta < 365 * 86400) return `${Math.floor(delta / (30 * 86400))}mo ago`;
	return `${Math.floor(delta / (365 * 86400))}y ago`;
}

export function utcNowStamp(): string {
	return new Date().toISOString().replace("T", " ").replace(/\.\d+Z$/, "").trim();
}

export function epochSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

/**
 * Cooperative macrotask yield for long-running indexing work. ONNX
 * inference, tokenization and tree-sitter parsing all run on the main
 * thread, so a long stretch of synchronous work starves pi's UI loop
 * (measured by scripts/bench-event-loop.mts: ~0.5-0.9 s stalls per 64-text
 * embed batch). setImmediate keeps the yield cheap — same loop turn's check
 * phase — while still letting pending timers and I/O (keystrokes, renders)
 * run between units of work.
 */
export function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Fractional seconds. Session-capture ordering needs sub-second resolution:
 * several decisions are commonly recorded within the same wall-clock second,
 * and `getRecentDecisions` sorts by this value.
 */
export function epochSecondsFloat(): number {
	return Date.now() / 1000;
}
