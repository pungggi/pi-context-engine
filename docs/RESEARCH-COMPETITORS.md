# Competitor comparison and the prose (non-code) gap

Status: living design and implementation record. Shipped: P0/P1 prose
chunking (2026-10-25), WP2 symbol PageRank ordering and P2.A doc-graph edges
(2026-10-26). Pending: the rest of §4. Date: 2026-10-25.

Companion to `docs/RESEARCH-RETRIEVAL.md`, which reviews the retrieval
literature for **code**. This file answers two questions:

1. What do competitors do better than pi-context-engine for coding context?
2. Could we serve **normal text** (Markdown, notes, docs) better, not just code?

---

## 1. Where we stand vs competitors (coding)

**Sources**: Cursor indexing deep-dive (Bito, 2026), Continue.dev docs, aider
repo-map articles, Cody/Sourcegraph material, Greptile pages, Anthropic
"Contextual Retrieval" (2024). See §5 for links.

### What we already match or beat

| Area | pi-context-engine | Competitor reference |
|---|---|---|
| Retrieval | hybrid vector + BM25 + RRF, confidence scores, opt-in rerank | Cursor uses the same hybrid split; Cody **dropped embeddings entirely** (2024) and runs BM25/regex only |
| Chunking | tree-sitter AST chunks (9 languages) + module parent, small-to-big serve | Cursor: tree-sitter AST, ~500-token sibling-merged chunks |
| Sync | content-hash incremental reindex + watcher + manifest checkpoints | Cursor: Merkle tree, but on a ~5 min cloud sync cadence; ours is local and instant |
| Memory | decisions, code areas, turn summaries, PII-scrubbed, linked recall | Most OSS competitors (aider, Cline) have none; closest is Windsurf Memories (automatic, opaque) |
| Privacy | fully local, no API keys, secret/PII guards, file budget | Cursor embeds on their servers (paths obfuscated); Greptile/Cody are hosted |
| Maturity | measured 97% token savings, 76-query eval suite, dashboard, warmup command, resume-after-interrupt | Many competitors publish no measurable quality numbers at all |

**Why this matters**: for a local, per-session tool we are not behind on the
core retrieval design. The gap is in *breadth of context sources* and in
*prose handling*, not in the code pipeline.

### What competitors do better

- **Cursor: @Docs and Notepads.** Persistent reference documents and indexed
  external documentation sites. We only index the repo.
- **Continue.dev: context-provider breadth.** `@web`, `@pdf`, `@diff`,
  `@terminal`, `@issue` and more. **Deliberately not our gap** (user decision,
  2026-10-25): other pi packages and solutions already provide these sources.
  Our context stays "index + memory", plus indexed third-party docs if the
  @Docs-with-proposal idea gets built (§4).
- **Aider: PageRank repo map.** Ranks symbols by graph centrality inside a
  token budget. **Matched 2026-10-25 (WP2)**: file-level was already there
  (`computePageRank()`, R7, retriever prior), and `computeSymbolPageRank()`
  now ranks individual symbols over the `calls`/`defines` graph, ordering
  `related_context` neighbours hub-first (deterministic tie-break, same
  lifecycle as file ranks: recompute after indexing, delete with the file).
  Still open: the token-budget "repo map" *view* (a ranked symbol-signature
  list for architecture questions). Opened 2026-10-26 as WP4 in the §4
  sequence (user decision; the earlier "only if eval asks" gate was waived).
- **Greptile / Potpie: agentic retrieval.** Iterative query loops over a full
  codebase graph, wired into PR review. Our search is one-shot with refine
  hints instead.
- **Zed: indexed file summaries.** LLM-generated per-file summaries are
  retrievable units, which helps "how does this system work" questions.
  We compress at serve time, never at index time.
- **Cody: org-wide remote search.** Multi-repo search via Sourcegraph. We are
  single-project by design (per-project storage), which is a deliberate local
  tradeoff, not a defect.
- **Cursor: proprietary code-tuned embeddings.** Trained on agent session
  data. We counter with a configurable model and the measured `jina-code`
  option, which is the honest local equivalent.

**Tradeoff call**: remote multi-repo and hosted graph reviews are
product-scope features (cloud, accounts, editor plugins) and stay out. External
docs indexing is the one competitor feature still worth a design decision,
because the agent-proposed flow is not something Cursor/Continue do. The rest
(centrality ranking, summary chunks) were candidates only if eval shows a win.
(2026-10-26: superseded. The user opened every remaining candidate including
@Docs for implementation; §4 holds the sequence and per-item eval gates.)

---

## 2. The prose gap: how non-code text is handled today

Facts verified in this repo:

- **One chunk per file.** Any non-AST language (Markdown, YAML, JSON, plain
  text, ...) takes the fallback path in `src/indexer/pipeline.ts`
  (`_fallback_chunk` port): the whole file becomes a single `module` chunk.
- **The vector only sees the file head.** `MAX_EMBED_CHARS = 2000` in
  `src/indexer/embedder.ts` pre-truncates embeddings. For a 50 KB notes file,
  the embedding represents roughly the first screen; everything below is
  invisible to semantic search. BM25 still covers the full text, so exact
  phrases work but concept queries into section 10 do not.
