import type { JsonValue, PairedHoldout } from '@tangle-network/agent-eval/campaign'
import { heldoutSignificance } from '@tangle-network/agent-eval/campaign'
import type { RunSerializedKnowledgeOptimizationResult } from '../../optimization'
import type { AgentMemorySequence, AgentMemorySequenceProbe } from '../experiment'
import {
  type AgentMemoryFinalEvaluation,
  type AgentMemoryPromotionDecision,
  DEFAULT_CRITICAL_DIMENSIONS,
  type RunAgentMemoryImprovementOptions,
} from './types'

export function decidePromotion<TConfig extends JsonValue>(input: {
  options: RunAgentMemoryImprovementOptions<TConfig>
  optimization: RunSerializedKnowledgeOptimizationResult<TConfig>
  finalEvaluation: AgentMemoryFinalEvaluation
  unchanged: boolean
}): AgentMemoryPromotionDecision {
  const { options, finalEvaluation } = input
  const baselineScores = finalEvaluation.pairs.map((pair) => pair.baseline.score)
  const winnerScores = finalEvaluation.pairs.map((pair) => pair.winner.score)
  const baselineScore = mean(baselineScores)
  const winnerScore = mean(winnerScores)
  if (input.unchanged) {
    return {
      status: 'no-change',
      reasons: ['optimization selected the baseline configuration'],
      baselineScore,
      winnerScore,
      lift: 0,
      criticalDimensions: [],
    }
  }

  const significance = heldoutSignificance(
    {
      before: baselineScores,
      after: winnerScores,
      cellIds: finalEvaluation.pairs.map((pair) => `${pair.sequenceId}:${pair.rep}`),
    },
    options.significance,
  )
  const tolerance = options.criticalDimensionTolerance ?? 0.05
  const criticalDimensions = (options.criticalDimensions ?? DEFAULT_CRITICAL_DIMENSIONS).map(
    (dimension) => {
      const expectedN =
        applicableSequenceCount(options.finalSequences, dimension) * (options.reps ?? 1)
      const pairs = pairedDimension(finalEvaluation, dimension)
      const comparison = heldoutSignificance(pairs, {
        ...options.significance,
        deltaThreshold: 0,
      })
      return {
        dimension,
        n: comparison.n,
        expectedN,
        measured: expectedN > 0 && comparison.n === expectedN,
        meanDelta: comparison.bootstrap.mean,
        low: comparison.bootstrap.low,
        high: comparison.bootstrap.high,
        tolerance,
        regressed:
          expectedN > 0 && comparison.n === expectedN && comparison.bootstrap.low < -tolerance,
      }
    },
  )
  const reasons: string[] = []
  const optimizationCost = input.optimization.comparison.optimizationCost
  const finalCost = input.optimization.comparison.testCost
  if (
    !input.optimization.comparison.totalCost.accountingComplete &&
    !options.allowIncompleteCostAccounting
  ) {
    reasons.push('optimization or final cost accounting is incomplete')
  }
  if (optimizationCost.totalCostUsd > (options.maxOptimizationCostUsd ?? 0)) {
    reasons.push(
      `optimization cost ${optimizationCost.totalCostUsd} exceeds the configured limit ${options.maxOptimizationCostUsd ?? 0}`,
    )
  }
  if (finalCost.totalCostUsd > (options.maxFinalCostUsd ?? 0)) {
    reasons.push(
      `final comparison cost ${finalCost.totalCostUsd} exceeds the configured limit ${options.maxFinalCostUsd ?? 0}`,
    )
  }
  if (!significance.significant) {
    reasons.push(
      significance.fewRuns
        ? `only ${significance.n} paired final cells; more are required`
        : 'final lift is not confidently above the promotion threshold',
    )
  }
  if (winnerScore < (options.minFinalScore ?? 0)) {
    reasons.push(`winner final score ${winnerScore} is below the required minimum`)
  }
  for (const dimension of criticalDimensions) {
    if (!dimension.measured) {
      reasons.push(
        dimension.expectedN === 0
          ? `critical dimension ${dimension.dimension} has no applicable final histories`
          : `critical dimension ${dimension.dimension} was measured on ${dimension.n}/${dimension.expectedN} applicable paired final cells`,
      )
    } else if (dimension.regressed) {
      reasons.push(`${dimension.dimension} may regress beyond ${tolerance}`)
    }
  }
  return {
    status: reasons.length === 0 ? 'promote' : 'hold',
    reasons,
    baselineScore,
    winnerScore,
    lift: winnerScore - baselineScore,
    significance,
    criticalDimensions,
  }
}

export function normalizedPromotionPolicy<TConfig extends JsonValue>(
  options: RunAgentMemoryImprovementOptions<TConfig>,
): Record<string, unknown> {
  return {
    significance: {
      deltaThreshold: options.significance?.deltaThreshold ?? 0,
      minProductiveRuns: options.significance?.minProductiveRuns ?? 3,
      confidence: options.significance?.confidence ?? 0.95,
      resamples: options.significance?.resamples ?? 2000,
      seed: options.significance?.seed ?? 1337,
      statistic: options.significance?.statistic ?? 'mean',
    },
    criticalDimensions: [...(options.criticalDimensions ?? DEFAULT_CRITICAL_DIMENSIONS)],
    criticalDimensionTolerance: options.criticalDimensionTolerance ?? 0.05,
    minFinalScore: options.minFinalScore ?? 0,
    maxOptimizationCostUsd: options.maxOptimizationCostUsd ?? 0,
    maxFinalCostUsd: options.maxFinalCostUsd ?? 0,
    allowIncompleteCostAccounting: options.allowIncompleteCostAccounting ?? false,
  }
}

function pairedDimension(result: AgentMemoryFinalEvaluation, dimension: string): PairedHoldout {
  const applicable = result.pairs.filter(
    (pair) =>
      (pair.baseline.dimensionSampleCounts[dimension] ?? 0) > 0 &&
      (pair.winner.dimensionSampleCounts[dimension] ?? 0) > 0,
  )
  return {
    before: applicable.map((pair) => pair.baseline.dimensions[dimension]!),
    after: applicable.map((pair) => pair.winner.dimensions[dimension]!),
    cellIds: applicable.map((pair) => `${pair.sequenceId}:${pair.rep}`),
  }
}

function applicableSequenceCount(
  sequences: readonly AgentMemorySequence[],
  dimension: string,
): number {
  return sequences.filter((sequence) =>
    sequence.steps.some((step) =>
      (step.probes ?? []).some((probe) => probeAppliesToDimension(probe, dimension)),
    ),
  ).length
}

function probeAppliesToDimension(probe: AgentMemorySequenceProbe, dimension: string): boolean {
  switch (dimension) {
    case 'memory_fact_recall':
    case 'memory_required_fact_count':
    case 'memory_matched_fact_count':
      return Boolean(
        (probe.requiredFacts && probe.requiredFacts.length > 0) || probe.referenceAnswer,
      )
    case 'memory_event_recall':
      return Boolean(probe.expectedEventIds && probe.expectedEventIds.length > 0)
    case 'memory_actor_recall':
      return Boolean(probe.expectedActorIds && probe.expectedActorIds.length > 0)
    case 'memory_stale_safe':
    case 'memory_stale_rate':
    case 'memory_forbidden_fact_count':
    case 'memory_matched_forbidden_fact_count':
      return Boolean(probe.forbiddenFacts && probe.forbiddenFacts.length > 0)
    default:
      return true
  }
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}
