# Agent Knowledge

## Read for the task

- For package usage, CLI commands, write proposals, or evaluation adapters, read [README.md](README.md).
- Before changing storage, locks, research persistence, or package ownership, read [architecture](docs/architecture.md).
- For run isolation and promotion, read [run-scoped citations](docs/run-scoped-citations.md).
- For retrieval evidence, read [knowledge-use receipts](docs/knowledge-use-receipts.md).
- Resolve current exports and signatures from [src/index.ts](src/index.ts), the installed declarations, and nearby tests.

## Ownership

Imports flow from `agent-runtime` to this package, then to `agent-eval` and `agent-interface`.
This package must not import `agent-runtime`; agent execution enters through callbacks.
`agent-eval` must not import this package.
Keep knowledge-domain storage, sources, retrieval, freshness, and candidates here.
Portable contracts belong to `agent-interface`; shared evaluation and improvement machinery belongs to `agent-eval`.
Applications own tenant roots, lineage authority, effect authorization, runtime wiring, and promotion decisions.

## Evidence and mutation

- Register sources before citing them; preserve raw evidence unchanged.
- Validate write proposals with intake before changing any bytes.
  Writers and readers must use the same pages directory.
- Build retrieval briefs before execution and mint receipts from their actual results.
- Reindex page changes and propagate invalidation to citers.
- Write into run scope; promote through the maintained promotion API after lint and validation pass.
  Missing sources block use and promotion.
- Source `verifiable` means a fetch and extraction passed configured checks.
  It does not authenticate the publisher.
  Refuse citations to unverifiable fragments.

## Storage and outcomes

Use `KbStore` as the record owner and durable filesystem helpers for crash-sensitive writes.
Every writer to one store root shares its mutation lock, including consumer lock wrappers.
Use the reentrant mutation scope when a caller already holds that root lock.
Concurrent claim-ledger writers use `mergeClaimLedger`; a whole-record replacement can erase another writer's evidence.
Keep the live Set-based claim API separate from its serialized records.
Checkpoint research state before publishing a round event so interrupted work can resume without fabricated progress.

Use the maintained claim graders.
Self-supplied expectations, timeouts, and checks that never reach their input do not refute a claim.
Repeated copies of one check are not independent evidence.
External failures remain typed outcomes; callers inspect success before using values.
Do not replace missing evidence with zero or an implicit fallback.

## Validation

Run checks relevant to changed behavior from [package.json](package.json).
For public package or skill changes, include the corresponding package and skill checks.
Keep development cases separate from final comparisons, and activate only the exact candidate that passed the decision.
