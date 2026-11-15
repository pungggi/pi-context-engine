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
| `guidance.ts` | Query-formulation system-prompt section (config-gated) | upstream's session-start tool instructions |
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
index.lock            cross-process indexing gate (exists only mid-run)
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
- **Guidance pays for its tokens or does not ship.** The ~900-token section is
  injected only when `context_search` is in the run's selected tools *and*
  `guidance.enabled` is true, through `sections` (replayable, diffable) rather
  than a forced prompt replacement. Users who count prompt tokens opt out with
  one config line.

## Degradation paths

The package works without optional pieces instead of failing:

- **No Ollama** → local ONNX model (one-time download).
- **No sqlite-vec** → FTS-only retrieval; metadata still indexed.
- **No memory db open** → recall falls back to the JSON session archive.
- **Empty index** → first search returns a status line and indexes in the
  background rather than blocking the turn.

## Concurrency across sessions

Multiple pi sessions can work on one project at the same time, and they share
one storage dir (sqlite files + manifest). Three mechanisms keep that safe:

- **BEGIN IMMEDIATE for every write transaction** (`immediateTransaction` in
  `sqlite.ts`): a deferred read-then-write transaction fails with `database is
  locked` instantly under writer contention, because SQLite deliberately
  bypasses `busy_timeout` on lock upgrades (an upgrade can deadlock). Taking
  the write lock at BEGIN means concurrent writers queue instead of erroring.
- **`busy_timeout` of 15 s** (`PCE_BUSY_TIMEOUT_MS` overrides) so indexing
  bursts from another session ride out instead of surfacing as errors.
- **Cross-process index lock** (`indexer/index-lock.ts`): the whole indexing
  run holds an `index.lock` lockfile (exclusive-create, so acquisition is
  atomic). Stale locks are stolen when the holder's PID is dead or the lock
  outlives 15 minutes, so a crashed session cannot wedge the project.
  - **Automatic runs** (`autoIndexOnce`, watcher, lazy kick) skip instantly:
    the other session's incremental pass covers the same files, and the
    skipped engine un-consumes its one-shot so a later kick retries.
  - **Manual `/context-index`** waits up to 10 s (`PCE_INDEX_LOCK_WAIT_MS`)
    for the peer run, then reports the skip.
  - **`/context-index --reset`** reports the holder PID instead of deleting
    files out from under a live run.

WAL mode means readers (search) are never blocked by any of this.
