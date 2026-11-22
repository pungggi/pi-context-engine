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
	// Round-2 fixtures (augment PR #28, round 2).
	"docs/quoted.md": "## Q\n\nSee [q](./hub.md \"Hub (draft\") and [evil](./victim.md).\n",
	"docs/escaped.md": "## Esc\n\nSee [g](./guide\\(v2\\).md).\n",
	"docs/mlspan.md": "## ML\n\n`see\n[evil](./victim.md)\nthe example`\n\n[good](./hub.md)\n",
	"docs/indented.md": "## Ind\n\nIntro.\n\n    [evil](./victim.md)\n\n[good](./hub.md)\n",
	"docs/bracket.md": "## Br\n\n\\[evil](./victim.md) and [good](./hub.md)\n",
	// Round-3 fixtures (augment PR #28, round 3).
	// Multi-line PEM block: redaction collapses it (3 lines -> 1), shifting
	// every stored line number after it away from the raw file's.
	"docs/redacted.md":
		"## Before\n\nIntro.\n\n```\n-----BEGIN PRIVATE KEY-----\nabc123def456ghi789\n-----END PRIVATE KEY-----\n```\n\n## After\n\nSee [good](./hub.md).\n",
	"docs/wsp.md": "## W\n\nSee [w](./hub.md ) and [evil](./victim.md).\n",
	"docs/intitle.md": "## IT\n\nSee [t](./hub.md \"[evil](./victim.md)\").\n",
	"docs/escbt.md": "## EB\n\n\\`see [good](./hub.md) here\\`\n",
	// Hidden round-3 + round-4 fixtures (API pagination had capped the review
	// list at 30 comments, hiding 8 round-3 findings).
	"docs/hstop.md": "## Open\n\ntext with ` opener\n## Next\nSee [good](./hub.md) and `more`\n",
	"docs/listcont.md": "## LC\n\n- Intro\n\n    [good](./hub.md)\n",
	"docs/bqfence.md": "## BQ\n\n> ~~~md\n> [evil](./victim.md)\n> ~~~\n\n[good](./hub.md)\n",
	"docs/spancat.md": "## SC\n\n[lit]`x`(./victim.md) and [good](./hub.md)\n",
	"docs/escabel.md": "## EL\n\nSee [see \\[guide](./hub.md).\n",
	"docs/angle.md": "## Ang\n\nSee [bad](<./victim.md> text and [good](<./hub.md>).\n",
	"docs/ptitle.md": "## PT\n\nSee [p](./hub.md (Hub \\(draft)).\n",
	"docs/entity.md": "## Ent\n\nSee [e](./A&amp;B.md).\n",
	"docs/A&B.md": "# AB\n\nTarget with an ampersand.\n",
	"docs/spanesc.md": "## SE\n\n`[evil](./victim.md)\\` and [good](./hub.md).\n",
	"docs/comment.md": "## Cmt\n\n<!-- [evil](./victim.md) -->\n\n[good](./hub.md)\n",
	"docs/netpath.md": "## NP\n\nSee [x](//docs/hub.md) and [y](./victim.md).\n",
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
		// Round 2: the STEP-2 render carries the node path in parens; the
		// file-level fallback does not. If the outline parent (startLine 1,
		// endLine EOF) steals the link, this section lands on the fallback.
		expect(text).toContain("(docs/hub.md)");
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

