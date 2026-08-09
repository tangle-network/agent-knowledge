# @tangle-network/agent-knowledge

Build, search, test, and improve source-backed knowledge bases in TypeScript.

The package manages source records, Markdown knowledge, indexes, retrieval tests, candidate workspaces, and memory adapters.
It does not browse, call models, or run agents.
Supply application callbacks for those decisions, or use `@tangle-network/agent-runtime/knowledge` to run them with agents.

## Install

```bash
pnpm add @tangle-network/agent-knowledge@7.1.2 @tangle-network/agent-eval@0.144.6
```

Requires Node.js 20.19 or later.

## Choose an API

| Goal | Start with | Import |
|---|---|---|
| Create a file-backed knowledge base | `initKnowledgeBase`, `addSourceText`, `applyKnowledgeWriteBlocks` | package root |
| Search an existing package knowledge base | `createFileSystemSearchProvider` | package root |
| Improve a live knowledge base without editing it in place | `improveKnowledgeBase` | package root |
| Optimize retrieval or a complete RAG configuration | `runRetrievalImprovementLoop`, `runRagOptimization` | package root |
| Optimize a KB maintenance policy | `optimizeKnowledgeBasePolicy` | package root |
| Run retrieval, research, answer checks, and promotion as one process | `runRagKnowledgeImprovementLoop` | package root |
| Compare providers or optimize memory configuration | `AgentMemoryAdapter`, `runAgentMemoryImprovement` | `/memory` |
| Read from external authorities | `KnowledgeSource` and source adapters | `/sources` |
| Run retrieval, answer, KB, or memory benchmark cases | `runKnowledgeBenchmarkSuite` | `/benchmarks` |
| Use live research or coding agents | `runKnowledgeImprovementJob` | `@tangle-network/agent-runtime/knowledge` |

## Create and search a knowledge base

This example stores one source, writes one cited page, validates the result, and searches it.

```ts
import {
  addSourceText,
  applyKnowledgeWriteBlocks,
  createFileSystemSearchProvider,
  initKnowledgeBase,
  validateKnowledgeIndex,
  writeKnowledgeIndex,
} from '@tangle-network/agent-knowledge'

const root = './support-kb'
await initKnowledgeBase(root)

const source = await addSourceText(root, {
  uri: 'inline://refund-policy',
  title: 'Refund policy',
  text: 'Customers may request a refund within 30 days of purchase.',
})

await applyKnowledgeWriteBlocks(
  root,
  [
    '---FILE: knowledge/refunds.md---',
    '---',
    'id: refunds',
    'title: Refunds',
    'sources:',
    `  - ${source.id}`,
    '---',
    '# Refunds',
    `The refund window is 30 days.[^${source.id}#all]`,
    '---END FILE---',
  ].join('\n'),
)

const index = await writeKnowledgeIndex(root)
const validation = validateKnowledgeIndex(index, { strict: true })
if (!validation.ok) throw new Error(JSON.stringify(validation.findings))

const search = createFileSystemSearchProvider({ root, index })
console.log(await search.search('How long is the refund window?', { limit: 3 }))
```

The provider uses the package's local text search.
Pass `refresh: 'always'` to rebuild its index before every query, or call `invalidate()` after changing files.
Use `asRetrievalEvalRetriever()` to send the same search path into retrieval tests.

## Use the CLI

The CLI exposes the same file-backed workflow.

```bash
pnpm exec agent-knowledge init --root ./support-kb
pnpm exec agent-knowledge source-add ./refund-policy.md --root ./support-kb
pnpm exec agent-knowledge apply-write-blocks ./proposal.txt --root ./support-kb
pnpm exec agent-knowledge index --root ./support-kb
pnpm exec agent-knowledge search "refund window" --root ./support-kb
pnpm exec agent-knowledge validate --strict --root ./support-kb
```

Run `pnpm exec agent-knowledge help` for every command.

The default layout is:

```text
support-kb/
  raw/sources/                 # immutable imported content
  knowledge/                   # editable Markdown pages
  .agent-knowledge/
    sources.json               # source registry
    index.json                 # generated search index
```

## Improve a live knowledge base

`improveKnowledgeBase` creates an isolated candidate, runs your update callback, measures the candidate, and returns an exact candidate reference.
It does not overwrite the live knowledge base.

```ts
import {
  improveKnowledgeBase,
  knowledgeImprovementCandidateRef,
  promoteKnowledgeCandidate,
} from '@tangle-network/agent-knowledge'

const result = await improveKnowledgeBase({
  root: './support-kb',
  goal: 'Answer refund questions using the current policy',
  implementationRef: 'git:0123456789abcdef0123456789abcdef01234567',
  runId: 'refund-policy-2026-07',
  maxCandidates: 3,
  updateKnowledge: async ({ candidateRoot }) => {
    await updateCandidate(candidateRoot) // Your code or agent writes only to this copy.
    return { applied: true, summary: 'Updated refund knowledge' }
  },
  evaluate: ({ baselineRoot, candidateRoot }) =>
    compareOnProductTasks({ baselineRoot, candidateRoot }),
})

