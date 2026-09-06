import type { ComparisonCost } from '@tangle-network/agent-eval/campaign'
import type { AgentCandidateJsonValue as JsonValue } from '@tangle-network/agent-interface'
import { runRagKnowledgeImprovementPhases } from './rag-improvement-phases'
import type { RunRagOptimizationOptions, RunRagOptimizationResult } from './rag-optimization'
import type {
  KnowledgeResearchLoopDecision,
  KnowledgeResearchLoopResult,
  RunKnowledgeResearchLoopOptions,
} from './research-loop'
import type {
  RunRetrievalImprovementLoopOptions,
  RunRetrievalImprovementLoopResult,
} from './retrieval-optimization'

export type RagKnowledgeImprovementPhase =
  | 'rag-optimization'
  | 'retrieval-tuning'
  | 'gap-diagnosis'
  | 'knowledge-acquisition'
  | 'knowledge-update'
  | 'answer-quality'
  | 'promotion'

export type RagKnowledgeImprovementPhaseStatus = 'completed' | 'skipped' | 'failed'

export type RagGapKind =
  | 'missing-source'
  | 'stale-source'
  | 'retrieval-miss'
  | 'retrieval-noise'
  | 'chunking-mismatch'
  | 'missing-multihop-evidence'
  | 'generator-unsupported-claim'
  | 'citation-mismatch'
  | 'incorrect-abstention'
  | 'unknown'

export type RagGapSeverity = 'info' | 'warning' | 'error' | 'critical'

export interface RagGapFinding {
  id: string
  kind: RagGapKind
  severity: RagGapSeverity
  message: string
  scenarioId?: string
  evidence?: Record<string, JsonValue>
}

export interface RagKnowledgeImprovementPhaseResult {
  phase: RagKnowledgeImprovementPhase
  status: RagKnowledgeImprovementPhaseStatus
  summary: string
  startedAt: string
  finishedAt: string
  metadata?: Record<string, JsonValue>
}

export type RagOptimizationSelection = Pick<
  RunRagOptimizationResult,
  'methodName' | 'baseline' | 'winner' | 'baselineConfig' | 'winnerConfig'
>

export type RetrievalOptimizationSelection = Pick<
  RunRetrievalImprovementLoopResult,
  'methodName' | 'baseline' | 'winner' | 'baselineConfig' | 'winnerConfig'
>

export interface RagPhaseInputBase {
  goal: string
  phases: readonly RagKnowledgeImprovementPhaseResult[]
  /** Selected candidate only. Adaptive update callbacks run before final scoring starts. */
  optimization?: RagOptimizationSelection
  signal?: AbortSignal
}

export interface RagDiagnosisInput extends RagPhaseInputBase {
  retrieval?: RetrievalOptimizationSelection
}

export interface RagKnowledgeAcquisitionInput extends RagPhaseInputBase {
  retrieval?: RetrievalOptimizationSelection
  findings: readonly RagGapFinding[]
}

export interface RagKnowledgeUpdateInput extends RagPhaseInputBase {
  retrieval?: RetrievalOptimizationSelection
  findings: readonly RagGapFinding[]
  acquisition?: KnowledgeResearchLoopDecision
}

export interface RagKnowledgeUpdateResult {
  applied: boolean
  summary: string
  research?: KnowledgeResearchLoopResult
  metadata?: Record<string, JsonValue>
}

export interface RagAnswerQualityInput extends RagPhaseInputBase {
  retrieval?: RetrievalOptimizationSelection
  findings: readonly RagGapFinding[]
  acquisition?: KnowledgeResearchLoopDecision
  knowledgeUpdate?: RagKnowledgeUpdateResult
}

export interface RagAnswerQualityResult {
  passed: boolean
  metrics: Record<string, number>
  finalScenarioIds: readonly string[]
  datasetRef: string
  evaluatorRef: string
  cost: ComparisonCost
  findings?: readonly RagGapFinding[]
  metadata?: Record<string, JsonValue>
}

export interface RagPromotionInput extends RagPhaseInputBase {
  retrieval?: RetrievalOptimizationSelection
  /** Full final-case result available only to the terminal promotion decision. */
  optimizationComparison?: RunRagOptimizationResult['comparison']
  /** Full final-case result available only to the terminal promotion decision. */
  retrievalComparison?: RunRetrievalImprovementLoopResult['comparison']
  findings: readonly RagGapFinding[]
  acquisition?: KnowledgeResearchLoopDecision
  knowledgeUpdate?: RagKnowledgeUpdateResult
  answerQuality?: RagAnswerQualityResult
}

export interface RagPromotionResult {
  promoted: boolean
  reason: string
  metadata?: Record<string, JsonValue>
}

export interface RagKnowledgeResearchOptions
  extends Omit<RunKnowledgeResearchLoopOptions, 'goal' | 'signal' | 'step'> {
  goal?: string
  step?: RunKnowledgeResearchLoopOptions['step']
}

export interface RunRagKnowledgeImprovementLoopOptions {
  goal: string
  optimization?: RunRagOptimizationOptions
  retrieval?: RunRetrievalImprovementLoopOptions
  diagnose?: (input: RagDiagnosisInput) => MaybePromise<readonly RagGapFinding[]>
  acquireKnowledge?: (
    input: RagKnowledgeAcquisitionInput,
  ) => MaybePromise<KnowledgeResearchLoopDecision>
  knowledgeResearch?: RagKnowledgeResearchOptions
  updateKnowledge?: (input: RagKnowledgeUpdateInput) => MaybePromise<RagKnowledgeUpdateResult>
  evaluateAnswers?: (input: RagAnswerQualityInput) => MaybePromise<RagAnswerQualityResult>
  /** Maximum total answer-evaluation spend accepted for promotion. */
  answerQualityCostCeiling?: number
  /**
   * Makes a side-effect-free promotion decision after the library has rejected
   * missing, regressing, unaccounted, or over-budget final evidence.
   */
  decidePromotion?: (input: RagPromotionInput) => MaybePromise<RagPromotionResult>
  enabledPhases?: readonly RagKnowledgeImprovementPhase[]
  requiredPhases?: readonly RagKnowledgeImprovementPhase[]
  signal?: AbortSignal
  now?: () => Date
}

export interface RunRagKnowledgeImprovementLoopResult {
  goal: string
  phases: readonly RagKnowledgeImprovementPhaseResult[]
  optimization?: RunRagOptimizationResult
  retrieval?: RunRetrievalImprovementLoopResult
  findings: readonly RagGapFinding[]
  acquisition?: KnowledgeResearchLoopDecision
  knowledgeUpdate?: RagKnowledgeUpdateResult
  answerQuality?: RagAnswerQualityResult
  promotion?: RagPromotionResult
}

type MaybePromise<T> = T | Promise<T>

export async function runRagKnowledgeImprovementLoop(
  options: RunRagKnowledgeImprovementLoopOptions,
): Promise<RunRagKnowledgeImprovementLoopResult> {
  return runRagKnowledgeImprovementPhases(options)
}
