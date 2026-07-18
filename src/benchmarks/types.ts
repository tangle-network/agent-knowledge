import type {
  CampaignResult,
  CampaignStorage,
  CostLedgerHandle,
  DispatchContext,
  Scenario,
} from '@tangle-network/agent-eval/campaign'

import type { AgentMemoryAcquireRunLease, AgentMemoryControllerMode } from '../memory/run-control'

import type { AgentMemoryAdapter, AgentMemoryScope } from '../memory/types'

import type { RetrievalGoldTarget, RetrievedKnowledgeHit } from '../retrieval-eval'

export type KnowledgeBenchmarkTaskKind =
  | 'retrieval'
  | 'rag-answer'
  | 'hallucination'
  | 'kb-improvement'
  | 'memory-ingest'
  | 'memory-recall'
  | 'memory-temporal'
  | 'memory-update'
  | 'memory-forgetting'
  | 'memory-reasoning'
  | 'memory-summarization'
  | 'memory-recommendation'
  | 'memory-multiparty'

export type KnowledgeAnswerBenchmarkTaskKind = 'rag-answer' | 'hallucination' | 'kb-improvement'

export type KnowledgeMemoryBenchmarkTaskKind = Exclude<
  KnowledgeBenchmarkTaskKind,
  'retrieval' | KnowledgeAnswerBenchmarkTaskKind
>

export type KnowledgeBenchmarkFamily =
  | 'beir'
  | 'mteb-retrieval'
  | 'msmarco'
  | 'trec-dl'
  | 'miracl'
  | 'lotte'
  | 'bright'
  | 'crag'
  | 'hotpotqa'
  | 'kilt'
  | 'ragtruth'
  | 'faithbench'
  | 'locomo'
  | 'longmemeval'
  | 'longmemeval-v2'
  | 'memora'
  | 'memoryagentbench'
  | 'memorybank'
  | 'groupmembench'
  | 'first-party'
  | 'custom'

export type KnowledgeBenchmarkSplit = 'search' | 'dev' | 'holdout' | string

export interface KnowledgeBenchmarkSource {
  name?: string
  url?: string
  version?: string
  license?: string
  citation?: string
}

export interface KnowledgeBenchmarkSpec {
  id: string
  family: KnowledgeBenchmarkFamily
  taskKind: KnowledgeBenchmarkTaskKind
  primaryMetrics: readonly string[]
  adapter: string
  notes: string
}

export interface KnowledgeBenchmarkCaseBase {
  id: string
  family: KnowledgeBenchmarkFamily | string
  taskKind: KnowledgeBenchmarkTaskKind
  split?: KnowledgeBenchmarkSplit
  tags?: readonly string[]
  source?: KnowledgeBenchmarkSource
  metadata?: Record<string, unknown>
}

export interface KnowledgeRetrievalBenchmarkCase extends KnowledgeBenchmarkCaseBase {
  taskKind: 'retrieval'
  query: string
  expected: RetrievalGoldTarget | readonly RetrievalGoldTarget[]
  k?: number
}

export interface KnowledgeClaimMatcher {
  id: string
  anyOf: readonly string[]
  weight?: number
}

export interface KnowledgeMemoryEvent {
  id: string
  text: string
  actorId?: string
  sessionId?: string
  timestamp?: string
  metadata?: Record<string, unknown>
}

export interface KnowledgeMemoryFactMatcher extends KnowledgeClaimMatcher {
  sourceEventIds?: readonly string[]
  validAt?: string
  obsolete?: boolean
}

export interface KnowledgeAnswerBenchmarkCase extends KnowledgeBenchmarkCaseBase {
  taskKind: KnowledgeAnswerBenchmarkTaskKind
  prompt: string
  requiredClaims?: readonly KnowledgeClaimMatcher[]
  forbiddenClaims?: readonly KnowledgeClaimMatcher[]
  expectedSourceIds?: readonly string[]
  referenceAnswer?: string
}