if (result.candidate && result.evaluation?.passed) {
  const candidate = knowledgeImprovementCandidateRef(result)
  // Call this only after your application approves the measured candidate.
  await promoteKnowledgeCandidate({ root: './support-kb', candidate })
}
```

`updateCandidate` and `compareOnProductTasks` are application callbacks.
The update can come from a research agent, a coding agent, a source connector, or deterministic code.
The comparison must return the product measures that decide whether the change helped.

Use the same `runId` and `implementationRef` to resume an interrupted run.
Change `implementationRef` whenever callbacks, evaluation policy, models, indexes, or external configuration change.
Reusing a run ID with a different implementation reference fails before cached work or callbacks run.
Different run IDs create separate candidate workspaces, so workers can explore in parallel.
Promotion checks the original base hash and rejects a stale candidate instead of replacing newer work.
Candidate retries use `evaluateDevelopment` when provided, otherwise they use deterministic validation, readiness, and KB quality checks.
Development evaluation must use only train or selection data.
The configured `evaluate` callback and final RAG phases run once, on the first candidate that passes those development checks.
A failed final evaluation ends the run instead of selecting another candidate against final data.

Candidate promotion currently requires Linux because it relies on Linux directory descriptors for exact file identity.

## Evaluate and improve RAG

Use the narrowest API that matches the job:

| API | What it does |
|---|---|
| `runRetrievalImprovementLoop` | Runs one complete `OptimizationMethod` over serialized retrieval configuration. |
| `runRagOptimization` | Optimizes retrieval and answer behavior as one serialized RAG configuration. |
| `optimizeKnowledgeBasePolicy` | Optimizes a KB maintenance policy, then applies only the selected policy to an isolated candidate. |
| `scoreKnowledgeBaseIndex` | Measures KB structure, citations, source freshness, and configured quality thresholds. |
| `createRagAnswerQualityHook` | Adapts answer-quality checks such as support, relevance, citations, and abstention. |
| `runRagKnowledgeImprovementLoop` | Connects retrieval tuning, gap diagnosis, source acquisition, KB updates, answer checks, and a promotion decision. |
| `improveKnowledgeBase` | Adds resumable state, isolated candidates, exact promotion, and conflict detection around that process. |

```ts
import type {
  OptimizationMethod,
} from '@tangle-network/agent-eval/campaign'
import {
  runRetrievalImprovementLoop,
  type RetrievalEvalArtifact,
  type RetrievalEvalScenario,
} from '@tangle-network/agent-knowledge'

