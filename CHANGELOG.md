# Changelog

## 4.0.0

### Breaking Changes

- `runAgentMemoryImprovement()` now activates a measured winner through `activation.readCurrent()` and atomic `activation.compareAndSet()` instead of `onPromote`.
- `AgentMemoryActivation.receiptPath` is now `journalPath` because the file is an append-only activation record.
- `mem0MemoryAdapterIdentity()` and `graphitiMemoryAdapterIdentity()` require a stable, non-secret `backendRef` so two deployments cannot share a cache identity.
- Paid benchmark and improvement work now defaults to a zero dollar limit and requires an explicit `costCeiling` or `maxTotalCostUsd`.

### Added

- Official-client adapters for Mem0 hosted and open-source deployments, Graphiti MCP, and Neo4j Agent Memory.
- Isolated memory branches with snapshots, replayable forks, private, team, and shared visibility, and ordered writes per agent.
- Parallel multi-track memory experiments and configuration search on `agent-eval`, with fresh-history comparison before activation.
- Durable controller ownership, interrupted-attempt cleanup, retired-candidate recovery, bounded cleanup work, and conservative recovery cost reconciliation.
- Exact scoped Mem0 deletion with list and search convergence checks.
