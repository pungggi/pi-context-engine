# Research: code retrieval literature → improvement backlog

This note summarizes what peer-reviewed and preprint research says about code
retrieval and code RAG, and maps each finding onto pi-context-engine.

**Why it exists:** we currently optimize for token savings and latency, both of
which we measure. Retrieval *quality* we do not measure. The literature shows
that retriever-side choices dominate final answer quality, so this is the
highest-leverage area to study before adding features.

**How to read it:**
- **Evidence A**: primary source read in full or abstract (arXiv/ACL/official blog).
- **Evidence B**: found via search result snippet only, not yet verified in full.
- **Recommendations** are tagged **P0** (quick win), **P1** (next), **P2**
  (experiment, gate behind config). Every one lists the files to touch and how
  to prove it worked.

Research done 2026-10-17. Sources are listed at the end with links.

**Implementation:** deferred by owner decision. The build plan, with per-item
steps, tests, acceptance criteria and a status table, lives in
[IMPLEMENTATION-PLAN.md](./IMPLEMENTATION-PLAN.md). Nothing is started yet.

---

## 1. What the evidence says

### 1.1 The retriever matters more than the generator

- **Finding**: in a component-wise study of 21+ models across code generation,
  summarization and repair, retriever-side components (query processing,
  retrieval algorithm, context refinement) influenced final performance more
  than the choice of generator model.
- **Why it matters for us:** pi-context-engine *is* the retriever side. Every
  improvement here lands on every model the user runs, cheap and model-agnostic.
- **Evidence A**: Not All RAGs Are Created Equal (arXiv:2605.14503).

### 1.2 BM25 is remarkably strong on code; hybrid is safe but conservative

- **Finding 6**: BM25 was "an exceptionally powerful and versatile retriever"
  across text-heavy, clean and noisy code queries, often beating larger dense
  models. Exact matches on algorithm names and error strings drive this.
- **Finding 9**: hybrid retrieval was "safe but conservative": in their
  experiments it did **not** beat the single best retriever for a given task.
- **Finding 7/8**: bigger embedding models did not win, and code-specific
  training did not reliably beat strong general-purpose models.
- **Why it matters for us:** our RRF hybrid and small general embedders
  (all-MiniLM-L6-v2, nomic-embed-text) are consistent with the evidence. The
  win is not a bigger model, it is better lexical handling and better query
  understanding.
- **Evidence A**: arXiv:2605.14503, Findings 5-9.

### 1.3 Query rewriting: keep the raw query by default

- **Finding 1**: the original, unaltered query is a powerful baseline and often
  beats automated transformations when the task input is clear.
- **Finding 2**: elaboration helps only for ambiguous or noisy inputs.
- **Finding 4**: every LLM-based rewrite risks changing intent or dropping
  critical details ("semantic drift").
- **Cost note**: an elaborated query cost +987 input tokens, roughly the price
  of 2-3 extra retrieved documents.
- **Why it matters for us:** our `QueryParser` does regex intent
  classification and keyword extraction, which is free and drift-free. The
  evidence says do not add LLM query rewriting as a default.
- **Evidence A**: arXiv:2605.14503, Findings 1-4 and the cost table.

### 1.4 Reranking: contested evidence, do not default to it

- **Negative (SE tasks)**: Findings 10/11 report reranking as "unreliable" and
  "often detrimental": it disrupted an already good BM25 ordering and failed to
  rescue weak retrievals. Their cost table shows a BGE reranker at 815 ms on a
  12.8 GB GPU, versus <10 ms for BM25.
- **Positive (repo-level completion)**: CodeRAG's preference-aligned "BestFit"
  reranking (LLM reranker, then distilled to a small model) is a core reason it
  beats SOTA on ReccEval and CCEval.
- **Positive (general RAG)**: Anthropic reports failed retrievals drop by 67%
  when reranking is added on top of contextual retrieval.
- **Positive (code search)**: two-stage retrieve-then-rerank work reports
  consistent gains for text-to-code search (arXiv:2208.11274, Evidence B snippet).