- **Small-to-big degenerates.** `retrieval.expand_context` serves a hit's
  module parent, but for prose the hit *is* the whole file, so there is no
  finer context to expand from.
- **No graph signal** (fixed 2026-10-26, §4 P2.A): prose files had no
  import edges, so `related_context` always fell back to file level. Markdown
  links now become `references` edges, so notes reach the pages they cite.
- **Prose is unmeasured.** `tests/eval/queries.jsonl` has 76 queries, **0**
  targeting `.md` or docs paths. The README quality numbers are code-only.
- **No markdown parser available.** `tree-sitter-wasms` ships no markdown
  grammar (checked), so a regex heading splitter is the zero-dependency path.

**What this means in practice**: prose is searchable today (BM25 carries it),
but the semantic half of the hybrid is near-blind past 2 000 chars and every
hit is a whole file. That is the exact failure mode competitors' header-aware
chunkers avoid.

---

## 3. What the evidence says improves prose retrieval

- **Header-aware chunking wins for Markdown.** Snowflake's RAG study found
  markdown-header-based chunking the best of the "vanilla" strategies;
  the common recipe is 256-512-token sections with 10-20% overlap. Splitting
  on headings keeps each chunk a semantically complete section, so its
  embedding represents one topic instead of a file intro.
- **Contextual retrieval is the biggest cheap win.** Anthropic measured a
  **49% cut in failed retrievals** by prepending 50-100 tokens of
  chunk-specific context before embedding *and* BM25 indexing (**67%** with
  reranking). We already do a deterministic version of this for code via
  `indexer.context_headers`; prose just needs the heading path added.
- **Parent-child retrieval.** Index small sections for precision, serve the
  parent (whole section or file) for context. Our `expand_context` machinery
  already implements this pattern for AST files; prose needs chunk
  granularity first, then the same mechanism works as-is.
- **Semantic chunking** (embedding-similarity breakpoints) helps unstructured
  text with no headings, at the cost of an extra embedding pass per file.
  Keep it as a fallback, not the default.
- **RAPTOR / summary trees** help long-document questions that span many
  chunks. Better as an opt-in phase: it needs an LLM at index time.

---

## 4. Proposed plan (prose in the indexed repo)

### P0: section chunking for prose, measured — **implemented 2026-10-25**

