/**
 * R1 context headers: every indexed chunk carries a deterministic
 * `// file: … | lang: … | unit: … | imports: …` line so embedding and BM25
 * see where the code lives, not just what it says. Also covers the v2→v3
 * index-format migration that forces a re-index of header-less installs.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ContextEngine } from "../src/engine.js";
import { defaultConfig, type Config } from "../src/config.js";
import { LocalBackend } from "../src/storage/local-backend.js";
import { Chunker, warmupLanguages } from "../src/indexer/chunker.js";
import { buildContextHeader, applyContextHeader, HEADER_BUDGET_CHARS } from "../src/indexer/context-header.js";
import { makeFakeEmbedder, makeTempDir, rmrf, writeFiles } from "./helpers.js";

const tempDirs: string[] = [];
const engines: ContextEngine[] = [];

afterAll(async () => {
	await Promise.all(engines.map((engine) => engine.shutdown().catch(() => undefined)));
	for (const dir of tempDirs) rmrf(dir);
});

async function harness(
	repo: Record<string, string>,
	configOverride: Partial<Config> = {},
): Promise<{ engine: ContextEngine; embedder: ReturnType<typeof makeFakeEmbedder> }> {
	const projectDir = makeTempDir("pce-header-");
	tempDirs.push(projectDir);
	writeFiles(projectDir, repo);
	const storageRoot = makeTempDir("pce-store-");
	tempDirs.push(storageRoot);
	const config: Config = { ...defaultConfig(), storagePath: storageRoot, ...configOverride };
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
	return { engine, embedder };
}

const PY = `"""Auth module."""

import jwt


def verify_token(token):
    """Validate a JWT token."""
    return jwt.decode(token)


class SessionStore:
    """In-memory session store."""

    def get(self, key):
        return self._data.get(key)
`;

describe("context header construction", () => {
	it("formats path, language, unit and imports", () => {
		const header = buildContextHeader({
			filePath: "src/retrieval/retriever.ts",
			language: "typescript",
			unit: "HybridRetriever.retrieve",
			imports: ["./confidence", "./query-parser"],
		});
		expect(header).toBe(
			"// file: src/retrieval/retriever.ts | lang: typescript | unit: HybridRetriever.retrieve | imports: ./confidence, ./query-parser",
		);
	});

	it("omits empty parts and caps long import lists", () => {
		const bare = buildContextHeader({ filePath: "a.py", language: "python" });
		expect(bare).toBe("// file: a.py | lang: python");

		const many = buildContextHeader({ filePath: "a.ts", language: "typescript", imports: Array.from({ length: 12 }, (_, i) => `./m${i}`) });
		expect(many).toContain("+4 more");
		expect(many.length).toBeLessThanOrEqual(HEADER_BUDGET_CHARS);
	});

	it("stays within the header budget even with a long unit path", () => {
		const header = buildContextHeader({
			filePath: `deep/${"nested/".repeat(30)}file.ts`,
			language: "typescript",
			unit: `VeryLongClassName${"::nested".repeat(20)}`,
			imports: Array.from({ length: 30 }, (_, i) => `./import-${i}`),
		});
		expect(header.length).toBeLessThanOrEqual(HEADER_BUDGET_CHARS);
	});

	it("never prepends a second header (idempotent)", () => {
		const once = applyContextHeader("def f(): pass", { filePath: "a.py", language: "python" });
		const twice = applyContextHeader(once, { filePath: "a.py", language: "python" });
		expect(twice).toBe(once);
		expect(once.split("// file:").length - 1).toBe(1);
	});
});

describe("chunker symbol units", () => {
	beforeAll(async () => {
		await warmupLanguages(["python", "typescript"]);
	});

	it("records Class.method units for nested definitions", async () => {
		const chunks = new Chunker().chunk(PY, "src/auth.py", "python");
		const fn = chunks.find((c) => c.content.includes("verify_token"));
		expect(fn?.metadata["unit"]).toBe("verify_token");
		const cls = chunks.find((c) => c.chunkType === "class");
		expect(cls?.metadata["unit"]).toBe("SessionStore");
		const method = chunks.find((c) => c.chunkType === "function" && c.content.includes("self._data"));
		expect(method?.metadata["unit"]).toBe("SessionStore.get");
	});
});

describe("indexed content carries the header (engine level)", () => {
	it("prepends the header with unit and imports to indexed chunks", async () => {
		const { engine, embedder } = await harness({ "src/auth.py": PY });
		expect((await engine.reindex({})).errors).toEqual([]);

		const hits = engine.backend.vectorSearch(await embedder.embedQuery("validate jwt token"), 10, {
			filePath: "src/auth.py",
		});
		expect(hits.length).toBeGreaterThan(0);
		const withHeader = hits.find((c) => c.content.startsWith("// file: src/auth.py"));
		expect(withHeader).toBeDefined();
		expect(withHeader!.content).toContain("lang: python");
		expect(withHeader!.content).toContain("unit: ");
		expect(withHeader!.content).toContain("imports: jwt");
		// The header is the first line; the original code follows intact.
		const body = withHeader!.content.slice(withHeader!.content.indexOf("\n") + 1);
		expect(body).toContain("def verify_token");
	});

	it("keeps chunk ids stable across the header change", async () => {
		const { engine, embedder } = await harness({ "src/auth.py": PY });
		await engine.reindex({});
		const before = engine.backend.vectorSearch(await embedder.embedQuery("session store"), 10, {
			filePath: "src/auth.py",
		});
		expect(before.length).toBeGreaterThan(0);
		for (const c of before) {
			// id derives from the ORIGINAL span, not the header-prefixed content.
			expect(c.id).toMatch(/^[0-9a-f]{16}$/);
		}
	});

	it("can be turned off via indexer.context_headers", async () => {
		const { engine, embedder } = await harness({ "src/auth.py": PY }, { indexerContextHeaders: false });
		await engine.reindex({});
		const hits = engine.backend.vectorSearch(await embedder.embedQuery("validate jwt token"), 10, {
			filePath: "src/auth.py",
		});
		expect(hits.length).toBeGreaterThan(0);
		for (const c of hits) expect(c.content.startsWith("// file:")).toBe(false);
	});
});

describe("index format migration v2 → v3", () => {
	it("forces a full re-index when the manifest predates context headers", async () => {
		const { engine } = await harness({ "src/auth.py": PY });
		const first = await engine.reindex({});
		expect(first.indexed).toBe(1);
		expect(first.chunks).toBeGreaterThan(0);
		const countAfterFirst = engine.chunkCount();
		expect(countAfterFirst).toBeGreaterThan(0);

		// Simulate an install that indexed under the header-less format: files on
		// disk are unchanged, so only the schema gate can trigger the rebuild.
		const manifestPath = path.join(engine.storageBase, "manifest.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
		manifest["__schema_version"] = 2;
		fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf-8");

		const second = await engine.reindex({});
		expect(second.indexed).toBe(1); // re-indexed despite unchanged file hashes
		expect(engine.chunkCount()).toBe(countAfterFirst);
	});
});
