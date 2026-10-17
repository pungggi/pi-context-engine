# Implementation plan: retrieval improvements

Full build plan for the recommendations in
[RESEARCH-RETRIEVAL.md](./RESEARCH-RETRIEVAL.md). Nothing here is started yet:
implementation is deliberately delayed, this document defines exactly what will
be built, in what order, and how each item is proven before its status changes.

**Why a plan first:** every item changes retrieval behavior, and our only
current metrics are token savings and latency. Building the measurement harness
before the changes lets us prove each improvement instead of guessing.

## How to use this document

- **Status legend**
  - **Not started**: planned, nothing built yet. All items are here today.
  - **Ready**: implementation can begin (dependencies met, baseline recorded).
  - **In progress**: work branch open.
  - **Review**: code done, eval deltas attached to the PR.
  - **Done**: merged, released, status table updated.
  - **Dropped**: decided against, with the reason recorded in the item.
- **Rules for flipping a status**
  1. Typecheck and unit tests pass (`npm run check`).
  2. Eval deltas (before/after) are recorded in the PR description.
  3. README and `src/config.ts` cover any new config keys.
  4. This table is updated in the same PR.
- **Every item lists**: objective, evidence, files touched, steps, tests,
  acceptance criteria, risks, dependencies, effort (S < half day, M 1-2 days,
  L 3-5 days).

---

## Status summary

| ID | Title | Phase | Priority | Effort | Status |
|----|-------|-------|----------|--------|--------|
| R4 | Labeled retrieval eval harness | 0 | P0 | M | Not started |
| R1 | Contextual chunk headers | 1 | P0 | M | Not started |
| R2 | BM25 phrases, column weights, symbol matches | 1 | P0 | S | Not started |
| R3 | Query-aware compression | 1 | P0 | M | Not started |
| R5 | Multi-path retrieval with symbol path | 2 | P1 | M | Not started |
| R6 | Small-to-big context expansion | 2 | P1 | L | Not started |
| R7 | Graph context packs + centrality prior | 2 | P1 | M | Not started |
| R8 | Query-confidence signal + optional elaboration | 2 | P1 | M | Not started |
| R9 | Refine suggestions in search results | 2 | P1 | S | Not started |
| R10 | Opt-in local reranker | 3 | P2 | M | Not started |
| R11 | Code-specialized embedder option | 3 | P2 | S | Not started |
| R12 | AST density chunking (split-merge) | 3 | P2 | L | Not started |
| R13 | Linked memory (A-MEM style) | 3 | P2 | M | Not started |

**Blocked by nothing right now:** only R4 (phase 0). Everything else waits on
R4's baseline so its impact can be measured.

**Status history**
- 2026-10-17: plan created from the research note. Implementation delayed by
  owner decision. All items set to **Not started**.

---

## Phase 0: measurement foundation

### R4. Labeled retrieval eval harness

- **Objective:** measure retrieval quality (not just tokens) so every later
  item has a before/after number.
- **Evidence:** CORE-Bench (arXiv:2606.11864) shows code-search scores overstate
  agentic usefulness; UDCG (arXiv:2510.21440) shows distracting chunks must be
  counted; Voyage reports CoSQA has ~51% bad labels, so we label our own.
- **Files:**
  - new `tests/eval/queries.jsonl` (labels)
  - new `scripts/eval-retrieval.mjs` (runner, tsx)
  - `scripts/smoke-real-world.mjs` (add a `quality` block to its report)
  - new `tests/eval/baseline.json` (recorded thresholds)
  - `package.json` (`eval` script, wire into `check`)
- **Steps:**
  1. Write 60-100 labeled queries over this repo, four kinds: exact identifier
     (`HybridRetriever`), natural language (`where is the retry logic`),
     bug-report style (paste an error string), file-name style
     (`src/retrieval/retriever.ts`). Each label lists expected file paths and,
     where easy, expected chunk line ranges.
  2. Runner indexes a fixture copy of the repo, runs each query through
     `HybridRetriever`, and computes: Recall@5, Recall@10, nDCG@10, distraction
     ratio (share of served chunks whose file is not in the label set), served
     tokens, p50/p95 latency.
  3. Implement nDCG in the script (no dependency); binary relevance is enough.
  4. Record current numbers into `baseline.json`; the runner exits non-zero on
     regression beyond a small tolerance (start at 2 points on Recall@10).
  5. Add an optional external slice later (CORE-Bench level-2 sample) as a
     separate non-gating script.
