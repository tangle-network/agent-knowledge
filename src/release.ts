import {
  evaluateReleaseConfidence,
  releaseTraceEvidenceFromMultiShotTrials,
  validateRunRecord,
  type MultiShotOptimizationResult,
  type MultiShotTrialResult,
  type RunRecord,
  type ReleaseConfidenceScorecard,
} from '@tangle-network/agent-eval'
import type { KnowledgeBaseCandidate, KnowledgeRelease } from './types'
import { stableId } from './ids'

export interface KnowledgeReleaseReport {
  release: KnowledgeRelease
  scorecard: ReleaseConfidenceScorecard
  candidateRuns: RunRecord[]
  baselineRuns: RunRecord[]
}

export function knowledgeReleaseReportFromOptimization(
  result: MultiShotOptimizationResult<KnowledgeBaseCandidate>,
  options: {
    runRecords?: RunRecord[]
    createdAt?: string
    minScore?: number
  } = {},
): KnowledgeReleaseReport {
  const trials = result.evolution.generations.flatMap((generation) => generation.trials) as MultiShotTrialResult[]
  const traceEvidence = releaseTraceEvidenceFromMultiShotTrials(trials)
  const runRecords = (options.runRecords ?? [
    ...(result.gate?.candidateRuns ?? []),
    ...(result.gate?.baselineRuns ?? []),
  ]).map(validateRunRecord)
  const scorecard = evaluateReleaseConfidence({
    target: 'agent-knowledge-base',
    candidateId: result.promotedVariant.id,
    baselineId: 'baseline',
    traces: traceEvidence,
    runs: runRecords,
    gateDecision: result.gate?.decision ?? null,
    thresholds: {
      requireCorpus: false,
      requireHoldout: Boolean(result.gate),
      minHoldoutRuns: result.gate ? 1 : 0,
      minSearchRuns: 1,
      minMeanScore: options.minScore ?? 0.7,
    },
  })
  const release: KnowledgeRelease = {
    id: stableId('krel', `${result.promotedVariant.id}:${options.createdAt ?? new Date().toISOString()}`),
    candidateId: result.promotedVariant.id,
    createdAt: options.createdAt ?? new Date().toISOString(),
    promoted: scorecard.status !== 'fail' && result.promotedVariant.id === result.searchBestVariant.id,
    scorecard,
    runRecordIds: runRecords.map((record) => record.runId),
  }
  return {
    release,
    scorecard,
    candidateRuns: result.gate?.candidateRuns ?? [],
    baselineRuns: result.gate?.baselineRuns ?? [],
  }
}
