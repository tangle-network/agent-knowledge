# Architecture

`@tangle-network/agent-knowledge` is a domain-agnostic knowledge-base construction layer for agents.

It owns the small set of primitives every serious agent knowledge system needs:

- immutable source records
- generated knowledge pages and units
- claims with source references
- deterministic indexing, graph construction, search, and lint
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
| `.agent-knowledge/event-log/` | immutable event payload segments, bounded metadata buckets, and sequence state |
| `.agent-knowledge/events.json` | legacy event array; migrated transactionally on the first event write |
| `.agent-knowledge/claim-ledgers/<id>.json` | one research run's claim ledger: corroboration counts, contradiction edges, open deep questions |
| `.agent-knowledge/sources.json` | the immutable source registry |
| `.agent-knowledge/mutation.lock.durable`, `mutation-epoch.json`, `file-transactions/` | the cross-process mutation lock and its crash-recovery state |

The root is also the directory `withKnowledgeMutation` locks, so every record above is written under one lock and one epoch.
Within one process, writers to a root queue in arrival order before they take the file lock, and reads share that admission: a reader waits for at most the write in progress, and a same-process write never restarts a read.
A waiting writer stops new readers from entering, and a finishing writer admits every waiting reader, so neither side starves.
A mutation cannot start inside a read of the same root; it fails instead of waiting on itself.
Other processes still meet the file lock and the epoch.
Retrieval visibility snapshots under `.agent-knowledge/retrieval-visibility/` are content-addressed evidence, written without the lock and without moving the epoch.
There is exactly one writer per file: a second index writer alongside this one is a defect, not a variation.

### Event persistence

Event writes append a content-addressed payload under `event-log/records/` and replace only the affected metadata bucket under `event-log/index/` plus `state.json`. All changes use the existing recoverable file transaction under the store mutation lock. A repeated id replaces its visible value; older payload segments remain as retained history. Repeated writes replace the visible id without creating duplicate results. Backdated events and non-ISO `createdAt` strings retain the published `localeCompare` ordering; ties use insertion sequence.

Metadata is partitioned by event-id hash prefix. A leaf holds at most 256 entries; an overflowing leaf splits into narrower hash prefixes under the same transaction. Upserts read only the matching branch and leaf, so index writes are bounded independently of the total event count.

A limited query inventories and sorts the compact metadata buckets, then reads only the selected payloads. Filters apply before the limit. This is O(n) index metadata work and O(k) payload reads, not an O(1) tail lookup. Event writes do not read, sort, or rewrite the prior payload history. Retained payloads grow with distinct event versions; automatic compaction is intentionally absent because deleting history requires an explicit retention policy.

**Version 21 changes the on-disk event format. Older package versions cannot read migrated roots and may report an empty event history. Do not downgrade in place.**

Local comparison against `fdce05e` on Linux/Node 24 (three timed repetitions, median; fixtures preloaded, no ingestion timed):

| Events | Payload | Old append | New append | Old filtered tail(5) | New filtered tail(5) |
| --- | --- | --- | --- | --- | --- |
| 1,000 | research iteration | 15 ms | 43 ms | 7 ms | 16 ms |
| 10,000 | research iteration | 69 ms | 29 ms | 32 ms | 43 ms |
| 10,000 | 8 KiB metadata | 518 ms | 23 ms | 223 ms | 56 ms |
| 10,000 | 32 B metadata | 26 ms | 29 ms | 16 ms | 38 ms |

The representative fixture follows `src/research-loop.ts`: a goal, iteration, done flag, source count, three written paths, warning count and error count. This is the package's current event producer, and its events are typically compact summaries; 8 KiB is a stress control, not the expected workload. These observations show the tradeoff, not a latency guarantee: transaction overhead makes small-store writes slower, and scanning the index can make compact-payload reads slower. At 10,000 representative events the old array is about 4.88 MB and the metadata index 1.86 MB; only five full payloads are read. The prior per-id-file design was rejected after a 7× small-payload tail regression.

No claim is made of constant-time indexed tail access. Reproduce after building both revisions with `node scripts/benchmark-event-store.mjs /path/to/previous/dist/index.js`; the script emits JSONL measurements. The metadata scan uses anchored, no-follow descriptors in bounded 64-file slices, yielding between slices, and no process-global cache whose identity could go stale on promotion.

Read-only access to an unmigrated `events.json` remains supported. The first write migrates it and removes it atomically; interrupted migrations use the same recovery journal as other writes. Stop older writers before upgrading. If an older writer recreates `events.json` after migration, reads and writes refuse rather than silently combining divergent histories. A missing state record alongside log files is also refused. `KB_EVENTS_PATH` continues to identify the legacy import path, not a live array to edit.

