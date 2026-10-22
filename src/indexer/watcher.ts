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
 */
import fs from "node:fs";
import { DEFAULT_IGNORE, ROOT_ONLY_IGNORE } from "../config.js";

/**
 * Trailing-edge debounce for watcher events: long enough that a burst
 * (editor save, `git checkout` rewriting many files) collapses into one
 * kick, short enough that retrieval catches up quickly after an edit.
 */
export const WATCH_DEBOUNCE_MS = 1500;

/**
 * Path segments whose events are dropped before debouncing. Reuses the
 * config's ignore lists so the watcher stays quiet exactly where the
 * pipeline would not index anyway (`node_modules/`, `.git/`, build output,
 * root-only `storage`/`logs`/`tmp`). Best-effort noise reduction — a wrongly
 * accepted event costs one cheap incremental run.
 */
const NOISE_SEGMENTS = new Set([...DEFAULT_IGNORE, ...ROOT_ONLY_IGNORE].map((s) => s.toLowerCase()));

export interface ProjectWatcherOptions {
	/** Called once per debounced change burst. Keep it cheap and sync. */
	onChange: () => void;
	/** Fatal watcher problem (e.g. Linux ENOSPC inotify exhaustion). The watcher closes itself; the caller falls back to session-start/lazy indexing. */
	onError?: (err: Error) => void;
	/** Defaults to {@link WATCH_DEBOUNCE_MS}. */
	debounceMs?: number;
}

export class ProjectWatcher {
	private watcher: fs.FSWatcher | null = null;
	private debounceTimer: NodeJS.Timeout | null = null;
	private stopped = false;

	constructor(
		readonly dir: string,
		private readonly options: ProjectWatcherOptions,
	) {}

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
		const name = Buffer.isBuffer(filename) ? filename.toString("utf-8") : filename;
		if (name !== null && this.isNoise(name)) return;
		this.scheduleKick();
	}

	private isNoise(filename: string): boolean {
		return filename
			.split(/[\\/]/)
			.some((segment) => segment !== "" && NOISE_SEGMENTS.has(segment.toLowerCase()));
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
