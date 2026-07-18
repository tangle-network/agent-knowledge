import {
  type DatasetScenario,
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
 * Build a knowledge release report from candidate and baseline run records,
 * optional trace evidence, and an optional decision record.
 */
export interface KnowledgeReleaseInput {
  candidateId: string
  baselineId?: string
  candidateRuns: RunRecord[]
  baselineRuns?: RunRecord[]
  traces?: ReleaseTraceEvidence[]
  gateDecision?: GateDecision | null
  /** Scenario corpus used to prove train and holdout split coverage. */
  scenarios?: readonly DatasetScenario[]
  /**
   * Require both a holdout scenario and a holdout run.
   * Provide `scenarios` with at least one `split: 'holdout'` item when true.
   */
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
    scenarios: input.scenarios,
    gateDecision: input.gateDecision ?? null,
    thresholds: {
      requireCorpus: false,
      // This report has run records but no scenario corpus, so it cannot require
      // a positive scenario count.
      minScenarioCount: 0,
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
