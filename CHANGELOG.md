# Changelog

All notable changes to `pi-context-engine`. Versions are tag-driven: pushing `vX.Y.Z` triggers CI to publish with OIDC + provenance (see `docs/PUBLISHING.md`). Date format: YYYY-MM-DD.

## 0.12.0 - 2026-11-24

### Added

- **R14 rarity-weighted FTS fusion** (#45): a query whose own tokens are
  corpus-near-unique (a prose term like `fernwaerme` matching one fixture
  file) used to lose RRF fusion — flat reciprocal-rank votes let ~30
  vector-noise hits from hub code files bury the BM25 rank-1 (served at rank
  16/20; common-token variants missed the top-10 entirely). The retriever now
  measures the query's token rarity against real document frequencies
  (new `FTSStore.docCount()` / `termDocCount()`, normalised Lucene-smooth
  IDF) and adds up to +3.0 extra weight to the BM25 list **head**, decaying
  with the candidate's FTS rank. Skipped below 50 indexed rows (df stats lie
  in tiny corpora), so existing small-index behaviour is untouched. Two
  design points are load-bearing, both caught in the repro: the boost must
  decay with FTS rank (a flat whole-list boost amplified common-token matches
  deeper in the list and demoted well-ranked hits on mixed queries), and the
  ramp must reach 3.0×rarity (weaker ramps left `error code 4100 lost prime`
  at rank 7). Issue repro after the fix: `fernwaerme` 16→1,
  `Fernwaerme field notes` MISS→1, `error code 4100 lost prime` MISS→1,
  `profile F7E null modem` stays 1.

### Changed

- **Retrieval eval baseline re-recorded after R14** (95 queries). Fake
  backend: fileRecall@5 0.719→0.789, fileRecall@10 0.814→0.854, nDCG@10
  0.705→0.779, distraction@10 0.735→0.708, identifier R@5 unchanged 0.922.
  Real ONNX backend: R@5 0.707→0.818, R@10 0.789→0.879, nDCG@10 0.712→0.818,
  prose slice R@10 0.421→0.789. Known accepted cost: identifier R@10 −0.023
  on the fake backend (q30 hit→miss) versus +4 prose hits; identifier results
  are unharmed on the real embedder. New `tests/fts-rarity.test.ts` (7 tests)
  covers the df primitives, the rarity maths and a deterministic 71-chunk
  burial corpus; red before the fix, green after.

## 0.11.0 - 2026-11-23

### Added

- **`indexer.chunking: semantic-prose`** (P2-C): opt-in semantic chunking for
  heading-less unstructured prose (`.txt`, Markdown with no ATX heading).
  Paragraph units get one extra embedding pass per eligible file (unit-level
  cached, stale-dimension validated) and chunk boundaries land at
  cosine-distance breakpoints (top quartile of the file's own boundary
  distances); undersize groups merge into the closer neighbour. Files with
  headings, code, and sub-budget files are untouched, and every failure mode
  (embedder down, <3 units, length mismatch) falls back deterministically to
  the existing prose chunker. Measured neutral on this package's eval
  (95 queries, real embedder: R@5 +0.04, nDCG@10 +0.006, R@10 −0.03), so the
  default stays `legacy` — the flag targets notes-heavy workloads where
  budget packing visibly blurs topics. Flipping the flag requires a full
  reindex (unchanged-file hashes skip re-chunking).

### Changed

- **R10 reranker default `off` now carries measured evidence**: the default
  cross-encoder (`Xenova/ms-marco-MiniLM-L-6-v2`) loads fine — the original
  blockers were only the code-specialized candidates — and the real-embedder
  A/B (89 queries) is mixed within the eval tolerance: sharper top of the
  list (R@5 +0.05, bug-report R@5 +0.29, served tokens −48%) but weaker deep
  recall (cross-file R@10 0.67→0.33, prose 0.46→0.31) at ~6× query latency
  (p50 112→675 ms). README documents the numbers.