- **Tests:** runner produces stable output twice in a row; a deliberately
  broken query (random words) scores below baseline.
- **Acceptance:** `npm run eval` reports all metrics, fails on regression, and
  is documented in README's Development section.
- **Risks:** labels drift when the repo changes. Mitigation: labels point at
  files/paths, not exact line numbers, except where a test pins them.
- **Dependencies:** none. **Effort:** M.

---

## Phase 1: quick wins (P0)

### R1. Contextual chunk headers

- **Objective:** give every chunk its surrounding context before embedding and
  indexing, so "the retrieval module" style queries find `src/retrieval/*`
  code.
- **Evidence:** Anthropic Contextual Retrieval: failed retrievals −49% with
  contextual embeddings + contextual BM25; late chunking (arXiv:2409.04701)
  +2.7-3.6% nDCG from the same missing-context problem.
- **Files:**
  - `src/indexer/chunker.ts` (`nodeToChunk`, `walk`: collect enclosing class,
    imports, exported symbol names)
  - `src/types.ts` (optional `metadata.contextHeader`)
  - `src/indexer/pipeline.ts` (`embedChunks` currently embeds `c.content`)
  - `src/indexer/manifest.ts` (index format version bump)
  - `src/indexer/embedding-cache.ts` (expect full cache invalidation)
- **Steps:**
  1. Define header format, deterministic and LLM-free:
     `// file: src/retrieval/retriever.ts | lang: typescript | unit: class HybridRetriever | imports: ./confidence, ./query-parser`
     Header must respect `indexer.redact_secrets` (path only, no file body).
  2. Prepend the header in one place at chunk build time so embed, FTS and
     `expand_chunk` all see the same text. Decision: header goes into
     `content`, single source of truth, no second code path.
  3. Bump `manifest` format version so existing installs reindex automatically
     (content hash change already invalidates the embedding cache).
  4. Keep header length capped (~120 tokens) so small chunks do not become
     header-dominated.
- **Tests:** header contains file path and unit name; cap respected; redacted
  paths behave; ids stay unique (id hashes `content.slice(0,100)`, so the
  header prefix changes ids: confirm full reindex, no stale rows).
- **Acceptance:** eval shows Recall@k up or flat, no regression on identifier
  queries, latency within 10% of baseline.
- **Risks:** header noise on very small chunks; path-only leakage of private
  directory names (accepted, index is local and paths already go to FTS).
- **Dependencies:** R4 baseline. **Effort:** M.

### R2. Strengthen BM25: phrases, column weights, symbol matches

- **Objective:** make the strongest code retriever work properly for quoted
  phrases and path queries.
- **Evidence:** Finding 6 (BM25 strongest for code, arXiv:2605.14503);
  Anthropic reports contextual BM25 as the larger single jump (35% → 49%).
- **Files:** `src/storage/fts-store.ts` (`escapeFts5`, `search`),
  `src/retrieval/retriever.ts` (existing `FTS_BOOST_CODE_LOOKUP`),
  tests under `tests/`.
- **Steps:**
  1. Parse quoted spans before tokenizing; emit FTS5 phrase strings
     (`"foo bar"`) for them and keep OR-joining unquoted tokens.
  2. Add explicit `bm25()` column weights in `ORDER BY`: weight `file_path`
     highest, then `content`, then `chunk_type`; leave `language` neutral.
  3. Exact symbol shortcut: if a query token matches a chunk's symbol name
     (metadata from R1/R12, fallback regex on content), give it a deterministic
     score bonus in `retriever.ts`.
  4. Keep stopword fallback and the `code_lookup` FTS weight as they are.
- **Tests:** phrase query matches only adjacent terms; path query ranks its
  file top-3; OR behavior for unquoted terms unchanged; empty/stopword-only
  queries still return the existing fallback.
- **Acceptance:** identifier and file-name slices of the eval improve; no
  slice regresses by more than 1 point.
- **Risks:** FTS5 phrase syntax with punctuation-heavy tokens (code symbols
  contain `_`, `.`); mitigate by tokenizing phrase content the same way FTS5
  tokenizer does for indexed content.
- **Dependencies:** R4. **Effort:** S.

### R3. Query-aware compression

