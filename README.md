# agent-knowledge

Source-grounded, eval-gated knowledge growth primitives for agents.

This package turns raw sources and generated markdown knowledge into a versionable graph that agents can search, lint, evaluate, and improve over time. It is intentionally domain-agnostic: legal, tax, coding, research, finance, business, and scientific workflows define their own policies and rubrics on top.

## Contents

- [Install](#install)
- [Start here](#start-here): pick CLI vs programmatic
- [Common uses](#common-uses): wiki, RAG, memory, new KBs, existing KBs, and parallel agents
- [CLI](#cli): `init` → `source-add` → `index` → `search` → `lint`
- [Design](#design): the invariants, including immutable sources, cited claims, and deterministic graph output
- [Benchmark runner](#benchmark-runner): BEIR/MTEB/qrels, RAG answer, hallucination, KB-improvement cases
- [Agent-Eval integration](#agent-eval-integration): retrieval eval, readiness bundles, and release reports
- [Memory adapters](#memory-adapters): Mem0, Graphiti, Neo4j, branching, and automatic improvement
- [Research loops](#research-loop): direct and worker/reviewer knowledge growth
- [Runtime integration](#runtime-integration): how agent runners plug into the pure KB loop
- [Pluggable knowledge sources](#pluggable-knowledge-sources): live authorities → eval re-runs

## Install

```bash
pnpm add @tangle-network/agent-knowledge @tangle-network/agent-eval
```

## Start here

Two ways in, depending on what you're doing:

- **Author / inspect a KB by hand** → the [CLI](#cli) (`init` → `source-add` → `index` → `search` → `lint`). Fastest way to see the shape on disk.
- **Drive it from an agent** → pick the primitive by intent:
  - *"Does the agent have enough context to run?"* → [`buildEvalKnowledgeBundle`](#agent-eval-integration) (block / ask / acquire before execution).
  - *"Grow the KB as a researcher"* → [`runKnowledgeResearchLoop`](#research-loop) (deterministic mechanics; your agent owns judgment) or [`runVerifiedResearchLoop`](#verified-research-loop) (researcher proposes, reviewer checks and fills gaps).
  - *"Spawn live agents to improve a KB"* → pass an `updateKnowledge` callback to `improveKnowledgeBase`; runtime-backed supervisors live in `@tangle-network/agent-runtime`.
  - *"Tune retrieval for a knowledge base"* → `runRetrievalImprovementLoop` in the [Agent-Eval integration](#agent-eval-integration) section.
  - *"Run an operator-grade KB improvement cycle"* → `improveKnowledgeBase` in the [Agent-Eval integration](#agent-eval-integration) section.
    It creates a candidate KB, lets agents or deterministic hooks improve it, runs configured evals, and returns exact candidate identity for later approval.
  - *"Expose the lower-level RAG lifecycle phases"* → `runRagKnowledgeImprovementLoop` in the [Agent-Eval integration](#agent-eval-integration) section.
    It exposes retrieval tuning, gap diagnosis, knowledge acquisition/update, answer-quality checks, and promotion as one typed lifecycle.
  - *"Evaluate RAG answers or a wiki/KB"* → `ragAnswerQualityJudge`, `createRagAnswerQualityHook`, and `scoreKnowledgeBaseIndex` in the [Agent-Eval integration](#agent-eval-integration) section.
  - *"Run standard RAG/KB benchmarks"* → `runKnowledgeBenchmarkSuite` in the [Benchmark runner](#benchmark-runner) section.
  - *"Does this candidate KB improve task success?"* → run an [agent-eval improvement loop](#agent-eval-integration) over KB variants, then `knowledgeReleaseReport` for the promotion decision.
  - *"Keep live authorities fresh"* → [pluggable sources](#pluggable-knowledge-sources) + `detectChanges` → eval re-runs.

Storage stays consumer-owned via `KbStore` (`MemoryKbStore`, `FileSystemKbStore`, or your own D1/Postgres). Every primitive below is source-grounded: claims cite immutable source records, and lint fails on un-grounded citations.

## Common Uses

| Use case | What this package owns | Front door |
|---|---|---|
| LLM wiki or docs KB | Source records, cited markdown pages, lint, readiness scoring, candidate promotion | `improveKnowledgeBase` or `runKnowledgeResearchLoop` |
| RAG | Retrieval eval, source-span labels, answer quality checks, missing/stale/noisy-source diagnosis | `runRagKnowledgeImprovementLoop` |
| Memory DB | Provider adapters, isolated branches, sharing policies, ordered histories, and fresh comparison | `/memory` plus `runAgentMemoryExperiment` |
| From scratch | Empty KB layout, source ingestion, write-block application, indexing, readiness checks | CLI `init` or `runKnowledgeResearchLoop` |
| Existing KB | Candidate workspace, resume state, base-hash conflict check, exact approved promotion | `improveKnowledgeBase` |
| Parallel agents | Isolated KB candidates or memory branches, ordered per-agent writes, concurrent histories, and explicit activation | `improveKnowledgeBase` or `runAgentMemoryImprovement` |
| One-call agent job | Runtime supervisor plus all KB mechanics above | `runKnowledgeImprovementJob` from `@tangle-network/agent-runtime/knowledge` |

## CLI

```bash
agent-knowledge init --root .
agent-knowledge source-add ./docs/spec.md --root .
agent-knowledge sources --root .
agent-knowledge apply-write-blocks ./proposal.txt --root .
agent-knowledge index --root .
agent-knowledge search "portfolio risk" --root .
agent-knowledge inspect --root .
agent-knowledge explain knowledge/concepts/risk.md --root .
agent-knowledge graph --root . --format json
agent-knowledge lint --root .
agent-knowledge validate --strict --root .
agent-knowledge export --root . --format json
agent-knowledge viz --root .
```

The default layout is:

```txt
raw/
  sources/
knowledge/
  index.md   # scaffold: human-navigation only, excluded from the page index
  log.md     # scaffold: human-navigation only, excluded from the page index
.agent-knowledge/
  sources.json
  index.json
```

`initKnowledgeBase` writes `knowledge/index.md` and `knowledge/log.md` for
authors to curate by hand. They are deliberately excluded from
`buildKnowledgeIndex` / `searchKnowledge` so they do not inflate page counts
or pollute search hits. Any nested `<dir>/index.md` or `<dir>/log.md` is
treated the same way. The shared predicate is `isScaffoldPath`, exported
from `@tangle-network/agent-knowledge`.

## Design

- Raw sources are immutable evidence.
- Generated knowledge is editable but validated.
- Claims should cite source records when promoted.
- Lint fails on pages that cite unknown source IDs.
- Text sources get deterministic anchors (`all`, `l1`, `l51`, ...) for precise citations like `[^src_id#all]`.
- Agent write proposals can be safely applied with `apply-write-blocks`.
- `KbStore` keeps storage consumer-owned; use `MemoryKbStore`, `FileSystemKbStore`, or implement D1 in the app.
- Discovery uses worker/dispatcher contracts, with a local dispatcher for dev and tests.
- `runKnowledgeResearchLoop()` provides thin loop mechanics for researcher
  agents: ingest sources, apply safe write blocks, rebuild the index,
  lint/validate, score readiness, and return a transcript. The agent still
  decides what to research, what to write, and when the wiki is good enough.
- `createKnowledgeControlLoopAdapter()` maps those mechanics into
  `agent-eval`'s `runAgentControlLoop()` so products can plug in their own
  proposer, reviewer, and driver policies.
- `runRagKnowledgeImprovementLoop()` coordinates the whole RAG improvement
  lifecycle. Retrieval tuning, diagnosis, acquisition, KB update,
  answer-quality eval, and promotion are separate typed phases so products can
  plug in browser agents, coding agents, connectors, or deterministic policies
  without this package hardcoding an agent runner.
- `improveKnowledgeBase()` wraps that lifecycle with durable candidate state,
  a per-run lock, resume support, isolated candidate workspaces, KB quality
  scoring, and an exact candidate reference for explicit promotion.
  Use it when running agents in loops against a real KB rather than only
  exposing phase hooks.
- `evaluateKnowledgeBaseReadiness()` checks one KB root without running an
  improvement loop: it rebuilds the index, validates/lints it, scores KB
  quality, and evaluates configured readiness specs.
- RAG answer evaluation follows the common open-source shape used by Ragas,
  DeepEval, TruLens, and RAGChecker: context quality, answer relevance,
  support/faithfulness, citations, abstention, and failure diagnosis.
  External tools stay pluggable via score normalization and row exporters.
- Zod schemas define the stable wire shape.
- Graph/search/lint are deterministic and fast.
- `searchKnowledge` returns hits with three score fields. `score` and
  `rrfScore` are the raw reciprocal-rank-fusion value (typically 0.01 to 0.05);
  use them when intent matters or when fusing across queries.
  `normalizedScore` is the same value scaled into [0, 1] relative to the top
  hit *in this result set* (top hit = 1, others = score / topScore). Use it
  when comparing against natural confidence thresholds. The normalization is
  within-set ranking, not a cross-query absolute confidence.
- Release confidence uses `@tangle-network/agent-eval` release gates (`evaluateReleaseConfidence`) instead of reimplementing them.
- Retrieval eval turns retrieval/RAG configs into `agent-eval` surfaces, auto-searches candidate configs, and scores them against page, source, source-anchor, or source-span targets.
- `buildEvalKnowledgeBundle()` maps wiki/search evidence into
  `agent-eval` `KnowledgeRequirement`, `KnowledgeBundle`, and
  `KnowledgeReadinessReport` contracts so control loops can block, ask, or
  acquire data before running an agent.

The `/viz` subpath exports graph insight helpers without UI dependencies.

The `/memory` subpath exports an optional memory adapter contract. Use it to
bridge episodic or graph-native memory systems into the same source-grounded
readiness/eval machinery without making `agent-knowledge` own the database.

## Benchmark Runner

Use `runKnowledgeBenchmarkSuite()` when the product goal is to run a fixed RAG/KB benchmark pack and get one report across retrieval, answer quality, hallucination, and candidate-KB improvement cases.
The module also exports `INDUSTRY_RAG_BENCHMARKS`, a compact manifest for BEIR, MTEB retrieval, MS MARCO, TREC DL, MIRACL, LoTTE, BRIGHT, CRAG, HotpotQA, KILT, RAGTruth, FaithBench, and first-party KB-improvement tasks.

```ts
import {
  buildFirstPartyMemoryLifecycleBenchmarkCases,
  buildIndustryMemoryBenchmarkSmokeCases,
  buildIndustryRagBenchmarkSmokeCases,
  buildRetrievalBenchmarkCasesFromQrels,
  createInMemoryBenchmarkAdapter,
  createNoopMemoryBenchmarkAdapter,
  isKnowledgeMemoryBenchmarkCase,
  parseKnowledgeBenchmarkQrels,
  respondToIndustryMemoryBenchmarkSmokeCase,
  respondToIndustryRagBenchmarkSmokeCase,
  runMemoryAdapterBenchmark,
  runKnowledgeBenchmarkSuite,
} from '@tangle-network/agent-knowledge/benchmarks'

await runKnowledgeBenchmarkSuite({
  cases: buildIndustryRagBenchmarkSmokeCases(),
  runDir: '.agent-knowledge/benchmark-runs/industry-smoke',
  respondRef: 'industry-rag-smoke:v1',
  respond: respondToIndustryRagBenchmarkSmokeCase,
})

await runKnowledgeBenchmarkSuite({
  cases: buildIndustryMemoryBenchmarkSmokeCases(),
  runDir: '.agent-knowledge/benchmark-runs/memory-smoke',
  respondRef: 'industry-memory-smoke:v1',
  respond: ({ case: testCase }) => {
    if (!isKnowledgeMemoryBenchmarkCase(testCase)) return { answer: '' }
    return respondToIndustryMemoryBenchmarkSmokeCase({ case: testCase })
  },
})

const memoryRanking = await runMemoryAdapterBenchmark({
  cases: buildFirstPartyMemoryLifecycleBenchmarkCases(),
  runDir: '.agent-knowledge/benchmark-runs/memory-ranking',
  costCeiling: 5,
  candidates: [
    { id: 'no-memory', ref: 'no-memory:v1', createAdapter: () => createNoopMemoryBenchmarkAdapter() },
    {
      id: 'in-memory',
      ref: 'in-memory:v1',
      createAdapter: () => createInMemoryBenchmarkAdapter(),
      searchLimit: 1,
    },
  ],
})

console.log(memoryRanking.rows)

const cases = buildRetrievalBenchmarkCasesFromQrels({
  benchmarkId: 'beir/nfcorpus',
  family: 'beir',
  queries: [{ id: 'q1', text: 'aspirin heart attack prevention', split: 'holdout' }],
  qrels: parseKnowledgeBenchmarkQrels('q1 0 src-aspirin 1'),
  targetKind: 'source',
  k: 10,
})

const result = await runKnowledgeBenchmarkSuite({
  cases,
  runDir: '.agent-knowledge/benchmark-runs/beir-nfcorpus-smoke',
  respondRef: 'product-retriever:v3',
  costCeiling: 5,
  respond: async ({ case: testCase }) => {
    if (testCase.taskKind !== 'retrieval') return { hits: [] }
    const hits = await retrieveFromYourKb(testCase.query)
    return { hits }
  },
})

console.log(result.report.score.mean)
```

`runMemoryAdapterBenchmark()` is for adapters that enforce every supplied scope and support exact scoped deletion.
Every cell records its fresh provider namespace before the first write and deletes it after measurement, so concurrent repetitions and retries cannot share memory.
On restart, unfinished scopes are deleted before any new benchmark cell runs.
The candidate factory receives `purpose: 'execute' | 'recovery'`, `signal`, and `markExternalCall()`; both paths must reconnect to the same provider and adapter identity.
Pass `signal` to provider connection and provisioning calls so timeout cancellation reaches the SDK.
Set `adapterId` when the returned adapter ID differs from the candidate ID.
The declared ID lets a fully cached resume skip adapter creation entirely; a returned mismatch fails before any case runs.
Keep local construction free.
When construction provisions or reconnects billable provider state, set `adapterCreationCostUsd` and call `markExternalCall()` immediately before the external action.
Normal read and write work belongs in adapter methods so it runs inside per-case cost accounting.
Use `runAgentMemoryExperiment()` below when an agent profile needs ordered multi-step histories, branch snapshots, runtime callbacks, or automatic configuration improvement.
Set `cleanupTimeoutMs` to bound each provider cleanup and close operation; the default is 180 seconds.
Set `costUsdPerCase` for normal provider work, `adapterCreationCostUsd` for billable construction or reconnects, and `recoveryCostUsdPerAttempt` when deleting an interrupted case can add another provider charge.
One `costCeiling` covers every candidate and recovery call in the comparison, and `totalCostUsd` reports the complete comparison cost.
`unrankedRecoveryCostUsd` identifies cleanup spend from retired candidates that cannot appear in ranking rows.
The default `costCeiling` is zero, so paid work is refused until the caller sets a limit.
Keep removed implementations in `recoveryCandidates` until their unfinished scopes are gone, and use `maxRecoveryAttempts` to reject an unexpectedly large backlog before provider work starts.
Each failed recovery is recorded before its provider call.
`maxRecoveryRetriesPerAttempt` defaults to three, and `recoveryLogPath` identifies the durable retry history returned by the run.
The default filesystem storage uses an OS lock; custom storage requires `controllerMode: 'process-local'` or a distributed `acquireRunLease` implementation.

Billable responders must execute paid work through `context.cost.runPaidCall()`; `costUsd` on an artifact is display-only.
Change `respondRef` whenever the model, prompt, retrieval, tools, or runtime behavior changes; resumable runs reject a missing reference instead of reusing ambiguous cached rows.
Use `buildRetrievalBenchmarkCasesFromQrels()` for qrels-backed retrieval datasets.
The smoke pack proves that every declared benchmark family is wired through the runner; full BEIR, MTEB, MS MARCO, TREC DL, MIRACL, LoTTE, BRIGHT, CRAG, HotpotQA, KILT, RAGTruth, and FaithBench runs should pass real dataset rows through the same case shapes.
Use `KnowledgeAnswerBenchmarkCase` for CRAG/HotpotQA/KILT-style answer checks and RAGTruth/FaithBench-style hallucination checks by encoding required claims, forbidden claims, and expected source IDs.
Use `taskKind: 'kb-improvement'` when the artifact is candidate KB text produced by `improveKnowledgeBase()`.
Use `KnowledgeMemoryBenchmarkCase` for memory systems.
Memory cases carry ordered events plus current required facts, stale forbidden facts, expected event IDs, and expected actor IDs.
The built-in memory scorer reports current fact recall, stale-memory safety, event recall, and actor recall, which maps to LoCoMo, LongMemEval, Memora, MemoryAgentBench, MemoryBank-style personalization, GroupMemBench, and first-party memory lifecycle checks.
Use `runMemoryAdapterBenchmark()` to rank real memory systems that implement `AgentMemoryAdapter`.
Built-in adapters cover Neo4j Agent Memory, Mem0 hosted and open source, and the official Graphiti MCP server.
Zep, Letta, a vector store, or a product-owned backend can implement the same small contract.

## Agent-Eval Integration

Use `ragAnswerQualityJudge` or `createRagAnswerQualityHook` when the product already has answer traces and needs RAG answer scoring without rebuilding metrics.
The built-in checks are deterministic and general; pass external scores from Ragas, DeepEval, TruLens, RAGChecker, or a custom evaluator when you want model-based judging.

```ts
import {
  createRagAnswerQualityHook,
  scoreKnowledgeBaseIndex,
} from '@tangle-network/agent-knowledge'

const evaluateAnswers = createRagAnswerQualityHook({
  scenarios: answerScenarios,
  run: async (scenario) => runRagAnswerTrace(scenario),
  externalEvaluator: async ({ scenario, artifact }) => runRagasOrDeepEval({
    input: scenario.query,
    output: artifact.answer,
    contexts: artifact.contexts,
  }),
})

const answerQuality = await evaluateAnswers()
const kbQuality = scoreKnowledgeBaseIndex(index, {
  strict: true,
  minCitationRate: 0.8,
  maxStaleSourceRate: 0.02,
})
```

Use `runRagKnowledgeImprovementLoop` when the product question is broader than retrieval:
can the system find the gaps, gather or update knowledge, prove generated answers still behave, and decide whether to promote?
`agent-knowledge` owns the knowledge/eval contract; the caller supplies the research, coding, connector, and answer-eval hooks.
This lower-level loop returns a promotion recommendation; it never writes to the live knowledge base.

```ts
import { runRagKnowledgeImprovementLoop } from '@tangle-network/agent-knowledge'

const result = await runRagKnowledgeImprovementLoop({
  goal: 'Improve the support RAG KB',
  retrieval: {
    baseline: { k: 5, hybrid: false },
    scenarios: trainRetrievalScenarios,
    holdoutScenarios,
    index,
    searchSpace: { k: [5, 10, 20], hybrid: [false, true] },
    targetRecall: 0.9,
  },
  diagnose: async ({ retrieval }) => diagnoseRagGaps(retrieval),
  acquireKnowledge: async ({ findings }) => researchMissingSources(findings),
  knowledgeResearch: { root: './kb' },
  evaluateAnswers,
  promote: async ({ retrieval, answerQuality }) =>
    decidePromotion({ retrieval, answerQuality }),
  requiredPhases: ['retrieval-tuning', 'knowledge-update', 'answer-quality', 'promotion'],
})

console.log(result.promotion)
```

Use `improveKnowledgeBase` when a program should own the candidate workspace and promotion mechanics.
The wrapper composes the same RAG lifecycle, but adds resumable state under `.agent-knowledge/improvements/<runId>/`, a lock lease for parallel operators, and exact candidate bytes that can be approved later.

```ts
import {
  improveKnowledgeBase,
  knowledgeImprovementCandidateRef,
  promoteKnowledgeCandidate,
  restoreKnowledgeCandidateBaseline,
  withKnowledgeImprovementComparison,
} from '@tangle-network/agent-knowledge'

const staged = await improveKnowledgeBase({
  root: './kb',
  goal: 'Improve support refund-policy knowledge',
  readinessSpecs,
  retrieval: {
    baseline: { k: 5 },
    scenarios: trainRetrievalScenarios,
    holdoutScenarios,
    searchSpace: { k: [5, 10, 20] },
    targetRecall: 0.9,
  },
  step: async ({ readiness }) => runResearchAgent({ missing: readiness?.report }),
  evaluateAnswers,
  requiredPhases: ['knowledge-update', 'retrieval-tuning', 'answer-quality'],
})

const candidate = knowledgeImprovementCandidateRef(staged)
console.log(staged.evaluation, candidate)

await withKnowledgeImprovementComparison({ root: './kb', candidate }, async (comparison) => {
  await compareKnowledgeFiles(
    comparison.baseline.root,
    comparison.candidate.root,
    comparison.evaluation,
  )
})

// Call this only after your product records approval for this exact candidate.
const promoted = await promoteKnowledgeCandidate({ root: './kb', candidate })
console.log(promoted.promoted, promoted.mutation)

// The same candidate reference can restore its exact frozen baseline.
await restoreKnowledgeCandidateBaseline({ root: './kb', candidate })
```

`improveKnowledgeBase` stages a measured candidate by default and does not change the live knowledge base.
Calling it again with the same `runId` resumes interrupted candidate generation.
Resume an interrupted promotion or restore through the same transition function with its exact candidate and activation.
`withKnowledgeImprovementComparison` materializes the exact measured baseline and candidate in isolated temporary directories for one trusted callback, checks both again afterward, and removes them.
`withKnowledgeImprovementCandidate` remains the focused candidate-only read.
`promoteKnowledgeCandidate` applies only the frozen bytes identified by the approved candidate reference, and refuses if the live base changed.
Promotion and restore results require `mutation` with the logical before/after hashes and transaction identity observed under the knowledge write lock; resumed transactions report `recovered: true`, while a later call that finds no pending work reports `changed: false`.
Passing `activation` makes the shared `AgentImprovementActivationResult` durable before the file transaction closes; `loadKnowledgeImprovementActivationResult` provides the read-only retry path.
Runtime supplies the result builder and product-owned result store, while this package owns knowledge files and their co-located result.
The current release accepts one strict run-state format; incomplete runs created before 3.0 must be completed or restarted before upgrading.
The exact candidate workflow requires Linux; other knowledge, retrieval, and evaluation APIs remain cross-platform.

If a required phase is missing its hook, the loop throws.
That keeps the public API from reporting a fake “RAG improved” result when the caller only wired retrieval or only wired a researcher.

Use retrieval eval when the question is whether a retrieval/RAG config can find the right knowledge before an agent reasons over it.
The labels should name stable pages, source records, anchors, or source spans, not ephemeral chunk IDs.
Benchmark coverage and completion criteria are documented in [`docs/eval/rag-eval-roadmap.md`](docs/eval/rag-eval-roadmap.md).

```ts
import { runRetrievalImprovementLoop } from '@tangle-network/agent-knowledge'

const result = await runRetrievalImprovementLoop({
  baseline: { k: 5, hybrid: false, reranker: null },
  scenarios: trainRetrievalScenarios,
  holdoutScenarios: holdoutRetrievalScenarios,
  index,
  searchSpace: {
    k: [5, 10, 20],
    hybrid: [false, true],
    reranker: [null, 'bge-reranker'],
  },
  targetRecall: 0.9,
  deltaThreshold: 0.02,
  costCeiling: 15,
  runDir: '.agent-knowledge/retrieval-runs',
})

console.log(result.winnerConfig)
```

Pass a custom `retrieve` function to `buildRetrievalEvalDispatch` when the config controls an external vector store, reranker, hybrid search service, or chunker.
The built-in fallback uses `searchKnowledge` over the local deterministic index.
Use `buildRetrievalEvalDispatch`, `retrievalRecallJudge`, and `retrievalParameterSweepProposer` directly only when you need custom `agent-eval` wiring.

To answer whether a candidate knowledge base improves agent task success, run an `@tangle-network/agent-eval` improvement loop (`runImprovementLoop`) over your KB variants on a real task corpus; each run is scored into a `RunRecord`.

Use `knowledgeReleaseReport()` before promotion: pass the candidate and baseline `RunRecord[]` (plus optional `ReleaseTraceEvidence` and the gate decision) and it folds them into a `ReleaseConfidenceScorecard` and a `KnowledgeRelease` using `agent-eval`'s release gates and `RunRecord` validation.

When holdout evidence is required, pass both the holdout-tagged run records and the scenario split:

```ts
const release = knowledgeReleaseReport({
  candidateId,
  candidateRuns,
  scenarios,
  hasHoldout: true,
})
```

Use `buildEvalKnowledgeBundle()` before execution when the question is whether
the agent has enough task-world context to run:

```ts
import { buildEvalKnowledgeBundle } from '@tangle-network/agent-knowledge'

const readiness = buildEvalKnowledgeBundle({
  taskId: 'sdk-migration',
  index,
  specs: [{
    id: 'repo-build-command',
    description: 'Repository build and typecheck command',
    query: 'build typecheck command',
    requiredFor: ['coding'],
    category: 'codebase_specific',
    acquisitionMode: 'inspect_repo',
    importance: 'blocking',
    freshness: 'weekly',
    sensitivity: 'public',
    confidenceNeeded: 0.9,
    minSources: 1,
  }],
})

console.log(readiness.report.recommendedAction)
```

Pass `readiness.report` to `blockingKnowledgeEval()` from
`@tangle-network/agent-eval`; use `readiness.questions` and
`readiness.acquisitionPlans` to drive UI or connector workflows.

## Memory Adapters

`agent-knowledge` does not replace a memory database.
It gives existing memory systems one contract, isolated branches, ordered multi-agent histories, comparable measurements, and an automatic improvement loop.

Use the provider adapter that matches the system you already run:

```ts
import {
  createGraphitiMemoryAdapter,
  createMem0MemoryAdapter,
  createNeo4jAgentMemoryAdapter,
} from '@tangle-network/agent-knowledge/memory'

const mem0Hosted = createMem0MemoryAdapter({
  client: mem0Client,
  mode: 'hosted',
  backendRef: 'mem0:production-account',
})

const mem0Oss = createMem0MemoryAdapter({
  client: mem0OssClient,
  mode: 'oss',
  backendRef: 'mem0:local-postgres',
})

const graphiti = createGraphitiMemoryAdapter({
  client: graphitiMcpClient,
  backendRef: 'graphiti:production-cluster',
})

const neo4j = createNeo4jAgentMemoryAdapter({
  client: neo4jMemoryClient,
  transport: 'rest',
  contextMode: 'search',
})
```

The Graphiti defaults match the current official server tools: `add_memory`, `search_memory_facts`, `search_nodes`, `get_episodes`, and `clear_graph`.
Set `toolNames` explicitly when your server lists different names.
The adapter never retries a write under another name because that could enqueue it twice.
Visible writes expand the episode scan when Graphiti truncates a long group and fail explicitly at `episodeScanLimit` instead of reporting a false success.
Hosted Mem0 follows the synchronous memory-array response from `mem0ai` 3.x and rejects legacy asynchronous event responses instead of treating them as successful writes.
Mem0 cleanup requires `getAll` plus per-memory `delete`, refuses an empty identity scope, and waits until both list and search results stop returning deleted IDs.
Every Mem0 operation requires `userId`, `agentId`, `runId`, or `namespace`.
`appId`, tenant, team, session, and tag filters refine that identity but cannot replace it.
Fresh-write probes expire after `ingestionTimeoutMs`, so a long-lived adapter retains only its current visibility window rather than its lifetime write history.
The adapter does not call Mem0's account-wide `deleteAll` method.
Use a stable, non-secret `backendRef` in Mem0 and Graphiti adapter identities so caches and dispatch keys cannot alias two accounts or clusters.

Each adapter uses the same `search`, `getContext`, and `write` method shape, but provider capabilities remain explicit.

| Adapter | Searchable through this adapter | Writable through this adapter |
| --- | --- | --- |
| Mem0 hosted or OSS | messages, observations, facts, entities, preferences, reasoning traces | all six kinds |
| Graphiti MCP | extracted facts and entities | all six kinds as episodes |
| Neo4j hosted REST | messages, observations, entities | messages, observations, entities, conversation reasoning steps |
| Neo4j bridge | messages, observations, entities, preferences, similar reasoning traces | all six kinds |

Neo4j bridge facts are graph writes.
The official `@neo4j-labs/agent-memory` 0.4 API has no corresponding fact-search method, so fact-only retrieval experiments should use another provider or a custom Neo4j query adapter.
Mem0 and Graphiti apply tenant, user, agent, team, run, session, namespace, and tag filters per request, subject to Mem0's required provider identity above.
Neo4j Agent Memory experiments require disposable external state per branch because the SDK cannot clear every memory kind atomically.
On a shared Neo4j client, the adapter rejects scope fields the selected SDK method cannot enforce before making a provider call.
Conversation messages can use `sessionId`, and reasoning writes can use either `sessionId` or `runId`; other direct operations are unscoped unless a dedicated client is used.
Pass `branchId` only after the caller has provisioned one physically isolated instance for that exact branch.
Provider-specific identifiers remain internal to the adapter.
Custom adapters must declare `branchIsolation: { mode: 'scoped' }` only when every operation enforces the supplied scope; undeclared adapters are rejected by branch execution.

```ts
const neo4jInstances = new WeakMap<object, string>()

const neo4jCandidate = {
  id: 'neo4j',
  ref: 'neo4j-agent-memory:0.4.0:rest',
  policy: { read: ['shared'], write: 'shared' },
  async createAdapter({ branchId, purpose, signal, markExternalCall }: {
    branchId: string
    purpose: 'execute' | 'recovery'
    signal: AbortSignal
    markExternalCall(): void
  }) {
    markExternalCall()
    const client = purpose === 'recovery'
      ? await openDedicatedNeo4jMemory({ branchId, transport: 'rest', signal })
      : await provisionDedicatedNeo4jMemory({ branchId, transport: 'rest', signal })
    if (!client) return null
    const adapter = createNeo4jAgentMemoryAdapter({ client, transport: 'rest', branchId })
    neo4jInstances.set(adapter, branchId)
    return adapter
  },
  async disposeAdapter(adapter: object) {
    const branchId = neo4jInstances.get(adapter)
    if (!branchId) throw new Error('unknown Neo4j branch')
    await destroyDedicatedNeo4jMemory({ branchId })
  },
}
```

The adapter requires `transport: 'rest' | 'bridge'` and rejects unsupported searches or writes before making a provider call.
`contextMode: 'search'` is the default and preserves query-based behavior across providers.
Set `contextMode: 'native'` with hosted REST to use Neo4j's whole-conversation context for message and observation memory.

Use a branch when agents or candidate configurations must not share state accidentally:

```ts
import {
  createAgentMemoryBranch,
  createMem0MemoryAdapter,
} from '@tangle-network/agent-knowledge/memory'

const memory = createAgentMemoryBranch({
  adapter: mem0Oss,
  branchId: 'candidate-17',
  policy: { read: ['private', 'team'], write: 'team' },
  baseScope: { tenantId: 'acme', teamId: 'research' },
})

await memory.write({
  kind: 'fact',
  text: 'The launch date is Friday.',
  scope: { agentId: 'researcher' },
})

const context = await memory.getContext('When is launch?', {
  scope: { agentId: 'builder' },
  limit: 5,
})

const snapshot = await memory.snapshot()
await memory.close?.()
const reopenedMem0Oss = createMem0MemoryAdapter({
  client: mem0OssClient,
  mode: 'oss',
  id: snapshot.adapterId,
})
const resumed = createAgentMemoryBranch({
  adapter: reopenedMem0Oss,
  branchId: 'candidate-17',
  snapshot,
})
```

Private writes stay visible only to one agent.
Team writes are shared inside one team.
Shared writes are visible to every agent in the branch.
`fork()` replays accepted writes into a child branch, including a branch backed by a different provider.
One adapter object can have only one live handle for a given branch ID in a process.
Close the prior handle before resuming it, and use the run lease to prevent distributed controllers from owning the same durable run at once.

Use `runAgentMemoryExperiment()` to compare known providers or configurations across ordered histories.
`buildAgentMemorySequencesFromBenchmarkCases()` feeds existing LoCoMo, LongMemEval, GroupMemBench, or first-party memory cases into the same runner without changing their event order.
Use `runAgentMemoryImprovement()` when a proposer should search configurations, measure them on training histories, compare the winner with the baseline on fresh histories, and activate it only after a statistically supported win.

```ts
const result = await runAgentMemoryImprovement({
  experimentId: 'support-memory-v3',
  trainSequences,
  holdoutSequences,
  seeds: [
    {
      config: currentConfig,
      track: 'conservative',
      proposer: 'conservative',
      vision: 'Improve recall without increasing stale-memory reuse.',
    },
    {
      config: graphConfig,
      track: 'graph',
      proposer: 'graph',
      vision: 'Improve temporal and multi-actor reasoning.',
    },
  ],
  proposer: configProposer,
  proposers: {
    conservative: conservativeConfigProposer,
    graph: graphConfigProposer,
  },
  improvementRef: 'memory-stack@8f2c1a7',
  budget: { maxSteps: 12 },
  maxTotalCostUsd: 25,
  candidateConcurrency: 4,
  sequenceConcurrency: 8,
  createCandidate: ({ config }) => buildMemoryCandidate(config),
  executeStep: ({ memory, step, context }) =>
    runProfileStep({ memory, step, context }),
  executeStepRef: 'support-profile@8f2c1a7',
  runDir: '.agent-knowledge/memory-runs/support-v3',
  activation: {
    ref: 'config-store:support-memory:v1',
    readCurrent: () => configStore.read('support-memory'),
    compareAndSet: ({
      activationId,
      expectedSurfaceHash,
      config,
      surfaceHash,
    }) => configStore.compareAndSet({
      key: 'support-memory',
      operationId: activationId,
      expectedHash: expectedSurfaceHash,
      nextHash: surfaceHash,
      value: config,
    }),
  },
})
```

`candidateConcurrency` controls how many configurations are measured at once.
`sequenceConcurrency` controls how many independent histories run at once.
Every experiment candidate must set `ref` to a version or commit that changes whenever its provider configuration or adapter behavior changes.
The first seed is always the deployed baseline.
Each seed starts an independent track with its own objective and optional proposer, and a branch inherits its parent track's proposer unless the governor chooses another one.
Candidate factories should perform local construction only when possible.
When a dedicated instance must be provisioned or reconnected, call `markExternalCall()` immediately before that action.
Set each candidate's `externalCostUsdPerSequence` to a conservative memory-provider charge; it is counted once an adapter method or a marked factory action attempts provider work, while a local factory failure costs zero.
Set `externalRecoveryCostUsdPerAttempt` when reconnecting and deleting an interrupted history adds a separate provider charge.
Recovery uses the same durable run-wide cost account as candidate execution, proposers, profile steps, and the governor, so a resumed run cannot exceed `maxTotalCostUsd` by treating cleanup as free work.
`runAgentMemoryExperiment()` reports all attempt and recovery spend in `totalCostUsd`, with retired-candidate cleanup separated as `unrankedRecoveryCostUsd`.
Cleanup completion is journaled before a paid-call receipt.
If a process exits between those writes, resume charges the reserved maximum without repeating provider cleanup and continues only after the account is complete.
The default `maxTotalCostUsd` is zero, so model and paid provider calls require an explicit limit.
Model calls inside `executeStep` should use `context.cost.runPaidCall()` so `maxTotalCostUsd` counts both sources before starting more work.
The same budget is supplied to named proposers as `context.costLedger` and to the governor as `context.costLedger`; the standard `agent-eval` proposers charge their model calls there.
Steps inside one history remain ordered, and writes from one agent remain ordered while independent agents can write concurrently.
Runtime callbacks may write only to scopes declared on a step, write, probe, or `sequence.cleanupScopes`; this lets an interrupted retry clear every actor and session it could have touched.
Search never changes the live configuration.
Only `activation.compareAndSet` can activate the fresh-history winner.
The activation target must provide an exact current read and an atomic compare-and-set from the measured baseline to the measured winner.
The durable activation journal is written before that operation.
After a crash, the runner reads the live configuration and records the completed activation without applying it twice.
Change `activation.ref` whenever the target or activation behavior changes.
The default filesystem path permits one controller and many parallel workers, persists candidate history, and resumes without adding more than `maxSteps` candidate nodes.
Custom storage must set `controllerMode: 'process-local'` when all controllers share one process, or provide `acquireRunLease` for distributed controllers.
Independent workers still use `candidateConcurrency` and `sequenceConcurrency`.
Every measured cell receives a fresh provider branch ID for that execution attempt.
This prevents a late asynchronous write from a crashed worker from entering a retried cell.
`experimentRunId` keeps the logical experiment identity stable across workers without reusing physical branch state.
Timed-out histories enter bounded branch cleanup before `runAgentMemoryExperiment()` returns.
The run waits for cleanup to succeed or for `cleanupTimeoutMs` to expire, and either cleanup failure leaves the attempt available for recovery.
The runner appends a `started` event before adapter creation and a `cleaned` event only after provider cleanup and disposal succeed.
On resume it recovers every unfinished attempt before starting new cells.
Independent unfinished attempts recover up to `maxConcurrency` at once, and no new cell starts until every cleanup succeeds.
Recovery refuses more than `maxRecoveryAttempts`, which defaults to 1000.
Recovery also refuses a fourth failed cleanup for the same attempt by default.
Set `maxRecoveryRetriesPerAttempt` to change that limit; its durable retry record is returned as `recoveryLogPath`.
`runAgentMemoryImprovement()` forwards the same option to every training and fresh-history experiment.
Pass retired implementations through `recoveryCandidates` until their recorded attempts are cleaned.
`createAdapter` receives `purpose: 'recovery'` during that pass so a dedicated-instance candidate can reconnect to the existing branch instead of provisioning another one.
It may return `null` during recovery when the recorded attempt never created external state.
Hosted Mem0 and Graphiti recovery waits for their configured ingestion timeout before deletion so an accepted asynchronous write can become visible first.
That visibility wait is bounded by `cleanupTimeoutMs`; a longer required delay fails before new provider work starts.
The default filesystem storage survives process restarts and uses an OS lock.
Custom durable storage must implement atomic `append`; process-local custom storage opts in with `controllerMode: 'process-local'`, and distributed controllers provide `acquireRunLease`.
Provider SDK calls should also have their own network timeout because a caller-side cleanup timeout cannot cancel an arbitrary third-party promise.
Candidate factories receive an `AbortSignal` and must pass it into provider connection or provisioning calls.
The persisted run identity includes `budget.maxSteps`; start a new `runDir` to enlarge a completed search instead of mutating its history.
Promotion is blocked when a configured critical dimension is missing or incomplete on either fresh-history arm.
Improvement runs clear each scoped branch before and after a measured history by default, including timeout and thrown-error cleanup.
Set `cleanupBranches: false` only when the candidate creates and disposes a physically isolated provider instance per cell.
The current Neo4j SDK has no complete all-memory clear operation, so a Neo4j improvement run must use disposable per-cell service instances with `cleanupBranches: false` and `disposeAdapter`; a persistent shared workspace is rejected because failed retries could read partial state.
If recovery cannot confirm deletion, the resumed run stops before launching new provider work and leaves the attempt active for another retry.

The package stays independent of `agent-runtime`.
The `executeStep` callback is where a runtime profile, coding agent, research agent, or deterministic worker uses the branch.
This keeps provider and measurement code reusable while the profile owns what agents do and what they choose to remember.

The Neo4j adapter accepts the real `@neo4j-labs/agent-memory` client and rejects unsafe branch reuse unless `branchId` identifies caller-provisioned isolated state.
The Mem0 adapter typechecks against `mem0ai` hosted and open-source clients and accepts only the current hosted SDK response shape.
The Graphiti adapter calls the official MCP tools and waits for queued episodes to become visible before evaluating them by default.
Hosted Mem0 and Graphiti visible writes are safe only in `lifetime: 'attempt'` branches because their writes may outlive a worker process.
`runAgentMemoryExperiment()` creates those fresh attempt branches automatically.
Attempt snapshots are audit and fork inputs, not restart points; use `forkAgentMemoryBranchSnapshot()` to replay one into a fresh branch.
Mem0 OSS and caller-provisioned disposable instances can use resumable branches.
Graphiti `consistency: 'queued'` is available only for direct ingestion and is rejected by branch execution.

## Research Loop

Use `runKnowledgeResearchLoop()` when an agent is acting as a researcher or
librarian. Keep the loop small: the package handles deterministic mechanics;
your agent handles judgment.

```ts
import {
  defineReadinessSpec,
  runKnowledgeResearchLoop,
} from '@tangle-network/agent-knowledge'

await runKnowledgeResearchLoop({
  root: './kb',
  goal: 'Build a grounded onboarding wiki for billing support',
  readinessSpecs: [defineReadinessSpec({
    id: 'refund-policy',
    description: 'Refund policy grounding',
    query: 'refund policy customer request',
    requiredFor: ['support-agent'],
  })],
  async step({ iteration, index, readiness }) {
    // Call your researcher/LLM/browser/connector workflow here.
    if (iteration > 1 && readiness?.report.blockingMissingRequirements.length === 0) {
      return { done: true, notes: 'ready for eval' }
    }
    return {
      sourceTexts: [{
        uri: 'research://refund-policy',
        title: 'Refund Policy Source',
        text: 'Source text gathered by the researcher.',
      }],
      proposalText: [
        '---FILE: knowledge/support/refund-policy.md---',
        '---',
        'id: refund-policy',
        'title: Refund Policy',
        '---',
        '# Refund Policy',
        'Grounded summary written by the researcher.',
        '---END FILE---',
      ].join('\n'),
    }
  },
})
```

This is intentionally not a crawler, prompt framework, or agent. It is the
repeatable shell around one.

For full `agent-eval` control-loop integration, use
`createKnowledgeControlLoopAdapter()` and provide `decide` yourself:

```ts
import { runAgentControlLoop } from '@tangle-network/agent-eval'
import { createKnowledgeControlLoopAdapter } from '@tangle-network/agent-knowledge'

const adapter = createKnowledgeControlLoopAdapter({
  root: './kb',
  goal: 'Maintain the billing support wiki',
  readinessSpecs,
})

await runAgentControlLoop({
  ...adapter,
  async decide({ state, evals }) {
    if (state.previousSteps.length > 0 && evals.every((e) => e.passed)) {
      return { type: 'stop', pass: true, reason: 'knowledge ready' }
    }
    const proposal = await proposerAgent(state)
    const review = await reviewerAgent({ ...state, proposal })
    return {
      type: 'continue',
      reason: review.summary,
      action: driverPolicy({ proposal, review }),
    }
  },
})
```

## Verified research loop

`runVerifiedResearchLoop()` coordinates a worker and reviewer over one knowledge base.
The worker discovers sources and proposes pages for open gaps.
The reviewer checks each source before admission and can run its own gap-filling pass with `driverResearches: true`.
Callers provide both roles and any credentials.
The loop owns indexing, write-block application, readiness scoring, and stopping when no blocking gap remains.

An equal-compute comparison across 9 ML topics using `glm-5.2` is documented in
[docs/two-agent-research-ab.md](docs/two-agent-research-ab.md).
The two-agent loop admitted about 2.33 fewer sources per topic at identical coverage.
Most of that difference came from de-duplication rather than relevance filtering.
The document includes limitations and reproduction steps.

```ts
import {
  defineReadinessSpec,
  runVerifiedResearchLoop,
} from '@tangle-network/agent-knowledge'

await runVerifiedResearchLoop({
  root: './kb',
  goal: 'Build a grounded onboarding wiki for billing support',
  readinessSpecs: [defineReadinessSpec({
    id: 'refund-policy',
    description: 'Refund policy grounding',
    query: 'refund policy customer request',
    requiredFor: ['support-agent'],
  })],
  // The worker researches the current gaps.
  async worker({ gaps, index }) {
    return {
      sources: [/* AddSourceTextInput for the open gaps */],
      proposalText: '/* ---FILE: knowledge/…--- write-protocol blocks */',
    }
  },
  // The reviewer checks each candidate source before admission.
  driver: {
    verifySource(source, { gaps }) {
      return source.uri ? { accept: true } : { accept: false, reason: 'no uri' }
    },
  },
})
```

## Runtime integration

`agent-knowledge` owns knowledge state and measurement.
It deliberately does not own an agent runner.
Live agent orchestration belongs in `@tangle-network/agent-runtime`.
Use the one-call runtime job when you want agents, candidate workspaces, readiness checks, exact candidate handoff, and spend measurement wired together:

```ts
import { runKnowledgeImprovementJob } from '@tangle-network/agent-runtime/knowledge'

await runKnowledgeImprovementJob({
  root: './kb',
  goal: 'Build a grounded onboarding wiki for billing support',
  readinessSpecs,
  budget: { maxIterations: 8, maxTokens: 120_000, maxUsd: 10 },
  backend,
})
```

Use `improveKnowledgeBase` directly when your product already owns the agent runner and only needs the pure KB mechanics:

```ts
import { improveKnowledgeBase } from '@tangle-network/agent-knowledge'

await improveKnowledgeBase({
  root: './kb',
  goal: 'Build a grounded onboarding wiki for billing support',
  readinessSpecs,
  updateKnowledge: async ({ goal, findings }) => {
    // Call your agent runner here, then apply source-backed write blocks.
    return {
      applied: true,
      summary: `updated KB for ${goal} with ${findings.length} finding(s)`,
    }
  },
})
```

This keeps the dependency graph acyclic: `agent-knowledge` depends on `agent-eval`; agent runners depend on `agent-knowledge`, not the reverse.

Validator scoring (default; overridable):

```
score = 0.4 · citation_density
      + 0.2 · source_diversity
      + 0.2 · recency_match
      + 0.2 · gap_coverage
```

The output preserves agent intelligence: `items`, `citations`,
`proposedWrites` are typed; `gaps`, `notes`, and any extras the agent
emitted land in `raw` rather than getting dropped.

## Pluggable Knowledge Sources

Static knowledge rots. Authorities like Cornell LII, the IRS, and state
Secretaries of State change without warning. A ruling vacates an FTC
non-compete rule, a CFR section renumbers, a state replaces Beverly-Killea
with RULLCA. The `@tangle-network/agent-knowledge/sources` subpath ships
three primitives that bridge "live authority" → "eval re-runs":

- `KnowledgeSource`: pluggable contract (`fetch(opts) → KnowledgeFragment[]`).
  Every fragment carries `provenance` (URL, source-attested timestamp,
  jurisdiction, and fetch/extraction status) and `dimensionHints` (which eval
  dimensions a change in this fragment should re-score). The `verifiable`
  flag rejects failed, blocked, or malformed responses; it does not
  cryptographically authenticate the publisher.
- `KnowledgeFreshnessStore`: per-`(workspaceId, sourceId)` last-refresh
  tracker. The package ships a filesystem implementation and
  `createD1FreshnessStoreStub(adapter)`, a complete bridge for an
  application-owned D1, PostgreSQL, SQLite, or equivalent adapter.
- `detectChanges(prev, next)`: diffs two fragment snapshots, emits
  `KnowledgeChange[]` tagged with the affected eval dimensions so a cron
  scheduler knows exactly which campaigns to re-run.

Three concrete sources ship in-package:

```ts
import {
  createCornellLiiSource,
  createIrsPublicationsSource,
  createStateSosSource,
  createFileSystemFreshnessStore,
  detectChanges,
  type KnowledgeChange,
  type KnowledgeFragment,
} from '@tangle-network/agent-knowledge'

const sources = [
  // Federal statutes + Wex encyclopedia from law.cornell.edu.
  createCornellLiiSource({
    selectors: [
      { kind: 'uscode', path: '18/1836' },               // DTSA
      { kind: 'wex', path: 'restraint_of_trade', dimensionHints: ['jurisdictional_accuracy'] },
    ],
  }),
  // IRS publications index + named publications + revenue procedures.
  createIrsPublicationsSource({
    publications: ['p15', 'p17', 'p463'],
    revenueProcedures: [],
  }),
  // Generic state SOS adapter: one config per state you need tracked.
  createStateSosSource({
    state: 'CA',
    baseUrl: 'https://www.sos.ca.gov',
    entities: [{
      id: 'business-entities-forms',
      path: '/business-programs/business-entities/forms',
      title: 'CA Business Entities Forms',
      selector: { kind: 'whole' },
    }],
  }),
]

const freshness = createFileSystemFreshnessStore({ root: './kb' })

// Worked example: Cornell LII updates the Wex `restraint_of_trade` entry
// to reflect Ryan-LLC v. FTC. The cron tick below detects the change,
// extracts the `jurisdictional_accuracy` dimension hint, and hands it to
// the eval scheduler which re-runs only the campaigns tagged with that
// dimension.
async function tick({ workspaceId, prevSnapshots }: {
  workspaceId: string
  prevSnapshots: Record<string, KnowledgeFragment[]>
}): Promise<KnowledgeChange[]> {
  const allChanges: KnowledgeChange[] = []
  for (const source of sources) {
    const stale = await freshness.stale({
      workspaceId,
      sourceId: source.id,
      ttlMs: 24 * 60 * 60 * 1000,
    })
    if (!stale) continue

    const next = await source.fetch({ cacheDir: './.agent-knowledge/http-cache' })
    const prev = prevSnapshots[source.id] ?? []
    const { changes } = detectChanges(prev, next)
    allChanges.push(...changes)

    await freshness.mark({ workspaceId, sourceId: source.id, when: new Date() })
    prevSnapshots[source.id] = next
  }
  return allChanges
}
```

Polite-by-default: every HTTP fetch carries the package User-Agent, is
throttled to 1 req/sec/origin, caches successful responses to disk, and
marks `verifiable: false` on block pages / 4xx rather than promoting
unusable content. See `src/sources/http.ts` for the checks.
