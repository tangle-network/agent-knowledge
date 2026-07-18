import { heldoutSignificance, type PairedHoldout } from '@tangle-network/agent-eval/campaign'
import type {
  AgentMemorySequence,
  AgentMemorySequenceArtifact,
  AgentMemorySequenceProbe,
  RunAgentMemoryExperimentResult,
} from '../experiment'
import {
  type AgentMemoryPromotionDecision,
  DEFAULT_CRITICAL_DIMENSIONS,
  type RunAgentMemoryImprovementOptions,
} from './types'

export function decidePromotion<TConfig>(input: {
  options: RunAgentMemoryImprovementOptions<TConfig>
  result: RunAgentMemoryExperimentResult
  baselineId: string
  winnerId: string
}): AgentMemoryPromotionDecision {
  const { options, result, baselineId, winnerId } = input
  const baselineRow = result.rows.find((row) => row.candidateId === baselineId)
  const winnerRow = result.rows.find((row) => row.candidateId === winnerId)
  if (!baselineRow || !winnerRow) throw new Error('holdout result is missing a comparison arm')
  const paired = pairedArtifacts(result, baselineId, winnerId, (artifact) => artifact.score)
  const significance = heldoutSignificance(paired, options.significance)
  const tolerance = options.criticalDimensionTolerance ?? 0.05
  const criticalDimensions = (options.criticalDimensions ?? DEFAULT_CRITICAL_DIMENSIONS).map(
    (dimension) => {
      const expectedN =
        applicableSequenceCount(options.holdoutSequences, dimension) * (options.reps ?? 1)
      const dimensionPairs = pairedArtifacts(result, baselineId, winnerId, (artifact) =>
        (artifact.dimensionSampleCounts?.[dimension] ?? 0) > 0
          ? artifact.dimensions[dimension]
          : undefined,
      )
      const comparison = heldoutSignificance(dimensionPairs, {
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
  if (baselineRow.cellsFailed > 0 || winnerRow.cellsFailed > 0) {
    reasons.push('at least one holdout cell failed')
  }
  if (!significance.significant) {
    reasons.push(
      significance.fewRuns
        ? `only ${significance.n} paired holdout cells; more are required`
        : 'holdout lift is not confidently above the promotion threshold',
    )
  }
  if (winnerRow.scoreMean < (options.minHoldoutScore ?? 0)) {
    reasons.push(`winner holdout score ${winnerRow.scoreMean} is below the required minimum`)
  }
  for (const dimension of criticalDimensions) {
    if (!dimension.measured) {
      reasons.push(
        dimension.expectedN === 0
          ? `critical dimension ${dimension.dimension} has no applicable holdout histories`
          : `critical dimension ${dimension.dimension} was measured on ${dimension.n}/${dimension.expectedN} applicable paired holdout cells`,
      )
    } else if (dimension.regressed) {
      reasons.push(`${dimension.dimension} may regress beyond ${tolerance}`)
    }
  }
  return {
    status: reasons.length === 0 ? 'promote' : 'hold',
    reasons,
    baselineScore: baselineRow.scoreMean,
    winnerScore: winnerRow.scoreMean,
    lift: winnerRow.scoreMean - baselineRow.scoreMean,
    significance,
    criticalDimensions,
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

export function normalizedPromotionPolicy<TConfig>(
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
    minHoldoutScore: options.minHoldoutScore ?? 0,
  }
}

function pairedArtifacts(
  result: RunAgentMemoryExperimentResult,
  baselineId: string,
  winnerId: string,
  select: (artifact: AgentMemorySequenceArtifact) => number | undefined,
): PairedHoldout {
  const baseline = artifactValues(result, baselineId, select)
  const winner = artifactValues(result, winnerId, select)
  const keys = [...baseline.keys()].filter((key) => winner.has(key)).sort()
  return {
    before: keys.map((key) => baseline.get(key)!),
    after: keys.map((key) => winner.get(key)!),
    cellIds: keys,
  }
}

function artifactValues(
  result: RunAgentMemoryExperimentResult,
  candidateId: string,
  select: (artifact: AgentMemorySequenceArtifact) => number | undefined,
): Map<string, number> {
  const values = new Map<string, number>()
  for (const cell of result.campaign.cells) {
    if (cell.error || cell.artifact.candidateId !== candidateId) continue
    const value = select(cell.artifact)
    if (value === undefined || !Number.isFinite(value)) continue
    values.set(`${cell.artifact.sequenceId}:${cell.rep}`, value)
  }
  return values
}

export function sequenceScores(
  result: RunAgentMemoryExperimentResult,
  sequences: readonly AgentMemorySequence[],
  candidateId: string,
): number[] {
  const bySequence = new Map<string, number[]>()
  for (const cell of result.campaign.cells) {
    if (cell.error || cell.artifact.candidateId !== candidateId) continue
    const bucket = bySequence.get(cell.artifact.sequenceId) ?? []
    bucket.push(cell.artifact.score)
    bySequence.set(cell.artifact.sequenceId, bucket)
  }
  return sequences.map((sequence) => mean(bySequence.get(sequence.id) ?? []))
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}
