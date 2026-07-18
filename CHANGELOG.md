# Changelog

## 4.0.0

### Breaking Changes

- `runAgentMemoryImprovement()` now activates a measured winner through `activation.readCurrent()` and atomic `activation.compareAndSet()` instead of `onPromote`.
- `AgentMemoryActivation.receiptPath` is now `journalPath` because the file is an append-only activation record.
- `mem0MemoryAdapterIdentity()` and `graphitiMemoryAdapterIdentity()` require a stable, non-secret `backendRef` so two deployments cannot share a cache identity.
- Mem0 hosted mode now follows the synchronous array response from `mem0ai` 3.x; the unsupported queued-event options were removed.
- Paid benchmark and improvement work now defaults to a zero dollar limit and requires an explicit `costCeiling` or `maxTotalCostUsd`.
- In-flight run directories from releases before 4.0 are not migrated; archive or clear them before upgrading because 4.0 rejects older attempt records.

### Added

- Official-client adapters for Mem0 hosted and open-source deployments, Graphiti MCP, and Neo4j Agent Memory.
- Isolated memory branches with snapshots, replayable forks, private, team, and shared visibility, and ordered writes per agent.
- Parallel multi-track memory experiments and configuration search on `agent-eval`, with fresh-history comparison before activation.
- Durable controller ownership, interrupted-attempt cleanup, retired-candidate recovery, bounded cleanup work, and conservative recovery cost reconciliation.
- Complete candidate cost attribution across interrupted retries, plus explicit unranked recovery spend for retired benchmark candidates.
- Exact scoped Mem0 deletion with list and search convergence checks.

### Fixed

- Mem0 and direct Neo4j operations reject provider scopes they cannot enforce before any provider call.
- Hosted Mem0 `appId` is an additional filter and cannot authorize an unscoped whole-application read or delete.
- Mem0 cleanup tracks fresh writes until they become visible and confirms deletion from both list and search indexes.
- Broader Mem0 cleanup scopes wait for delayed writes created under matching narrower scopes.
- Mem0 pending-write probes expire after the configured visibility window instead of accumulating for the adapter lifetime.
- Direct Neo4j reasoning writes reject combined session and run scopes because the SDK can enforce only one conversation identifier.
- Timed-out provider work blocks close or reuse of the same adapter until the original operation settles.
- Recovery retries are reserved durably before provider work and stop after three failures per attempt by default.
- Direct memory benchmarks account for billable adapter provisioning and reconnects in the shared dollar limit.
- Fully cached benchmark resumes skip adapter creation and add no provider charge.
- Execute and recovery adapter factories receive abort signals and are bounded by the configured timeout.
- Adapters returned after a timed-out factory call are closed, and experiment adapters also run their configured disposal callback.
- Reported dollar totals are normalized to twelve decimal places instead of exposing binary floating-point artifacts.
