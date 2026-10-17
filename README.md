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

Ten tools the agent can call, plus three slash commands.

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

Commands: `/context-index [--full]`, `/context-status`, `/context-savings`.

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

## Requirements

- **Node 22+** on macOS, Linux or Windows.
- **Embeddings**: Ollama at `localhost:11434`, or nothing (the local ONNX model
  downloads once, ~25 MB).
- **Optional Ollama model**: `nomic-embed-text` is pulled automatically on first use.

No Python. No build tools. No API key.

## Configuration

Zero config by default. Override in `~/.pi-context-engine/config.yaml` or a
per-project `.context-engine.yaml`:

```yaml
retrieval:
  top_k: 20
  confidence_threshold: 0.2
  marginal_ratio: 0.75   # stop adding chunks below this fraction of the top score
compression:
  level: standard        # minimal | standard | full
  ollama_url: http://localhost:11434
embedding:
  model: local           # or a specific transformers.js model id
  ollama_model: nomic-embed-text
indexer:
  watch: true
  redact_secrets: true
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
npm run check          # typecheck + 97 unit tests
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
