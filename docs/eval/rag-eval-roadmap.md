# RAG Eval Completion Roadmap

Verdict: use retrieval-only optimization when the retriever is the only changing component, and full RAG optimization when retrieval and answer behavior must move together.
SOTA RAG evaluation requires retrieval quality, context quality, generated-answer quality, abstention behavior, robustness, and operating budgets.

## Research Basis

| Source | What matters for us |
| --- | --- |
| [Ragas](https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/) / [paper](https://arxiv.org/abs/2309.15217) | Standard RAG eval splits retrieval and generation into context precision, context recall, faithfulness, and answer relevance. |
| [ARES](https://arxiv.org/abs/2311.09476) | Strong RAG eval scores context relevance, answer faithfulness, and answer relevance, and uses small human-labeled sets to calibrate automated judges. |
| [TruLens RAG Triad](https://www.trulens.org/getting_started/core_concepts/rag_triad/) | The minimal end-to-end triad is context relevance, groundedness, and answer relevance. |
| [RAGChecker](https://papers.nips.cc/paper_files/paper/2024/hash/27245589131d17368cccdfa990cbf16e-Abstract-Datasets_and_Benchmarks_Track.html) | Fine-grained diagnosis should separate retrieval misses, noisy context, and unsupported generated claims. |
| [BEIR](https://arxiv.org/abs/2104.08663) / TREC-style retrieval | Retrieval still needs classical rank metrics: Recall@k, Precision@k, MRR, MAP, and nDCG. |
| [CRAG](https://arxiv.org/abs/2406.04744) | Real RAG evals must include long-tail, dynamic, multi-hop, and unanswerable questions alongside easy static facts. |
| [DeepEval RAG metrics](https://deepeval.com/docs/metrics-faithfulness) | Production tools converge on faithfulness, answer relevance, and context relevance as generator/retriever checks. |

## Current Repo Status

Done:

- `runRetrievalImprovementLoop()` runs a complete `agent-eval` optimization method over retrieval configs.
- `runRagOptimization()` does the same for a serialized retrieval and answer configuration.
- `boundedRetrievalConfigMethod()` remains available for finite retrieval grids of at most 128 configurations by default.
- `runRagKnowledgeImprovementLoop()` exposes the whole RAG lifecycle as typed phases:
  retrieval tuning, gap diagnosis, knowledge acquisition, knowledge update, answer-quality eval, and promotion.
- Retrieval scenarios can label pages, page paths, sources, source anchors, and source spans.
- The retrieval judge reports recall, MRR, nDCG, and precision@k; `agent-eval` reports cost separately.
- Selection and final data remain independent, and the optimization method never receives final cases.
- The integration is tested with complete methods for retrieval and full RAG configuration.
- The lifecycle loop is tested both with pluggable phase hooks and with a real local KB update through `runKnowledgeResearchLoop()`.
- `ragAnswerQualityJudge()` and `createRagAnswerQualityHook()` score context precision/recall/relevance/sufficiency, faithfulness, answer relevance/correctness, citation support, abstention, and unsupported-answer rate.
- `normalizeExternalRagScores()` and the row exporters make Ragas, DeepEval, TruLens, RAGChecker, and custom evaluator outputs pluggable instead of hard dependencies.
- `scoreKnowledgeBaseIndex()` validates generic wiki/KB health: citation coverage, source-backed pages, stale sources, duplicate source hashes, and lint/validation errors.
- `calibrateRagAnswerJudge()` enforces the strong-vs-weak metric check before trusting a RAG answer metric.
- `runKnowledgeImprovementJob()` in `@tangle-network/agent-runtime` connects runtime backends and worker factories to candidate KB creation, readiness checks, frozen comparisons, spend measurement, and explicit activation.
- `agent-knowledge` remains runtime-free; applications with their own agent runner pass an `updateKnowledge` callback directly.

Not done:

- Slice-level reporting for freshness, distractors, multi-hop, and long-tail cases.
- A maintained, public benchmark pack with at least 100 labeled scenarios and published baseline results.

## Completion Criteria

### Phase 1: Retrieval Quality

Build a retrieval eval pack with at least 100 labeled scenarios.
Use source-span labels wherever possible.

Required slices:

- 25 known-answer questions.
- 25 paraphrase questions.
- 20 distractor questions.
- 10 freshness/version questions.
- 10 multi-source questions.
- 10 unanswerable or forbidden-source questions.

Ship criteria:

- Final source-span Recall@5 is at least 0.90.
- Final nDCG@5 is at least 0.80.
- Train-to-final recall gap is at most 0.08.
- Stale or forbidden source hit rate is at most 0.02.
- p95 retrieval latency and cost do not regress by more than 10 percent versus baseline.

### Phase 2: Answer Quality

Add a generated-answer eval artifact that includes query, retrieved context, answer text, citations, cost, latency, and trace ids.
Score it with deterministic checks first and LLM judges only for semantic quality.

Ship criteria:

- Faithfulness or groundedness is at least 0.95 on final cases.
- Answer relevance is at least 0.90 on final cases.
- Answer correctness is at least 0.85 on human-labeled final cases.
- Citation support is at least 0.95 for claims that cite sources.
- Unsupported-answer rate on unanswerable questions is at most 0.05.

### Phase 3: Diagnosis

Add RAGChecker-style failure attribution.
Every failed case must classify as one primary cause.

Required failure classes:

- Retrieval miss.
- Retrieval noisy context.
- Stale retrieval.
- Missing multi-hop evidence.
- Generator ignored evidence.
- Generator hallucinated unsupported claim.
- Citation mismatch.
- Correct abstention.
- Incorrect abstention.

Ship criteria:

- Every failed eval has one primary failure class.
- At least 95 percent of generated claims can be mapped to supporting context, contradicted context, or no context.
- Reports show metrics by slice and failure class as well as the aggregate score.

### Phase 4: Production Loop

Run the same eval pack on every retrieval or prompt change.
Keep train, selection, and final data isolated.
Never tune on final data.

Ship criteria:

- `runRetrievalImprovementLoop()` gates retrieval config changes.
- `runRagKnowledgeImprovementLoop()` is the default front door when retrieval changes, source acquisition, KB updates, answer checks, and promotion must run together.
- Answer-quality eval gates prompt and synthesis changes.
- Reports persist run id, commit, config hash, dataset hash, metric versions, cost, latency, and traces.
- A promoted candidate must improve the target metric without violating faithfulness, abstention, cost, or latency limits.

## Next Implementation Steps

1. Add slice-level aggregation helpers for freshness, distractors, multi-hop, long-tail, and unanswerable cases.
2. Add forbidden/stale source targets to retrieval scenarios.
3. Add a maintained benchmark pack with at least 100 labeled scenarios and a reproducible baseline report.
4. Add a CLI command that runs the lifecycle loop and writes a reproducible report under `.agent-knowledge/eval/`.