describe("WP3 review fixes (augment PR #28, round 2)", () => {
	it("attributes a link to its own section, not the whole-file outline parent", async () => {
		const { engine, backend } = await setup();
		const section = backend
			.chunksByFile("docs/a.md", 10)
			.find((c) => c.chunkType === "doc" && c.content.includes("the guide"))!;
		const text = engine.relatedContext(section.id);
		// Step-2 neighbour render carries the node path in parens; the
		// file-level fallback does not. Parent theft lands on the fallback.
		expect(text).toContain("(docs/hub.md)");
	});

	it("reads titles with an unmatched paren before separating the destination", async () => {
		const { backend } = await setup();
		expect(backend.getRelatedFilePaths(["docs/quoted.md"])).toContain("docs/hub.md");
	});

	it("unescapes CommonMark \\( \\) destinations before the exact-path lookup", async () => {
		const { backend } = await setup();
		expect(backend.getRelatedFilePaths(["docs/escaped.md"])).toContain("docs/guide(v2).md");
	});

	it("suppresses links inside multi-line code spans", async () => {
		const { backend } = await setup();
		const related = backend.getRelatedFilePaths(["docs/mlspan.md"]);
		expect(related).toContain("docs/hub.md");
		expect(related).not.toContain("docs/victim.md");
	});

	it("suppresses links in indented code blocks after a blank line", async () => {
		const { backend } = await setup();
		const related = backend.getRelatedFilePaths(["docs/indented.md"]);
		expect(related).toContain("docs/hub.md");
		expect(related).not.toContain("docs/victim.md");
	});

	it("treats an escaped opening bracket as literal text", async () => {
		const { backend } = await setup();
		const related = backend.getRelatedFilePaths(["docs/bracket.md"]);
		expect(related).toContain("docs/hub.md");
		expect(related).not.toContain("docs/victim.md");
	});

	it("attributes links beyond a 500-chunk note to the chunk containing them", async () => {
		const projectDir = makeTempDir("pce-wp3late-");
		dirs.push(projectDir);
		const paras = Array.from({ length: 601 }, (_, i) =>
			i === 600 ? "P600: late link [late](./hub.md)" : `P${i}: ${"x".repeat(350)}`,
		);
		writeFiles(projectDir, {
			"docs/late.md": paras.join("\n\n"),
			"docs/hub.md": "# Hub\n\nTarget.\n",
		});
		const storageRoot = makeTempDir("pce-wp3latestore-");
		dirs.push(storageRoot);
		const config: Config = { ...defaultConfig(), storagePath: storageRoot, indexerChunkBudgetChars: 500 };
		const backend = new LocalBackend(storageRoot);
		const engine = new ContextEngine({ projectDir, config, runtime: { backend, embedder: makeFakeEmbedder() } });
		engines.push(engine);
		await engine.reindex({ full: true });

		const all = backend.chunksByFile("docs/late.md", 100_000);
		expect(all.length).toBeGreaterThan(500);
		const last = all[all.length - 1]!;
		expect(last.content).toContain("[late](./hub.md)");
		expect(backend.graphNeighbors(last.id, "references").length).toBeGreaterThan(0);
	});

	it("never reads a file that outgrew MAX_FILE_BYTES (keeps its old edges)", async () => {
		const projectDir = makeTempDir("pce-wp3grow-");
		dirs.push(projectDir);
		writeFiles(projectDir, {
			"docs/grow.md": "## Grow\n\nSmall [g](./hub.md) note.\n",
			"docs/hub.md": "# Hub\n\nTarget.\n",
			"docs/victim.md": "# Victim\n\nNo.\n",
		});
		const storageRoot = makeTempDir("pce-wp3growstore-");
		dirs.push(storageRoot);
		const config: Config = { ...defaultConfig(), storagePath: storageRoot, indexerChunkBudgetChars: 500 };
		const backend = new LocalBackend(storageRoot);
		const engine = new ContextEngine({ projectDir, config, runtime: { backend, embedder: makeFakeEmbedder() } });
		engines.push(engine);
		await engine.reindex({ full: true });
		expect(backend.getRelatedFilePaths(["docs/grow.md"])).toContain("docs/hub.md");

		// Grows past the 2 MiB guard and now "links" the victim: the batch path
		// rejects it via safeRead, and the derivation pass must too.
		fs.writeFileSync(
			path.join(projectDir, "docs", "grow.md"),
			"## Grow\n\n" + "y".repeat(2_200_000) + "\n[evil](./victim.md)\n",
		);
		await engine.reindex();
		const related = backend.getRelatedFilePaths(["docs/grow.md"]);
		expect(related).toContain("docs/hub.md"); // old edges kept
		expect(related).not.toContain("docs/victim.md"); // oversized content never scanned
	});

	it("drops stale edges when a source reverts while staying manifest-unchanged", async () => {
		const projectDir = makeTempDir("pce-wp3stale-");
		dirs.push(projectDir);
		writeFiles(projectDir, {
			"docs/a.md": "## A\n\nLink to [b](./b.md).\n",
			"docs/b.md": "# B\n\nTarget B.\n",
			"docs/c.md": "# C\n\nTarget C.\n",
		});
		const storageRoot = makeTempDir("pce-wp3stalestore-");
		dirs.push(storageRoot);
		const config: Config = { ...defaultConfig(), storagePath: storageRoot, indexerChunkBudgetChars: 500 };
		const backend = new LocalBackend(storageRoot);
		const engine = new ContextEngine({ projectDir, config, runtime: { backend, embedder: makeFakeEmbedder() } });
		engines.push(engine);
		await engine.reindex({ full: true });
		expect(backend.getRelatedFilePaths(["docs/a.md"])).toContain("docs/b.md");

		// a.md is edited on disk but NEVER reindexed (targeted run on c only):
		// the pass follows the raw file (b -> c) and drops the old edge.
		fs.writeFileSync(path.join(projectDir, "docs", "a.md"), "## A\n\nLink to [c](./c.md).\n");
		await engine.reindex({ targetPath: "docs/c.md" });
		let related = backend.getRelatedFilePaths(["docs/a.md"]);
		expect(related).toContain("docs/c.md");
		expect(related).not.toContain("docs/b.md");

		// Revert: a.md matches its manifest hash again, so the batch skips it —
		// without drop+re-insert the a->c edge would linger forever.
		fs.writeFileSync(path.join(projectDir, "docs", "a.md"), "## A\n\nLink to [b](./b.md).\n");
		await engine.reindex();
		related = backend.getRelatedFilePaths(["docs/a.md"]);
		expect(related).toContain("docs/b.md");
		expect(related).not.toContain("docs/c.md");
	});
});

