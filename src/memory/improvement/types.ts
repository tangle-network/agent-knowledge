import type {
  CampaignStorage,
  HeldoutSignificance,
  HeldoutSignificanceOptions,
  JsonValue,
  OptimizationMethod,
  OptimizationMethodRunOptions,
  Scenario,
} from '@tangle-network/agent-eval/campaign'
import type { RunSerializedKnowledgeOptimizationResult } from '../../optimization'
import type {
  AgentMemoryExperimentCandidate,
  AgentMemorySequence,
  AgentMemorySequenceArtifact,
  RunAgentMemoryExperimentOptions,
} from '../experiment'
import type {
  AgentMemoryAcquireRunLease,
  AgentMemoryControllerMode,
  AgentMemoryRunLease,
  OwnedAgentMemoryRunLease,
} from '../run-control'

export interface AgentMemoryDimensionComparison {
  dimension: string
  n: number
  expectedN: number
  measured: boolean
  meanDelta: number
  low: number
  high: number
  tolerance: number
  regressed: boolean
}

export interface AgentMemoryPromotionDecision {
  status: 'promote' | 'hold' | 'no-change'
  reasons: readonly string[]
  baselineScore: number
  winnerScore: number
  lift: number
  significance?: HeldoutSignificance
  criticalDimensions: readonly AgentMemoryDimensionComparison[]
}

export interface AgentMemoryFinalPair {
  sequenceId: string
  rep: number
  baseline: AgentMemorySequenceArtifact
  winner: AgentMemorySequenceArtifact
}

export interface AgentMemoryFinalEvaluation {
  manifestHash: string
  pairs: readonly AgentMemoryFinalPair[]
}

export interface AgentMemoryActivation {
  id: string
  status:
    | 'not-eligible'
    | 'not-configured'
    | 'pending'
    | 'activated'
    | 'recovered'
    | 'already-activated'
  journalPath: string
}

export interface AgentMemoryActivationDriver<TConfig extends JsonValue> {
  /** Change whenever activation behavior or the external target changes. */
  ref: string
  /** Return the exact currently active configuration. */
  readCurrent(): Promise<TConfig>
  /** Atomically replace expectedConfig with config, or fail on a concurrent change. */
  compareAndSet(input: {
    activationId: string
    expectedConfig: TConfig
    expectedSurfaceHash: string
    config: TConfig
    surfaceHash: string
    decision: AgentMemoryPromotionDecision
    optimization: RunSerializedKnowledgeOptimizationResult<TConfig>
    finalEvaluation: AgentMemoryFinalEvaluation
  }): Promise<void>
}

export interface AgentMemoryActivationEvent {
  status: 'prepared' | 'activated'
  activationId: string
  experimentId: string
  activationRef: string
  baselineSurfaceHash: string
  winnerSurfaceHash: string
  finalEvaluationHash: string
  recordedAt: string
  outcome?: 'applied' | 'recovered' | 'already-current'
}

export interface AgentMemoryActivationJournalState {
  prepared: boolean
  activated?: AgentMemoryActivationEvent
}

export type AgentMemoryImprovementRunLease = AgentMemoryRunLease

export type AgentMemoryImprovementCandidate = Omit<
  AgentMemoryExperimentCandidate,
  | 'id'
  | 'externalCostUsdPerSequence'
  | 'externalRecoveryCostUsdPerAttempt'
  | 'externalCostAccounting'
> &
  Required<
    Pick<
      AgentMemoryExperimentCandidate,
      'externalCostUsdPerSequence' | 'externalRecoveryCostUsdPerAttempt'
    >
  > & {
    externalCostAccounting: 'exact'
  }

export interface RunAgentMemoryImprovementOptions<TConfig extends JsonValue> {
  experimentId: string
  baselineConfig: TConfig
  method: OptimizationMethod<MemoryConfigScenario, AgentMemorySequenceArtifact>
  trainSequences: readonly AgentMemorySequence[]
  selectionSequences: readonly AgentMemorySequence[]
  finalSequences: readonly AgentMemorySequence[]
  createCandidate(input: {
    config: TConfig
    candidateId: string
    surfaceHash: string
  }): AgentMemoryImprovementCandidate | Promise<AgentMemoryImprovementCandidate>
  /** Commit or content identity for method config, candidate construction, and execution. */
  improvementRef: string
  runDir: string
  repo?: string
  storage?: CampaignStorage
  /** Required with custom storage when all controllers are confined to one process. */
  controllerMode?: AgentMemoryControllerMode
  /** Required for distributed controllers using custom storage. */
  acquireRunLease?: AgentMemoryAcquireRunLease
  seed?: number
  reps?: number
  resumable?: boolean
  sequenceConcurrency?: number
  dispatchTimeoutMs?: number
  cleanupTimeoutMs?: number
  maxRecoveryAttempts?: number
  maxRecoveryRetriesPerAttempt?: number
  /** Method search spend limit. */
  maxOptimizationCostUsd?: number
  /** Final comparison spend limit. */
  maxFinalCostUsd?: number
  /** Enforced maximum for one config and one sequence. Required with either spend limit. */
  maximumEvaluationCostUsd?: number
  /** Allow activation when a method cannot fully account for cost. Default false. */
  allowIncompleteCostAccounting?: boolean
  optimizationRunOptions?: OptimizationMethodRunOptions<
    MemoryConfigScenario,
    AgentMemorySequenceArtifact
  >
  executeStep?: RunAgentMemoryExperimentOptions['executeStep']
  executeStepRef?: string
  onBranchSnapshot?: RunAgentMemoryExperimentOptions['onBranchSnapshot']
  cleanupBranches?: boolean
  serializeConfig?: (config: TConfig) => string
  parseConfig?: (surface: string) => TConfig
  significance?: HeldoutSignificanceOptions
  criticalDimensions?: readonly string[]
  criticalDimensionTolerance?: number
  minFinalScore?: number
  activation?: AgentMemoryActivationDriver<TConfig>
  activationTimeoutMs?: number
  now?: () => Date
}

export interface RunAgentMemoryImprovementResult<TConfig extends JsonValue> {
  optimization: RunSerializedKnowledgeOptimizationResult<TConfig>
  baselineConfig: TConfig
  winnerConfig: TConfig
  baselineSurface: string
  winnerSurface: string
  baselineSurfaceHash: string
  winnerSurfaceHash: string
  decision: AgentMemoryPromotionDecision
  finalEvaluation: AgentMemoryFinalEvaluation
  activation: AgentMemoryActivation
  totalCostUsd: number
  resultJsonPath: string
}

export interface MemoryConfigScenario extends Scenario {
  kind: 'agent-memory-config-search'
  sequenceId: string
  sequence: AgentMemorySequence
}

export const DEFAULT_CRITICAL_DIMENSIONS = [
  'memory_stale_safe',
  'memory_actor_recall',
  'memory_event_recall',
] as const

export type OwnedRunLease = OwnedAgentMemoryRunLease
