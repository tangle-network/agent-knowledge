# Architecture

`@tangle-network/agent-knowledge` is a domain-agnostic knowledge-base construction layer for agents.

It owns the small set of primitives every serious agent knowledge system needs:

- immutable source records
- generated knowledge pages and units
- claims with source references
- deterministic indexing, graph construction, search, and lint
- labeled relation graphs with one edge per `(source, target, predicate)` and neighbor, walk, and reachability queries
- retrieval/RAG candidate surfaces, gold-target scoring, and eval-loop adapters
- safe LLM write proposals
- eval-gated release confidence through `@tangle-network/agent-eval`
- visualization DTOs under the `/viz` subpath
- storage contracts with memory/filesystem reference adapters
- discovery worker/dispatcher contracts
- event and release report models
- Zod schemas for public JSON shapes

## Boundaries

`agent-eval` owns traces, ASI, improvement loops, run records, and promotion gates.

`agent-knowledge` owns sources, claims, pages, graph/search/lint, retrieval/RAG construction surfaces, and knowledge base candidates.
It calls `agent-eval` instead of reimplementing improvement loops or promotion math.

Product apps own domain policies, provider accounts, vector stores, source adapters, task corpora, and promotion decisions.

Core does not own a D1 schema or fleet dispatcher. Apps wire `KbStore` and `KnowledgeDiscoveryDispatcher` to their tenancy, queue, budget, auth, and sandbox systems.

## On-disk layout

`new FileSystemKbStore({ root })` is the explicit knowledge-base-root form and owns everything under `<root>/.agent-knowledge/`.
The published `new FileSystemKbStore(directory)` form remains a direct record directory, so upgrading does not silently move an existing store.
When that string is the canonical `<root>/.agent-knowledge` directory, both forms use the root's one mutation lock; retaining the path must not create a second lock for the same files.

| Path | Record |
| --- | --- |
| `.agent-knowledge/index.json` | the built knowledge index (`writeKnowledgeIndex` writes it through this store) |
| `.agent-knowledge/events.json` | the knowledge event log, including one `research.iteration` per research-loop round |
| `.agent-knowledge/claim-ledgers/<id>.json` | one research run's claim ledger: corroboration counts, contradiction edges, open deep questions |
| `.agent-knowledge/sources.json` | the immutable source registry |
| `.agent-knowledge/mutation.lock.durable`, `mutation-epoch.json`, `file-transactions/` | the cross-process mutation lock and its crash-recovery state |

The root is also the directory `withKnowledgeMutation` locks, so every record above is written under one lock and one epoch.
There is exactly one writer per file: a second index writer alongside this one is a defect, not a variation.

A claim ledger is the one record several writers legitimately share, such as a resumed run beside a live one or several workers researching one goal in parallel.
They reach it through `mergeClaimLedger(id, merge)`, which holds the mutation lock across the read, the merge, and the write, so no writer can build its record from a value another writer has already replaced.
`putClaimLedger` writes the whole record and is correct only for a single writer.
The combining rule is `mergeClaimLedgers`: support and contradiction edges union, `contested` and `addressed` latch on, `firstSeenRound` moves earlier, and every collection is sorted.
The merge is commutative, associative, and idempotent, so the bytes on disk depend on the evidence rather than on scheduling.
Ledgers for two different goals refuse to merge (`ClaimLedgerGoalConflictError`) rather than pooling unrelated evidence into one corroboration count.
The live driver exposes the published Set-based `TrackedClaim`; the ledger stores a separate `ResearchClaimRecord` with sorted arrays so JSON serialization cannot erase those sets.
Source verification snapshots the proposal and persists a `ResearchClaimEvidence` observation containing the expected registry id, original URI, and full content hash; that observation cannot affect claim support or completion by itself.
After the exact submitted bytes are durable, `runVerifiedResearchLoop` passes the resulting `SourceRecord` to `commitSources`.
The ledger materializes only observations whose complete source identity matches a confirmed record, so reusing one URI for different bytes cannot activate the wrong claims and a crash on either side resumes safely.
Unversioned URI-only ledgers cannot prove which bytes produced their observations; reads and writes fail with `ClaimLedgerMigrationRequiredError` and preserve the original file for an explicit archive-and-reverify migration.
Before synchronous question generation, the persistent driver records `preparedRounds`; a resume reconstructs and checkpoints any prepared round whose questions were interrupted, and the loop publishes its `research.iteration` event only after that checkpoint succeeds.

Every write in this layer goes through `durable-fs` (`writeFileDurable`, `writeJsonDurableWithinRoot`): temp file, fsync, atomic rename, and parent fsync.
`O_NOFOLLOW` descriptors anchored through `/proc/self/fd` prevent a directory swapped for a symlink during a write from redirecting it outside the root.
These are exported from the package entrypoint; consumers that keep their own journals should use them rather than reimplement them.

## Runtime Loop

1. Normalize sources into immutable source records.
2. Generate staged knowledge write proposals.
3. Parse write proposals through the safe write protocol.
4. Validate paths, citations, links, and schema.
5. Index generated knowledge pages.
6. Search and graph-lint the knowledge base.
7. Evaluate candidate KB and retrieval variants with an `agent-eval` improvement loop, then fold the resulting run records into release confidence with `knowledgeReleaseReport`.
8. Promote only variants that pass downstream gates.

## CLI

The CLI is intentionally fast and local:

```bash
agent-knowledge init
agent-knowledge source-add ./source.md
agent-knowledge sources
agent-knowledge apply-write-blocks ./proposal.txt
agent-knowledge index
agent-knowledge search "query"
agent-knowledge inspect
agent-knowledge explain knowledge/concepts/example.md
agent-knowledge graph
agent-knowledge lint
agent-knowledge validate --strict
agent-knowledge export --format json
agent-knowledge viz
```

It does not call an LLM. It operates over markdown and cached JSON indexes so fleet jobs and dev containers can use it cheaply.
