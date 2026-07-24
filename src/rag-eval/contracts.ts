import type { JudgeConfig, Scenario } from '@tangle-network/agent-eval/campaign'
import type { AgentCandidateJsonValue as JsonValue } from '@tangle-network/agent-interface'
import type { RagGapFinding } from '../rag-improvement-loop'

export type RagEvalProvider =
  | 'agent-knowledge'
  | 'ragas'
  | 'deepeval'
  | 'trulens'
  | 'ragchecker'
  | 'custom'

export type RagEvalMetricKey =
  | 'context_precision'
  | 'context_recall'
  | 'context_relevance'
  | 'context_sufficiency'
  | 'faithfulness'
  | 'groundedness'
  | 'answer_relevance'
  | 'answer_correctness'
  | 'citation_support'
  | 'abstention'
  | 'unsupported_answer_rate'

export type RagEvalSlice =
  | 'known-answer'
  | 'paraphrase'
  | 'distractor'
  | 'freshness'
  | 'multi-source'
  | 'unanswerable'
  | 'long-tail'
  | 'custom'

export interface RagEvalContext {
  id: string
  text: string
  rank?: number
  pageId?: string
  sourceId?: string
  anchorId?: string
  stale?: boolean
  metadata?: Record<string, JsonValue>
}

export interface RagEvalCitation {
  id: string
  claimId?: string
  contextId?: string
  pageId?: string
  sourceId?: string
  anchorId?: string
  quote?: string
  metadata?: Record<string, JsonValue>
}

export interface RagEvalClaim {
  id: string
  text: string
  citationIds?: readonly string[]
  metadata?: Record<string, JsonValue>
}

export interface RagRequiredContext {
  id?: string
  text?: string
  pageId?: string
  sourceId?: string
  anchorId?: string
}

export interface RagAnswerEvalScenario extends Scenario {
  kind: 'rag-answer-eval'
  query: string
  referenceAnswer?: string
  expectedClaims?: readonly string[]
  forbiddenClaims?: readonly string[]
  requiredContext?: readonly RagRequiredContext[]
  unanswerable?: boolean
  requireCitations?: boolean
  slices?: readonly RagEvalSlice[]
  thresholds?: Partial<Record<RagEvalMetricKey, number>>
}

export interface ExternalRagEvalScore {
  provider: RagEvalProvider | string
  scores: Record<string, number>
  reasons?: Record<string, string>
  metadata?: Record<string, JsonValue>
}

export interface RagAnswerEvalArtifact {
  query: string
  answer: string
  contexts: readonly RagEvalContext[]
  claims?: readonly RagEvalClaim[]
  citations?: readonly RagEvalCitation[]
  abstained?: boolean
  durationMs?: number
  costUsd?: number
  externalScores?: readonly ExternalRagEvalScore[]
  metadata?: Record<string, JsonValue>
}

export interface RagAnswerMetricSummary {
  metrics: Record<RagEvalMetricKey, number>
  composite: number
  passed: boolean
  findings: readonly RagGapFinding[]
  claimCount: number
  supportedClaimCount: number
  citedClaimCount: number
  supportedCitationCount: number
  matchedRequiredContextCount: number
  requiredContextCount: number
  providerScores: Record<string, Record<RagEvalMetricKey, number>>
}

export interface RagAnswerQualityJudgeOptions {
  name?: string
  thresholds?: Partial<Record<RagEvalMetricKey, number>>
  weights?: Partial<Record<RagEvalMetricKey, number>>
  externalScorePolicy?: 'prefer-external' | 'deterministic-first'
  minClaimSupport?: number
}

export interface RagAnswerEvalCase {
  scenario: RagAnswerEvalScenario
  artifact: RagAnswerEvalArtifact
}

export interface RagAnswerQualityHookOptions {
  scenarios: readonly RagAnswerEvalScenario[]
  run: (scenario: RagAnswerEvalScenario) => MaybePromise<RagAnswerEvalArtifact>
  externalEvaluator?: (
    item: RagAnswerEvalCase,
  ) => MaybePromise<ExternalRagEvalScore | readonly ExternalRagEvalScore[] | undefined>
  thresholds?: Partial<Record<RagEvalMetricKey, number>>
  weights?: Partial<Record<RagEvalMetricKey, number>>
}

export interface RagCalibrationOptions {
  scenario: RagAnswerEvalScenario
  strong: RagAnswerEvalArtifact
  weak: RagAnswerEvalArtifact
  judge?: JudgeConfig<RagAnswerEvalArtifact, RagAnswerEvalScenario>
  minStrongScore?: number
  maxWeakScore?: number
  signal?: AbortSignal
}

export interface RagCalibrationResult {
  passed: boolean
  strongScore: number
  weakScore: number
  gap: number
}

export interface KnowledgeBaseQualityOptions {
  now?: Date
  strict?: boolean
  minCitationRate?: number
  maxStaleSourceRate?: number
}

export interface KnowledgeBaseQualityReport {
  ok: boolean
  metrics: {
    page_count: number
    source_count: number
    citation_rate: number
    source_backed_page_rate: number
    stale_source_rate: number
    duplicate_source_hash_rate: number
    lint_error_count: number
    lint_warning_count: number
  }
  findings: readonly RagGapFinding[]
}

type MaybePromise<T> = T | Promise<T>
