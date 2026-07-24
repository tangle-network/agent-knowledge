import type {
  CampaignResult,
  CampaignStorage,
  CostLedgerHandle,
  DispatchContext,
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

export interface AgentMemorySequenceProbe {
  id: string
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
    sequence: AgentMemorySequence
    rep: number
    seed: number
    purpose: 'execute' | 'recovery'
    signal: AbortSignal
    markExternalCall(): void
  }): AgentMemoryAdapter | null | Promise<AgentMemoryAdapter | null>
  policy?: AgentMemorySharingPolicy
  baseScope?: AgentMemoryScope
  /** Exact fixed provider charge and provider-enforced maximum for one complete history. */
  externalCostUsdPerSequence?: number
  /** Exact fixed provider charge and provider-enforced maximum for one recovery attempt. */
  externalRecoveryCostUsdPerAttempt?: number
  /** Required for positive external charges. */
  externalCostAccounting?: 'exact'
  /** Release resources and, when cleanupBranches is false, delete the isolated state. */
  disposeAdapter?(adapter: AgentMemoryAdapter): Promise<void>
}

export interface AgentMemorySequenceProbeResult {
  id: string
  stepId: string
  query: string
  score: number
  passed: boolean
  dimensions: Record<string, number>
  applicableDimensions: readonly string[]
  notes: string
  hitIds: readonly string[]
}

export interface AgentMemorySequenceArtifact {
  candidateId: string
  sequenceId: string
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

export interface RunAgentMemoryExperimentOptions {
  experimentId: string
  /** Stable external branch namespace; distributed workers must use the same value. */
  experimentRunId?: string
  sequences: readonly AgentMemorySequence[]
  candidates: readonly AgentMemoryExperimentCandidate[]
  /** Retired candidates retained only so interrupted branches can be cleaned on resume. */
  recoveryCandidates?: readonly AgentMemoryExperimentCandidate[]
  runDir: string
  executeStep?: (input: {
    memory: AgentMemoryBranch
    candidateId: string
    sequence: AgentMemorySequence
    step: AgentMemorySequenceStep
    context: DispatchContext
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
}

export type AgentMemoryExperimentRunLease = AgentMemoryRunLease

export interface AgentMemoryAttemptEvent {
  status: 'started' | 'cleaned'
  branchId: string
  candidateId: string
  candidateRef: string
  sequenceId: string
  rep: number
  seed: number
  cleanupBranches: boolean
  externalCostUsdPerSequence: number
  externalRecoveryCostUsdPerAttempt: number
  recordedAt: string
  recovery: boolean
}

export interface RunAgentMemoryExperimentResult {
  campaign: CampaignResult<AgentMemorySequenceArtifact, AgentMemorySequenceScenario>
  rows: readonly AgentMemoryExperimentRankingRow[]
  totalCostUsd: number
  /** Recovery spend for retired candidates, excluded from ranking rows but included in totalCostUsd. */
  unrankedRecoveryCostUsd: number
  leaderCandidateId?: string
  rankingJsonPath: string
  rankingMarkdownPath: string
  attemptLogPath: string
  recoveryLogPath: string
}

export type OwnedMemoryExperimentRunLease = OwnedAgentMemoryRunLease