- **Retrieval eval suite extended to 95 queries** (heading-less prose fixture
  + 6 prose queries); baseline re-recorded on the default config.

## 0.10.4 - 2026-11-23

### Fixed

- **Permanent per-session `Parser.init is not a function` failures** (#29):
  `require("web-tree-sitter")` can silently return `{}` when the UMD gate at
  the end of `tree-sitter.js` never fires (jiti ESM-path evaluation), and the
  parser init cached the **rejected** promise — turning a transient cause
  into a permanent per-session failure with a re-toast on every watcher tick.
  The chunker now unwraps ESM-interop shapes, retries once after dropping the
  poisoned require-cache entry, never caches rejections (watcher reindex
  self-heals for any transient cause), and fails loud with a diagnostic
  fingerprint, shown in a longer toast slice when the cause persists.
- **Automatic indexing never stole an orphaned index lock** (#41):
  automatic (watcher / session-start) runs acquire the cross-process lock
  with a zero wait budget, and that single-shot path returned `busy` on its
  first failed create — **before** the staleness takeover (`stealIfStale`)
  was ever reached. A lock orphaned by a crashed session (dead pid, or past
  the 15-minute stale age) was therefore only ever stolen by a *manual*
  `/context-index`; background runs skipped forever while the skip counter
  climbed (`Index lock: held by pid … (2868m)`, 114 skips). Every acquire —
  including zero-budget ones — now performs a staleness pass **before**
  reporting busy, so automatic runs take over orphaned locks and self-heal,
  while still skipping instantly when the holder is alive.

## 0.10.3 - 2026-11-21

### Fixed

- **Watchdog dimension-mismatch loop**: a project whose `chunks_vec` table
  existed but was EMPTY (all rows deleted) kept its old embedding dimension,
  and the code only learned a table's dimension from its ROWS. After an
  embedder switch (e.g. Ollama `nomic-embed-text` 768-dim picked up because
  Ollama came up, vs the 384-dim local fallback), every watcher reindex died
  with `Dimension mismatch for inserted vector ... Expected 384 dimensions
  but received 768` and repeated forever — nothing ever healed the table.
  The declared dimension now comes from the table DDL (works for empty
  tables), and `ensureVecTable` re-verifies the DDL after create, so a
  stale-dimension table is dropped and rebuilt on the next ingest.
- **Mixed-dim stores**: the full-reindex migration gate now also compares
  the store's declared dimension against the embedder (not just the
  manifest's). Without this, a store rebuilt at another dim behind the
  manifest's back would wipe chunk metadata while file hashes still matched,
  silently stranding those files out of the index.
- **Embedding-cache dimension poisoning**: cache hits are now validated
  against the live embedder's dimension; a stale-dim hit is re-embedded and
  replaced instead of being ingested (which could throw the same dimension
  mismatch mid-batch or silently keep the index in the old vector space).
  Stale entries no longer count as cache hits during the transition run.

## 0.10.2 - 2026-11-15

### Added

- **Pipelined indexing batches**: batch N+1's prep (file reads, tree-sitter
  parsing) now runs inside batch N's embed wait, and batch N's sqlite ingest
  slots between the two embeds (one embed in flight at a time). Cold-start
  index time is embed-bound, so this shortens wall time meaningfully and
  shrinks the cross-process lock hold for everyone else. Manifest
  checkpointing still happens only after a batch's ingest, so interrupted
  runs resume exactly as before.
- **Lock observability**: `/context-status` (and `status_text`) now shows the
  cross-process index lock state — `held by pid N (age)` or `free` — plus a
  counter of how many indexing runs were skipped because another session
  held the lock. Why: multi-session setups could only diagnose a stuck
  holder by opening `index.lock` by hand.

### Changed

- **Async lock wait**: while a manual `/context-index` waits up to 10 s for
  another session's indexing run, pi's event loop now stays responsive
  (the poll used to block it with a synchronous sleep).
- **WAL hygiene**: every sqlite handle now sets `journal_size_limit` (32 MB)
  and each finished indexing run issues passive checkpoints on the vector,
  FTS and graph stores. Why: multi-MB embedding batches could balloon the
  `-wal` files between auto-checkpoints.

## 0.10.1 - 2026-11-15

### Fixed

- **Multiple sessions on one project no longer fail with "database is
  locked".** Three coordinated changes:
  - **All write transactions now start `BEGIN IMMEDIATE`** (previously
    deferred). A deferred read-then-write transaction fails instantly when
    another connection grabbed the write lock in between, because SQLite
    deliberately bypasses `busy_timeout` for lock upgrades (upgrading could
    deadlock). Immediate transactions queue at BEGIN and the busy timeout
    covers the wait.
  - **`busy_timeout` raised 5 s → 15 s** (env `PCE_BUSY_TIMEOUT_MS`), so a
    concurrent indexing burst from another session rides out instead of
    erroring.
  - **New cross-process index lock** (`index.lock` in the storage dir,
    `indexer/index-lock.ts`): only one session indexes at a time, which also
    stops the duplicated embedding work every session used to do on start.
    Other sessions' automatic runs skip instantly with a status line and
    retry on their next kick; manual `/context-index` waits up to 10 s
    (`PCE_INDEX_LOCK_WAIT_MS`) and then reports the skip; `/context-index
    --reset` reports the holder PID instead of failing per-file on locked
    targets. Stale locks (holder process gone, or lock older than 15 min)
    are stolen automatically, so a crashed session cannot wedge the project.
- **Manifest/session writes survive Windows file-lock blips.** The atomic
  write (tempfile + rename) used to fail the whole reindex with
  `EPERM: operation not permitted, rename …` when an antivirus scanner,
  search indexer or backup tool briefly held the temp or destination file
  open without share-delete. The rename now retries EPERM/EACCES/EBUSY
  with exponential backoff (~1.6 s budget, 8 attempts) before giving up,
  so a scanner blip no longer kills an indexing run.

## 0.10.0 - 2026-11-12

### Added

- **`/context-usage` command**: tokens, cost, and context window for the
  current session in one notification. The aggregation mirrors pi's own
  `/session` accounting (assistant messages, nested-call tool results,
  usage entries like cache warming, compaction summaries), so totals reflect
  what was actually billed, not just what is still in context.
  - **Cost**: pi's catalog cost when the provider reports one; otherwise an
    estimate at the configured `pricing.*` rates, clearly labeled `est.`.
  - Also shows context-window percentage, per-model cost split, and the
    project's savings ledger line. No footer replacement: the built-in pi
    footer keeps doing its job.
- **Dashboard "All pi sessions" table**: the Sessions tab now lists every
  pi session across all projects (the same source as pi's `/resume`
  picker) with per-session message count, tokens, and catalog cost parsed
  from each session file.
  - Why: cross-project spend was invisible: pi only shows cost for the
    current session. This answers "where did my tokens go this week?"
    without opening each project.
  - **Performance**: cost/token parsing runs only for the visible page
    (100 rows, "show more" pagination, concurrency 8) and is cached per
    file mtime+size; the session list itself is cached for 30 s, since
    pi's `listAll` reads every file header (~2.4 s for 821 sessions
    measured). Cold tab open stays a one-time cost, warm opens are
    instant.
  - Still strictly read-only: the scanner uses `SessionManager.listAll()`
    and file reads only.