For a quiesced rollback, stop all readers and writers, retain a backup of the migrated root, and export the current visible events into a separate, fresh legacy root. Use the current package to read, then the public durable writer to save the legacy array:

```ts
const events = await new FileSystemKbStore({ root: migratedRoot }).listEvents()
await writeJsonDurableWithinRoot(freshLegacyRoot, '.agent-knowledge/events.json', events)
```

Copy the other authoritative KB content (pages, raw sources, source registry and claim ledgers) to that fresh root without `event-log/`, locks, or transaction journals, while the source remains quiescent. Validate the exported array before directing older code at the fresh root. For a direct-directory store, use its string constructor and export to `events.json`. This exports the latest value per id, which is the old array's contract; historical superseded segments remain in the backup. Never write the export into a migrated root. The original root and its snapshots remain intact, and switching back to them is possible without rebuilding lost history.

The direct-directory string constructor stores `event-log/` beside its former `events.json`; the explicit root constructor stores `.agent-knowledge/event-log/`. The canonical `.agent-knowledge` string alias shares the explicit root's layout and lock. Distinct direct and root layouts remain isolated even when their roots are the same directory.

Research-state candidate snapshots include the entire canonical event log, including retained payloads, so hashing, promotion, rollback and recovery preserve the exact declared event history. Default candidates still exclude research state.

A claim ledger is the one record several writers legitimately share, such as a resumed run beside a live one or several workers researching one goal in parallel.
They reach it through `mergeClaimLedger(id, merge)`, which holds the mutation lock across the read, the merge, and the write, so no writer can build its record from a value another writer has already replaced.
`putClaimLedger` writes the whole record and is correct only for a single writer.
The combining rule is `mergeClaimLedgers`: support and contradiction edges union, `contested` and `addressed` latch on, `firstSeenRound` moves earlier, and every collection is sorted.
The merge is commutative, associative, and idempotent, so the bytes on disk depend on the evidence rather than on scheduling.
Ledgers for two different goals refuse to merge (`ClaimLedgerGoalConflictError`) rather than pooling unrelated evidence into one corroboration count.
`TrackedClaim` keeps its published `Set` fields; the ledger stores a separate `ResearchClaimRecord` with sorted arrays so JSON serialization cannot erase those sets.
A `ResearchClaimEvidence` observation records the expected registry id, original URI, and full content hash; it cannot affect claim support or completion by itself.
The ledger materializes only observations whose complete source identity matches a confirmed record, so reusing one URI for different bytes cannot activate the wrong claims and a crash on either side resumes safely.
Unversioned URI-only ledgers cannot prove which bytes produced their observations; reads and writes fail with `ClaimLedgerMigrationRequiredError` and preserve the original file for an explicit archive-and-reverify migration.
Without readiness specifications, the loop runs to its round limit and never reports ready.

Every write in this layer goes through `durable-fs` (`writeFileDurable`, `writeJsonDurableWithinRoot`): temp file, fsync, atomic rename, and parent fsync.
`O_NOFOLLOW` descriptors anchored through `/proc/self/fd` prevent a directory swapped for a symlink during a write from redirecting it outside the root.
These are exported from the package entrypoint; consumers that keep their own journals should use them rather than reimplement them.

## Candidate state scope

KB improvement snapshots include pages, raw evidence, and the source registry by default.
A declared `stateScope.pagesDirectory` selects the same pages for writers, readers, indexing, and promotion.
Opting into `stateScope.researchState` also binds canonical claim ledgers and research events.
The hash includes nondefault scope declarations, so two different scopes cannot silently share an identity when their extra directories are empty.
Resume uses the persisted scope and refuses a changed declaration.
Promotion and crash recovery apply its narrow path allowlist through the existing file transaction journal.
Derived indexes, lock state, retrieval artifacts, and external providers are excluded.
Applications must bind external state through their existing memory branch or evaluation contracts.

## Runtime Loop

1. Normalize sources into immutable source records.
2. Generate staged knowledge write proposals.
3. Parse write proposals through the safe write protocol.
4. Validate paths, citations, links, and schema.
5. Index generated knowledge pages.
6. Search and graph-lint the knowledge base.
7. Evaluate candidate KB and retrieval variants with an `agent-eval` improvement loop, then fold the resulting run records into release confidence with `knowledgeReleaseReport`.
8. Promote only variants that pass downstream gates.
