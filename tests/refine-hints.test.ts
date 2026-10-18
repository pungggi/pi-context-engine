/**
 * R9: refine suggestions — a single `[refine: ...]` line per search result
 * pointing at the next query candidates the retriever can already see.
 * - max 3 items, ≤160 chars (≤40 tokens);
 * - never suggests a file that was already served;
 * - fully disabled by `retrieval.refine_hints: false`.
 */
import { afterAll, describe, expect, it } from "vitest";
import { ContextEngine } from "../src/engine.js";
import { defaultConfig, type Config } from "../src/config.js";
import { LocalBackend } from "../src/storage/local-backend.js";
import { makeFakeEmbedder, makeTempDir, rmrf, writeFiles } from "./helpers.js";

const dirs: string[] = [];
const engines: ContextEngine[] = [];

afterAll(async () => {
	await Promise.all(engines.map((e) => e.shutdown().catch(() => undefined)));
	for (const d of dirs.splice(0)) rmrf(d);
});

const FILES: Record<string, string> = {};
// Enough files for near-miss ranks to be non-trivial.
for (let i = 0; i < 14; i++) {
	FILES[`src/mod${i}.ts`] = `export function mod${i}Work(input: number): number {\n  return input * ${i + 1};\n}\n\nexport function mod${i}Helper(text: string): string {\n  return text.trim().toUpperCase();\n}\n`;
}

async function setup(overrides: Partial<Config> = {}): Promise<ContextEngine> {
	const projectDir = makeTempDir("pce-r9-");
	dirs.push(projectDir);
	writeFiles(projectDir, FILES);
	const storageRoot = makeTempDir("pce-r9store-");
	dirs.push(storageRoot);
	const config: Config = { ...defaultConfig(), storagePath: storageRoot, ...overrides };
	const backend = new LocalBackend(storageRoot);
	const engine = new ContextEngine({ projectDir, config, runtime: { backend, embedder: makeFakeEmbedder() } });
	engines.push(engine);
	await engine.reindex({ full: true });
	return engine;
}

describe("R9: refine hints", () => {
	it("emits at most 3 items within the token budget", async () => {
		const engine = await setup();
		const out = await engine.search("mod0Work mod1Work mod2Work mod3Work", { topK: 4 });
		const line = out.body.split("\n").find((l) => l.startsWith("[refine:"));
		if (line) {
			const items = line.slice("[refine:".length, -1).split("·");
			expect(items.length).toBeLessThanOrEqual(3);
			expect(line.length).toBeLessThanOrEqual(160);
		} else {
			// Absence is legal (nothing useful to suggest), but then no line at all.
			expect(out.body).not.toContain("[refine:");
		}
	});

	it("never suggests a file that was already served", async () => {
		const engine = await setup();
		for (const q of ["mod0Work input multiply", "mod3Helper text uppercase", "mod9Work mod10Work"]) {
			const out = await engine.search(q, { topK: 6 });
			const served = new Set([...out.inline, ...out.overflow].map((c) => c.filePath));
			const line = out.body.split("\n").find((l) => l.startsWith("[refine:"));
			if (!line) continue;
			for (const m of line.matchAll(/file:(\S+)/g)) {
				expect(served.has(m[1]!)).toBe(false);
			}
		}
	});

	it("suggests a sibling symbol from the top hit's file", async () => {
		const engine = await setup();
		const out = await engine.search("mod0Work", { topK: 3 });
		const line = out.body.split("\n").find((l) => l.startsWith("[refine:"));
		expect(line).toBeDefined();
		// mod0.ts defines mod0Work and mod0Helper; either is a valid sibling
		// hint, but chunker fallback names like "function" never are.
		expect(line).toMatch(/mod0(Work|Helper)/);
		expect(line).not.toContain('"function"');
	});

	it("is disabled by retrieval.refine_hints: false", async () => {
		const engine = await setup({ retrievalRefineHints: false });
		const out = await engine.search("mod0Work input number", { topK: 3 });
		expect(out.body).not.toContain("[refine:");
	});
});