- **Objective:** stop cutting the lines that answer the question.
- **Evidence:** Finding 12 (aggressive compression consistently harmful,
  budget ≥ 8000, arXiv:2605.14503); SWE-Pruner (arXiv:2601.16746) 23-54% token
  cut with task-conditioned selection; LLMLingua budget controller.
- **Files:** `src/compression/compressor.ts` (`TRUNCATION_LIMITS`, prompts),
  `src/retrieval/retriever.ts` (packing uses
  `chunk.compressedContent` length), `src/config.ts`, README config block.
- **Steps:**
  1. Add `compress(content, level, query?)`. With a query: keep signature
     lines, import block, any line containing a query token or identifier, then
     apply the cap to the remainder.
  2. Pass query terms into the Ollama summary prompt (`{query}` slot) so
     summaries mention the asked-for symbols; keep the existing
     `QualityChecker` identifier-ratio gate as the safety net.
  3. `full` becomes budget-driven: no fixed cap, only the retrieval token
     budget trims it (aligns with the ≥ 8000 guidance).
  4. New config: `compression.query_aware: true` (default on), so users can
     revert to the old fixed behavior.
- **Tests:** query tokens always survive truncation; identifier ratio stays
  ≥ 0.4; without query, output is byte-identical to today (regression guard).
- **Acceptance:** at equal or lower served tokens, Recall@k does not drop; on
  the bug-report slice it rises.
- **Risks:** keeping many matched lines can exceed caps; cap logic must prefer
  matched lines over head lines, with a hard ceiling.
- **Dependencies:** R4. **Effort:** M.

---

## Phase 2: retrieval depth (P1)

### R5. Multi-path retrieval with a structured symbol path

- **Objective:** stop relying on similarity alone for "where is X defined".
- **Evidence:** CodeRAG (arXiv:2509.16112) multi-path retrieval is a core gain;
  the coding-agent preprint found production agents mix lexical, semantic and
  structural signals.
- **Files:** `src/storage/graph-store.ts` (symbol lookup), `src/retrieval/
  retriever.ts` (third RRF list), `src/retrieval/query-parser.ts` (extract
  symbol candidates), `src/storage/local-backend.ts`.
- **Steps:**
  1. Add `findSymbol(name)`: exact then case-insensitive then prefix match
     over graph node names (function/class/file nodes).
  2. Add file-path exact match as its own path using existing `fileHints`.
  3. Fuse vector, FTS and symbol results with the existing RRF (k=60); symbol
     and path lists get the same weight class as `code_lookup`'s FTS boost.
  4. Keep `MAX_CHUNKS_PER_FILE` and marginal-ratio logic after fusion.
- **Tests:** exact symbol query returns its chunk in top-3; unknown symbol
  falls back to current behavior; fusion does not double-count a chunk.
- **Acceptance:** identifier slice Recall@5 improves; general slice flat.
- **Risks:** symbol collisions across files (dedupe by file, prefer file hint).
  **Dependencies:** R4, benefits from R1 headers. **Effort:** M.

### R6. Small-to-big context expansion

- **Objective:** serve enough surrounding context per hit to answer without a
  second tool call.
- **Evidence:** cross-file context length was the dominant parameter
  (2048 → 8192 tokens = up to +4.2 points, arXiv:2605.04763); small-to-big
  retrieval is the standard fix; cAST metadata retention added +2.7 on SWE-bench.
- **Files:** `src/indexer/chunker.ts` (emit module/top-level chunks),
  `src/retrieval/retriever.ts` (expansion stage, packing),
  `src/config.ts`.
- **Steps:**
  1. Emit, for every AST file, a `module` chunk covering top-level statements,
     imports and exported names, so code outside functions is retrievable.
  2. After ranking, expand each top hit: attach the file's module chunk plus
     one neighboring chunk above/below when budget allows. Mark provenance in
     metadata (`served_via: self|module|neighbor`) for eval analysis.
  3. Expansion must run inside the `maxTokens` budget and must not break the
     marginal-ratio stop (expanded context counts as part of the parent hit).
  4. Fix the interaction with `dedupeOverlaps`: a module chunk overlaps every
     function chunk in the file and would be dropped. Exempt parent-tier chunks
     from overlap dedupe, dedupe only within a tier.
- **Tests:** module chunk survives dedupe; expansion respects budget;
  provenance recorded; concat property of module + function chunks still
  reconstructs the file.
