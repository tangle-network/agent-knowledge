import type { JudgeConfig } from '@tangle-network/agent-eval/campaign'
import type { RagGapFinding } from '../rag-improvement-loop'
import { mean } from '../statistics'
import {
  claimSupport,
  clamp01,
  contextIsRelevant,
  contextMatchesTarget,
  contextRelevanceScore,
  looksLikeAbstention,
  neutralScore,
  normalizeClaims,
  requiredContextTargets,
  scoreAnswerCorrectness,
  scoreAnswerRelevance,
  scoreCitations,
} from './answer'
import type {
  RagAnswerEvalArtifact,
  RagAnswerEvalScenario,
  RagAnswerMetricSummary,
  RagAnswerQualityJudgeOptions,
  RagEvalMetricKey,
} from './contracts'
import { normalizeExternalRagScores } from './providers'

const defaultThresholds: Partial<Record<RagEvalMetricKey, number>> = {
  context_precision: 0.5,
  context_recall: 0.8,
  context_relevance: 0.5,
  context_sufficiency: 0.8,
  faithfulness: 0.9,
  answer_relevance: 0.7,
  citation_support: 0.9,
  abstention: 1,
  unsupported_answer_rate: 0,
}

const defaultWeights: Partial<Record<RagEvalMetricKey, number>> = {
  context_relevance: 1,
  context_sufficiency: 1,
  faithfulness: 2,
  answer_relevance: 1,
  citation_support: 1,
  abstention: 1,
}

export function ragAnswerQualityJudge(
  options: RagAnswerQualityJudgeOptions = {},
): JudgeConfig<RagAnswerEvalArtifact, RagAnswerEvalScenario> {
  return {
    name: options.name ?? 'rag-answer-quality',
    dimensions: [
      { key: 'context_precision', description: 'share of retrieved context that is useful' },
      { key: 'context_recall', description: 'share of required evidence present in context' },
      { key: 'context_relevance', description: 'context relevance to the query and answer target' },
      { key: 'context_sufficiency', description: 'whether context is enough to answer' },
      { key: 'faithfulness', description: 'share of answer claims supported by retrieved context' },
      { key: 'answer_relevance', description: 'answer addresses the user query' },
      { key: 'answer_correctness', description: 'answer contains expected claims' },
      { key: 'citation_support', description: 'citations support the claims they cite' },
      { key: 'abstention', description: 'answer abstains exactly when the case is unanswerable' },
    ],
    appliesTo: (scenario) => scenario.kind === 'rag-answer-eval',
    async score({ artifact, scenario }) {
      const summary = scoreRagAnswerArtifact(artifact, scenario, options)
      return {
        dimensions: summary.metrics,
        composite: summary.composite,
        notes: summary.findings.map((finding) => finding.message).join('; '),
      }
    },
  }
}

export function scoreRagAnswerArtifact(
  artifact: RagAnswerEvalArtifact,
  scenario: RagAnswerEvalScenario,
  options: RagAnswerQualityJudgeOptions = {},
): RagAnswerMetricSummary {
  const claims = normalizeClaims(artifact)
  const abstained = artifact.abstained ?? looksLikeAbstention(artifact.answer)
  const requiredTargets = requiredContextTargets(scenario)
  const matchedRequiredContextCount = requiredTargets.filter((target) =>
    artifact.contexts.some((context) => contextMatchesTarget(context, target)),
  ).length
  const requiredContextCount = requiredTargets.length
  const contextRecall =
    requiredContextCount === 0
      ? neutralScore(Boolean(scenario.unanswerable) || artifact.contexts.length > 0)
      : matchedRequiredContextCount / requiredContextCount
  const relevantContextCount = artifact.contexts.filter((context) =>
    contextIsRelevant(context, scenario),
  ).length
  const contextPrecision =
    artifact.contexts.length === 0
      ? scenario.unanswerable
        ? 1
        : 0
      : relevantContextCount / artifact.contexts.length
  const contextRelevance =
    artifact.contexts.length === 0
      ? scenario.unanswerable
        ? 1
        : 0
      : mean(artifact.contexts.map((context) => contextRelevanceScore(context, scenario)))
  const contextSufficiency = requiredContextCount === 0 ? contextRelevance : contextRecall
  const support = claims.map((claim) => claimSupport(claim.text, artifact.contexts, options))
  const supportedClaimCount = support.filter(Boolean).length
  const faithfulness =
    claims.length === 0 ? (abstained ? 1 : 0) : supportedClaimCount / Math.max(1, claims.length)
  const citation = scoreCitations(claims, artifact, scenario, options)
  const answerRelevance = scoreAnswerRelevance(artifact, scenario, abstained)
  const answerCorrectness = scoreAnswerCorrectness(artifact, scenario, abstained)
  const abstention = scenario.unanswerable ? (abstained ? 1 : 0) : abstained ? 0 : 1
  const unsupportedAnswerRate =
    claims.length === 0 ? (abstained ? 0 : 1) : 1 - supportedClaimCount / Math.max(1, claims.length)

  const deterministicMetrics: Record<RagEvalMetricKey, number> = {
    context_precision: clamp01(contextPrecision),
    context_recall: clamp01(contextRecall),
    context_relevance: clamp01(contextRelevance),
    context_sufficiency: clamp01(contextSufficiency),
    faithfulness: clamp01(faithfulness),
    groundedness: clamp01(faithfulness),
    answer_relevance: clamp01(answerRelevance),
    answer_correctness: clamp01(answerCorrectness),
    citation_support: clamp01(citation.support),
    abstention: clamp01(abstention),
    unsupported_answer_rate: clamp01(unsupportedAnswerRate),
  }
  const providerScores = normalizeExternalRagScores(artifact.externalScores ?? [])
  const metrics = mergeMetrics(deterministicMetrics, providerScores, options.externalScorePolicy)
  const thresholds = { ...defaultThresholds, ...scenario.thresholds, ...options.thresholds }
  const findings = diagnoseRagAnswerFailure(metrics, scenario, thresholds)
  const composite = weightedComposite(metrics, options.weights ?? defaultWeights)

  return {
    metrics,
    composite,
    passed: findings.every(
      (finding) => finding.severity !== 'error' && finding.severity !== 'critical',
    ),
    findings,
    claimCount: claims.length,
    supportedClaimCount,
    citedClaimCount: citation.citedClaimCount,
    supportedCitationCount: citation.supportedCitationCount,
    matchedRequiredContextCount,
    requiredContextCount,
    providerScores,
  }
}

