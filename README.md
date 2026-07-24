# @tangle-network/agent-knowledge

Build, search, test, and improve source-backed knowledge bases in TypeScript.

The package manages source records, Markdown knowledge, indexes, retrieval tests, candidate workspaces, and memory adapters.
It does not browse, call models, or run agents.
Supply application callbacks for those decisions, or use `@tangle-network/agent-runtime/knowledge` to run them with agents.

## Install

```bash
pnpm add @tangle-network/agent-knowledge
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

Use the same `runId` to resume an interrupted run.
Different run IDs create separate candidate workspaces, so workers can explore in parallel.
Promotion checks the original base hash and rejects a stale candidate instead of replacing newer work.

Candidate promotion currently requires Linux because it relies on Linux directory descriptors for exact file identity.

## Evaluate and improve RAG

Use the narrowest API that matches the job:

| API | What it does |
|---|---|
| `runRetrievalImprovementLoop` | Runs one complete `OptimizationMethod` over serialized retrieval configuration. |
| `boundedRetrievalConfigMethod` | Builds a complete method that enumerates a small finite retrieval grid, limited to 128 configurations by default. |
| `runRagOptimization` | Optimizes retrieval and answer behavior as one serialized RAG configuration. |
| `optimizeKnowledgeBasePolicy` | Optimizes a KB maintenance policy, then applies only the selected policy to an isolated candidate. |
| `scoreKnowledgeBaseIndex` | Measures KB structure, citations, source freshness, and configured quality thresholds. |
| `createRagAnswerQualityHook` | Adapts answer-quality checks such as support, relevance, citations, and abstention. |
| `runRagKnowledgeImprovementLoop` | Connects retrieval tuning, gap diagnosis, source acquisition, KB updates, answer checks, and a promotion decision. |
| `improveKnowledgeBase` | Adds resumable state, isolated candidates, exact promotion, and conflict detection around that process. |

```ts
const method = boundedRetrievalConfigMethod({
  searchSpace: { k: [5, 10], reranker: [false, true] },
})

const result = await runRetrievalImprovementLoop({
  baseline: { k: 5, reranker: false },
  method,
  trainScenarios,
  selectionScenarios,
  finalScenarios,
  retrieve: ({ scenario, config, k }) => search(scenario.query, { ...config, k }),
  runDir: 'refund-retrieval-v1',
  expectUsage: 'off', // Local search does not make a billable model call.
})
```

The method receives train and selection cases.
`agent-eval` keeps final cases out of the search and measures the exact selected configuration on them afterward.
Every optimization call requires an explicit complete method.
Pass an applicable official method, a custom method, or `boundedRetrievalConfigMethod()` for a small finite retrieval grid.
Reuse the run directory only with the method's compatible resume mode.
Use separate run directories to explore branches in parallel.
Optimizer-specific identity and resume settings stay on the supplied method; this package does not reinterpret them.
The supplied method owns `evaluationVersion`, engine or skill inputs, and resume compatibility.
`agent-eval` component surfaces stay outside this adapter; each knowledge candidate has one canonical serialized identity.
See the [`agent-eval` method guide](https://github.com/tangle-network/agent-eval/blob/main/docs/campaign-proposers.md) for official GEPA and Omni methods.
SkillOpt is skill-only; use it here only when the serialized candidate is itself a skill.

Retrieval and answer generation remain callbacks.
This lets the same evaluation code work with local search, vector databases, hybrid search, rerankers, and hosted RAG services.

## Integrate memory systems

`@tangle-network/agent-knowledge/memory` defines `AgentMemoryAdapter` and adapters for Mem0, Graphiti, and Neo4j Agent Memory.
The package is not a memory database.
Install the provider you use, create its client, and pass that client to the adapter.

The memory APIs support scoped reads and writes, isolated branches, ordered histories, independent train, selection, and final comparisons, and adapter experiments.
Use them to compare a provider against no memory or another provider on the same tasks before changing production behavior.
`runAgentMemoryImprovement` accepts a complete `OptimizationMethod`, evaluates each serialized configuration in an isolated provider branch, and activates only a final-data winner through compare-and-set.
Paid memory improvement defaults to zero-dollar optimization and final limits; set both limits and a per-evaluation maximum before enabling paid work.

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
- [Two-agent research comparison](docs/two-agent-research-ab.md)
- [Changelog](CHANGELOG.md)

## License

MIT
