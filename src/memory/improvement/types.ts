import type {
  CampaignStorage,
  CostLedgerHandle,
  GovernorContext,
  GovernorOp,
  HeldoutSignificance,
  HeldoutSignificanceOptions,
  Lineage,
  LineageStore,
  Scenario,
  SurfaceProposer,
} from '@tangle-network/agent-eval/campaign'
import type {
  AgentMemoryExperimentCandidate,
  AgentMemorySequence,
  RunAgentMemoryExperimentOptions,
  RunAgentMemoryExperimentResult,
} from '../experiment'
import type {
  AgentMemoryAcquireRunLease,
  AgentMemoryControllerMode,
  AgentMemoryRunLease,
  OwnedAgentMemoryRunLease,
} from '../run-control'

export interface AgentMemoryImprovementSeed<TConfig> {
  config: TConfig
  track: string
  vision?: string
  proposer: string
}

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

export interface AgentMemoryActivationDriver<TConfig> {
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
    lineage: Lineage
    holdout: RunAgentMemoryExperimentResult
  }): Promise<void>
}

export interface AgentMemoryActivationEvent {
  schema: 1
  status: 'prepared' | 'activated'
  activationId: string
  experimentId: string
  activationRef: string
  baselineSurfaceHash: string
  winnerSurfaceHash: string
  holdoutManifestHash: string
  recordedAt: string
  outcome?: 'applied' | 'recovered' | 'already-current'
}

export interface AgentMemoryActivationJournalState {
  prepared: boolean
  activated?: AgentMemoryActivationEvent
}

export type AgentMemoryImprovementRunLease = AgentMemoryRunLease

export interface AgentMemoryGovernor {
  decide(
    context: GovernorContext & {
      costLedger: CostLedgerHandle
      costPhase: string
    },
  ): GovernorOp | Promise<GovernorOp>
}

export interface RunAgentMemoryImprovementOptions<TConfig> {
  experimentId: string
  trainSequences: readonly AgentMemorySequence[]
  holdoutSequences: readonly AgentMemorySequence[]
  /** First entry is the current baseline; remaining entries seed independent search tracks. */
  seeds: readonly AgentMemoryImprovementSeed<TConfig>[]
  createCandidate(input: {
    config: TConfig
    candidateId: string
    surfaceHash: string
  }):
    | Omit<AgentMemoryExperimentCandidate, 'id'>
    | Promise<Omit<AgentMemoryExperimentCandidate, 'id'>>
  proposer: SurfaceProposer
  /** Optional proposer implementations keyed by seed and branch proposer labels. */
  proposers?: Readonly<Record<string, SurfaceProposer>>
  /** Stable version or commit for the candidate factory, proposer, and governor. */
  improvementRef: string
  governor?: AgentMemoryGovernor
  budget: { maxSteps: number }
  populationSize?: number
  candidateConcurrency?: number
  sequenceConcurrency?: number
  runDir: string
  repo?: string
  storage?: CampaignStorage
  lineageStore?: LineageStore
  /** Required with custom storage when all controllers are confined to one process. */
  controllerMode?: AgentMemoryControllerMode
  /** Required for distributed controllers using custom storage. Worker concurrency is independent. */
  acquireRunLease?: AgentMemoryAcquireRunLease
  seed?: number
  reps?: number
  resumable?: boolean
  dispatchTimeoutMs?: number
  cleanupTimeoutMs?: number
  maxRecoveryAttempts?: number
  maxRecoveryRetriesPerAttempt?: number
  maxTotalCostUsd?: number
  executeStep?: RunAgentMemoryExperimentOptions['executeStep']
  executeStepRef?: string
  onBranchSnapshot?: RunAgentMemoryExperimentOptions['onBranchSnapshot']
  cleanupBranches?: boolean
  serializeConfig?: (config: TConfig) => string
  parseConfig?: (surface: string) => TConfig
  significance?: HeldoutSignificanceOptions
  criticalDimensions?: readonly string[]
  criticalDimensionTolerance?: number
  minHoldoutScore?: number
  activation?: AgentMemoryActivationDriver<TConfig>
  activationTimeoutMs?: number
  now?: () => Date
}

export interface RunAgentMemoryImprovementResult<TConfig> {
  lineage: Lineage
  baselineConfig: TConfig
  winnerConfig: TConfig
  baselineSurface: string
  winnerSurface: string
  baselineSurfaceHash: string
  winnerSurfaceHash: string
  decision: AgentMemoryPromotionDecision
  activation: AgentMemoryActivation
  holdout?: RunAgentMemoryExperimentResult
  totalCostUsd: number
  resultJsonPath: string
}

export interface MemoryConfigScenario extends Scenario {
  kind: 'agent-memory-config-search'
  sequenceId: string
}

export const DEFAULT_CRITICAL_DIMENSIONS = [
  'memory_stale_safe',
  'memory_actor_recall',
  'memory_event_recall',
] as const

export const MEMORY_IMPROVEMENT_IMPLEMENTATION_REF = 'agent-knowledge:memory-improvement:v2'

export type OwnedRunLease = OwnedAgentMemoryRunLease