Measured A/B on the 89-query eval suite (13 new `prose` queries over this
repo's own docs), same query set before/after:

| metric | before (whole-file fallback) | after (sections) |
|---|---|---|
| prose R@10 (real ONNX embedder) | **0.000** | **0.462** |
| prose nDCG@10 (real embedder) | 0.000 | 0.263 |
| prose R@10 (deterministic embedder) | 0.308 | 0.462 |
| overall R@10 (real embedder) | 0.755 | 0.843 |
| overall nDCG@10 (real embedder) | 0.674 | 0.732 |

- **A. Markdown section chunker.** `src/indexer/prose-chunker.ts` splits on
  ATX headings (fence- and frontmatter-aware), packs sections to
  `indexer.chunk_budget_chars` at paragraph boundaries with line windows for
  oversize paragraphs, records `startLine`/`endLine`, and adds a heading-outline
  `module` parent for small-to-big. Plain text packs by paragraph; files that
  pack to one chunk keep the byte-identical legacy whole-file chunk.
- **B. Heading breadcrumb in the context header.** The section's heading path
  (`Guide > Setup > Windows`) rides `metadata.unit` into the existing
  `indexer.context_headers` line (`file: … | lang: … | unit: …`). This is
  deterministic contextual retrieval: it lands in both the embedding and the
  FTS row, at zero model cost, and reuses config already in place.
- **C. Prose eval slice.** 13 labeled queries (`kind: "prose"`) over this
  repo's own `docs/*.md` and README-family files live in `tests/eval/`
  (harness `QueryKind` gained `prose`), reported as their own slice. The
  pre-change baseline was recorded with the same query set, so the gate below
  is a true A/B.

**Why P0 first**: it fixes precision, the embedder's 2 000-char blindness,
and the degenerate small-to-big case in one change, with no new dependencies.

### P1: index-format invalidation — **resolved in the same change**

- **Chunk-format version bumped**: `CURRENT_SCHEMA_VERSION` 3 → 4
  (`src/indexer/manifest.ts`). The manifest skips files whose content hash is
  unchanged, so without the bump already-indexed prose would never re-chunk;
  the bump rides the existing store-reset path (wipe index stores, keep
  memory, full rebuild, manifest saved only once at the end).
- **`chunkType` decision: `doc` for sections.** It already exists in the
  `ChunkType`/`NodeType` unions (AST-density trivia uses it), it is *not*
  exempted from overlap dedupe (unlike `module`), and it maps to graph node
  type `doc` with zero storage migration. The outline parent stays `module`,
  which is what the retriever's parent lookup and dedupe exemption key on.

### P2: follow-ups — opened for implementation 2026-10-26, each with its own eval A/B

The earlier "only if eval asks" gate was waived by the user; the order below
is the agreed sequence (small and evidence-backed first).

- **A. File-level prose graph edges** — **implemented 2026-10-26 (WP3)**.
  Section (heading) chunks and legacy whole-file note chunks emit a
  `references` edge to every indexed file their Markdown links resolve to:
  - **Covered links**: inline `[text](other.md)` / `![img](...)` and
    reference definitions `[label]: dest`; `..`, root-`/` and %-encoded
    targets; `#fragment` and `?query` are stripped before resolution.
    Destinations are read with a two-phase scan (destination first, then
    the optional title), so balanced parens in either survive
    (`./guide(v2).md`, `./hub.md "Hub (draft")`), and CommonMark
    backslash escapes (`./guide\(v2\).md`) unescape before the lookup.
  - **Skipped**: URL schemes, pure anchors, self-links and targets that are
    not indexed; example links inside fences, frontmatter, multi-line and
    inline code spans, indented code blocks, and escaped `\[` never become
    edges (the block mask mirrors the heading detector).
  - **Prose only**: a doc-link string inside a code file stays out of the
    graph, so the code calls/imports projection keeps its meaning.
  - **Derivation order**: links are derived AFTER all batches, over every
    indexed prose file, from a fence-aware scan of the RAW file with line
    attribution back into chunks (mirrors the calls-derivation design; the
    owner is the TIGHTEST covering chunk, so the whole-file outline parent
    cannot steal a section's links). The pass replaces rather than adds
    (drop + re-insert), so links that vanish from the source cannot linger,
    and it honors the batch path's `MAX_FILE_BYTES` guard. That survives
    fences split across chunk windows and heals links whose target file
    appears on a later run, without a source edit.
  - **Why it helps**: the edges ride three existing consumers unchanged:
    `related_context`'s neighbour lookup, `getRelatedFilePaths` (retriever
    1-hop expansion and the file-level fallback), and both PageRank tables,
    so a note linked from many notes gains hub signal like an imported code
    file does.

  A/B on the 89-query suite (same query set before/after; the ±0.05 gate
  passed on both backends):

  | metric | before | after |
  |---|---|---|
  | overall R@10 (fake backend = committed gate) | 0.830 | 0.852 |
  | prose nDCG@10 (fake) | 0.269 | 0.307 |
  | overall R@10 (real ONNX embedder) | 0.800 | 0.826 |
  | overall nDCG@10 (real ONNX) | 0.682 | 0.723 |
  | prose R@10 (real ONNX) | 0.308 | 0.385 |
  | prose nDCG@10 (real ONNX) | 0.200 | 0.328 |
  | distraction@10 (real ONNX, lower is better) | 0.733 | 0.712 |

  The prose slice moves the most (nDCG +0.128 on the real embedder): linked
  pages now expand into each other, which is exactly what whole-file notes
  could not do before. The direct win stays `related_context` on a note
  returning its linked pages instead of "No related context found".

- **B. Summary chunk per large prose file**, generated via Ollama at index time
  (Zed-style), behind a config flag: costs an LLM call per changed file.
- **C. Semantic chunking** for heading-less unstructured text, behind a flag.

### What we deliberately do not chase

- **Context providers (`@web`, `@pdf`, `@diff`, `@terminal`)**: covered by
  other pi packages/solutions, not by this engine (user decision, 2026-10-25).
- **Remote multi-repo search (Cody-style) and hosted graph reviews**: product
  scope of cloud tools; out of local pi scope.
- **Not decided yet**: @Docs-style indexing of external doc sites with the
  agent proposing new sources on low retrieval confidence. Design discussed
  2026-10-25 (separate docs corpus under `~/.pi-context-engine/docs/`,
  `docs_search` tool, crawl guardrails, static HTML only); awaiting a
  go/no-go before entering the plan.
- **LLM contextual retrieval**: Anthropic's prompt-per-chunk costs an LLM
  call per chunk at index time. The deterministic heading breadcrumb (P0.B)
  captures most of the benefit for free; revisit only if eval plateaus.

---

## 5. Sources

- How Cursor's codebase indexing works (Bito, 2026):
  https://bito.ai/blog/how-cursors-codebase-indexing-works-2026-guide/
- Anthropic, Introducing Contextual Retrieval (49% / 67% fewer failed
  retrievals): https://www.anthropic.com/engineering/contextual-retrieval
- Snowflake, retrieval & chunking impact study (markdown-header chunking
  best of vanilla strategies):
  https://www.snowflake.com/en/blog/engineering/impact-retrieval-chunking-finance-rag/
- aider, Building a better repository map with tree-sitter (PageRank map):
  https://aider.chat/2023/10/22/repomap.html
- Continue.dev context providers: https://docs.continue.dev/
- Cody dropped embeddings for search (2024 analysis):
  https://www.desplega.ai/blog/deep-dive-continue-vs-cody-index
- RAPTOR (recursive summarization trees): https://arxiv.org/abs/2401.18059
- Chunks of RAG strategy survey (header-aware chunking recipe):
  https://www.context.dev/blog/how-to-scrape-websites-into-llm-ready-markdown-for-rag-pipelines