## 0.9.0 - 2026-11-08

### Added

- **`pce` CLI**: standalone commands over the same engine and store as the
  extension: `pce search <query> [--top-k N] [--max-tokens N]`,
  `pce status`, `pce recall <topic>`, `pce index [--full]`, plus
  `--project <dir>`. Exit codes: `0` ok, `1` operational, `2` usage error.
  - Why: debug retrieval without starting a pi session, scripted sanity
    checks in CI, and a no-host path for power users (the CLI leg of the
    [protect-context](https://github.com/XJTLUmedia/Protect-Context) study).
  - **Ephemeral runs**: no session row, no session file, no rollup — CLI
    invocations never pollute session history, and `pce search` never
    triggers background indexing (an empty index tells you to run
    `pce index`).
  - **Packaging**: `bin: pce` → `dist/cli.js`, built by tsc at pack time
    (`prepack`, which also chmods the bin). CI asserts the tarball contains
    `dist/cli.js` and runs `node dist/cli.js --version` before publishing.
- **Decision provenance (`by=agent` / `by=owner`)**: decisions carry a new
  `authored_by` column and every `session_recall` decision hit is labeled.
  The model-callable `record_decision` writes `by=agent` (unverified); the
  new `/context-decide <decision> [--because <reason>]` command writes
  `by=owner` behind an interactive confirmation. The dashboard shows the
  authorship badge.
  - Why: a model-authored decision must never read as owner intent after
    compaction. Labels let a future session distinguish "the model decided
    once" from "the human decided this" — the trust-provenance pattern from
    protect-context.
  - **Migration**: existing rows backfill as `agent` (every write path until
    now was model-callable); nothing becomes owner authority retroactively.
  - **Minor-version note**: `session_recall` output gained a `by=` segment
    in decision lines (`[decision #12 src=manual by=agent|sid:…]`) —
    consumers that parse recall output should expect it.
- **Injection digest gate** (`src/injection-gate.ts`): keyed content-digest
  primitive so a future per-turn injection never re-injects identical text
  (protect-context's `brief_mode: "changed"` pattern). No current
  injection qualifies yet — this ships as the day-one gate for the next one.

### Fixed

- **Symlinked `pce` bins no longer exit silently**: the bin main-guard
  compared `import.meta.url` against the raw `argv[1]`, which never matches
  through the symlinks npm/pnpm create on POSIX — `pce` would print nothing
  and exit 0. It now compares real paths, with symlink regression tests.
- **`--top-k` / `--max-tokens` followed by another flag** reports
  `(missing value)` instead of misreading the next flag as a bad number.
- **README exit codes** match behavior: `pce recall` with no match is a
  normal answer (exit `0`) and prints its guidance.

## 0.8.1 - 2026-11-08

### Changed

- **CHANGELOG.md now ships in the npm tarball** — `files` previously excluded it, so pi ≥ 1.5.0's "Extension Updates" feature (which reads `CHANGELOG.md` from the installed package after an update) stayed silently off. Why: the changelog was there all along, just never installed where pi could read it. With this release pi records its version baseline; from the next release onward, release notes appear in the pi launcher under "Extension Updates".

## 0.8.0 - 2026-11-07

### Added

- **Prose section chunking**: markdown and plain text are chunked at headings instead of by tree-sitter, with the heading path carried as chunk context and paragraphs packed to the chunk budget.
  - Why: docs and prose have no functions to parse; heading-path context keeps retrieved sections self-describing.
- **Symbol-level PageRank for `related_context`**: graph traversal now orders results by symbol centrality, so hub symbols (shared types, core helpers) come before peripheral callers.
  - Why: a fixed page of graph neighbors buried the symbols most other symbols depend on.
- **Session bootstrap re-injection after compaction**: compaction removes the "where you left off" block like any other message, and the mid-run retry path (threshold/overflow recovery) never re-fires `before_agent_start`. On `session_compact` the extension resets the once-per-session gate and arms a per-request `context` hook that re-asserts a freshly regenerated bootstrap until a persisted copy is back in the conversation. Outside that armed window the hook is an O(1) no-op.
  - Why: compaction is exactly when orientation matters most, and previously exactly when it was lost; the text is regenerated, so decisions recorded mid-session still appear.
  - Pattern borrowed from [protect-context](https://github.com/XJTLUmedia/Protect-Context) (MIT).
  - 12 unit tests plus a wiring smoke test driving the real extension lifecycle through a fake `ExtensionAPI`. 312 total.