- **Acceptance:** cross-file and NL slices improve Recall@10 and distraction
  ratio, with served tokens up by no more than the configured budget share.
- **Risks:** token creep; duplicate content between module and function chunks
  wastes budget (mitigate: serve module chunk in compressed form by default).
  **Dependencies:** R4, R3 (compression runs on expanded content). **Effort:** L.

### R7. Graph context packs with a centrality prior

- **Objective:** make the repository graph a real retrieval path, not a
  2-chunk bonus.
- **Evidence:** RepoGraph (ICLR 2025) gained +2.66/+2.34 absolute on
  SWE-bench-Lite across four systems at roughly constant cost; Aider's PageRank
  file ranking was observed working in practice.
- **Files:** `src/storage/graph-store.ts`, `src/storage/local-backend.ts`,
  `src/indexer/pipeline.ts` (compute prior at index time),
  `src/retrieval/retriever.ts`, `src/extension.ts` (`related_context` output).
- **Steps:**
  1. At index time, run a small power-iteration PageRank over the file-level
     import graph and store it as node `properties.pagerank`.
  2. In retrieval, build a context pack per top hit: the node's callers,
     callees, importers and importees with edge types and line refs, capped at
     N lines and included in the token budget.
  3. Apply centrality as a bounded prior: score multiplier in
     `[1 - p, 1 + p]` with `retrieval.graph_prior` default `0.05`. Never let it
     outrank a relevance gap larger than the prior.
  4. Extend `related_context` to return the same packs for manual drilling.
- **Tests:** pack contains at least one caller/importer on a fixture repo;
  prior is clamped to its range; graph failures stay best-effort (existing
  try/catch behavior).
- **Acceptance:** cross-file slice improves; cost per query stays within
  +20 ms of baseline warm latency.
- **Risks:** dense graphs flood the pack (cap by degree, prefer higher-ranked
  neighbors); PageRank staleness on incremental reindex (recompute per
  full index, reuse on partial).
- **Dependencies:** R4, R6 (packs ride the same budget path). **Effort:** M.

### R8. Query-confidence signal and optional elaboration

- **Objective:** tell the agent when a search was weak, and let it recover,
  without silent query rewriting.
- **Evidence:** predicted query performance correlates with answer quality
  (arXiv:2507.10411); Findings 1/2/4 (raw query wins, elaborate only when
  ambiguous, LLM rewrites drift); Search-R1 for the loop framing.
- **Files:** `src/retrieval/confidence.ts`, `src/retrieval/query-parser.ts`,
  `src/guidance.ts`, `src/extension.ts` (tool result shape), `src/config.ts`.
- **Steps:**
  1. Compute query-level signals: top final score, margin to the next distinct
     file, vector/FTS agreement (Jaccard of their top-10), candidate count.
  2. Map to `query_confidence: high|medium|low` with thresholds calibrated
     against the eval set, stored in config so they are tunable.
  3. Return the signal plus 1-3 deterministic recovery hints (add a file path,
     use an exact symbol, drop vague terms) when confidence is low.
  4. Optional elaboration behind `retrieval.auto_elaborate` (default `false`):
     generate a deterministic variant (stopword-stripped, file hints injected,
     terms from near-miss top hits), run both, fuse with RRF, always keep the
     raw query's results as primary.
  5. Document the signal and the loop in the guidance section so the agent
     knows to refine instead of re-reading files.
- **Tests:** weak synthetic query gets `low` and hints; strong identifier query
  gets `high`; elaboration never removes raw-query results; no network calls.
- **Acceptance:** guidance renders, config off switches everything off, eval
  unchanged when elaboration is disabled.
- **Risks:** noisy confidence on tiny indexes (calibrate on the fixture, floor
  the candidate count). **Dependencies:** R4. **Effort:** M.

### R9. Refine suggestions in search results

- **Objective:** turn a one-shot tool into a guided loop at near-zero token cost.
- **Evidence:** every production coding agent in the exploratory preprint
  narrows iteratively; RepoCoder's loop drives its reported gain.
- **Files:** `src/extension.ts` (result shaping), optionally
  `src/engine.ts`; guidance text in `src/guidance.ts`.
- **Steps:**
  1. From the top hits, derive up to 3 next queries: a sibling symbol from the
     same file (graph `defines` edges), a near-miss file ranked 11-15 that was
     not served, one alternate term that appears often in top hits.
  2. Emit as a single `refine:` line in the tool result; cap length.
  3. Config `retrieval.refine_hints` (default `true`), documented in README.