- **Why it matters for us:** the sign of the effect depends on the task. A
  reranker is a reasonable *opt-in experiment*, never a default, until our own
  eval says otherwise.
- **Evidence A**: arXiv:2605.14503 (Findings 10-11), arXiv:2509.16112,
  Anthropic contextual retrieval blog.

### 1.5 Compression: gentle and task-aware helps, aggressive hurts

- **Finding 12**: compression utility depends on the token budget and the
  compressor. Code-specialized compressors with a generous budget were robust;
  aggressive compression was consistently harmful. Their advice: if you compress,
  keep a budget of at least 8000 tokens.
- **SWE-Pruner** (2026): a goal-conditioned 0.6B "skimmer" that keeps task-relevant
  lines achieved 23-54% token reduction on SWE-bench Verified *while improving*
  success rates, and up to 14.84x on single-turn QA. The key idea: pruning is
  conditioned on the current task goal, not a fixed rule.
- **LLMLingua** (EMNLP 2023): a budget controller plus perplexity-based token
  dropping reaches up to 20x compression with little loss.
- **Provence** (ICLR 2025): a lightweight trained pruner removes irrelevant
  sentences from retrieved contexts before generation.
- **Why it matters for us:** our compressor truncates at fixed character caps
  (100/300/800 by level) with no knowledge of the query, and our LLM summarizer
  prompt is query-agnostic. Fixed caps can cut exactly the lines the agent needs.
- **Evidence A**: arXiv:2605.14503, arXiv:2601.16746, arXiv:2310.05736,
  arXiv:2501.16214.

### 1.6 Chunking: pure function-sized AST chunks measured worst

