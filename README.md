# pi-context-engine

Semantic code context for [pi](https://pi.dev). Your agent searches an index
instead of re-reading files.

It is a native TypeScript port of
[code-context-engine](https://github.com/elara-labs/code-context-engine) (MIT).
Everything runs locally: no cloud, no Python, no API keys.

```bash
pi install npm:pi-context-engine
```

Then index a project once and every later question hits the index:

```
/context-index
```

## Why this exists

Input tokens dominate an AI coding bill. Re-reading whole files to answer "where
is the retry logic" wastes most of them.

This package indexes your code into semantic chunks and serves only the relevant
ones. On this package's own source (46 files, 593 chunks) a real run measured:

| Metric | Result |
|---|---|
| Baseline (whole files) | 49,698 tokens |
| Served (retrieved chunks) | 1,252 tokens |
| Savings | **97%** |
| Warm query latency | ~11 ms |

Numbers come from `npm run smoke:real-world`, which re-indexes this repo and
runs fixed queries. Run it yourself; nothing is cherry-picked.

## What you get

Ten tools the agent can call, plus four slash commands.

**Search**
- **`context_search`**: hybrid vector + BM25 retrieval with confidence scores.
  The system prompt tells the agent to prefer it over `grep`/`read` for questions.
- **`expand_chunk`**: full source for a compressed hit, when the snippet is not enough.
- **`related_context`**: code reachable through `imports`/`defines` graph edges.

**Memory**
- **`record_decision`**: store a choice and its reason.
- **`record_code_area`**: store a file and what it does.
- **`session_recall`**: search past decisions and turn summaries by topic.
- **`session_timeline`**: walk a session's turns, oldest first.
- **`session_event`**: inspect the raw payload behind one turn.

**Index**
- **`index_status`**: chunk count and measured savings.
- **`reindex`**: refresh a path or the whole project.

Commands: `/context-index [--full]`, `/context-status`, `/context-savings`,
`/context-warmup`.

**Shipped guidance.** The package also injects a ~900-token guidance section
into the system prompt while `context_search` is active: how to formulate
queries, when *not* to search, how to read confidence and overflow markers,
and the index lifecycle.

- **Why it ships:** retrieval only saves tokens when queries are good, and
  these rules describe this package's own semantics. Keeping them in the tool
  description alone would leave every user guessing.
- **Cost-aware gate:** the section appears only while the tool is selected, and
  `guidance.enabled: false` turns it off entirely for prompt-lean setups.
- **Structured, not forced:** it is written to `systemPromptOptions.sections`,
  so pi replays and diffs it like any other section instead of freezing the
  whole prompt.

## How it works

1. **Chunk**: tree-sitter parses source into functions, classes and modules.
   Grammars ship as WASM, so there is no C toolchain to install.
2. **Embed**: a content-hash cache skips unchanged code. Ollama is used when it
   is reachable; otherwise a local ONNX model runs in-process.
3. **Search**: vector similarity and BM25 are merged with Reciprocal Rank
   Fusion, then scored by similarity, keyword match and recency.
4. **Compress**: chunks are cut to signatures and docstrings, or summarised by
   a local LLM when one is available.
5. **Remember**: decisions and turn summaries persist in SQLite, keyed for both
   full-text and semantic recall.

Re-indexing only touches changed files. In the run above, a second pass over an
unchanged repo took 237 ms.

### Automatic indexing

- **Auto-index at session start**: ~2 s after a session opens, an incremental
  reindex runs in the background, so the index is warm before the agent needs
  it. You get a notification only when something changed.
- **Lazy fallback**: if a search still lands on an empty index, indexing kicks
  off on the spot and the tool asks you to retry in a few seconds.
- **Live reindex while you work**: a recursive file watcher re-indexes on
  edits, saves and branch switches (debounced, so a `git checkout` collapses
  into one run). The agent's own edits are searchable right away instead of
  after the next session.
- **Switches**: `indexer.auto_index: false` disables the session-start and
  lazy kicks; `indexer.watch: false` disables the file watcher. Use
  `/context-index` for manual builds.
- **Large-workspace guard**: automatic indexing and the watcher pause with a
  warning above `indexer.max_auto_files` (default 10,000). The check uses the
  normal directory walk and stops at the first file above the limit, so it does
  not add a full directory scan. Periodic yields keep the check responsive.
  This prevents an accidental parent-directory
  session from starting an unrequested multi-minute workload. `/context-index`
  remains available as an explicit manual build. While the pause is active,
  every `context_search` result carries a stale-note and `/context-status`
  leads with the pause line, so outdated results are never served silently;
  all messages name the config file that raises the limit.
- **Resume after interruption**: the manifest checkpoints completed batches,
  starting with the first batch and then at most once every five seconds. An
  interrupted build can skip completed files instead of starting from zero.
  Migration runs (schema reset, embedding-dimension change) are exempt: their
  manifest stays untouched on disk until the run completes, so an interrupted
  migration resumes cleanly instead of stranding stale rows.
- **Cold-start visibility**: the first build on an empty index announces its
  start (`building the first index…`) and always closes with a result line
  (`updated: N file(s)` or `no files to index`). This is the one background
  run that can take minutes, so a pause reads as "indexing", not as a hung
  session. Warm incremental runs stay quiet on start: they finish in a few
  hundred ms, and a toast per session would be noise.
- **Why it matters**: incremental runs are cheap (a few hundred ms on an
  unchanged repo), so this removes the classic cold-start failure of searching
  an empty index, without ever blocking the UI.

### Model warmup

- **`/context-warmup`** downloads the embedding model up front, no project or
  index needed. With `retrieval.rerank: local` it also fetches the reranker
  model; with Ollama as the backend it forces the model pull through the same
  command.
- **Why it matters**: the embedder initializes lazily, only when a run has
  chunks to embed. An empty repo or an already up-to-date index never touches
  the network, so on a fresh machine or an ephemeral container the download
  lands inside the first search. Warming turns it into an explicit
  provisioning step (a devcontainer `postCreateCommand`, a CI cache setup),
  keeping first searches fast.

## Requirements

- **Node 22+** on macOS, Linux or Windows.
- **Embeddings**: Ollama at `localhost:11434`, or nothing (the local ONNX model
  downloads once, ~25 MB).
- **Optional Ollama model**: `nomic-embed-text` is pulled automatically on first use.

No Python. No build tools. No API key.

### Embedding model choice (measured, not claimed)

Evaluated on this package's own 76-query suite (`npm run eval -- --local`, same
code state, CPU only):

| local model | R@5 | R@10 | nDCG@10 | distraction@10 | served tokens | p50/p95 |
|---|---|---|---|---|---|---|
| `Xenova/all-MiniLM-L6-v2` (default, ~25 MB) | 0.752 | 0.827 | 0.744 | 0.713 | 702 | 28/33 ms |
| `michaelfeil/jina-embeddings-v2-base-code` (recommended for code) | **0.798** | **0.899** | **0.813** | **0.640** | 654 | 55/61 ms |

Why the split default: the code-trained model wins every quality metric on
this codebase (natural-language queries most of all: R@10 0.433 → 0.700) at
~2× CPU latency and a larger first download. Keep MiniLM as the default for
fast general use; point code-heavy projects at the jina model:

```yaml
embedding:
  model: michaelfeil/jina-embeddings-v2-base-code
```

Long inputs are pre-truncated to ~2000 chars per embedding so long-context
models cannot OOM the CPU runtime, and changing the model (dimension change)
forces a full reindex automatically.

## Configuration

Zero config by default. Override in `~/.pi-context-engine/config.yaml` or a
per-project `.context-engine.yaml`:

```yaml
retrieval:
  top_k: 20
  confidence_threshold: 0.2
  marginal_ratio: 0.75   # stop adding chunks below this fraction of the top score
  expand_context: true   # serve a hit's module parent + adjacent chunk (small-to-big)
  confidence_high: 0.55  # query-quality composite at/above which a search reports `high`
  confidence_low: 0.45   # below this the result gets a `[query confidence: low ...]` line with hints
  auto_elaborate: false  # opt-in: fuse a deterministic query variant as an extra candidate source
  refine_hints: true     # append a `[refine: ...]` line with next-query candidates
  rerank: off            # off | local — opt-in cross-encoder reranking of the top 30 fused hits
  rerank_model: Xenova/ms-marco-MiniLM-L-6-v2
  rerank_topn: 30
guidance:
  enabled: true          # inject context_search guidance into the system prompt
compression:
  level: standard        # minimal | standard | full
  ollama_url: http://localhost:11434
  query_aware: true      # keep query-relevant lines when truncating
embedding:
  model: local           # or a specific transformers.js model id
  ollama_model: nomic-embed-text
indexer:
  redact_secrets: true
  context_headers: true  # prepend `// file: ... | unit: ... | imports: ...` to chunk text
  chunking: legacy        # legacy (default) | ast-density — cAST-style budgeted split-merge (experimental)
  chunk_budget_chars: 1200 # non-whitespace budget per ast-density chunk
  auto_index: true        # incremental background reindex shortly after session start
  max_auto_files: 10000   # automatic full-project file budget; 0 disables the guard
  watch: true             # reindex on file changes while the session runs (debounced, incremental)
memory:
  redact_pii: true
pricing:
  model: opus            # opus | sonnet | haiku | gpt-4o | gemini-2.5-pro | ...
storage:
  path: ~/.pi-context-engine/projects
```

Environment overrides:
- **`PCE_OLLAMA_URL`**: point at a remote Ollama; wins over config.
- **`PCE_EMBED_BACKEND`**: force `local` or `ollama` instead of auto-detect.
- **`PCE_RECALL_DISPLAY_CAP`**: how many recall hits to show (default 7).

**Reranking caveat**: `retrieval.rerank: local` is opt-in because it downloads
an ~80 MB cross-encoder model on first use (into the same models dir as the
embedder) and adds CPU latency per query. It reorders only the top 30 fused
candidates; if the model cannot load, retrieval falls back to the fused order
instead of failing.

**Chunking caveat**: `indexer.chunking: ast-density` (cAST-style budgeted
split-merge) is experimental and measured WORSE than the legacy walk on this
package's eval (R@10 0.818 vs 0.936 with the deterministic embedder): tiling
trivia into chunks dilutes fixed-size result sets. It stays behind a flag for
A/B on other workloads; chunks concatenate byte-for-byte back to the source,
so it is safe to try on a branch.

**Embedding backends**: two options, picked automatically per project.

- **Ollama** (default when reachable): no extra model files on disk beyond the
  Ollama model itself.
- **Local ONNX** (transformers.js): works with no server. Needs the
  `@huggingface/transformers` optional dependency, which plain `npm` and `pi`
  installs include. If it was stripped (e.g. `--omit=optional`), indexing fails
  with a clear message telling you to reinstall or switch to Ollama, instead of
  a bare module error.

## Security

Indexing is local, but the index is still a copy of your code. Two guards ship on
by default:

- **Secret files are never read**: `.env*`, `*.pem`, `credentials.json`,
  `id_rsa` and similar are skipped at the filesystem walk.
- **Secret values are redacted**: AWS keys, GitHub and Slack tokens, Stripe live
  keys, JWTs and private-key blocks become `[REDACTED:LABEL]` before embedding.
- **PII is scrubbed on memory writes**: emails, IPs, SSNs, phones and
  Luhn-valid cards never reach the memory database.

Path arguments are validated against the project root, so a crafted `path` cannot
read outside it.

## Supported languages

**AST chunking** (tree-sitter): Python, JavaScript, TypeScript, TSX, PHP, Go,
Rust, Java, C#.

**Fallback chunking** (whole-module): every other text file, including
Markdown, JSON, YAML, SQL, HTML, CSS and 40+ more extensions. Binary files and
files over 2 MB are skipped.

## Differences from upstream CCE

This is a port, not a wrapper. Three deliberate changes:

- **Pi-native integration**: tools and lifecycle hooks replace the MCP server and
  the `curl`-based Claude Code hooks. Session capture rides on pi's own events.
- **No Python runtime**: embeddings run through transformers.js or Ollama, so
  installation is one npm command.
- **Two upstream bugs fixed**: chunk ids now include column offsets (identical
  spans on one line used to overwrite each other in the index), and the
  placeholder filter no longer suppresses unambiguous vendor keys that happen to
  contain a word like `example`.

Not ported (yet): the web dashboard, output-compression rules, and editor
bootstrapping for non-pi editors.

## Development

```bash
npm install
npm run check          # typecheck + 251 unit tests
npm run smoke:env      # tree-sitter + sqlite-vec capability check
npm run smoke:loader   # load the extension through pi's jiti loader
npm run smoke:real-world  # index this repo with the local embedder
```

## Credits

- [code-context-engine](https://github.com/elara-labs/code-context-engine) by
  elara-labs (Fazle Elahee, Raj): the retrieval design, thresholds and heuristics.
- [sqlite-vec](https://github.com/asg017/sqlite-vec), [tree-sitter](https://tree-sitter.github.io/),
  [transformers.js](https://github.com/huggingface/transformers.js), and [Ollama](https://ollama.com/).

## License

MIT. See [LICENSE](LICENSE).
