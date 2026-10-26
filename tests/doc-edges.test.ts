/**
 * WP3 doc-graph edges (docs/RESEARCH-COMPETITORS.md §4 P2):
 * markdown `[text](other.md)` references become `references` edges from the
 * prose chunk that contains them to the target file's node, so
 * `related_context` and graph expansion are no longer empty for notes.
 */
import fs from "node:fs";
import path from "node:path";
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

const FILES = {
	// Linked-to hub: no outgoing links itself.
	"docs/hub.md": "# Hub\n\nThe central page.\n",
	// Two sections so it chunks into real `doc` sections; link in the first.
	"docs/a.md": "## Setup\n\nSee [the guide](./hub.md) for details.\n\n## Detail\n\nMore text here.\n",
	// Single section (whole-file fallback chunk) with a ..-relative link plus
	// noise that must NOT produce edges: external URL, pure anchor, missing
	// file, self-link.
	"docs/b.md":
		"## Usage\n\nDeep link: [guide](../docs/hub.md#setup) and [web](https://example.com/x) and [anchor](#top) and [missing](gone.md) and [self](./b.md).\n",
	// Fenced example, inline code span, external: no valid references at all.
	"docs/noise.md":
		"## Examples\n\n```md\n[example](./hub.md)\n```\n\nInline code: `[code](./hub.md)` plus [web](https://example.com) and [top](#local).\n",
	// No headings → legacy whole-file module chunk that still gets its link.
	"docs/legacy.md": "Just a flat note with a link to [the hub](./hub.md).\n",
	// Code file containing a doc-link string: prose gate must keep it out.
	"src/weird.ts": 'export const note = "see [x](../docs/hub.md)";\n',
	// Review-fix fixtures (augment PR #28, round 1).
	"docs/victim.md": "# Victim\n\nMust never appear as a reference target.\n",
	"docs/guide(v2).md": "# Guide v2\n\nDestination with balanced parentheses.\n",
	// Oversize fence (> budget) splits across chunk windows; its last window
	// holds "[evil] ``` [good]" — per-chunk scanning would leak the example
	// AND treat the closer as an opener that hides the real link.
	"docs/bigfence.md":
		"## Big\n\n```md\n" + "x".repeat(4200) + "\n[evil](./victim.md)\n```\n[good](./hub.md)\n",
	"docs/dblb.md": "## Dbl\n\n``[evil](./victim.md)`` and [good](./hub.md)\n",
	"docs/paren.md": "## Paren\n\nSee [the guide](./guide(v2).md).\n",
};

async function setup(): Promise<{ engine: ContextEngine; backend: LocalBackend }> {
	const projectDir = makeTempDir("pce-wp3-");
	dirs.push(projectDir);
	writeFiles(projectDir, FILES);
	const storageRoot = makeTempDir("pce-wp3store-");
	dirs.push(storageRoot);
	const config: Config = { ...defaultConfig(), storagePath: storageRoot, indexerChunkBudgetChars: 500 };
	const backend = new LocalBackend(storageRoot);
	const engine = new ContextEngine({ projectDir, config, runtime: { backend, embedder: makeFakeEmbedder() } });
	engines.push(engine);
	await engine.reindex({ full: true });
	return { engine, backend };
}

describe("WP3: markdown references become graph edges", () => {
	it("gives a prose section real related_context through its link", async () => {
		const { engine, backend } = await setup();
		const aChunks = backend.chunksByFile("docs/a.md", 10);
		const section = aChunks.find((c) => c.chunkType === "doc" && c.content.includes("the guide"))!;
		expect(section).toBeDefined();
		const text = engine.relatedContext(section.id);
		expect(text).not.toContain("No related context");
		expect(text).toContain("docs/hub.md");
	});

	it("resolves ..-relative links from a whole-file fallback chunk", async () => {
		const { engine, backend } = await setup();
		const bChunks = backend.chunksByFile("docs/b.md", 10);
		const fallback = bChunks.find((c) => c.content.includes("Deep link"))!;
		const text = engine.relatedContext(fallback.id);
		expect(text).toContain("docs/hub.md");
		// The noise links on the same lines resolve to nothing: external URL,
		// pure anchor, unindexed file and the self-link must not show up.
		expect(text).not.toContain("example.com");
		expect(text).not.toContain("docs/b.md (docs/b.md)");
	});

	it("creates no edges for fenced, inline-code, external or anchor-only links", async () => {
		const { engine, backend } = await setup();
		const noise = backend.chunksByFile("docs/noise.md", 10)[0]!;
		expect(engine.relatedContext(noise.id)).toContain("No related context");
		expect(backend.getRelatedFilePaths(["docs/noise.md"])).toHaveLength(0);
	});

	it("keeps doc-link strings inside code files out of the doc graph", async () => {
		const { backend } = await setup();
		expect(backend.getRelatedFilePaths(["src/weird.ts"])).toHaveLength(0);
	});

	it("links a flat legacy note through its whole-file module chunk", async () => {
		const { engine, backend } = await setup();
		const legacy = backend.chunksByFile("docs/legacy.md", 10)[0]!;
		const text = engine.relatedContext(legacy.id);
		expect(text).toContain("docs/hub.md");
	});
});