describe("WP3 review fixes (augment PR #28, round 3)", () => {
	it("keeps line attribution stable when secret redaction collapses lines", async () => {
		const { engine, backend } = await setup();
		const section = backend
			.chunksByFile("docs/redacted.md", 10)
			.find((c) => c.chunkType === "doc" && c.content.includes("See [good]"))!;
		expect(section).toBeDefined();
		const text = engine.relatedContext(section.id);
		// Step-2 render: only the SECTION holding the edge prints the path in
		// parens. With raw-line attribution the PEM collapse (3 lines -> 1)
		// shifts this link onto the outline parent / fallback instead.
		expect(text).toContain("(docs/hub.md)");
	});

	it("accepts whitespace before the closing paren (no title)", async () => {
		const { backend } = await setup();
		const related = backend.getRelatedFilePaths(["docs/wsp.md"]);
		expect(related).toContain("docs/hub.md");
		// Sanity: the real second link on the same line still lands.
		expect(related).toContain("docs/victim.md");
	});

	it("does not rescan inside a link's title", async () => {
		const { backend } = await setup();
		const related = backend.getRelatedFilePaths(["docs/intitle.md"]);
		expect(related).toContain("docs/hub.md");
		// The title is literal text: no reference to its fake link target.
		expect(related).not.toContain("docs/victim.md");
	});

	it("keeps links between escaped backticks (\\` is literal, not a span)", async () => {
		const { backend } = await setup();
		expect(backend.getRelatedFilePaths(["docs/escbt.md"])).toContain("docs/hub.md");
	});
});