- **Tests:** cap of 3; never suggests a file already served; disabled by config.
- **Acceptance:** token overhead ≤ 40 tokens per call; no eval regression.
- **Risks:** hints duplicating what the agent would do anyway (measure usage in
  session telemetry later). **Dependencies:** R5, R7 for better symbol/family
  hints (can ship with weaker heuristics first). **Effort:** S.

---

## Phase 3: gated experiments (P2)

Each phase-3 item ships **behind config, default off**, and only graduates to
default-on if the eval shows a win and latency budget holds.

### R10. Opt-in local reranker

- **Objective:** test whether cross-encoder reranking helps *our* workloads.
- **Evidence is split, on purpose:** harmful for SE tasks with 815 ms GPU cost
  (Findings 10/11), a core gain in CodeRAG, −67% failures with Anthropic's
  stack. Only our eval can decide.
- **Files:** new `src/retrieval/reranker.ts`, `src/config.ts`, README.
- **Steps:**
  1. Use the already-shipped `@huggingface/transformers` for
     `text-classification` with an ONNX reranker (candidate:
     `Xenova/ms-marco-MiniLM-L-6-v2`), cached in the existing models dir.
  2. Rerank only the fused candidate list (cap 30), then re-apply path penalty,
     file diversity and marginal stop.
  3. Config: `retrieval.rerank: off | local` (default `off`),
     `retrieval.rerank_model`, `retrieval.rerank_topn`.
  4. One-time model download must be explicit (never on by default) because it
     adds ~80 MB to a package that markets "one npm command".
- **Tests:** mock pipeline ordering (no model in unit tests); opt-in path
  exercised in a smoke test with a stubbed model.
- **Acceptance:** measured eval delta (up or down) and p95 latency recorded in
  the PR; default stays `off` unless quality wins justify the download.
- **Risks:** CPU latency; ONNX export availability for the chosen model.
  **Dependencies:** R4 mandatory. **Effort:** M.

### R11. Code-specialized embedder option

- **Objective:** offer, and only recommend, a code-trained local embedder.
- **Evidence:** Findings 7/8 say scale and code-specialization did not decide
  outcomes, but CORE-Bench shows agentic retrieval is harder and in-domain
  training helped a lot.
- **Files:** `src/indexer/embedder.ts` (model list), README embedding section.
- **Steps:**
  1. Document `embedding.model: <hf-id>` with one tested code-oriented model
     and the existing general defaults.
  2. Run the eval for each backend; publish the table in README.
  3. Dimension change already forces full reindex; verify the migration path.
- **Tests:** backend selection unit test; reindex-on-dimension-change test
  (logic exists, add a regression test if missing).
- **Acceptance:** README shows measured numbers per model, not claims.
- **Dependencies:** R4. **Effort:** S.

### R12. AST density chunking (cAST-style split-merge)

- **Objective:** replace worst-measured strategy (whole function nodes) with
  budgeted, self-contained chunks.
- **Evidence:** function chunking −3.57 to −5.64 points and never
  Pareto-optimal (arXiv:2605.04763); cAST +4.3 Recall@5, +2.67 Pass@1
  (arXiv:2506.15655).
- **Files:** `src/indexer/chunker.ts` (core rework), `src/types.ts`
  (metadata: `symbol`, `parent`, `segment`), `src/config.ts`, chunk-id scheme
  in `makeChunk`.
- **Steps:**
  1. Top-down fit: a node fits if its non-whitespace chars ≤
     `indexer.chunk_budget_chars` (default ~1200, configurable).
  2. Oversized nodes split at syntactic children; only leaf-level overflow uses
     line windows. Greedy-merge small adjacent siblings up to budget.
  3. Emit module/top-level chunks (shared with R6).
  4. Preserve chunk-id uniqueness for split segments (add segment index; keep
     the upstream column-offset fix that the README documents).
  5. Keep the legacy chunker behind `indexer.chunking: legacy | ast-density`
     (default `legacy`) for A/B on the same index format.
  6. Verify the concat property: chunks concatenated reproduce the file.
- **Tests:** concat round-trip; id uniqueness on duplicate spans; budget
  respected; legacy mode byte-identical to today.
- **Acceptance:** `ast-density` wins the eval on at least Recall@10 without
  inflating chunk count beyond +30%; then flip the default in its own release.
