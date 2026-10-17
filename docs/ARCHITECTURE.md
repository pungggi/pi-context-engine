# Architecture

How the pieces fit together, and where to change what.

## Flow

```
pi session
  └─ extension.ts          tools, commands, lifecycle events
       └─ engine.ts        stateful core: owns every resource for one project
            ├─ indexer/    walk → chunk → embed → ingest
            ├─ retrieval/  vector + BM25 + RRF + confidence
            ├─ compression/  signatures, or an Ollama summary
            └─ memory/     decisions, turn summaries, savings ledger
                 └─ storage/  sqlite-vec | FTS5 | graph, three databases
```

## Module map

| Module | Responsibility | Ported from (upstream) |
|---|---|---|
| `extension.ts` | Pi integration: 10 tools, 3 commands, 4 events | `integration/mcp_server.py` |
| `engine.ts` | Per-project state, savings accounting, recall | `integration/mcp_server.py` |
| `indexer/pipeline.ts` | Walk, chunk, embed, ingest, prune, git history | `indexer/pipeline.py` |
| `indexer/chunker.ts` | tree-sitter AST chunking, import extraction | `indexer/chunker.py` |
| `indexer/embedder.ts` | Ollama + local ONNX backends, selection | `indexer/embedder.py` |
| `indexer/secrets.ts` | Secret filename skip, content redaction, PII scrub | `indexer/secrets.py` |
| `retrieval/retriever.ts` | RRF merge, confidence blend, graph expansion | `retrieval/retriever.py` |
| `compression/compressor.ts` | Truncation signatures, Ollama summaries, quality gate | `compression/*` |
| `memory/db.ts` | Schema, vec recall, savings ledger, retention | `memory/db.py` |
| `memory/grammar.ts` | Deterministic prose compression | `memory/grammar.py` |
| `storage/*` | vector / FTS / graph stores behind one backend | `storage/*` |

## Storage layout

One directory per project under `storage.path` (default
`~/.pi-context-engine/projects/<basename>-<6hex>/`):

```
vectors/vectors.db    chunks + sqlite-vec embeddings + compression cache
fts/fts.db            BM25 index (FTS5)
graph.db              nodes + imports/defines/modifies edges
memory.db             sessions, prompts, tool events, decisions, savings_log
sessions/*.json       readable session archive (also feeds recall)
manifest.json         content hash per file → incremental indexing
embedding_cache.db    SHA-256(content) → vector, salted with backend identity
stats.json            query and token totals
```

**Why several databases:** the vector store and the FTS store are written with
different concurrency patterns, and FTS5 rebuilds are cheaper when they are not
contending with embedding writes. Upstream made the same split.

## Key invariants

- **Rowids never cross the bind boundary.** better-sqlite3 binds JS numbers as
  REAL, and sqlite-vec's `vec0` rejects non-INTEGER rowids. Every vec insert uses
  `INSERT...SELECT` (`run(BigInt(rowid), buffer)` only where a bigint is required).
  Getting this wrong fails silently: search returns nothing while metadata still
  reads fine.
- **`warmupLanguages()` before `chunk()`.** Grammar loading is async because WASM
  loads asynchronously, but chunking is sync for throughput. The pipeline warms
  every language it is about to need.
- **Embed before delete.** Per-batch rows are removed only after embeddings
  succeed, so an embedding failure can never wipe a working index.
- **Manifest is saved last.** A mid-run crash leaves the manifest unchanged, so
  the next run simply retries the affected files.
- **Chunk ids are deterministic.** Ids hash `file:startLine:startCol:endLine:endCol:content[0:100]`.
  Columns matter: two spans on one line otherwise collide, and the second write
  silently overwrites the first (an upstream bug).
- **Best-effort everywhere it must not crash.** Savings accounting, audit logs,
  session capture and shutdown all swallow their own errors: an instrumentation
  problem must never break a tool response.

## Degradation paths

The package works without optional pieces instead of failing:

- **No Ollama** → local ONNX model (one-time download).
- **No sqlite-vec** → FTS-only retrieval; metadata still indexed.
- **No memory db open** → recall falls back to the JSON session archive.
- **Empty index** → first search returns a status line and indexes in the
  background rather than blocking the turn.