- **Controlled study (864 configurations, RepoEval + CrossCodeEval)**:
  function-based chunking underperformed every other strategy by 3.57-5.64
  percentage points (Cliff's delta = -1.0). Sliding window and cAST sat on the
  cost-quality Pareto front; function chunking was never Pareto-optimal.
- **Dominant parameter**: cross-file context *length*. Doubling from 2048 to
  8192 tokens gave up to +4.2 points, while chunk size had a weaker,
  non-monotonic effect.
- **cAST** (AST split-then-merge chunking): +4.3 Recall@5 on RepoEval retrieval,
  +2.67 Pass@1 on SWE-bench. It packs AST nodes to a size budget measured in
  non-whitespace characters, merges small siblings, and preserves file/class/
  function metadata so hybrid matching improves.
- **Overlap**: two sources agree overlap is not clearly helpful (late chunking
  appendix; a 2601 chunking study says "avoid overlap").
- **Why it matters for us:** `chunker.ts` emits whole functions and classes
  exactly as parsed. There is no size budget, no sibling merge, no parent
  context, and top-level code outside functions is not its own chunk. Our tasks
  are questions rather than completion, so the transfer is partial, but the
  direction is clear: density and surrounding context beat raw node boundaries.
- **Evidence A**: arXiv:2605.04763, arXiv:2506.15655, arXiv:2409.04701.

### 1.7 Contextualized chunks: the biggest cheap win in the literature

- **Anthropic Contextual Retrieval**: prepend a short chunk-specific context
  statement before embedding and before building the BM25 index.
  - Contextual embeddings alone: top-20 failure rate 5.7% → 3.7% (−35%).
  - Embeddings + contextual BM25: 5.7% → 2.9% (−49%).
  - Plus reranking: −67%.
- **Late chunking** (Jina): embed the whole document first, pool per chunk
  afterwards. +2.7% to +3.63% relative nDCG across models and datasets, no extra
  training, and it beats naive chunking in almost every configuration.
- **Why it matters for us:** `pipeline.ts` embeds `c.content` verbatim. A chunk
  from `src/retrieval/retriever.ts` carries no clue that it lives in the
  retrieval module unless the words appear in the code itself. Deterministic
  context headers (path, enclosing class, sibling names, imports) are free, need
  no LLM, and match what both papers show helps most.
- **Evidence A**: Anthropic engineering blog, arXiv:2409.04701.

### 1.8 Repository structure and graphs pay off

- **RepoGraph** (ICLR 2025): an AST-built graph (reference/definition nodes,
  invoke/contain edges) plugged into four systems raised SWE-bench-Lite resolve
  rate by +2.66 and +2.34 absolute, at roughly proportional or lower cost. Best
  combined result was 29.67, state of the art among open-source methods at the time.
- **Aider** ranks context files with PageRank over the repo graph (cited in the
  RepoGraph related work), which our own preprint source also observed in practice.
- **Why it matters for us:** we already build `calls`/`imports`/`defines` edges,
  but graph expansion in `retriever.ts` only adds 2 bonus chunks from 2 related
  files with a fixed 0.85 score factor. There is headroom to make the graph a
  first-class retrieval path.
- **Evidence A**: arXiv:2410.14684.

### 1.9 Real coding agents retrieve iteratively and along several paths

- **RepoCoder** (EMNLP 2023): iterative retrieval then generation, rerunning
  retrieval with the model's own partial output, improved repository-level
  completion by over 10% (Evidence B for the number, A for the mechanism).
- **CodeRAG** (EMNLP 2025): attacks three failure modes directly: bad query
  construction (uses log-probability guided probing instead of "last k lines"),
  single-path retrieval (runs several retrieval paths and fuses), and
  retriever/generator mismatch (reranks by generator preference).
- **Exploratory study of code retrieval in coding agents** (2025 preprint, not
  peer reviewed): across Claude Code, Codex CLI, Gemini CLI, Cursor, Amp, Cline
  and Aider, every agent used progressive narrowing: broad first query, then
  tighter follow-ups. It also found agents mixing lexical, semantic, LSP and
  graph-based signals rather than relying on one.
- **Query performance prediction in agentic RAG** (2025): predicted quality of
  the generated query correlates positively with final answer quality, and
  better retrievers produce higher quality answers in shorter reasoning chains.
  This is the basis for adaptive retrieval: signal low confidence and retry.
- **Why it matters for us:** our guidance tells the agent how to phrase one
  query. The literature says the winning pattern is a *loop*: search, judge,
  refine. We can support that with confidence signalling and refine hints.
- **Evidence A**: arXiv:2303.12570 (mechanism), arXiv:2509.16112,
  arXiv:2507.10411; Evidence B: preprint 10.20944/preprints202510.0924.

### 1.10 Evaluation: public code-search benchmarks mislead; measure recall and distraction yourself

- **CORE-Bench** (2026): agentic coding retrieval is "requirement-driven
  repository search", not snippet matching. Representative embedding models
  show a *sharp drop* from traditional code search to this setting, because of
  intent-to-implementation gaps, scattered evidence, long chunks that dilute the
  embedding, and dense in-repo distractors.
- **Voyage AI**: CoSQA has an estimated 51% incorrect labels, CodeSearchNet
  queries are copied from docstrings (too easy), and public sets suffer data
  contamination. They recommend mining eval queries from real SWE-bench-style work.
- **Metric mismatch**: UDCG (2025) shows classical nDCG/MAP/MRR mispredict RAG
  performance because they ignore *distracting* (related but useless) documents;
  a utility-and-distraction-aware metric improved correlation with end-to-end
  accuracy by up to 36%.
- **Why it matters for us:** `smoke:real-world` measures tokens and latency only.
  We cannot tell whether a change helps or hurts retrieval quality today, and
  our 97% savings claim has no paired quality number.
- **Evidence A**: arXiv:2606.11864, arXiv:2510.21440, Voyage AI blog.

### 1.11 Memory: link memories, do not just store them

- **A-MEM** (NeurIPS 2025): Zettelkasten-style memory with dynamic indexing and
  linking. New memories get structured attributes (context, keywords, tags),
  get linked to related old memories, and can *update* older memories as
  understanding improves. Beats SOTA memory baselines on six foundation models.
- **MemGPT** (2023): memory as an OS-style paging system, the reference frame
  for tiered agent memory.
- **Why it matters for us:** `record_decision` stores items that are searchable
  but not linked to each other or to the code areas they concern, and old
  entries are never revised.
- **Evidence A**: arXiv:2502.12110, arXiv:2310.08560.

---

## 2. Gap analysis: pi-context-engine today vs the evidence

| Area | Today | Evidence says | Gap |
|---|---|---|---|
| Chunk embedding text | raw `chunk.content` only | contextual headers cut failed retrievals by 49% | no path/class/import context in vectors or FTS |
| Chunking | whole functions/classes, no size budget | function chunking measured worst; split-merge + density wins | no split-merge, no sibling merge, no top-level code chunks |
| Served context length | packed to token budget, one chunk at a time | cross-file context length is the dominant quality factor | no parent/neighbor expansion around a hit |
| Compression | fixed 100/300/800 char caps, query-agnostic summaries | gentle, task-conditioned pruning helps; aggressive hurts | compression ignores the query |
| FTS/BM25 | OR-joined tokens, quoted phrases flattened, default column weights | BM25 strongest single retriever for code; contextual BM25 gave the bigger jump | no phrase search, no path/file column weighting, no symbol path |
| Query handling | regex intents + keywords, free and drift-free | raw query best; elaborate only when ambiguous; QPP signals help | no low-confidence feedback loop, no refine hints |
| Graph | 1-hop file bonus: 2 files × 2 chunks, fixed 0.85 factor | RepoGraph: +2.66/+2.34 absolute SWE-bench resolve | graph is a footnote, not a retrieval path |
| Reranking | none | contested: negative for SE tasks, positive for repo completion | fine as-is; only revisit as a gated experiment |
| Evaluation | tokens + latency | recall + distraction metrics needed to trust any change | no labeled query set, no quality metric |
| Memory | stored + searchable, no links | linking and memory evolution improve recall | no decision-to-decision or decision-to-code links |

---

## 3. Recommendations

### P0: quick wins, no new dependencies

**R1. Prepend deterministic context headers to chunks (indexing + FTS).**
- **Do:** build a header per chunk: file path, language, enclosing class or
  module, function signature, imports of the file, and a one-line "part of
  file X" statement. Prepend it before embedding *and* before FTS ingest.
- **Why:** Anthropic measured a 49% cut in failed retrievals from exactly this,
  and late chunking shows the same "chunks lose surrounding context" effect
  (+2.7-3.6% nDCG). Our headers need no LLM, so there is no per-chunk cost.
- **Where:** `src/indexer/chunker.ts` (`nodeToChunk`), `src/indexer/pipeline.ts`
  (`embedChunks` embeds `c.content`), `src/storage/fts-store.ts` (`ingest`).
  The embedding cache is keyed by content hash, so the header change triggers a
  clean full re-embed; bump an index-format version to make that explicit.
- **Verify:** Recall@k on the labeled set (R4) before/after, plus a canary
  query per file that mentions the module name but not the code words.

**R2. Strengthen BM25: phrases, column weights, symbol matching.**
- **Do:** detect quoted input and keep it as an FTS5 phrase; weight `file_path`
  and `chunk_type` columns explicitly in the `bm25()` call; surface exact
  symbol hits (a query token matching a function/class name) as a strong signal.
- **Why:** BM25 is the most reliable retriever for code in the study, and exact
  identifiers are where dense embeddings are weakest. We already OR-join tokens,
  which is safe, but phrases like `"ENOENT handler"` cannot match today.
- **Where:** `src/storage/fts-store.ts` (`escapeFts5`, `search`),
  `src/retrieval/retriever.ts` (already boosts FTS for `code_lookup` intent).
- **Verify:** the identifier-heavy query slice of R4 should improve first.

**R3. Make compression query-aware.**
- **Do:** add a `query` parameter to compression. Keep the fixed caps as the
  fallback, but when a query is present, retain lines containing query tokens,
  identifiers, imports and the signature, then truncate. Treat `full` as the
  budget-generous level (evidence says budgets under ~8k tokens lose quality).
- **Why:** SWE-Pruner shows task-conditioned pruning both cuts tokens and raises
  success rates, while Finding 12 shows fixed aggressive caps hurt. Our current
  caps can delete the only line that answers the question.
- **Where:** `src/compression/compressor.ts` (`TRUNCATION_LIMITS`, prompts),
  `src/retrieval/retriever.ts` (packing already estimates compressed size).
- **Verify:** measure served tokens and answer quality per compression level on
  the labeled set; expect equal or better recall at equal or fewer tokens.

**R4. Build a labeled retrieval eval and report quality in the smoke run.**
- **Do:** a small query set (start with 50-100 queries over this repo: bug-report
  style, identifier style, NL style, file-name style) with expected file or
  chunk labels. Report Recall@5, Recall@10, nDCG@10, a distraction ratio
  (relevant chunks among served), tokens and latency. Add it to
  `npm run smoke:real-world`.
- **Why:** every other recommendation depends on being able to tell "better"
  from "feels better". CORE-Bench shows code-search scores overstate agentic
  usefulness, and UDCG shows distraction must be counted, not ignored. This also
  gives our 97% savings claim a paired quality number.
- **Where:** `scripts/smoke-real-world.mjs`, new `tests/eval/` fixture,
  optionally a CORE-Bench sample from Hugging Face for external validity.
- **Verify:** the harness itself: it must fail loudly when scores drop.

### P1: next iteration

**R5. Multi-path retrieval with a structured symbol path.**
- **Do:** keep vector + FTS, and add a third path: exact lookup in the graph node
  index for symbols and file paths named in the query. Fuse all three with the
  existing RRF.
- **Why:** CodeRAG attributes its gains to multi-path retrieval over a single
  similarity path; the coding-agent study found real agents mix lexical,
  semantic and structural signals. We extract identifiers today but only use
  them for keyword distance.
- **Where:** `src/retrieval/retriever.ts`, `src/retrieval/query-parser.ts`,
  `src/storage/graph-store.ts`.
- **Verify:** identifier and "where is X defined" query slices of R4.

**R6. Small-to-big serving: expand hits with parent and neighbor context.**
- **Do:** after ranking, expand the top hits with the enclosing module summary
  and adjacent chunks in the same file, plus the file-level module chunk, until
  the marginal-ratio stop. Keep `expand_chunk` for deeper drilling.
- **Why:** cross-file context length was the dominant quality parameter in the
  controlled study (+4.2 points from 2048 → 8192 tokens), and small-to-big is
  the standard fix for "the chunk that retrieves well is not the chunk that
  answers well". CORE-Bench also flags long, diluted chunks as a problem, so
  expand selectively rather than making every chunk bigger.
- **Where:** `src/retrieval/retriever.ts` (diversity/packing stage),
  `src/indexer/chunker.ts` (emit module and top-level chunks for AST files too).
- **Verify:** recall should rise while token count stays bounded by the budget.

**R7. Make the graph a real retrieval path (context packs).**
- **Do:** for each top hit, build a small context pack: the node, its file, its
  callers/callees or importers/importees with edge types labeled, and a
  centrality-based prior for which files are "important" in this repo.
- **Why:** RepoGraph gained +2.66/+2.34 absolute on SWE-bench-Lite across four
  systems at no extra cost; Aider's PageRank file ranking was observed working
  in practice. Our current expansion is 2 chunks from 2 files with a magic 0.85.
- **Where:** `src/storage/local-backend.ts` (`getRelatedFilePaths`),
  `src/storage/graph-store.ts`, `src/retrieval/retriever.ts`,
  `related_context` tool in `src/extension.ts`.
- **Verify:** cross-file queries in R4; count how often the labeled answer file
  arrives via graph edges instead of similarity.

**R8. Adaptive retrieval: score the query, tell the agent, then optionally elaborate.**
- **Do:** treat the score distribution (top score, margin to the second cluster,
  agreement between vector and FTS) as a query-performance signal. When it is
  low, return it in the tool result: "low confidence, try X". Only when the
  agent opts in (or the query is classified ambiguous), generate an elaborated
  variant and run both, keeping the raw query's results.
- **Why:** predicted query performance correlates with answer quality in
  agentic RAG, and Findings 1/2/4 say raw queries win by default while
  elaboration helps only ambiguous ones. This gives us the loop real agents use
  (broad first, narrow second) without semantic drift.
- **Where:** `src/retrieval/confidence.ts`, `src/retrieval/query-parser.ts`,
  `src/guidance.ts` (document the new signal for the agent).
- **Verify:** measure how often a low-confidence signal is followed by a
  successful second query in real sessions; track recall on ambiguous queries.

**R9. Return refine suggestions with every search.**
- **Do:** in `context_search` results, add 2-3 concrete next queries (sibling
  symbol names, the file that almost matched, an alternate term seen in top
  hits). Keep it to a line or two to stay token-cheap.
- **Why:** every production coding agent in the exploratory study narrowed
  iteratively, and RepoCoder's loop is the mechanism behind its reported gain.
  Suggestions turn our one-shot tool into a guided loop at near-zero cost.
- **Where:** tool response shaping in `src/extension.ts` or `engine.ts`.
- **Verify:** follow-up query rate and whether sessions stop earlier.

### P2: experiments, gated behind config, only with R4 in place

**R10. Opt-in reranker.**
- **Do:** `retrieval.rerank: off | cheap` using a small ONNX cross-encoder via
  the transformers.js runtime we already ship (text-classification task).
  Default `off`.
- **Why:** evidence is genuinely split. The SE study found reranking harmful
  and expensive (815 ms GPU), while CodeRAG and Anthropic found large gains on
  repository tasks. Only our own eval can settle which side applies to pi's
  workloads.
- **Where:** new `src/retrieval/reranker.ts`, config in `src/config.ts`.
- **Verify:** R4 with rerank on/off; enable by default only if it wins on
  quality *and* the latency budget holds (warm queries are ~11 ms today).

**R11. Optional code-specialized embedder.**
- **Do:** document an `embedding.model: code` option (a code-oriented ONNX
  model) next to the general default, and evaluate it before recommending it.
- **Why:** Findings 7/8 say scale and code-specific training did not reliably
  win, but CORE-Bench shows agentic retrieval is a different, harder regime
  where in-domain training helped a lot. So: offer it, measure it, then decide.
- **Where:** `src/indexer/embedder.ts` (`DEFAULT_LOCAL_MODEL`), README config block.
- **Verify:** R4 per model; the local backend already reindexes on dimension change.

**R12. Rework chunking toward density: split-merge with a budget.**
- **Do:** adopt cAST's algorithm: top-down fit of AST nodes to a non-whitespace
  character budget, greedy merge of small siblings, and emit module/top-level
  chunks so code outside functions is retrievable. Keep chunks concatenable back
  to the original file.
- **Why:** function-only chunking was the worst measured strategy (−3.57 to
  −5.64 points) and was never Pareto-optimal; cAST gains 4.3 Recall@5. Our
  current chunker does exactly this (whole function/class nodes, no budget).
- **Where:** `src/indexer/chunker.ts` (`walk`, `nodeToChunk`), chunk-id scheme in
  `makeChunk` (ids include line spans, so the upstream column-offset fix must
  survive the rework).
- **Verify:** R4 by query type, plus re-run `smoke:real-world` for chunk counts
  and token deltas; expect more, denser chunks.

**R13. Link memories (A-MEM style).**
- **Do:** when writing a decision or code area, compute links to related past
  entries (embedding similarity + the `decided`/`discussed_in` graph edges) and
  allow a later entry to annotate an earlier one instead of only appending.
- **Why:** A-MEM's linked, evolving memories beat fixed-structure memory on six
  models. Our memory is flat today, so recall quality degrades as history grows.
- **Where:** `src/memory/db.ts`, `decision-extractor.ts`, `session-capture.ts`.
- **Verify:** a small recall test: seed N decisions, query for each by topic,
  measure whether its linked neighbours surface too.

---

## 4. What the literature says not to do

- **No always-on LLM query rewriting**: semantic drift risk plus ~987 tokens per
  rewrite (Finding 4 and the cost table).
- **No default cross-encoder reranking**: often negative on SE tasks, expensive,
  and our warm-query latency would regress (Findings 10-11).
- **No aggressive compression**: fixed tight caps and hard truncation lose the
  answering lines (Finding 12, SWE-Pruner).
- **No chunk overlap by default**: two evaluations found no clear benefit.
- **No "bigger embedder" reflex**: scale and code-specific training did not
  decide outcomes (Findings 7/8). Measure first with R4.
- **No full-file indexing as a substitute for retrieval**: useful for repos
  under ~200k tokens, per Anthropic, which is a niche case.

---

## 5. Measurement plan

1. **Baseline first**: run R4's harness on the current release and record
   Recall@5/@10, nDCG@10, distraction ratio, tokens, latency.
2. **One change at a time**: each Rn lands with its before/after numbers in the
   PR. This mirrors how every paper above isolates one component.
3. **Report quality in `smoke:real-world`**, next to the existing savings and
   latency numbers, so regressions are visible without a separate tool.
4. **External check**: optionally run a CORE-Bench level-2 slice to confirm
   gains transfer beyond our own query set.
5. **Session telemetry (opt-in)**: track low-confidence rate and follow-up
   query rate to validate R8/R9 outside the lab.

---

## 6. Sources

Primary sources read for this note (Evidence A unless marked):

- **Not All RAGs Are Created Equal: A Component-Wise Empirical Study for SE Tasks**
  (2026) https://arxiv.org/abs/2605.14503
  Retriever beats generator; BM25 robust; query rewriting and reranking are
  situational, not defaults.
- **How Does Chunking Affect Retrieval-Augmented Code Completion?** (2026)
  https://arxiv.org/abs/2605.04763
  Function chunking worst; cross-file context length dominant.
- **cAST: Enhancing Code RAG with Structural Chunking via AST** (2025)
  https://arxiv.org/abs/2506.15655
  Split-merge AST chunking, char budget, metadata retention.
- **RepoGraph: Enhancing AI Software Engineering with Repository-level Code Graph**
  (ICLR 2025) https://arxiv.org/abs/2410.14684
  Graph plug-in: +2.66/+2.34 absolute SWE-bench-Lite resolve.
- **CodeRAG: Finding Relevant and Necessary Knowledge for RAG Repository-Level
  Code Completion** (EMNLP 2025) https://arxiv.org/abs/2509.16112
  Log-probability query construction, multi-path retrieval, preference-aligned reranking.
- **RepoCoder: Repository-Level Code Completion through Iterative Retrieval and
  Generation** (EMNLP 2023) https://arxiv.org/abs/2303.12570
  Iterative retrieve-generate loop for repo context.
- **CORE-Bench: Code Retrieval in the Era of Agentic Coding** (2026)
  https://arxiv.org/abs/2606.11864
  Agentic retrieval is requirement-driven repo search; standard benchmarks overstate.
- **SWE-Pruner: Self-Adaptive Context Pruning for Coding Agents** (2026)
  https://arxiv.org/abs/2601.16746
  Task-conditioned pruning: 23-54% fewer tokens, success rates up.
- **Provence: Efficient and Robust Context Pruning for RAG** (ICLR 2025)
  https://arxiv.org/abs/2501.16214
  Lightweight trained pruner removes irrelevant sentences pre-generation.
- **LLMLingua: Compressing Prompts for Accelerated Inference** (EMNLP 2023)
  https://arxiv.org/abs/2310.05736
  Budget-controlled compression, up to 20x with little loss.
- **Late Chunking: Contextual Chunk Embeddings** (2024)
  https://arxiv.org/abs/2409.04701
  +2.7-3.6% relative nDCG; overlap shows no clear benefit.
- **Anthropic, Contextual Retrieval** (industry, engineering blog, 2024)
  https://www.anthropic.com/engineering/contextual-retrieval
  Failed retrievals −49% (embeddings + BM25), −67% with reranking.
- **Lost in the Middle: How Language Models Use Long Contexts** (TACL 2024)
  https://arxiv.org/abs/2307.03172
  Result ordering matters: information in the middle of long context is used least.
- **A-MEM: Agentic Memory for LLM Agents** (NeurIPS 2025)
  https://arxiv.org/abs/2502.12110
  Zettelkasten linking plus memory evolution beats fixed memory structures.
- **MemGPT: Towards LLMs as Operating Systems** (2023)
  https://arxiv.org/abs/2310.08560
  Tiered, OS-style memory management for agents.
- **Am I on the Right Track? Predicted Query Performance in Agentic RAG** (2025)
  https://arxiv.org/abs/2507.10411
  Query quality prediction correlates with answer quality: basis for adaptive retrieval.
- **Search-R1: Training LLMs to Reason and Leverage Search Engines with RL** (2025)
  https://arxiv.org/abs/2503.09516
  Reference design for search-as-a-tool inside reasoning loops.
- **Precise Zero-Shot Dense Retrieval without Relevance Labels (HyDE)** (ACL 2023)
  https://arxiv.org/abs/2212.10496
  Query→hypothetical answer→embedding; costs a generation per query.
- **Redefining Retrieval Evaluation in the Era of LLMs** (2025)
  https://arxiv.org/abs/2510.21440
  UDCG metric counts distraction, +36% correlation with end-to-end accuracy.
- **Retrieval-Augmented Code Generation: A Survey (Repository-Level)** (2025)
  https://arxiv.org/abs/2510.04905
  Taxonomy of repo-level retrieval: substrate, control regime, evaluation.
- **Revisiting Code Search in a Two-Stage Paradigm** (2022) Evidence B
  https://arxiv.org/abs/2208.11274
  Retrieve-then-rerank for code search.
- **CORNSTACK: High-Quality Contrastive Data for Code Retrieval and Reranking**
  (ICLR 2025) Evidence B https://arxiv.org/abs/2412.01007
  Rerankers matter for code retrieval when trained on good data.
- **COIR: A Comprehensive Benchmark for Code Information Retrieval** (ACL 2025)
  Evidence B https://aclanthology.org/2025.acl-long.1072.pdf
  Broader code-IR benchmark beyond CodeSearchNet.
- **CodeSearchNet Challenge** (2019) Evidence B https://arxiv.org/abs/1909.09436
  The classic benchmark, and its limits.
- **Voyage AI, How do we evaluate vector-based code retrieval?** (industry, 2024)
  https://blog.voyageai.com/2024/12/04/code-retrieval-eval/
  CoSQA ~51% bad labels; CodeSearchNet queries trivial; mine evals from SWE work.
- **An Exploratory Study of Code Retrieval Techniques in Coding Agents** (2025
  preprint, not peer reviewed) Evidence B
  https://doi.org/10.20944/preprints202510.0924
  Seven production agents all narrow iteratively and mix lexical/semantic/graph/LSP.
- **ColBERT: Efficient Passage Search via Late Interaction** (SIGIR 2020)
  Evidence B https://arxiv.org/abs/2004.12832
  Late interaction: better than bi-encoders, heavier infrastructure than ours.

---

## 7. Open questions

- Does the function-chunking penalty from the completion study transfer to our
  question-answering workload? R4 + R12 will answer this empirically.
- Which side of the reranking debate applies to pi: SE tasks or repo tasks?
- Is a code-specialized embedder worth the extra model weight for local users,
  given Findings 7/8?
- Should confidence scoring learn weights (vector/keyword/recency) from the
  labeled set instead of the fixed 0.5/0.4/0.1 split?