- **Risks:** more chunks = more embeddings = slower first index (content-hash
  cache limits repeat cost); id scheme changes force a full reindex.
  **Dependencies:** R4, R6 (module chunks shared), ideally after R1 so headers
  apply to the new chunk shapes. **Effort:** L.

### R13. Linked memory (A-MEM style)

- **Objective:** make cross-session recall improve with age instead of
  degrading.
- **Evidence:** A-MEM (NeurIPS 2025): dynamic indexing, linking between
  memories and memory evolution beat fixed structures on six models.
- **Files:** `src/memory/db.ts`, `decision-extractor.ts`,
  `session-capture.ts`, `record_decision` tool surface in `extension.ts`.
- **Steps:**
  1. On `record_decision`: embed it, find top-3 past decisions above a
     similarity threshold, store `related_to` edges (new edge type alongside
     `decided`/`discussed_in`), cap links per memory.
  2. Store structured attributes on write: keywords, tags, affected files
     (files already feed `record_code_area`).
  3. Memory evolution: allow a later decision to annotate an earlier one
     (`relatedTo` tool parameter) instead of only appending rows; keep the
     original text immutable, append annotations with timestamps.
  4. Surface links in `session_recall` output so the agent can walk them.
- **Tests:** threshold and cap behavior; no self-links; redaction still applies
  before any write (PII guard must run before link text is stored).
- **Acceptance:** a seeded recall test shows linked neighbours surfacing;
  latency of `record_decision` stays under +100 ms.
- **Risks:** link noise from loose thresholds (calibrate on a fixture set).
  **Dependencies:** R4-style eval extended to memory recall. **Effort:** M.

---

## Cross-cutting work

- **Index format versioning:** R1, R6 and R12 each change on-disk content.
  Add `manifest.formatVersion`; bump it per item and force a full reindex with
  a logged migration line (the dimension-change path in `pipeline.ts` is the
  template).
- **Config surface:** new keys land in `src/config.ts`, the README
  Configuration block, and the guidance text in one PR per item. Planned keys:
  - `compression.query_aware`, `retrieval.auto_elaborate`,
    `retrieval.graph_prior`, `retrieval.refine_hints`,
    `retrieval.rerank`, `retrieval.rerank_model`, `retrieval.rerank_topn`,
    `indexer.chunk_budget_chars`, `indexer.chunking`.
- **Guidance updates:** R8 and R9 change how the agent should use the tool, so
  `src/guidance.ts` must document the confidence signal and refine hints in the
  same release, keeping the ~900-token budget.
- **Docs:** README tables (What you get, How it works, Configuration,
  Differences from upstream) updated per release; research evidence lives in
  `RESEARCH-RETRIEVAL.md`, build detail here.
- **Releases:** every item ships through a PR to `main` and a `v*.*.*` tag per
  the packages AGENTS.md recipe. Suggested grouping, adjustable once baselines
  exist:
  - **0.2.0**: R4 + R1 + R2 + R3 (measurement + phase 1), format version bump.
  - **0.3.0**: R5 + R6 + R7 (retrieval depth).
  - **0.4.0**: R8 + R9 (agentic loop).
  - **0.5.0+**: whichever of R10-R13 wins its experiment, one per release.
- **Definition of done (per item):** `npm run check` green, eval deltas in the
  PR, README/config/guidance updated, status table in this file flipped.

---

## Explicit non-goals

Recorded so they are not re-litigated later:

- **No always-on LLM query rewriting** (Finding 4, +987 tokens per rewrite).
- **No default reranking** (Findings 10-11; R10 stays opt-in).
- **No aggressive compression defaults** (Finding 12).
- **No chunk overlap** by default (two evaluations found no clear benefit).
- **No bigger-embedder reflex** (Findings 7-8); R11 must win on the eval.
- **No full-file indexing** as a substitute for retrieval (Anthropic notes it
  only makes sense under ~200k tokens).

---

## Open questions that gate work

1. Does the function-chunking penalty transfer to our question workload?
   R4 then R12 answer this with data.
2. Which side of the reranking debate applies to pi? R10 answers it.
3. Should confidence weights (0.5 vector / 0.4 keyword / 0.1 recency) be
   fitted on the eval set instead of fixed? A cheap follow-up after R4.
4. Do refine suggestions change agent behavior in real sessions? Needs opt-in
   session telemetry after R9.