async function tuneRetrieval(
  method: OptimizationMethod<RetrievalEvalScenario, RetrievalEvalArtifact>,
) {
  return runRetrievalImprovementLoop({
    executionRef: 'git:0123456789abcdef0123456789abcdef01234567',
    baseline: { k: 5, reranker: false },
    method,
    trainScenarios,
    selectionScenarios,
    finalScenarios,
    retrieve: ({ scenario, config, k }) => search(scenario.query, { ...config, k }),
    runDir: 'refund-retrieval',
    expectUsage: 'off', // Local search does not make a billable model call.
  })
}
```

The method receives train and selection cases.
`agent-eval` keeps final cases out of the search and measures the exact selected configuration on them afterward.
Every optimization call requires an explicit complete method.
Create an official method with `gepaOptimizationMethod()` or `skillOptOptimizationMethod()` from `@tangle-network/agent-eval/campaign`, or pass another complete public `OptimizationMethod`.
Reuse the run directory only with the method's compatible resume mode.
Use separate run directories to explore branches in parallel.
Optimizer-specific identity and resume settings stay on the supplied method; this package does not reinterpret them.
The supplied method owns its engine inputs and resume state.
`executionRef` owns retrieval, index, judge, model, and external-service identity.
Use `git:<40 lowercase hex>` or `sha256:<64 lowercase hex>` and change it whenever any candidate execution or scoring behavior changes.
Each candidate has one canonical serialized identity.
See the [`agent-eval` method guide](https://github.com/tangle-network/agent-eval/blob/main/docs/campaign-proposers.md) for official GEPA and SkillOpt methods.
SkillOpt is skill-only; use it here only when the serialized candidate is itself a skill.
Read reported spend from `result.comparison.totalCost` and upstream source and run identity from `result.comparison.best.provenance`.
Official external methods must report observed package identity.
Custom in-process methods have no external package identity, so their behavior must be covered by `executionRef`.
Treat `accountingComplete: false` as incomplete evidence for activation.

Retrieval and answer generation remain callbacks.
This lets the same evaluation code work with local search, vector databases, hybrid search, rerankers, and hosted RAG services.
Adaptive diagnosis, acquisition, and update callbacks finish before retrieval or RAG final scoring starts.
Only answer evaluation, the terminal promotion decision, and the returned result can observe selected configurations.
Answer-quality evidence must name at least two final scenario IDs, immutable dataset and evaluator references, non-empty finite metrics, and observed cost accounting.
Promotion also requires `answerQualityCostCeiling`.

## Integrate memory systems

`@tangle-network/agent-knowledge/memory` defines `AgentMemoryAdapter` and adapters for Mem0, Graphiti, and Neo4j Agent Memory.
The package is not a memory database.
Install the provider you use, create its client, and pass that client to the adapter.

The memory APIs support scoped reads and writes, isolated branches, ordered histories, independent train, selection, and final comparisons, and adapter experiments.
Use them to compare a provider against no memory or another provider on the same tasks before changing production behavior.
`runAgentMemoryImprovement` accepts a complete `OptimizationMethod`, evaluates each serialized configuration in an isolated provider branch, and activates only a winner that passes a separate final comparison.
Set `implementationRef` to `git:<40 lowercase hex>` or `sha256:<64 lowercase hex>` covering the installed implementation, method configuration, candidate construction, execution behavior, and external configuration so incompatible state cannot resume.
The run records one immutable candidate reference for each memory configuration and refuses cached results if that reference changes.
Each improvement candidate declares a maximum for one sequence and one recovery attempt.
The adapter must enforce that maximum with its provider before starting external work.
The adapter callback must call `recordExternalCost()` with each observed charge.
Positive external work without a receipt is recorded as incomplete cost accounting, not as the configured maximum.
Use `0` only for a free local path.
Paid memory improvement defaults to a zero-dollar total limit; set `maxTotalCostUsd` and `maximumEvaluationCostUsd` before enabling paid work.

Use `runAgentMemoryLearningExperiment` to measure whether retained memory helps across ordered steps:

```ts
import { runAgentMemoryLearningExperiment } from '@tangle-network/agent-knowledge/memory'

const result = await runAgentMemoryLearningExperiment({
  experimentId: 'support-memory',
  runDir: 'support-memory',
  candidates: [memoryCandidate],
  sequences,
  seed: 42,
  reps: 5,
  armOrder: 'stateful-first',
  costCeiling: 10,
})

console.log(result.comparison.gain)
```

The function runs matched stateful and stateless arms with the same immutable candidate, tasks, executor, policy, seed, and repetitions.
The stateless arm clears declared scopes between steps; adapters must support scoped `clear`.
Gain excludes first-step probes and averages candidates and repetitions within each independent sequence.
Use `transferKey` on later probes for transfer and repeat one `retentionKey` across steps for forgetting.
Unmarked probes are not assigned those meanings.

Both arms share one cost limit and must have identical comparison references.
Run independent experiments with opposite `armOrder` values when provider behavior may drift.
Each saved probe includes the exact scoring input and content hash, so protect the run directory like the memory data itself.
Pass `signal` to cancel; rerun the same options and directory to resume completed work and cost records.

## Run benchmarks

`@tangle-network/agent-knowledge/benchmarks` provides common case and report types for:

- retrieval from qrels datasets
- RAG answer quality and unsupported claims
- knowledge-base improvement
- multi-turn memory behavior and provider comparison

The bundled industry cases are small smoke checks for adapter wiring.
They are not copies of full BEIR, MTEB, MS MARCO, LongMemEval, or other external datasets, and they do not produce a public leaderboard by themselves.
Import the real dataset rows or qrels and run them through `runKnowledgeBenchmarkSuite` for benchmark results.

## Package boundaries

| Import | Contents |
|---|---|
| `@tangle-network/agent-knowledge` | KB files, indexes, search, validation, research callbacks, RAG evaluation, and candidate improvement |
| `@tangle-network/agent-knowledge/memory` | Memory contracts, provider adapters, branches, and experiments |
| `@tangle-network/agent-knowledge/sources` | HTTP and authority-specific source adapters |
| `@tangle-network/agent-knowledge/benchmarks` | Benchmark cases, qrels import, execution, and reports |
| `@tangle-network/agent-knowledge/viz` | Dependency-free graph analysis helpers |

Use the `agent-knowledge` binary for CLI commands rather than importing its CLI module.

The package intentionally does not own model selection, prompts, browser access, agent scheduling, or a vector database.
Those choices stay in the application or in `@tangle-network/agent-runtime`.

## More detail

- [Architecture and data model](docs/architecture.md)
- [Verified research comparison](docs/verified-research-ab.md)
- [Changelog](CHANGELOG.md)

## License

MIT
