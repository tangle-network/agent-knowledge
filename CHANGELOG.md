# Changelog

## Unreleased

## 7.2.4

### Changed

- Require Eval `0.145.2` and Interface `0.47.0` as the current shared contract cohort.
- Bump the exact Eval and Interface development pins to `0.145.2` and `0.47.0`.

## 7.2.3

### Changed

- Align the required Eval peer and exact development pin with Eval `0.145.0`.
- Keep the published Knowledge package on one Eval copy after Eval's tiered root-barrel release.

## 7.2.2

### Fixed

- Import `pairArms` from Eval's `experiment` subpath so the published package works with Eval `0.144.13`.

## 7.2.1

### Changed

- Updated the required Eval peer and exact development pin to `0.144.11` so consumers install one current shared cohort.

## 7.2.0

### Changed

- Changed `@tangle-network/agent-eval` and `@tangle-network/agent-interface` to required compatible peers.
- Kept exact development pins at Eval `0.144.10` and Interface `0.46.1`.
- Consumers now select one shared Eval and Interface cohort instead of nested package copies.

## 7.1.3

### Changed

- Updated `@tangle-network/agent-eval` to `0.144.8` so Knowledge and Runtime install the duplicate-safe candidate contract without an older Eval copy.

## 7.1.2

### Changed

- Updated `@tangle-network/agent-eval` to `0.144.6` and `@tangle-network/agent-interface` to `0.46.1`, so Knowledge consumers resolve one canonical interaction-binding contract through Eval, Core, and Interface.

## 7.1.1

### Changed

- Updated `@tangle-network/agent-eval` to `0.144.5` and `@tangle-network/agent-interface` to `0.46.0`, so Knowledge consumes the current profile contract through one exact dependency set.

## 7.0.11

### Changed

- Updated `@tangle-network/agent-eval` to `0.144.4` and `@tangle-network/agent-interface` to `0.43.1`, so Knowledge consumes prompt-cache accounting through one exact Core, Interface, and Eval dependency set.

## 7.0.10

### Changed

- Updated `@tangle-network/agent-eval` to `0.144.3` so Knowledge consumers use exact profile-matrix evidence validation and concurrent profile comparison without installing an older Eval copy.

## 7.0.9

### Changed

- Updated `@tangle-network/agent-eval` to `0.144.1` so Knowledge and Runtime install the same official-optimizer callback contract.

## 7.0.8

### Changed

- Updated `@tangle-network/agent-eval` to `0.143.0` so Knowledge preserves exact observed, estimated, and uncaptured evaluation costs without installing an older Eval copy.

## 7.0.7

### Changed

- Updated `@tangle-network/agent-eval` to `0.142.2` and `@tangle-network/agent-interface` to `0.43.0` so Knowledge, Runtime, and Sandbox use one current canonical profile contract.

## 7.0.6

### Changed

- Updated `@tangle-network/agent-eval` to `0.142.1` and `@tangle-network/agent-interface` to `0.42.1` so one installed stack uses the current shared contracts without nested older copies.

## 7.0.5

### Added

- Added `runAgentMemoryLearningExperiment` for matched stateful-versus-stateless memory measurement under one shared cost limit.
- Added exact paired gain, explicitly labeled transfer probes, and repeated-probe forgetting reports.
- Limited learning gain to post-first-step probes, averaged repetitions within independent sequences, and added per-candidate intervals.
- Added recorded arm order for counterbalanced runs and exact sequence references for safe crash recovery.
- Added abort and resume support, content-addressed comparison and probe evidence, and exact cell artifact hashes.

### Changed

- Memory experiment artifacts and cache identities now record `memoryMode` and a full `comparisonRef`; non-equivalent arms fail comparison.
- Updated `@tangle-network/agent-eval` to `0.142.0` and `@tangle-network/agent-interface` to `0.42.0` so one installed stack uses the same exact evaluation, profile, and interface contracts without older nested copies.
- Extended packed-package verification to reject stack dependency overrides, mismatched transitive versions, and multiple installed copies of Eval, Core, or Interface.

## 7.0.1

### Changed

- Updated `@tangle-network/agent-eval` to `0.135.4` and `@tangle-network/agent-interface` to `0.37.0` so one installed stack uses the same exact trace-ingestion, source-identity, and interface contracts without older nested copies.

## 7.0.0

### Breaking Changes

- Changed research source confirmation from URI strings to exact `SourceRecord` values and versioned the durable claim ledger schema so every observation is bound to its registry id, original URI, and full SHA-256 content hash.
- URI-only 6.2 ledgers now fail with `ClaimLedgerMigrationRequiredError` and remain untouched for explicit archive-and-reverify migration; they are never guessed into the exact-source schema.

### Fixed