describe("WP3 review fixes (augment PR #28, hidden round-3 + round 4)", () => {
	it("stops a code-span lookahead at a heading (paragraph boundary)", async () => {
		const { backend } = await setup();
		expect(backend.getRelatedFilePaths(["docs/hstop.md"])).toContain("docs/hub.md");
	});

	it("keeps indented prose inside an open list item after a blank", async () => {
		const { backend } = await setup();
		expect(backend.getRelatedFilePaths(["docs/listcont.md"])).toContain("docs/hub.md");
	});

	it("masks blockquoted fences", async () => {
		const { backend } = await setup();
		const related = backend.getRelatedFilePaths(["docs/bqfence.md"]);
		expect(related).toContain("docs/hub.md");
		expect(related).not.toContain("docs/victim.md");
	});

	it("does not glue separated delimiters across a removed code span", async () => {
		const { backend } = await setup();
		const related = backend.getRelatedFilePaths(["docs/spancat.md"]);
		expect(related).toContain("docs/hub.md");
		expect(related).not.toContain("docs/victim.md");
	});

	it("finds an unescaped opener when the label contains an escaped bracket", async () => {
		const { backend } = await setup();
		expect(backend.getRelatedFilePaths(["docs/escabel.md"])).toContain("docs/hub.md");
	});

	it("rejects an angle-bracket destination with no closing paren", async () => {
		const { backend } = await setup();
		const related = backend.getRelatedFilePaths(["docs/angle.md"]);
		expect(related).toContain("docs/hub.md");
		expect(related).not.toContain("docs/victim.md");
	});

	it("reads a parenthesised title containing escaped parens", async () => {
		const { backend } = await setup();
		expect(backend.getRelatedFilePaths(["docs/ptitle.md"])).toContain("docs/hub.md");
	});

	it("decodes HTML entities in destinations (A&amp;B.md -> A&B.md)", async () => {
		const { backend } = await setup();
		expect(backend.getRelatedFilePaths(["docs/entity.md"])).toContain("docs/A&B.md");
	});

	it("lets an escaped backtick close an open span (escapes are literal inside)", async () => {
		const { backend } = await setup();
		const related = backend.getRelatedFilePaths(["docs/spanesc.md"]);
		expect(related).toContain("docs/hub.md");
		expect(related).not.toContain("docs/victim.md");
	});

	it("ignores links inside HTML comments", async () => {
		const { backend } = await setup();
		const related = backend.getRelatedFilePaths(["docs/comment.md"]);
		expect(related).toContain("docs/hub.md");
		expect(related).not.toContain("docs/victim.md");
	});

	it("treats //host/path as an external URL, not a local path", async () => {
		const { backend } = await setup();
		const related = backend.getRelatedFilePaths(["docs/netpath.md"]);
		expect(related).not.toContain("docs/hub.md");
		expect(related).toContain("docs/victim.md");
	});

	it("matches the batch when indexerRedactSecrets is off (raw coordinates)", async () => {
		const projectDir = makeTempDir("pce-wp3nore-");
		dirs.push(projectDir);
		writeFiles(projectDir, {
			"docs/redacted.md":
				"## Before\n\nIntro.\n\n```\n-----BEGIN PRIVATE KEY-----\nabc123def456\n-----END PRIVATE KEY-----\n```\n\n## After\nSee [good](./hub.md).\n",
			"docs/hub.md": "# Hub\n\nTarget.\n",
		});
		const storageRoot = makeTempDir("pce-wp3norestore-");
		dirs.push(storageRoot);
		const config: Config = {
			...defaultConfig(),
			storagePath: storageRoot,
			indexerChunkBudgetChars: 500,
			indexerRedactSecrets: false,
		};
		const backend = new LocalBackend(storageRoot);
		const engine = new ContextEngine({ projectDir, config, runtime: { backend, embedder: makeFakeEmbedder() } });
		engines.push(engine);
		await engine.reindex({ full: true });
		const section = backend
			.chunksByFile("docs/redacted.md", 10)
			.find((c) => c.chunkType === "doc" && c.content.includes("See [good]"))!;
		expect(section).toBeDefined();
		// The batch chunked RAW text: the pass must attribute raw lines too, or
		// the redacted coordinate (line 10) lands inside Before (1-10) instead.
		expect(engine.relatedContext(section.id)).toContain("(docs/hub.md)");
	});
});
