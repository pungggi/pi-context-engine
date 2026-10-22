import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ProjectWatcher, WATCH_DEBOUNCE_MS } from "../src/indexer/watcher.js";
import { defaultConfig, loadConfig } from "../src/config.js";
import { makeTempDir, rmrf, writeFiles } from "./helpers.js";

const tempDirs: string[] = [];
const watchers: ProjectWatcher[] = [];

afterEach(() => {
	for (const w of watchers.splice(0)) w.stop();
	for (const dir of tempDirs.splice(0)) rmrf(dir);
	vi.restoreAllMocks();
});

function watchDir(dir: string, onChange: () => void, debounceMs = 60): ProjectWatcher {
	const w = new ProjectWatcher(dir, { onChange, debounceMs });
	watchers.push(w);
	return w;
}

/** Poll until `probe` returns non-null, so timing assertions ride on real watcher delivery instead of fixed sleeps. */
async function waitFor<T>(probe: () => T | null, timeoutMs = 3000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = probe();
		if (value !== null && value !== undefined) return value;
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("ProjectWatcher", () => {
	it("debounces a change burst into one kick, then kicks again for later changes", async () => {
		const dir = makeTempDir("pce-watch-");
		tempDirs.push(dir);
		const kicks = vi.fn();
		expect(watchDir(dir, kicks).start()).toBe(true);

		// Burst: three files written in the same tick = one settled kick.
		writeFiles(dir, {
			"src/a.ts": "export const a = 1;\n",
			"src/b.ts": "export const b = 2;\n",
			"src/c.ts": "export const c = 3;\n",
		});
		await waitFor(() => (kicks.mock.calls.length >= 1 ? kicks.mock.calls.length : null));
		await sleep(250); // debounce window + delivery slack: no second kick
		expect(kicks).toHaveBeenCalledTimes(1);

		// A later, separated change is a new kick.
		writeFiles(dir, { "src/a.ts": "export const a = 42;\n" });
		await waitFor(() => (kicks.mock.calls.length >= 2 ? kicks.mock.calls.length : null));
		await sleep(250);
		expect(kicks).toHaveBeenCalledTimes(2);
	});

	it("filters noise dirs (node_modules, .git, build output) before debouncing", async () => {
		const dir = makeTempDir("pce-watch-");
		tempDirs.push(dir);
		writeFiles(dir, { "src/a.ts": "export const a = 1;\n" });
		const kicks = vi.fn();
		expect(watchDir(dir, kicks).start()).toBe(true);
		await sleep(100); // let any spurious startup events settle

		writeFiles(dir, {
			"node_modules/pkg/index.js": "module.exports = 1;\n",
			".git/HEAD": "ref: refs/heads/other\n",
			"dist/bundle.js": "console.log(1);\n",
			"package-lock.json": "{}",
		});
		await sleep(300); // well past the debounce window
		expect(kicks).not.toHaveBeenCalled();

		// A real source change still kicks.
		writeFiles(dir, { "src/a.ts": "export const a = 2;\n" });
		await waitFor(() => (kicks.mock.calls.length >= 1 ? true : null));
	});

	it("stop() cancels the pending kick and silences later events", async () => {
		const dir = makeTempDir("pce-watch-");
		tempDirs.push(dir);
		const kicks = vi.fn();
		const w = watchDir(dir, kicks);
		expect(w.start()).toBe(true);

		writeFiles(dir, { "src/a.ts": "export const a = 1;\n" });
		w.stop(); // before the debounce window elapses
		await sleep(250);
		expect(kicks).not.toHaveBeenCalled();
		expect(w.watching).toBe(false);

		writeFiles(dir, { "src/b.ts": "export const b = 1;\n" });
		await sleep(250);
		expect(kicks).not.toHaveBeenCalled();
	});

	it("start() on a missing dir reports via onError and returns false instead of throwing", () => {
		const dir = makeTempDir("pce-watch-");
		tempDirs.push(dir);
		const onChange = vi.fn();
		const onError = vi.fn();
		const w = new ProjectWatcher(path.join(dir, "does-not-exist"), { onChange, onError });
		watchers.push(w);

		expect(w.start()).toBe(false);
		expect(w.watching).toBe(false);
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("defaults the debounce to the shared WATCH_DEBOUNCE_MS constant", () => {
		// The extension relies on this default; keep it in the 1–2s band so a
		// branch checkout collapses into one kick without feeling laggy.
		expect(WATCH_DEBOUNCE_MS).toBeGreaterThanOrEqual(1000);
		expect(WATCH_DEBOUNCE_MS).toBeLessThanOrEqual(2000);
		expect(defaultConfig().indexerWatch).toBe(true);
	});
});

describe("config mapping indexer.watch", () => {
	it("maps the yaml key and defaults to true", () => {
		const globalPath = path.join(makeTempDir("pce-cfg-"), "config.yaml");
		tempDirs.push(path.dirname(globalPath));

		expect(loadConfig(globalPath).indexerWatch).toBe(true);

		fs.writeFileSync(globalPath, "indexer:\n  watch: false\n");
		expect(loadConfig(globalPath).indexerWatch).toBe(false);

		// Project config wins over global.
		fs.writeFileSync(globalPath, "indexer:\n  watch: true\n");
		const projectDir = makeTempDir("pce-cfg-proj-");
		tempDirs.push(projectDir);
		fs.writeFileSync(path.join(projectDir, ".context-engine.yaml"), "indexer:\n  watch: false\n");
		expect(loadConfig(globalPath, path.join(projectDir, ".context-engine.yaml")).indexerWatch).toBe(false);
	});
});
