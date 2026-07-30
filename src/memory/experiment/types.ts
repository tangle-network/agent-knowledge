import type {
  CostChannel,
  CostReceipt,
  PairedBootstrapResult,
  RunPaidCallInput,
} from '@tangle-network/agent-eval'
import type {
  CampaignResult,
  CampaignStorage,
  CostLedgerHandle,
  Scenario,
} from '@tangle-network/agent-eval/campaign'
import type {
  KnowledgeBenchmarkFamily,
  KnowledgeBenchmarkSplit,
  KnowledgeMemoryBenchmarkCase,
  KnowledgeMemoryBenchmarkTaskKind,
  KnowledgeMemoryEvent,
  KnowledgeMemoryFactMatcher,
} from '../../benchmarks/index'
import type {
  AgentMemoryBranch,
  AgentMemoryBranchSnapshot,
  AgentMemorySharingPolicy,
} from '../branch'
import type {
  AgentMemoryAcquireRunLease,
  AgentMemoryControllerMode,
  AgentMemoryRunLease,
  OwnedAgentMemoryRunLease,
} from '../run-control'
import type { AgentMemoryAdapter, AgentMemoryScope, AgentMemoryWriteInput } from '../types'

export type AgentMemoryMode = 'stateful' | 'stateless'
export type AgentMemoryLearningArmOrder = 'stateful-first' | 'stateless-first'
export type AgentMemoryExperimentComparisonRef = `sha256:${string}`
export type AgentMemoryEvidenceRef = `sha256:${string}`

export interface AgentMemoryExperimentCandidateRef {
  id: string
  ref: string
}

export interface AgentMemorySequenceProbe {
  id: string
  /** Stable identity shared by exact repeated measurements of one retention target. */
  retentionKey?: string
  /** Explicitly marks a later-step probe as measuring transfer from prior steps. */
  transferKey?: string
  query: string
  scope?: AgentMemoryScope
  limit?: number
  taskKind?: KnowledgeMemoryBenchmarkTaskKind
  requiredFacts?: readonly KnowledgeMemoryFactMatcher[]
  forbiddenFacts?: readonly KnowledgeMemoryFactMatcher[]
  expectedEventIds?: readonly string[]
  expectedActorIds?: readonly string[]
  referenceAnswer?: string
}

export interface AgentMemorySequenceStep {
  id: string
  instruction?: string
  scope?: AgentMemoryScope
  writes?: readonly AgentMemoryWriteInput[]
  parallelWrites?: boolean
  probes?: readonly AgentMemorySequenceProbe[]
  parallelProbes?: boolean
  metadata?: Record<string, unknown>
}

/** Runtime-visible step fields. Evaluation labels and dataset identity are excluded. */
export interface AgentMemoryExecutionStep {
  ordinal: number
  instruction?: string
  scope?: AgentMemoryScope
}

export type AgentMemoryExecutionPaidCallInput<T> = Omit<
  RunPaidCallInput<T>,
  'channel' | 'phase' | 'tags' | 'signal'
> & {
  channel?: CostChannel
}

export type AgentMemoryExecutionCostReceipt = Omit<CostReceipt, 'phase' | 'tags'>

export type AgentMemoryExecutionPaidCallResult<T> =
  | {
      succeeded: true
      callId: string
      value: T
      receipt: AgentMemoryExecutionCostReceipt
    }
  | {
      succeeded: false
      callId?: string
      error: Error
      receipt?: AgentMemoryExecutionCostReceipt
    }

export interface AgentMemoryExecutionCostMeter {
  runPaidCall<T>(
    input: AgentMemoryExecutionPaidCallInput<T>,
  ): Promise<AgentMemoryExecutionPaidCallResult<T>>
}

/** Execution capabilities with all campaign and evaluation identity removed. */
export interface AgentMemoryExecutionContext {
  readonly signal: AbortSignal
  readonly cost: AgentMemoryExecutionCostMeter
}

