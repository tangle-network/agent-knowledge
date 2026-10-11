# Evaluate and improve RAG

> Extracted from the README — see the [README](../README.md) for the package overview.

## Evaluate and improve RAG

Use the narrowest API that matches the job:

| API | What it does |
|---|---|
| `runRetrievalImprovementLoop` | Runs one complete `OptimizationMethod` over serialized retrieval configuration. |
| `runRagOptimization` | Optimizes retrieval and answer behavior as one serialized RAG configuration. |
| `scoreKnowledgeBaseIndex` | Measures KB structure, citations, source freshness, and configured quality thresholds. |
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

Retrieval, RAG, and serialized-candidate optimization accept Eval's optional `claim` and `finalEvidence` options.
Use `claim.independentUnit` to group questions from the same source.
A `new-units` claim requires separate source units for development and final evaluation.
Results retain scenario scores, source-unit scores, and both observation counts.
Claim metadata declares the intended scope; it does not authenticate labels or establish certification.

For fresh final evidence, pass a shared durable ledger from `openFinalEvidenceLedger()` in `@tangle-network/agent-eval/experiment`.
The policy also requires a request ID and the actual evaluator's content digest.
Eval reserves final units before search and records exposure before measurement.
Interrupted measurements consume that evidence, and another request cannot restore its freshness.
See [Eval's integrity guide](https://github.com/tangle-network/agent-eval/blob/main/docs/evaluation-integrity.md) for the full controls and limits.

Retrieval and answer generation remain callbacks.
This lets the same evaluation code work with local search, vector databases, hybrid search, rerankers, and hosted RAG services.
Adaptive diagnosis, acquisition, and update callbacks finish before retrieval or RAG final scoring starts.
Only answer evaluation, the terminal promotion decision, and the returned result can observe selected configurations.
Answer-quality evidence must name at least two final scenario IDs, immutable dataset and evaluator references, non-empty finite metrics, and observed cost accounting.
Promotion also requires `answerQualityCostCeiling`.

For evaluator admission, use `auditEvaluator()` from `@tangle-network/agent-eval/meta-eval` with actual judgments of independently verified controls.
The application must enforce evaluator and auditor separation and retain evidence for the labels.