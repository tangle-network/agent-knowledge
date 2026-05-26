import {
  evaluateReleaseConfidence,
  type GateDecision,
  type ReleaseConfidenceScorecard,
  type ReleaseTraceEvidence,
  type RunRecord,
  validateRunRecord,
} from '@tangle-network/agent-eval'
import { stableId } from './ids'
import type { KnowledgeRelease } from './types'

export interface KnowledgeReleaseReport {
  release: KnowledgeRelease
  scorecard: ReleaseConfidenceScorecard
  candidateRuns: RunRecord[]
  baselineRuns: RunRecord[]
}

/**
 * Campaign-native release report. The caller (a consumer's KB self-improvement
 * loop) supplies the candidate/baseline `RunRecord[]` (e.g. via
 * `campaignToRunRecords`) + optional per-instance `ReleaseTraceEvidence` + the
 * gate decision; this folds them into a `ReleaseConfidenceScorecard` + a
 * `KnowledgeRelease`. Decoupled from any optimizer result shape — agent-eval's
 * legacy multi-shot orchestration (and its `MultiShotOptimizationResult`) was
 * removed in 0.42; release confidence is computed from records + traces.
 */
export interface KnowledgeReleaseInput {
  candidateId: string
  baselineId?: string
  candidateRuns: RunRecord[]
  baselineRuns?: RunRecord[]
  traces?: ReleaseTraceEvidence[]
  gateDecision?: GateDecision | null
  /** True when a held-out split was evaluated (drives the holdout threshold). */
  hasHoldout?: boolean
  /** Candidate is the search-best variant — a promotion precondition. Default true. */
  promotedIsBest?: boolean
  createdAt?: string
  minScore?: number
}

export function knowledgeReleaseReport(input: KnowledgeReleaseInput): KnowledgeReleaseReport {
  const baselineRuns = input.baselineRuns ?? []
  const runRecords = [...input.candidateRuns, ...baselineRuns].map(validateRunRecord)
  const scorecard = evaluateReleaseConfidence({
    target: 'agent-knowledge-base',
    candidateId: input.candidateId,
    baselineId: input.baselineId ?? 'baseline',
    traces: input.traces ?? [],
    runs: runRecords,
    gateDecision: input.gateDecision ?? null,
    thresholds: {
      requireCorpus: false,
      requireHoldout: input.hasHoldout ?? false,
      minHoldoutRuns: input.hasHoldout ? 1 : 0,
      minSearchRuns: 1,
      minMeanScore: input.minScore ?? 0.7,
    },
  })
  const release: KnowledgeRelease = {
    id: stableId('krel', `${input.candidateId}:${input.createdAt ?? new Date().toISOString()}`),
    candidateId: input.candidateId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    promoted: scorecard.status !== 'fail' && (input.promotedIsBest ?? true),
    scorecard,
    runRecordIds: runRecords.map((record) => record.runId),
  }
  return { release, scorecard, candidateRuns: input.candidateRuns, baselineRuns }
}