export interface AgentMemorySequence {
  id: string
  family: KnowledgeBenchmarkFamily | string
  split?: KnowledgeBenchmarkSplit
  steps: readonly AgentMemorySequenceStep[]
  /** Exact scopes a runtime callback may write beyond scopes declared by steps. */
  cleanupScopes?: readonly AgentMemoryScope[]
  tags?: readonly string[]
  metadata?: Record<string, unknown>
}

export interface BuildAgentMemorySequencesFromBenchmarkCasesOptions {
  memoryAgentId?: string
  eventScope?: (input: {
    event: KnowledgeMemoryEvent
    case: KnowledgeMemoryBenchmarkCase
    eventIndex: number
  }) => AgentMemoryScope
  probeScope?: (testCase: KnowledgeMemoryBenchmarkCase) => AgentMemoryScope
}

export interface AgentMemoryExperimentCandidate {
  id: string
  label?: string
  /** Change when provider configuration changes so cached cells cannot be reused. */
  ref: string
  /** Local construction is free; call markExternalCall before billable provisioning or reconnects. */
  createAdapter(input: {
    branchId: string
    purpose: 'execute' | 'recovery'
    signal: AbortSignal
    /** Maximum the adapter must enforce with its provider before external work. */
    maximumCostUsd: number
    markExternalCall(): void
    /** Record each observed provider charge. Required for complete positive-cost accounting. */
    recordExternalCost(actualCostUsd: number): void
  }): AgentMemoryAdapter | null | Promise<AgentMemoryAdapter | null>
  policy?: AgentMemorySharingPolicy
  baseScope?: AgentMemoryScope
  /** Maximum the adapter must enforce for one complete history. Zero declares a free path. */
  externalCostUsdPerSequence?: number
  /** Maximum the adapter must enforce for one recovery attempt. Zero declares free recovery. */
  externalRecoveryCostUsdPerAttempt?: number
  /** Requires observed provider receipts for positive external charges. */
  externalCostAccounting?: 'exact'
  /** Release resources and, when cleanupBranches is false, delete the isolated state. */
  disposeAdapter?(adapter: AgentMemoryAdapter): Promise<void>
}

export interface AgentMemorySequenceProbeResult {
  id: string
  stepId: string
  stepOrdinal: number
  retentionKey?: string
  transferKey?: string
  query: string
  score: number
  passed: boolean
  dimensions: Record<string, number>
  applicableDimensions: readonly string[]
  notes: string
  hitIds: readonly string[]
  /** Exact scoring input, saved under the cell artifact directory. */
  evidenceRef: AgentMemoryEvidenceRef
  evidencePath: string
}

export interface AgentMemorySequenceArtifact {
  candidateId: string
  sequenceId: string
  memoryMode: AgentMemoryMode
  comparisonRef: AgentMemoryExperimentComparisonRef
  score: number
  passed: boolean
  dimensions: Record<string, number>
  dimensionSampleCounts: Record<string, number>
  probes: readonly AgentMemorySequenceProbeResult[]
  branchDigest: string
  journalEntries: number
  durationMs: number
}

export interface AgentMemorySequenceScenario extends Scenario {
  kind: 'agent-memory-sequence'
  candidateId: string
  sequenceId: string
  sequence: AgentMemorySequence
  seedGroup: string
}

export interface AgentMemoryExperimentRankingRow {
  rank: number
  candidateId: string
  label: string
  scoreMean: number
  passRate: number
  totalSequences: number
  totalCells: number
  totalProbes: number
  cellsFailed: number
  totalCostUsd: number
  durationMs: number
  dimensions: Record<string, number>
}

export interface AgentMemoryLearningCellComparison {
  cellId: string
  candidateId: string
  sequenceId: string
  rep: number
  seed: number
  statefulArtifactRef: AgentMemoryEvidenceRef
  statelessArtifactRef: AgentMemoryEvidenceRef
  /** Probes after the first step used for this contrast. */
  probeCount: number
  statefulReward: number
  statelessReward: number
  gain: number
}

export interface AgentMemoryLearningCandidateSummary {
  candidateId: string
  cells: number
  /** One value per independent sequence after averaging repetitions. */
  gain: PairedBootstrapResult
}

