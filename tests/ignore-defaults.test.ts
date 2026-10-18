/**
 * Default-ignore semantics for ambiguous directory names (bug fix found by the
 * R4 eval harness): `storage`, `logs`, `tmp`, `temp` and `env` are ignored at
 * the project ROOT only. At any depth they silently hid real source trees:
 * this package's own `src/storage/*.ts` was invisible to search until the fix.
 */
import { afterAll, describe, expect, it } from "vitest";
import path from "node:path";
import { ContextEngine } from "../src/engine.js";
import { defaultConfig, DEFAULT_IGNORE, ROOT_ONLY_IGNORE, type Config } from "../src/config.js";
import { LocalBackend } from "../src/storage/local-backend.js";
import { makeFakeEmbedder, makeTempDir, rmrf, writeFiles } from "./helpers.js";

const tempDirs: string[] = [];
const engines: ContextEngine[] = [];

afterAll(async () => {
	await Promise.all(engines.map((engine) => engine.shutdown().catch(() => undefined)));
	for (const dir of tempDirs) rmrf(dir);
});

async function harness(repo: Record<string, string>): Promise<{ engine: ContextEngine; projectDir: string }> {
	const projectDir = makeTempDir("pce-ignore-");
	tempDirs.push(projectDir);
	writeFiles(projectDir, repo);
	const storageRoot = makeTempDir("pce-store-");
	tempDirs.push(storageRoot);
	const config: Config = { ...defaultConfig(), storagePath: storageRoot };
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
	return { engine, projectDir };
}

describe("default ignore: ambiguous names are root-only", () => {
	it("keeps the root-only names out of the any-depth ignore list", () => {
		for (const name of ["storage", "logs", "tmp", "temp", "env"]) {
			expect(ROOT_ONLY_IGNORE).toContain(name);
			expect(DEFAULT_IGNORE).not.toContain(name);
		}
	});

	it("indexes nested source dirs but skips the root junk dirs", async () => {
		const { engine } = await harness({
			"src/storage/store.ts": "export function storeIt() {\n  return 1;\n}\n",
			"src/logs/app.ts": "export function logApp() {\n  return 2;\n}\n",
			"src/env/config.ts": "export const envFlag = true;\n",
			"storage/junk.txt": "root junk dump\n",
			"logs/junk.txt": "root log dump\n",
			"tmp/junk.txt": "root tmp dump\n",
			"temp/junk.txt": "root temp dump\n",
		});
		const result = await engine.reindex({});
		expect(result.errors).toEqual([]);
		const files = Object.keys(engine.backend.fileChunkCounts());
		expect(files).toContain("src/storage/store.ts");
		expect(files).toContain("src/logs/app.ts");
		expect(files).toContain("src/env/config.ts");
		expect(files.filter((f) => /^(storage|logs|tmp|temp)\//.test(f))).toEqual([]);
	});

	it("still skips build artifacts at any depth", async () => {
		const { engine } = await harness({
			"src/build/artifact.ts": "export const generated = 1;\n",
			"packages/a/dist/bundle.js": "export const bundled = 1;\n",
			"src/app.ts": "export const app = 1;\n",
		});
		await engine.reindex({});
		const files = Object.keys(engine.backend.fileChunkCounts());
		expect(files).toContain("src/app.ts");
		expect(files.filter((f) => /(^|\/)(build|dist)\//.test(f))).toEqual([]);
	});

	it("applies the same root rule to directory and file targets", async () => {
		const { engine, projectDir } = await harness({
			"src/storage/store.ts": "export function storeIt() {\n  return 1;\n}\n",
			"storage/junk.txt": "root junk dump\n",
		});
		const nested = await engine.reindex({ targetPath: "src/storage" });
		expect(nested.indexed).toBe(1);

		const root = await engine.reindex({ targetPath: path.join("storage") });
		expect(root.indexed).toBe(0);
		expect(root.skipped).toBe(1);

		const rootFile = await engine.reindex({ targetPath: "storage/junk.txt" });
		expect(rootFile.indexed).toBe(0);
		expect(rootFile.skipped).toBe(1);
	});
});
