import type { ComparisonCost } from '@tangle-network/agent-eval/campaign'
import { assertImmutableRef } from './immutable-ref'

interface RagAnswerEvidence {
  passed: boolean
  metrics: Record<string, number>
  finalScenarioIds: readonly string[]
  datasetRef: string
  evaluatorRef: string
  cost: ComparisonCost
}

export function assertRagAnswerEvidence(result: RagAnswerEvidence): void {
  if (!result || typeof result !== 'object') {
    throw new Error('answer-quality evidence must be an object')
  }
  if (typeof result.passed !== 'boolean') {
    throw new Error('answer-quality evidence requires a boolean passed verdict')
  }
  assertImmutableRef(result.datasetRef, 'answer-quality datasetRef')
  assertImmutableRef(result.evaluatorRef, 'answer-quality evaluatorRef')
  if (
    !Array.isArray(result.finalScenarioIds) ||
    result.finalScenarioIds.length < 2 ||
    new Set(result.finalScenarioIds).size !== result.finalScenarioIds.length ||
    result.finalScenarioIds.some((id) => typeof id !== 'string' || id.trim().length === 0)
  ) {
    throw new Error('answer-quality evidence requires at least 2 unique final scenario IDs')
  }
  if (!result.metrics || typeof result.metrics !== 'object' || Array.isArray(result.metrics)) {
    throw new Error('answer-quality evidence requires non-empty finite metrics')
  }
  const metrics = Object.entries(result.metrics)
  if (
    metrics.length === 0 ||
    metrics.some(([key, value]) => key.trim().length === 0 || !Number.isFinite(value))
  ) {
    throw new Error('answer-quality evidence requires non-empty finite metrics')
  }
  if (!result.cost || typeof result.cost !== 'object') {
    throw new Error('answer-quality evidence requires cost accounting')
  }
  if (
    !Number.isFinite(result.cost.totalCostUsd) ||
    result.cost.totalCostUsd < 0 ||
    typeof result.cost.accountingComplete !== 'boolean' ||
    !Array.isArray(result.cost.incompleteReasons) ||
    result.cost.incompleteReasons.some((reason) => typeof reason !== 'string' || !reason.trim())
  ) {
    throw new Error('answer-quality evidence has invalid cost accounting')
  }
  if (result.cost.accountingComplete && result.cost.incompleteReasons.length > 0) {
    throw new Error('complete answer-quality cost accounting cannot include incomplete reasons')
  }
}

export function ragAnswerEvidenceRejectionReasons(
  evidence: RagAnswerEvidence,
  costCeiling: number | undefined,
): string[] {
  const reasons: string[] = []
  if (!evidence.passed) reasons.push('answer-quality evaluation failed')
  if (!evidence.cost.accountingComplete) {
    reasons.push('answer-quality final comparison has incomplete cost accounting')
  }
  if (costCeiling === undefined) {
    reasons.push('answer-quality promotion requires answerQualityCostCeiling')
  } else if (exceedsCostCeiling(evidence.cost.totalCostUsd, costCeiling)) {
    reasons.push(
      `answer-quality final comparison cost ${evidence.cost.totalCostUsd} exceeds ${costCeiling}`,
    )
  }
  return reasons
}

function exceedsCostCeiling(totalCostUsd: number, costCeiling: number): boolean {
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(totalCostUsd), Math.abs(costCeiling)) * 8
  return totalCostUsd - costCeiling > tolerance
}
