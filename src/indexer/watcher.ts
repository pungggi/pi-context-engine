/**
 * Real-time reindex trigger — issue #12. A thin debounced wrapper around
 * Node's built-in `fs.watch(dir, { recursive: true })` (one OS handle on
 * Windows/macOS, inotify tree on Linux since Node 19.1).
 *
 * The watcher only produces a *change signal*: the incremental pipeline
 * re-walks and re-hashes anyway, so false positives cost one cheap walk and
 * only missed events matter. That is why the built-in suffices and neither
 * chokidar (per-file stat-confirmed events, Node >= 22.22) nor
 * @parcel/watcher (native addon, snapshot diffs) are needed.
 *
 * Filter semantics deliberately MIRROR the pipeline's inclusion policy
 * (`targetExcluded` / `iterProjectFiles` in pipeline.ts), because a dropped
 * event is the only unrecoverable failure mode: a wrongly accepted event just
 * costs one cheap incremental run.
 */
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_IGNORE, ROOT_ONLY_IGNORE } from "../config.js";

/**
 * Trailing-edge debounce for watcher events: long enough that a burst
 * (editor save, `git checkout` rewriting many files) collapses into one
 * kick, short enough that retrieval catches up quickly after an edit.
 */
export const WATCH_DEBOUNCE_MS = 1500;

const ROOT_ONLY_SET = new Set(ROOT_ONLY_IGNORE);

export interface ProjectWatcherOptions {
	/** Called once per debounced change burst. Keep it cheap and sync. */
	onChange: () => void;
	/** Fatal watcher problem (e.g. Linux ENOSPC inotify exhaustion). The watcher closes itself; the caller falls back to session-start/lazy indexing. */
	onError?: (err: Error) => void;
	/** Defaults to {@link WATCH_DEBOUNCE_MS}. */
	debounceMs?: number;
	/**
	 * Segment names ignored at ANY depth — defaults to `DEFAULT_IGNORE`; the
	 * extension passes `config.indexerIgnore` so user additions apply too
	 * (same set the walker checks via `ignoreSet.has(seg)`).
	 */
	ignoreSegments?: readonly string[];
	/**
	 * Absolute directories whose events are dropped entirely. The extension
	 * passes the engine's storage dir when it points INSIDE the checkout:
	 * every reindex rewrites `manifest.json` there unconditionally, so
	 * without this exclusion a watcher kick would re-trigger itself forever
	 * after source edits stop (PR #15 review, #12).
	 */
	ignorePaths?: readonly string[];
}

export class ProjectWatcher {
	private watcher: fs.FSWatcher | null = null;
	private debounceTimer: NodeJS.Timeout | null = null;
	private stopped = false;
	private watchRoot: string | null = null;
	private readonly ignoreSet: Set<string>;
	private ignorePaths: string[] = [];

	constructor(
		readonly dir: string,
		private readonly options: ProjectWatcherOptions,
	) {
		this.ignoreSet = new Set(options.ignoreSegments ?? DEFAULT_IGNORE);
	}

	/** True while an OS watch handle is held. */
	get watching(): boolean {
		return this.watcher !== null;
	}

	/** Start watching. Returns false (after reporting via `onError`) when the watch could not be established — never throws. */
	start(): boolean {
		if (this.watcher) return true;
		let watcher: fs.FSWatcher;
		try {
			// Canonicalize 8.3 short names first: on Windows,
			// fs.watch({recursive}) hits an uncatchable libuv assertion
			// (fs-event.c: `filename` vs watched dir prefix mismatch) that ABORTS
			// the whole host process when the watched path has short-name
			// components (common for os.tmpdir() and some tool-set cwds) and an
			// event then reports the long name. realpathSync.native returns the
			// canonical long path and avoids the mismatch entirely.
			const dir = fs.realpathSync.native(this.dir);
			this.watchRoot = dir;
			this.ignorePaths = (this.options.ignorePaths ?? []).map((p) => {
				try {
					return fs.realpathSync.native(p);
				} catch {
					return path.resolve(p);
				}
			});
			watcher = fs.watch(dir, { recursive: true }, (_event, filename) => this.onEvent(filename));
		} catch (err) {
			this.options.onError?.(err as Error);
			return false;
		}
		this.watcher = watcher;
		watcher.on("error", (err) => {
			// E.g. inotify watch exhaustion on huge Linux trees. Close and let
			// the caller degrade to session-start/lazy indexing — a watcher
			// problem must never crash or stall the session.
			this.closeWatcher();
			if (!this.stopped) this.options.onError?.(err);
		});
		// Never keep the host process alive just for indexing.
		watcher.unref?.();
		return true;
	}

	private onEvent(filename: string | Buffer | null): void {
		if (this.stopped || !this.watcher) return;
		// No filename (happens, e.g. Linux inotify): cannot filter — a missed
		// event is the unrecoverable failure mode, so accept and debounce it.
		if (filename === null) {
			this.scheduleKick();
			return;
		}
		const name = Buffer.isBuffer(filename) ? filename.toString("utf-8") : filename;
		if (name !== "" && this.isNoise(name)) return;
		this.scheduleKick();
	}

	/**
	 * Mirrors the walker's inclusion policy (see header): case-sensitive
	 * segment match at any depth, root-only names only for the FIRST segment,
	 * and explicit storage-dir path exclusion. Returns "noise" = drop event.
	 */
	private isNoise(filename: string): boolean {
		const rel = this.relativeToRoot(filename);
		if (rel === null) return false; // absolute path outside the watch root: be conservative, kick
		const segments = rel.split(/[\\/]/).filter((s) => s !== "");
		if (segments.length === 0) return false;
		// Root-only names (`storage`, `logs`, `tmp`, ...) count only at the
		// project root — nested `src/storage/` is real source the pipeline
		// indexes, so its events must kick (PR #15 review).
		if (ROOT_ONLY_SET.has(segments[0]!)) return true;
		// Case-SENSITIVE like `ignoreSet.has(seg)`: the pipeline indexes
		// `src/Build/`, so its events must not be dropped (PR #15 review).
		if (segments.some((s) => this.ignoreSet.has(s))) return true;
		return this.isUnderIgnoredPath(rel);
	}

	/** Relative path from the watch root, or null when outside/unknown. */
	private relativeToRoot(filename: string): string | null {
		if (!path.isAbsolute(filename)) return filename;
		const rel = path.relative(this.watchRoot ?? this.dir, filename);
		if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
		return rel;
	}

	/** True when the event's resolved path lives under an ignored dir (e.g. an in-project storage dir). */
	private isUnderIgnoredPath(rel: string): boolean {
		if (this.ignorePaths.length === 0 || this.watchRoot === null) return false;
		const abs = path.resolve(this.watchRoot, rel);
		const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
		const absFolded = fold(abs);
		return this.ignorePaths.some((p) => {
			const ignored = fold(p);
			return absFolded === ignored || absFolded.startsWith(ignored + path.sep);
		});
	}

	private scheduleKick(): void {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			// `stopped` mid-debounce, or the watcher died (error path) while
			// the timer was pending: no kick.
			if (this.stopped || !this.watcher) return;
			this.options.onChange();
		}, this.options.debounceMs ?? WATCH_DEBOUNCE_MS);
		this.debounceTimer.unref?.();
	}

	/** Stop watching and cancel any pending debounced kick. Idempotent. */
	stop(): void {
		this.stopped = true;
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		this.closeWatcher();
	}

	private closeWatcher(): void {
		try {
			this.watcher?.close();
		} catch {
			// already closed by the runtime
		}
		this.watcher = null;
	}
}