export interface KnowledgeMemoryBenchmarkCase extends KnowledgeBenchmarkCaseBase {
  taskKind: KnowledgeMemoryBenchmarkTaskKind
  events: readonly KnowledgeMemoryEvent[]
  prompt: string
  requiredFacts?: readonly KnowledgeMemoryFactMatcher[]
  forbiddenFacts?: readonly KnowledgeMemoryFactMatcher[]
  expectedEventIds?: readonly string[]
  expectedActorIds?: readonly string[]
  referenceAnswer?: string
}

export type KnowledgeBenchmarkCase =
  | KnowledgeRetrievalBenchmarkCase
  | KnowledgeAnswerBenchmarkCase
  | KnowledgeMemoryBenchmarkCase

export interface KnowledgeBenchmarkArtifact {
  answer?: string
  text?: string
  hits?: readonly RetrievedKnowledgeHit[]
  citedSourceIds?: readonly string[]
  rememberedFacts?: readonly string[]
  citedEventIds?: readonly string[]
  usedMemoryIds?: readonly string[]
  actorIds?: readonly string[]
  /** Informational copy. Billable responders account through context.cost.runPaidCall. */
  costUsd?: number
  durationMs?: number
  metadata?: Record<string, unknown>
}

export interface KnowledgeBenchmarkEvaluation {
  score: number
  passed: boolean
  dimensions: Record<string, number>
  /** Dimensions for which this case declared an actual target. */
  applicableDimensions?: readonly string[]
  notes: string
  raw: Record<string, unknown>
}

export interface KnowledgeBenchmarkScenario extends Scenario {
  kind: 'knowledge-benchmark'
  family: KnowledgeBenchmarkFamily | string
  taskKind: KnowledgeBenchmarkTaskKind
  splitTag: KnowledgeBenchmarkSplit
  case: KnowledgeBenchmarkCase
}

export type KnowledgeBenchmarkResponder<TArtifact = KnowledgeBenchmarkArtifact> = (input: {
  case: KnowledgeBenchmarkCase
  scenario: KnowledgeBenchmarkScenario
  context: DispatchContext
}) => Promise<TArtifact> | TArtifact

export interface RunKnowledgeBenchmarkSuiteOptions<TArtifact = KnowledgeBenchmarkArtifact> {
  cases: readonly KnowledgeBenchmarkCase[]
  respond: KnowledgeBenchmarkResponder<TArtifact>
  /** Versioned identity for the model, prompt, retrieval, and runtime behavior. */
  respondRef?: string
  runDir: string
  splits?: readonly KnowledgeBenchmarkSplit[]
  repo?: string
  seed?: number
  reps?: number
  resumable?: boolean
  costCeiling?: number
  /** Shared across nested benchmark suites when an outer run owns spend. */
  costLedger?: CostLedgerHandle
  costPhase?: string
  maxConcurrency?: number
  dispatchTimeoutMs?: number
  expectUsage?: 'assert' | 'warn' | 'off'
  storage?: CampaignStorage
  now?: () => Date
}

export interface KnowledgeBenchmarkDistribution {
  n: number
  min: number
  mean: number
  median: number
  p90: number
  max: number
}

export interface KnowledgeBenchmarkSliceSummary {
  n: number
  meanScore: number
  passRate: number
  score: KnowledgeBenchmarkDistribution
}

export interface KnowledgeBenchmarkReport {
  totalCases: number
  totalCells: number
  cellsFailed: number
  cellsCached: number
  totalCostUsd: number
  bySplit: Record<string, KnowledgeBenchmarkSliceSummary>
  byFamily: Record<string, KnowledgeBenchmarkSliceSummary>
  byTaskKind: Record<string, KnowledgeBenchmarkSliceSummary>
  dimensions: Record<string, KnowledgeBenchmarkDistribution>
  score: KnowledgeBenchmarkDistribution
}

export interface RunKnowledgeBenchmarkSuiteResult<TArtifact = KnowledgeBenchmarkArtifact> {
  scenarios: readonly KnowledgeBenchmarkScenario[]
  campaign: CampaignResult<TArtifact, KnowledgeBenchmarkScenario>
  report: KnowledgeBenchmarkReport
  reportJsonPath: string
  reportMarkdownPath: string
}