- Prevented registering one version of a URI from activating claims extracted from different bytes at that URI, including concurrent writers and crash recovery.
- Snapshotted source proposals before asynchronous work, preserved the exact submitted raw bytes, and used full content hashes in raw-source paths.
- Kept one-sided contradiction observations pending until both claims have exact registered support, preventing a missing counterpart from satisfying completion.

## 6.2.0

### Added

- Added durable, merge-safe research claim ledgers and `createPersistentResearchDrivingDriver`, preserving corroboration, contradictions, deep questions, and round state across crashes, resumes, and concurrent workers.
- Exported the durable filesystem write primitives used by the reference store so other journaled consumers can reuse the same atomic, symlink-safe writes.

### Fixed

- Kept extracted claim evidence pending until its exact source registration is confirmed, and reconciled interrupted registrations on restart so absent sources cannot satisfy completion while registered sources are not lost.
- Routed knowledge indexes, research iteration events, and claim ledgers through the canonical store layout and one mutation-lock domain.

## 6.1.11

### Changed

- Updated `@tangle-network/agent-eval` to `0.135.2` so knowledge improvement uses the corrected paired promotion decisions without installing an older Eval copy.
- Updated the installation example to pin the matching Knowledge and Eval releases.

## 6.1.10

### Fixed

- Extended packed-package verification to reject bare side-effect imports of packages that patch Node builtins while continuing to allow dynamic imports.

### Changed

- Updated `@tangle-network/agent-eval` to `0.135.1` for strict rollout-record validation and stable estimated-cost receipt validation.
- Updated the installation example to pin the matching Knowledge and Eval releases.

## 6.1.9

### Fixed

- Load `proper-lockfile` with a dynamic import inside the functions that take a lock, instead of at module scope.
  It pulls in `graceful-fs`, which patches Node's `fs` at import time (`fs.close = ...`).
  workerd exposes those as getter-only accessors, so the assignment threw while Cloudflare validated an uploaded Worker (`Cannot set property close of #<Object> which has only a getter [code: 10021]`), rejecting the whole Worker, including consumers that never take a lock.
  `verify:package` now fails on any static import of a module that patches a Node builtin, because `wrangler deploy --dry-run` bundles without executing and cannot see this class of failure.

## 6.1.8

### Changed

- Updated `@tangle-network/agent-eval` to `0.134.2` so knowledge evaluation resolves complete multishot judge cost accounting without installing an older Eval copy.

## 6.1.7

### Changed

- Updated `@tangle-network/agent-eval` to `0.134.1` so Knowledge consumers resolve the corrected Eval implementation without installing an older copy.

## 6.1.6

### Changed

- Updated `@tangle-network/agent-eval` to `0.134.0` so Knowledge and Runtime share one explicit proposal-finding contract without installing an older Eval copy.

## 6.1.5

### Changed

- Updated `@tangle-network/agent-eval` to `0.133.3` so knowledge evaluation and promotion use the corrected exact, Student-t, rank-test, and Welch implementations.

## 6.1.4

### Changed

- Updated `@tangle-network/agent-eval` to `0.133.2` for final-evaluation data isolation, lazy OpenCode SQLite loading, and fail-closed paired comparisons.
- Increased the official optimizer check's pip timeout and retries so slow package downloads do not fail an otherwise valid release.

## 6.1.3

### Changed

- Updated `@tangle-network/agent-eval` to `0.133.1` for corrected normal-approximation statistics.

## 6.1.2

### Changed

- Updated `@tangle-network/agent-eval` to `0.133.0` and `@tangle-network/agent-interface` to `0.36.0`.

## 6.1.1

### Changed

- Updated `@tangle-network/agent-eval` to `0.131.0` while retaining the exact `@tangle-network/agent-interface` `0.35.0` contract.
- Extended packed-package verification to confirm both installed agent stack dependencies match the package manifest.

## 6.1.0

### Changed

- Updated `@tangle-network/agent-eval` to `0.130.1`, `@tangle-network/agent-interface` to `0.35.0`, Mem0 to `3.1.2`, and the maintained build toolchain.
- Replaced tsup with tsdown so declaration builds support TypeScript 7.
- Added package export validation with publint and Are the Types Wrong to every release.
- Split Mem0 hosted and OSS client contracts, compile them against Mem0 3.1.2, and exercise the OSS SQLite lifecycle locally.
- Updated GitHub Actions to their current stable releases.

## 6.0.0

### Breaking Changes

- Renamed the verified research entry point to `runVerifiedResearchLoop` and removed the old two-agent function, option, result, round, and module names.
- Updated `@tangle-network/agent-eval` to `0.129.0` and `@tangle-network/agent-interface` to `0.34.0`.

## 5.0.4

### Changed

- Updated `@tangle-network/agent-eval` to `0.128.2` for canonical task-failure imports, reports, validation, and the exact Core 0.4.21 and Interface 0.33 dependencies.
- Updated `@tangle-network/agent-interface` to `0.33.0` so Knowledge and Runtime share the current certified context contract.

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
