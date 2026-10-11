# Improve a live knowledge base

> Extracted from the README — see the [README](../README.md) for the package overview.

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
Diagnosis runs before acquisition and updates, using development data only.
Its findings and update results remain available to final answer checks and the promotion decision.
Development evaluation must use only train or selection data.
The configured `evaluate` callback and final RAG phases run once, on the first candidate that passes those development checks.
A failed final evaluation ends the run instead of selecting another candidate against final data.

The default evaluator reports only measured dimensions and averages those dimensions with equal weight.
It omits `answer_quality` without answer evaluation, `promotion_decision` without a promotion decision, and `blocking_readiness` without blocking readiness requirements.
Default evaluator version `2` records this weighting.
Declare additional authoritative local state through `stateScope`:

```ts
const stateScope = { pagesDirectory: 'kb/pages', researchState: true }
const result = await improveKnowledgeBase({ ...options, stateScope })
const identity = await hashKnowledgeBase(root, stateScope)
```

The default scope remains `knowledge/`, `raw/`, and `.agent-knowledge/sources.json`.
`pagesDirectory` replaces the default page directory for copying, indexing, hashing, and promotion.
`researchState: true` also includes canonical `.agent-knowledge/claim-ledgers/` records and `.agent-knowledge/events.json`.
The persisted run binds this scope, and resume rejects a different scope.
Candidate materialization, selected changes, promotion, and restoration preserve the same declared state.
Use `normalizeKnowledgeStateScope` when carrying this scope into another contract.
Indexes, locks, transaction journals, retrieval artifacts, credentials outside declared content directories, and external memory providers remain outside this identity.
Use the canonical `FileSystemKbStore({ root: candidateRoot })` for research records in update callbacks.
Callbacks must bind external state separately and must not close over a shared mutable store when evaluating isolated candidates.
A scoped KB hash does not identify an entire learner with external state.

A candidate can pass structural checks without any task outcome evaluation; the metric notes state this limit.
`candidate-ready` means the configured checks passed and the candidate remains detached from the live knowledge base.

Candidate promotion currently requires Linux because it relies on Linux directory descriptors for exact file identity.