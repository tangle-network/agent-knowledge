# Changelog

## 5.0.3

### Changed

- Updated `@tangle-network/agent-eval` to `0.127.0` and adopted its explicit run outcome, cost provenance, and scenario identity contract.
- Allowed filesystem-heavy lifecycle tests enough time to complete under shared-runner load.

## 5.0.2

### Changed

- Updated the maintained Neo4j Agent Memory and Mem0 adapters plus compatible build and formatting dependencies.
- Aligned the official optimizer bridge with `@tangle-network/agent-eval@0.126.7`.
- Forced patched Hono, Node server, WebSocket, Vite, and esbuild releases so the installed graph has no known npm advisories.

## 5.0.1

### Changed

- Updated `@tangle-network/agent-eval` to `0.126.6` so Knowledge and Runtime use the same optimizer provenance contract.

## 5.0.0

### Breaking Changes

- Retrieval improvement now requires independent train, selection, and final scenarios plus an explicit complete `OptimizationMethod`.
- Serialized retrieval and RAG optimization now requires an immutable `executionRef` covering candidate execution and scoring behavior.
- Memory configuration improvement now requires a baseline configuration, a complete `OptimizationMethod`, and independent train, selection, and final histories.
- The RAG lifecycle promotion callback is now `decidePromotion` and runs only after final evidence passes regression, provenance, and cost checks.
- Knowledge improvement requires an immutable `implementationRef`, separates repeatable development evaluation from single-use final evaluation, and refuses to resume after interrupted final scoring.
- Memory candidate factories no longer receive scenario, repetition, or seed identity and must report observed external charges through `recordExternalCost()`.
- Answer-quality hooks require immutable evaluator identity, final scenario identity, and complete cost evidence.
- Removed the public retrieval and memory proposer-search options; candidate generation and selection now belong to `agent-eval` methods.

### Added

- Added a shared serialized-candidate adapter for running complete `agent-eval` optimization methods with canonical candidate identity and untouched final comparison.
- Added full RAG configuration optimization and KB maintenance policy optimization.
- Added direct support for official GEPA and SkillOpt methods through the shared `OptimizationMethod` contract.
- Added durable per-configuration memory candidate identities to prevent stale result reuse.
- Added live activation verification so resumed memory runs reject configuration drift.
- Added private execution contexts that expose memory operations, cancellation, and cost metering without evaluation labels.

### Changed

- Updated `@tangle-network/agent-eval` to `0.126.5` and `@tangle-network/agent-interface` to `0.32.0`.
- Kept memory provider evaluations resumable and branch-isolated while moving search ownership to the supplied method.
- Restricted immutable references to lowercase SHA-256 and full Git commit identities.

## 4.1.0

### Added

- Added optional scenario input to `knowledgeReleaseReport()` so a required holdout can prove both scenario and run coverage.

### Changed

- Split knowledge-base improvement and RAG evaluation internals into focused modules while preserving public exports and implementation behavior.
- Split the knowledge improvement tests into candidate, promotion, activation, and integrity suites with shared setup in one support module.
- Removed unused development dependencies and internal-only exports.
- Updated the test runner to Vitest 4 and Node type definitions to 26; TypeScript remains on 5.9 because tsup's declaration bundler does not yet support TypeScript 7.
- Declared Node types explicitly in TypeScript configuration instead of relying on ambient type discovery.
- Corrected the package dependency guide and RAG roadmap to reflect runtime-owned agent execution through `runKnowledgeImprovementJob()`.
- Removed historical commentary and em dashes from repository documentation.

### Fixed

- Replaced the stale versioned HTTP user agent with a stable package identity and added request-header coverage.

## 4.0.1

### Changed

- Split benchmark, memory experiment, and memory improvement internals into focused modules while preserving every public export and signature.
- Split memory and benchmark tests by behavior, with shared controller and adapter fixtures kept in one test-support module.
- Moved retrieval holdout contracts into the memory type layer to remove the holdout/types import cycle.

### Fixed

- Made the Mem0 deletion-convergence test deterministic under file-level parallel execution.

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
