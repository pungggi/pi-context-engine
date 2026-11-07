# Changelog

All notable changes to `pi-context-engine`. Versions are tag-driven: pushing `vX.Y.Z` triggers CI to publish with OIDC + provenance (see `docs/PUBLISHING.md`). Date format: YYYY-MM-DD.

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