export function diagnoseRagAnswerFailure(
  metrics: Record<RagEvalMetricKey, number>,
  scenario: RagAnswerEvalScenario,
  thresholds: Partial<Record<RagEvalMetricKey, number>> = defaultThresholds,
): RagGapFinding[] {
  const findings: RagGapFinding[] = []
  if (below(metrics.context_recall, thresholds.context_recall)) {
    findings.push({
      id: `${scenario.id}:context-recall`,
      kind: scenario.slices?.includes('multi-source')
        ? 'missing-multihop-evidence'
        : 'retrieval-miss',
      severity: 'error',
      scenarioId: scenario.id,
      message: 'Required evidence was not present in retrieved context.',
      evidence: { context_recall: metrics.context_recall },
    })
  }
  if (below(metrics.context_precision, thresholds.context_precision)) {
    findings.push({
      id: `${scenario.id}:context-precision`,
      kind: 'retrieval-noise',
      severity: 'warning',
      scenarioId: scenario.id,
      message: 'Retrieved context contains too much irrelevant material.',
      evidence: { context_precision: metrics.context_precision },
    })
  }
  if (below(metrics.faithfulness, thresholds.faithfulness)) {
    findings.push({
      id: `${scenario.id}:faithfulness`,
      kind: 'generator-unsupported-claim',
      severity: 'error',
      scenarioId: scenario.id,
      message: 'The answer contains claims not supported by retrieved context.',
      evidence: { faithfulness: metrics.faithfulness },
    })
  }
  if (below(metrics.citation_support, thresholds.citation_support)) {
    findings.push({
      id: `${scenario.id}:citation-support`,
      kind: 'citation-mismatch',
      severity: 'error',
      scenarioId: scenario.id,
      message: 'Citations do not support the claims they are attached to.',
      evidence: { citation_support: metrics.citation_support },
    })
  }
  if (below(metrics.abstention, thresholds.abstention)) {
    findings.push({
      id: `${scenario.id}:abstention`,
      kind: 'incorrect-abstention',
      severity: 'error',
      scenarioId: scenario.id,
      message: scenario.unanswerable
        ? 'The system answered a case marked unanswerable.'
        : 'The system abstained from an answerable case.',
      evidence: { abstention: metrics.abstention },
    })
  }
  return findings
}

function mergeMetrics(
  deterministic: Record<RagEvalMetricKey, number>,
  providerScores: Record<string, Record<RagEvalMetricKey, number>>,
  policy: RagAnswerQualityJudgeOptions['externalScorePolicy'] = 'prefer-external',
): Record<RagEvalMetricKey, number> {
  if (policy === 'deterministic-first') return deterministic
  const merged = { ...deterministic }
  for (const scores of Object.values(providerScores)) {
    for (const [key, value] of Object.entries(scores) as Array<[RagEvalMetricKey, number]>) {
      merged[key] = value
      if (key === 'groundedness') merged.faithfulness = value
      if (key === 'faithfulness') merged.groundedness = value
    }
  }
  return merged
}

export function aggregateRagAnswerMetrics(
  summaries: readonly RagAnswerMetricSummary[],
): Record<string, number> {
  const keys = new Set<RagEvalMetricKey>()
  for (const summary of summaries) {
    for (const key of Object.keys(summary.metrics) as RagEvalMetricKey[]) keys.add(key)
  }
  const out: Record<string, number> = {}
  for (const key of [...keys].sort()) {
    out[key] = mean(summaries.map((summary) => summary.metrics[key]))
  }
  out.composite = mean(summaries.map((summary) => summary.composite))
  return out
}

function weightedComposite(
  metrics: Record<RagEvalMetricKey, number>,
  weights: Partial<Record<RagEvalMetricKey, number>>,
): number {
  let weighted = 0
  let total = 0
  for (const [key, weight] of Object.entries(weights) as Array<[RagEvalMetricKey, number]>) {
    if (!Number.isFinite(weight) || weight <= 0) continue
    const metric = metrics[key]
    if (!Number.isFinite(metric)) continue
    const value = key === 'unsupported_answer_rate' ? 1 - metric : metric
    weighted += value * weight
    total += weight
  }
  return total === 0 ? 0 : weighted / total
}

function below(metric: number, threshold: number | undefined): boolean {
  return threshold !== undefined && metric < threshold
}