describe("WP3: file-level expansion and priors", () => {
	it("getRelatedFilePaths reaches linked notes (retriever 1-hop expansion)", async () => {
		const { backend } = await setup();
		const related = backend.getRelatedFilePaths(["docs/a.md"]);
		expect(related).toContain("docs/hub.md");
		expect(related).not.toContain("docs/a.md");
		// The file-level related_context fallback rides the same lookup: a note
		// with no link of its own still reaches what its siblings link to.
		expect(backend.getRelatedFilePaths(["docs/noise.md"])).toHaveLength(0);
	});

	it("flows PageRank into the linked hub (prose analogue of R7)", async () => {
		const { backend } = await setup();
		const ranks = backend.pageRanks();
		const hub = ranks.get("docs/hub.md")!;
		// a, b and legacy all link to the hub; noise links nothing.
		expect(hub).toBeGreaterThan(ranks.get("docs/noise.md")!);
		expect(hub).toBeGreaterThan(ranks.get("docs/legacy.md")!);
	});
});

describe("WP3: deletion keeps reference edges consistent", () => {
	it("drops the source chunk's reference edges with its file", async () => {
		const { backend } = await setup();
		const bId = backend.chunksByFile("docs/b.md", 10)[0]!.id;
		expect(backend.graphNeighbors(bId, "references").length).toBeGreaterThan(0);
		backend.deleteByFiles(["docs/b.md"]);
		expect(backend.graphNeighbors(bId, "references")).toHaveLength(0);
		const ranks = backend.pageRanks();
		expect(ranks.has("docs/b.md")).toBe(false);
		expect(ranks.has("docs/hub.md")).toBe(true);
	});
});

describe("WP3 review fixes (augment PR #28, round 1)", () => {
	it("keeps example links inside an oversized fence that chunk windows split", async () => {
		const { backend } = await setup();
		const related = backend.getRelatedFilePaths(["docs/bigfence.md"]);
		// The split window holds "[evil] ``` [good]": per-chunk scanning would
		// leak the example and let the stray closer hide the real link. The
		// raw-file scan gets both right.
		expect(related).toContain("docs/hub.md");
		expect(related).not.toContain("docs/victim.md");
	});

	it("treats a double-backtick code span as one span (no leaked edge)", async () => {
		const { backend } = await setup();
		const related = backend.getRelatedFilePaths(["docs/dblb.md"]);
		expect(related).toContain("docs/hub.md");
		expect(related).not.toContain("docs/victim.md");
	});

	it("keeps destinations with balanced parentheses", async () => {
		const { backend } = await setup();
		expect(backend.getRelatedFilePaths(["docs/paren.md"])).toContain("docs/guide(v2).md");
	});

	it("heals a link whose target appears later, without touching the source", async () => {
		const projectDir = makeTempDir("pce-wp3defer-");
		dirs.push(projectDir);
		writeFiles(projectDir, { "docs/a.md": "## A\n\nLink to [b](./b.md), not indexed yet.\n" });
		const storageRoot = makeTempDir("pce-wp3deferstore-");
		dirs.push(storageRoot);
		const config: Config = { ...defaultConfig(), storagePath: storageRoot, indexerChunkBudgetChars: 500 };
		const backend = new LocalBackend(storageRoot);
		const engine = new ContextEngine({ projectDir, config, runtime: { backend, embedder: makeFakeEmbedder() } });
		engines.push(engine);
		await engine.reindex({ full: true });
		expect(backend.getRelatedFilePaths(["docs/a.md"])).toHaveLength(0);

		fs.writeFileSync(path.join(projectDir, "docs", "b.md"), "# B\n\nTarget page.\n");
		// Incremental: a.md is unchanged and skipped by the manifest, so only
		// the end-of-run derivation pass can heal the edge.
		await engine.reindex();
		expect(backend.getRelatedFilePaths(["docs/a.md"])).toContain("docs/b.md");
	});
});