export interface AgentMemoryTransferCellComparison {
  cellId: string
  candidateId: string
  sequenceId: string
  rep: number
  seed: number
  stepId: string
  stepOrdinal: number
  transferKey: string
  probeCount: number
  statefulArtifactRef: AgentMemoryEvidenceRef
  statelessArtifactRef: AgentMemoryEvidenceRef
  statefulReward: number
  statelessReward: number
  gain: number
}

export interface AgentMemoryTransferStepSummary {
  candidateId: string
  transferKey: string
  stepOrdinal: number
  /** Stateful minus stateless transfer reward, one pair per independent sequence. */
  gain: PairedBootstrapResult
}

export interface AgentMemoryForgettingComparison {
  cellId: string
  candidateId: string
  sequenceId: string
  rep: number
  seed: number
  retentionKey: string
  observations: number
  firstStepOrdinal: number
  finalStepOrdinal: number
  statefulArtifactRef: AgentMemoryEvidenceRef
  statelessArtifactRef: AgentMemoryEvidenceRef
  statefulPriorPeakReward: number
  statefulPriorPeakStepOrdinal: number
  statefulFinalReward: number
  /** Prior peak minus final reward. Negative means the final result improved. */
  statefulForgetting: number
  statelessPriorPeakReward: number
  statelessPriorPeakStepOrdinal: number
  statelessFinalReward: number
  /** Prior peak minus final reward. Negative means the final result improved. */
  statelessForgetting: number
  /** Stateful forgetting minus stateless forgetting. Negative favors stateful memory. */
  excessForgetting: number
}

export interface AgentMemoryLearningComparison {
  comparisonRef: AgentMemoryExperimentComparisonRef
  evidence: {
    splitRef: AgentMemoryEvidenceRef
    statefulManifestRef: AgentMemoryEvidenceRef
    statelessManifestRef: AgentMemoryEvidenceRef
    statefulRunDir: string
    statelessRunDir: string
    candidateRefs: readonly AgentMemoryExperimentCandidateRef[]
    executionRef: string
  }
  cells: readonly AgentMemoryLearningCellComparison[]
  preTreatment: {
    definition: 'first-step-probes'
    /** Raw matched cells with at least one first-step probe. */
    cells: number
    /** Independent sequences after averaging candidates and repetitions. */
    n: number
    /** Fraction of independent sequences whose first-step scores matched exactly in every cell. */
    exactMatchRate: number | null
    /** Stateful minus stateless first-step reward. Null when no first-step probes exist. */
    difference: PairedBootstrapResult | null
  }
  /**
   * Paired stateful minus stateless reward on probes after the first step.
   * Repetitions and candidates are averaged within each sequence before bootstrapping.
   */
  gain: PairedBootstrapResult
  gainByCandidate: readonly AgentMemoryLearningCandidateSummary[]
  /** Later-step probes explicitly labeled with transferKey. No task meaning is inferred. */
  transfer: {
    definition: 'explicit-transfer-probes'
    cells: readonly AgentMemoryTransferCellComparison[]
    byStep: readonly AgentMemoryTransferStepSummary[]
  }
  forgetting: {
    /** Signed prior peak minus final reward. Negative values mean improvement. */
    definition: 'prior-peak-minus-final'
    probes: readonly AgentMemoryForgettingComparison[]
    n: number
    meanStatefulForgetting: number | null
    meanStatelessForgetting: number | null
    meanExcessForgetting: number | null
    /** Stateful minus stateless forgetting, one pair per independent retention target. */
    excess: PairedBootstrapResult | null
  }
}

export interface CompareAgentMemoryLearningOptions {
  stateful: RunAgentMemoryExperimentResult
  stateless: RunAgentMemoryExperimentResult
}

