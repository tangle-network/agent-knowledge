import { clamp01, normalizeClaims, requiredContextTexts } from './answer'
import type { ExternalRagEvalScore, RagAnswerEvalCase, RagEvalMetricKey } from './contracts'

const metricAliases: Record<string, RagEvalMetricKey> = {
  answer_correctness: 'answer_correctness',
  answer_relevance: 'answer_relevance',
  answer_relevancy: 'answer_relevance',
  answerrelevancy: 'answer_relevance',
  context_precision: 'context_precision',
  context_recall: 'context_recall',
  context_relevance: 'context_relevance',
  context_relevancy: 'context_relevance',
  context_sufficiency: 'context_sufficiency',
  contextual_precision: 'context_precision',
  contextual_recall: 'context_recall',
  contextual_relevancy: 'context_relevance',
  faithfulness: 'faithfulness',
  groundedness: 'groundedness',
  claim_recall: 'context_recall',
  claim_precision: 'faithfulness',
  citation_support: 'citation_support',
  abstention: 'abstention',
  unsupported_answer_rate: 'unsupported_answer_rate',
}

export function normalizeExternalRagScores(
  scores: readonly ExternalRagEvalScore[],
): Record<string, Record<RagEvalMetricKey, number>> {
  const normalized: Record<string, Record<RagEvalMetricKey, number>> = {}
  for (const item of scores) {
    const provider = item.provider || 'custom'
    const providerScores = (normalized[provider] ?? {}) as Record<RagEvalMetricKey, number>
    for (const [key, value] of Object.entries(item.scores)) {
      const canonical = metricAliases[normalizeMetricName(key)]
      if (!canonical) continue
      if (Number.isFinite(value)) providerScores[canonical] = clamp01(value)
    }
    normalized[provider] = providerScores
  }
  return normalized
}

export function toRagasEvaluationRows(cases: readonly RagAnswerEvalCase[]) {
  return cases.map(({ scenario, artifact }) => ({
    user_input: scenario.query,
    response: artifact.answer,
    retrieved_contexts: artifact.contexts.map((context) => context.text),
    reference: scenario.referenceAnswer,
    reference_contexts: requiredContextTexts(scenario),
  }))
}

export function toDeepEvalTestCases(cases: readonly RagAnswerEvalCase[]) {
  return cases.map(({ scenario, artifact }) => ({
    input: scenario.query,
    actual_output: artifact.answer,
    expected_output: scenario.referenceAnswer,
    retrieval_context: artifact.contexts.map((context) => context.text),
    context: requiredContextTexts(scenario),
  }))
}

export function toTruLensRecords(cases: readonly RagAnswerEvalCase[]) {
  return cases.map(({ scenario, artifact }) => ({
    input: scenario.query,
    output: artifact.answer,
    context: artifact.contexts.map((context) => context.text).join('\n\n'),
  }))
}

export function toRagCheckerRecords(cases: readonly RagAnswerEvalCase[]) {
  return cases.map(({ scenario, artifact }) => ({
    query_id: scenario.id,
    query: scenario.query,
    gt_answer: scenario.referenceAnswer,
    response: artifact.answer,
    retrieved_context: artifact.contexts.map((context) => ({
      doc_id: context.id,
      text: context.text,
    })),
    claims: normalizeClaims(artifact).map((claim) => claim.text),
  }))
}

function normalizeMetricName(metric: string): string {
  return metric
    .trim()
    .toLowerCase()
    .replace(/[@/.-]+/g, '_')
    .replace(/\s+/g, '_')
}
