# agent-knowledge

Source-grounded, eval-gated knowledge growth primitives for agents.

This package turns raw sources and generated markdown knowledge into a versionable graph that agents can search, lint, evaluate, and improve over time. It is intentionally domain-agnostic: legal, tax, coding, research, finance, business, and scientific workflows define their own policies and rubrics on top.

## Contents

- [Install](#install)
- [Start here](#start-here) — pick CLI vs programmatic
- [CLI](#cli) — `init` → `source-add` → `index` → `search` → `lint`
- [Design](#design) — the invariants (immutable sources, cited claims, deterministic graph)
- [Benchmark harness](#benchmark-harness) — BEIR/MTEB/qrels, RAG answer, hallucination, KB-improvement cases
- [Agent-Eval integration](#agent-eval-integration) — retrieval eval + readiness bundles + release reports
- [Memory adapters](#memory-adapters) — generic memory contract + Neo4j Agent Memory bridge
- [Research loop](#research-loop) — `runKnowledgeResearchLoop` + control-loop adapter
- [Runtime integration](#runtime-integration) — how agent runners plug into the pure KB loop
- [Pluggable knowledge sources](#pluggable-knowledge-sources) — live authorities → eval re-runs

## Install

```bash
pnpm add @tangle-network/agent-knowledge @tangle-network/agent-eval
```

## Start here

Two ways in, depending on what you're doing:

- **Author / inspect a KB by hand** → the [CLI](#cli) (`init` → `source-add` → `index` → `search` → `lint`). Fastest way to see the shape on disk.
- **Drive it from an agent** → pick the primitive by intent:
  - *"Does the agent have enough context to run?"* → [`buildEvalKnowledgeBundle`](#agent-eval-integration) (block / ask / acquire before execution).
  - *"Grow the KB as a researcher"* → [`runKnowledgeResearchLoop`](#research-loop) (deterministic mechanics; your agent owns judgment) or [`runTwoAgentResearchLoop`](#two-agent-research-loop) (researcher proposes, verifier checks + fills gaps).
  - *"Spawn live agents to improve a KB"* → pass an `updateKnowledge` callback to `improveKnowledgeBase`; runtime-backed supervisors live in `@tangle-network/agent-runtime`.
  - *"Tune retrieval for a knowledge base"* → `runRetrievalImprovementLoop` in the [Agent-Eval integration](#agent-eval-integration) section.
  - *"Run an operator-grade KB improvement cycle"* → `improveKnowledgeBase` in the [Agent-Eval integration](#agent-eval-integration) section.
    It creates a candidate KB, lets agents or deterministic hooks improve it, runs configured evals, can be resumed, and promotes only when the live KB has not changed underneath it.
  - *"Expose the lower-level RAG lifecycle phases"* → `runRagKnowledgeImprovementLoop` in the [Agent-Eval integration](#agent-eval-integration) section.
    It exposes retrieval tuning, gap diagnosis, knowledge acquisition/update, answer-quality checks, and promotion as one typed lifecycle.
  - *"Evaluate RAG answers or a wiki/KB"* → `ragAnswerQualityJudge`, `createRagAnswerQualityHook`, and `scoreKnowledgeBaseIndex` in the [Agent-Eval integration](#agent-eval-integration) section.
  - *"Run standard RAG/KB benchmarks"* → `runKnowledgeBenchmarkSuite` in the [Benchmark harness](#benchmark-harness) section.
  - *"Does this candidate KB actually improve task success?"* → run an [agent-eval improvement loop](#agent-eval-integration) over KB variants, then `knowledgeReleaseReport` for the promotion decision.
  - *"Keep live authorities fresh"* → [pluggable sources](#pluggable-knowledge-sources) + `detectChanges` → eval re-runs.

Storage stays consumer-owned via `KbStore` (`MemoryKbStore`, `FileSystemKbStore`, or your own D1/Postgres). Every primitive below is source-grounded: claims cite immutable source records, and lint fails on un-grounded citations.

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
  scoring, and conflict-safe promotion.
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
  `rrfScore` are the raw reciprocal-rank-fusion value (typically 0.01–0.05);
  use them when intent matters or when fusing across queries.
  `normalizedScore` is the same value scaled into [0, 1] relative to the top
  hit *in this result set* (top hit = 1, others = score / topScore) — use it
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

## Benchmark Harness

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
import { createNeo4jAgentMemoryAdapter } from '@tangle-network/agent-knowledge/memory'

await runKnowledgeBenchmarkSuite({
  cases: buildIndustryRagBenchmarkSmokeCases(),
  runDir: '.agent-knowledge/benchmark-runs/industry-smoke',
  respond: respondToIndustryRagBenchmarkSmokeCase,
})

await runKnowledgeBenchmarkSuite({
  cases: buildIndustryMemoryBenchmarkSmokeCases(),
  runDir: '.agent-knowledge/benchmark-runs/memory-smoke',
  respond: ({ case: testCase }) => {
    if (!isKnowledgeMemoryBenchmarkCase(testCase)) return { answer: '' }
    return respondToIndustryMemoryBenchmarkSmokeCase({ case: testCase })
  },
})

const memoryRanking = await runMemoryAdapterBenchmark({
  cases: buildFirstPartyMemoryLifecycleBenchmarkCases(),
  runDir: '.agent-knowledge/benchmark-runs/memory-ranking',
  candidates: [
    { id: 'no-memory', createAdapter: () => createNoopMemoryBenchmarkAdapter() },
    {
      id: 'in-memory',
      createAdapter: () => createInMemoryBenchmarkAdapter(),
      searchLimit: 1,
    },
    {
      id: 'neo4j-agent-memory',
      createAdapter: () => createNeo4jAgentMemoryAdapter({ client: neo4jMemoryClient }),
      searchLimit: 5,
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
  respond: async ({ case: testCase }) => {
    if (testCase.taskKind !== 'retrieval') return { hits: [] }
    const hits = await retrieveFromYourKb(testCase.query)
    return { hits, costUsd: 0.001 }
  },
})

console.log(result.report.score.mean)
```

Use `buildRetrievalBenchmarkCasesFromQrels()` for qrels-backed retrieval datasets.
The smoke pack proves that every declared benchmark family is wired through the runner; full BEIR, MTEB, MS MARCO, TREC DL, MIRACL, LoTTE, BRIGHT, CRAG, HotpotQA, KILT, RAGTruth, and FaithBench runs should pass real dataset rows through the same case shapes.
Use `KnowledgeAnswerBenchmarkCase` for CRAG/HotpotQA/KILT-style answer checks and RAGTruth/FaithBench-style hallucination checks by encoding required claims, forbidden claims, and expected source IDs.
Use `taskKind: 'kb-improvement'` when the artifact is candidate KB text produced by `improveKnowledgeBase()`.
Use `KnowledgeMemoryBenchmarkCase` for memory systems.
Memory cases carry ordered events plus current required facts, stale forbidden facts, expected event IDs, and expected actor IDs.
The built-in memory scorer reports current fact recall, stale-memory safety, event recall, and actor recall, which maps to LoCoMo, LongMemEval, Memora, MemoryAgentBench, MemoryBank-style personalization, GroupMemBench, and first-party memory lifecycle checks.
Use `runMemoryAdapterBenchmark()` to rank real memory systems that implement `AgentMemoryAdapter`.
This is the path for Neo4j Agent Memory, Mem0, Zep, Letta, Graphiti, a vector store, or a product-owned memory backend.

## Agent-Eval Integration

Use `ragAnswerQualityJudge` or `createRagAnswerQualityHook` when the product already has answer traces and needs SOTA-style RAG scoring without rebuilding metrics.
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
The wrapper composes the same RAG lifecycle, but adds resumable state under `.agent-knowledge/improvements/<runId>/`, a lock lease for parallel operators, and a base-hash check before copying the candidate over the live KB.

```ts
import { improveKnowledgeBase } from '@tangle-network/agent-knowledge'

const result = await improveKnowledgeBase({
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

console.log(result.promoted, result.candidate?.evaluation)
```

Pass `promote: false` to leave the candidate workspace open for another agent or a human edit.
Calling `improveKnowledgeBase` again with the same `runId` re-evaluates that candidate and promotes it only if the original live KB hash still matches.

If a required phase is missing its hook, the loop throws.
That keeps the public API from reporting a fake “RAG improved” result when the caller only wired retrieval or only wired a researcher.

Use retrieval eval when the question is whether a retrieval/RAG config can find the right knowledge before an agent reasons over it.
The labels should name stable pages, source records, anchors, or source spans, not ephemeral chunk IDs.
The completion roadmap is in [`docs/eval/rag-eval-roadmap.md`](docs/eval/rag-eval-roadmap.md).

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

To answer whether a candidate knowledge base actually improves agent task success, run an `@tangle-network/agent-eval` improvement loop (`runImprovementLoop`) over your KB variants on a real task corpus; each run is scored into a `RunRecord`.

Use `knowledgeReleaseReport()` before promotion: pass the candidate and baseline `RunRecord[]` (plus optional `ReleaseTraceEvidence` and the gate decision) and it folds them into a `ReleaseConfidenceScorecard` and a `KnowledgeRelease` using `agent-eval`'s release gates and `RunRecord` validation.

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

`agent-knowledge` does not store operational memory itself. It defines the
contract that lets a runtime read/write memory through any backend, then turn
memory hits into `SourceRecord` evidence for readiness, linting, and eval gates.

```ts
import {
  createNeo4jAgentMemoryAdapter,
  memoryHitToSourceRecord,
} from '@tangle-network/agent-knowledge/memory'

const memory = createNeo4jAgentMemoryAdapter({ client: neo4jMemoryClient })

const context = await memory.getContext('What does this user prefer?', {
  scope: { userId: 'user-123', sessionId: 'session-456' },
  limit: 5,
})

const sourceRecords = context.hits.map((hit) =>
  memoryHitToSourceRecord(hit, { scope: { userId: 'user-123' } }),
)
```

The Neo4j adapter is runtime dependency-free: pass the real
`@neo4j-labs/agent-memory` client in products, or a fake client in tests. CI
typechecks against `@neo4j-labs/agent-memory@0.4.0` and covers the published
TypeScript SDK surface: `shortTerm.addMessage/searchMessages/getContext`,
`longTerm.addEntity/addPreference/addFact/searchEntities/searchPreferences`,
and `reasoning.getSimilarTraces`. Generic `search` / `getContext` and
snake_case bridge-style methods remain supported for non-hosted clients.

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

## Two-agent research loop

`runTwoAgentResearchLoop()` is the offline sibling of `runKnowledgeResearchLoop`
with a differentiated worker/driver split over ONE knowledge base: the `worker`
does primary research (discovers sources, proposes pages for the open gaps); the
`driver` verifies each candidate source before it commits, optionally gap-fills
with its own pass (`driverResearches: true`), and gates on the readiness check.
Both are yours (no creds) — the loop owns the deterministic mechanics (indexing,
applying write blocks, scoring readiness) and stops once no blocking gap remains.

Does the verifying driver actually earn its keep? See
[docs/two-agent-research-ab.md](docs/two-agent-research-ab.md) for an equal-compute
A/B (9 ML topics, `glm-5.2`): the two-agent loop admits ~2.33 fewer sources per topic
at identical coverage — though most of that win is de-duplication, not relevance
filtering. Honest caveats and how to reproduce included.

```ts
import {
  defineReadinessSpec,
  runTwoAgentResearchLoop,
} from '@tangle-network/agent-knowledge'

await runTwoAgentResearchLoop({
  root: './kb',
  goal: 'Build a grounded onboarding wiki for billing support',
  readinessSpecs: [defineReadinessSpec({
    id: 'refund-policy',
    description: 'Refund policy grounding',
    query: 'refund policy customer request',
    requiredFor: ['support-agent'],
  })],
  // WORKER: primary research targeting `ctx.gaps`. Returns a ResearchContribution.
  async worker({ gaps, index }) {
    return {
      sources: [/* AddSourceTextInput for the open gaps */],
      proposalText: '/* ---FILE: knowledge/…--- write-protocol blocks */',
    }
  },
  // DRIVER: verifies each candidate source before it commits, then gates.
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
Live agent orchestration belongs in `@tangle-network/agent-runtime`, which can call `improveKnowledgeBase` by passing an `updateKnowledge` callback:

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

The output preserves agent intelligence — `items`, `citations`,
`proposedWrites` are typed; `gaps`, `notes`, and any extras the agent
emitted land in `raw` rather than getting dropped.

## Pluggable Knowledge Sources

Static knowledge rots. Authorities like Cornell LII, the IRS, and state
Secretaries of State change without warning — a ruling vacates an FTC
non-compete rule, a CFR section renumbers, a state replaces Beverly-Killea
with RULLCA. The `@tangle-network/agent-knowledge/sources` subpath ships
three primitives that bridge "live authority" → "eval re-runs":

- `KnowledgeSource` — pluggable contract (`fetch(opts) → KnowledgeFragment[]`).
  Every fragment carries `provenance` (URL, source-attested timestamp,
  jurisdiction, `verifiable` flag) and `dimensionHints` (which eval
  dimensions a change in this fragment should re-score).
- `KnowledgeFreshnessStore` — per-`(workspaceId, sourceId)` last-refresh
  tracker. Filesystem adapter ships in-package; D1 / Postgres adapter
  scaffold is shipped as `createD1FreshnessStoreStub(adapter)`.
- `detectChanges(prev, next)` — diffs two fragment snapshots, emits
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
  // Generic state SOS adapter — one config per state you need tracked.
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
un-grounded content. See `src/sources/http.ts` for the invariants.