export interface RunAgentMemoryExperimentOptions {
  experimentId: string
  /** Stable external branch namespace; distributed workers must use the same value. */
  experimentRunId?: string
  /** Stateful by default. Stateless clears every declared sequence scope between steps. */
  memoryMode?: AgentMemoryMode
  sequences: readonly AgentMemorySequence[]
  candidates: readonly AgentMemoryExperimentCandidate[]
  /** Retired candidates retained only so interrupted branches can be cleaned on resume. */
  recoveryCandidates?: readonly AgentMemoryExperimentCandidate[]
  runDir: string
  executeStep?: (input: {
    memory: AgentMemoryBranch
    candidateId: string
    step: AgentMemoryExecutionStep
    context: AgentMemoryExecutionContext
  }) => Promise<void>
  /** Required with executeStep; identify the runtime/profile behavior in cache keys. */
  executeStepRef?: string
  onBranchSnapshot?: (input: {
    candidateId: string
    sequenceId: string
    cellId: string
    snapshot: AgentMemoryBranchSnapshot
  }) => Promise<void> | void
  cleanupBranches?: boolean
  storage?: CampaignStorage
  repo?: string
  seed?: number
  reps?: number
  resumable?: boolean
  costCeiling?: number
  /** Shared across nested experiments when an outer improvement run owns spend. */
  costLedger?: CostLedgerHandle
  costPhase?: string
  maxConcurrency?: number
  dispatchTimeoutMs?: number
  /** Total deadline for each provider cleanup, close, or recovery operation. */
  cleanupTimeoutMs?: number
  /** Refuse a damaged run with more unfinished attempts than this. Default 1000. */
  maxRecoveryAttempts?: number
  /** Bound repeated provider cleanup after process crashes. Default 3 per attempt. */
  maxRecoveryRetriesPerAttempt?: number
  now?: () => Date
  /** Required with custom storage when all controllers are confined to one process. */
  controllerMode?: AgentMemoryControllerMode
  /** Required for distributed controllers that share custom storage. */
  acquireRunLease?: AgentMemoryAcquireRunLease
  /** Cancels active cells; completed cells remain resumable. Cleanup still drains safely. */
  signal?: AbortSignal
}

export type AgentMemoryExperimentRunLease = AgentMemoryRunLease

export interface AgentMemoryAttemptEvent {
  status: 'started' | 'cleaned'
  branchId: string
  candidateId: string
  candidateRef: string
  sequenceId: string
  sequenceRef: AgentMemoryEvidenceRef
  rep: number
  seed: number
  cleanupBranches: boolean
  externalCostUsdPerSequence: number
  externalRecoveryCostUsdPerAttempt: number
  recordedAt: string
  recovery: boolean
}

export interface RunAgentMemoryExperimentResult {
  memoryMode: AgentMemoryMode
  comparisonRef: AgentMemoryExperimentComparisonRef
  candidateRefs: readonly AgentMemoryExperimentCandidateRef[]
  /** Immutable executor identity, or 'fixtures' when only declared writes are used. */
  executionRef: string
  campaign: CampaignResult<AgentMemorySequenceArtifact, AgentMemorySequenceScenario>
  rows: readonly AgentMemoryExperimentRankingRow[]
  totalCostUsd: number
  /** Spend attributed to retired recovery candidates, excluded from ranking rows. */
  unrankedRecoveryCostUsd: number
  leaderCandidateId?: string
  rankingJsonPath: string
  rankingMarkdownPath: string
  attemptLogPath: string
  recoveryLogPath: string
}

export type RunAgentMemoryLearningExperimentOptions = Omit<
  RunAgentMemoryExperimentOptions,
  'memoryMode'
> & {
  /** Counterbalance this across independent runs when provider behavior may drift over time. */
  armOrder?: AgentMemoryLearningArmOrder
}

export interface RunAgentMemoryLearningExperimentResult {
  armOrder: AgentMemoryLearningArmOrder
  stateful: RunAgentMemoryExperimentResult
  stateless: RunAgentMemoryExperimentResult
  comparison: AgentMemoryLearningComparison
  evidenceRef: AgentMemoryEvidenceRef
  comparisonPath: string
  cost: {
    /** Receipts attributed only to these two arms, including interrupted attempts. */
    experimentUsd: number
    /** All receipts in the shared ledger, including an owning workflow's other work. */
    ledgerUsd: number
    ceilingUsd: number
    accountingComplete: boolean
  }
}

export type OwnedMemoryExperimentRunLease = OwnedAgentMemoryRunLease