export interface MemoryAdapterBenchmarkCandidate {
  id: string
  /** Versioned adapter and configuration identity used by resumable caches. */
  ref: string
  /** Expected adapter.id. Defaults to candidate id and permits lazy no-work resume. */
  adapterId?: string
  label?: string
  /** Local construction is free; call markExternalCall before billable provisioning or reconnects. */
  createAdapter: (input: {
    purpose: 'execute' | 'recovery'
    signal: AbortSignal
    markExternalCall(): void
  }) => AgentMemoryAdapter | Promise<AgentMemoryAdapter>
  /** Conservative charge for one billable adapter provisioning or reconnect call. */
  adapterCreationCostUsd?: number
  searchLimit?: number
  costUsdPerCase?: number
  /** Conservative extra provider charge for recovering one interrupted case. */
  recoveryCostUsdPerAttempt?: number
  scope?: AgentMemoryScope
}

export interface RunMemoryAdapterBenchmarkOptions {
  cases: readonly KnowledgeMemoryBenchmarkCase[]
  candidates: readonly MemoryAdapterBenchmarkCandidate[]
  /** Retired candidates retained only so interrupted scopes can be cleaned on resume. */
  recoveryCandidates?: readonly MemoryAdapterBenchmarkCandidate[]
  runDir: string
  storage?: CampaignStorage
  repo?: string
  seed?: number
  reps?: number
  resumable?: boolean
  costCeiling?: number
  /** Shared with nested benchmark suites so the dollar limit applies to the whole comparison. */
  costLedger?: CostLedgerHandle
  costPhase?: string
  maxConcurrency?: number
  dispatchTimeoutMs?: number
  cleanupTimeoutMs?: number
  /** Refuse a damaged run with more unfinished attempts than this. Default 1000. */
  maxRecoveryAttempts?: number
  /** Bound repeated provider cleanup after process crashes. Default 3 per attempt. */
  maxRecoveryRetriesPerAttempt?: number
  expectUsage?: 'assert' | 'warn' | 'off'
  now?: () => Date
  /** Required with custom storage when all controllers are confined to one process. */
  controllerMode?: AgentMemoryControllerMode
  /** Required for distributed controllers that share custom storage. */
  acquireRunLease?: AgentMemoryAcquireRunLease
}

export interface MemoryAdapterBenchmarkRankingRow {
  rank: number
  candidateId: string
  label: string
  adapterId: string
  scoreMean: number
  passRate: number
  totalCases: number
  totalCells: number
  cellsFailed: number
  totalCostUsd: number
  reportJsonPath: string
  reportMarkdownPath: string
  report: KnowledgeBenchmarkReport
}

export interface RunMemoryAdapterBenchmarkResult {
  rows: readonly MemoryAdapterBenchmarkRankingRow[]
  totalCostUsd: number
  /** Recovery spend for retired candidates, excluded from ranking rows but included in totalCostUsd. */
  unrankedRecoveryCostUsd: number
  rankingJsonPath: string
  rankingMarkdownPath: string
  attemptLogPath: string
  recoveryLogPath: string
}

export interface KnowledgeRetrievalBenchmarkQuery {
  id: string
  text: string
  split?: KnowledgeBenchmarkSplit
  tags?: readonly string[]
  metadata?: Record<string, unknown>
}

export interface KnowledgeRetrievalBenchmarkQrel {
  queryId: string
  documentId: string
  score: number
}

export interface BuildRetrievalBenchmarkCasesFromQrelsOptions {
  benchmarkId: string
  family: KnowledgeBenchmarkFamily | string
  queries: readonly KnowledgeRetrievalBenchmarkQuery[]
  qrels: readonly KnowledgeRetrievalBenchmarkQrel[]
  source?: KnowledgeBenchmarkSource
  tags?: readonly string[]
  k?: number
  targetKind?: 'page' | 'page-path' | 'source'
  documentTarget?: (
    documentId: string,
    qrel: KnowledgeRetrievalBenchmarkQrel,
  ) => RetrievalGoldTarget
  splitOf?: (queryId: string) => KnowledgeBenchmarkSplit
}
