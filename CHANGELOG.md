# Changelog

All notable changes to `pi-context-engine`. Versions are tag-driven: pushing `vX.Y.Z` triggers CI to publish with OIDC + provenance (see `docs/PUBLISHING.md`). Date format: YYYY-MM-DD.

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
