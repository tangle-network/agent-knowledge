import type { SourceRecord } from '../types'

export type AgentMemoryKind =
  | 'message'
  | 'entity'
  | 'fact'
  | 'preference'
  | 'observation'
  | 'reasoning-trace'

export interface AgentMemoryScope {
  tenantId?: string
  userId?: string
  agentId?: string
  teamId?: string
  runId?: string
  sessionId?: string
  namespace?: string
  tags?: Record<string, string>
}

export interface AgentMemoryHit {
  id: string
  uri: string
  kind: AgentMemoryKind
  text: string
  title?: string
  score?: number
  normalizedScore?: number
  confidence?: number
  createdAt?: string
  validUntil?: string
  lastVerifiedAt?: string
  metadata?: Record<string, unknown>
}

export interface AgentMemoryContext {
  query: string
  text: string
  hits: AgentMemoryHit[]
  sourceRecords: SourceRecord[]
  metadata?: Record<string, unknown>
}

export interface AgentMemorySearchOptions {
  scope?: AgentMemoryScope
  limit?: number
  minScore?: number
  kinds?: AgentMemoryKind[]
  metadata?: Record<string, unknown>
  /**
   * Opt-in randomized retrieval holdout (epsilon-dropout) for treatment-effect logging.
   * Absent by default; when absent, retrieval behavior is unchanged. See ./holdout.
   */
  holdout?: RetrievalHoldoutConfig
}

export interface AgentMemoryWriteInput {
  kind: AgentMemoryKind
  text: string
  id?: string
  title?: string
  role?: 'system' | 'user' | 'assistant' | 'tool'
  entityName?: string
  entityType?: string
  category?: string
  predicate?: string
  subject?: string
  object?: string
  confidence?: number
  scope?: AgentMemoryScope
  metadata?: Record<string, unknown>
}

export interface AgentMemoryWriteResult {
  accepted: boolean
  id: string
  uri: string
  kind: AgentMemoryKind
  sourceRecord?: SourceRecord
  metadata?: Record<string, unknown>
}

export type AgentMemoryBranchIsolation =
  | {
      mode: 'scoped'
      /** False when writes may outlive the worker process that issued them. */
      processExitSafe?: boolean
      /** Wait before clearing an abandoned branch so accepted asynchronous writes become visible. */
      recoveryDelayMs?: number
    }
  | {
      mode: 'instance'
      branchId: string
      /** True only when the dedicated instance also enforces every logical scope. */
      supportsLogicalScopes?: boolean
    }
  | { mode: 'unsupported'; reason: string }

export interface AgentMemoryAdapter {
  readonly id: string
  /** How this adapter prevents candidate branches from reading each other's state. */
  readonly branchIsolation?: AgentMemoryBranchIsolation
  search(query: string, options?: AgentMemorySearchOptions): Promise<AgentMemoryHit[]>
  getContext(query: string, options?: AgentMemorySearchOptions): Promise<AgentMemoryContext>
  write(input: AgentMemoryWriteInput): Promise<AgentMemoryWriteResult>
  /** Delete exactly this scope. Repeated and concurrent calls for the same scope must be safe. */
  clear?(scope?: AgentMemoryScope): Promise<void>
  flush?(): Promise<void>
  close?(): Promise<void>
}

/**
 * Optional session-level retrieval dropout for estimating whether delivered memories affect
 * task outcomes. The feature is disabled unless configured, and consumers persist events
 * through `onEvent`.
 */

export interface RetrievalHoldoutConfig {
  /** Per-session probability that one eligible watchlist item is suppressed. 0 logs the full schema without ever dropping. */
  epsilon: number
  /** Item ids eligible for suppression. Empty or absent means no item can ever be dropped. */
  watchlist?: string[]
  /** Ties every event to the exact epsilon/watchlist in force, for audit and replay. */
  configVersion?: string
  /** Copied onto every event so multi-adapter logs stay attributable. */
  adapterId?: string
  /** Corpus/store version stamp; an edited item under the same id is a different treatment. */
  corpusVersion?: string
  /**
   * Emit plaintext sessionId and scope on events. Default false: events carry only
   * sessionIdHash/scopeHash, so PII-bearing identifiers (tenantId/userId/tags) never reach a
   * consumer-controlled sink unless the consumer explicitly owns that decision. Note that
   * replaying assignment draws from logs alone needs the plaintext sessionId, so
   * privacy-preserving logs require the consumer's own sessionId mapping for replay.
   */
  includePlaintextIdentifiers?: boolean
  /**
   * Cap on tracked sessions per experiment config in the sticky wrapper's registry.
   * The default is 10,000.
   */
  maxTrackedSessions?: number
  /**
   * Uniform-[0,1) generator keyed by a string. Defaults to a sha256-derived deterministic
   * generator so every assignment is replayable from the logged keys alone.
   */
  rng?: (key: string) => number
  /** Receives one event per retrieval call, including calls where nothing is dropped. */
  onEvent: (event: RetrievalHoldoutEvent) => void
}

export interface RetrievalHoldoutEligibleItem {
  id: string
  /** 1-based position in the post-filter hit list. */
  rank: number
  score?: number
  kind: string
  /** sha256(hit.text) prefix; effects are estimated per (id, contentHash) pair. */
  contentHash: string
}

export interface RetrievalHoldoutEvent {
  v: 1
  eventId: string
  ts: string
  adapterId?: string
  /** Plaintext session id, emitted only when `includePlaintextIdentifiers` is true. */
  sessionId?: string
  /** Consumer-supplied experiment/outcome join id (scope.tags.taskId); deliberately plaintext. */
  taskId?: string
  /** 1-based call counter within the session; 0 when the call is outside session randomization. */
  callIndex: number
  /**
   * sha256(sessionId) prefix used as the privacy-preserving join key and assignment seed.
   */
  sessionIdHash?: string
  queryHash?: string
  /** Verbatim scope, emitted only when `includePlaintextIdentifiers` is true. */
  scope?: AgentMemoryScope
  /** sha256 prefix of the canonical-JSON scope (keys sorted, undefined stripped). */
  scopeHash?: string
  config: { epsilon: number; watchlist: string[]; configVersion?: string }
  /**
   * Value-hash of the experiment-defining knobs, sha256({epsilon, sorted watchlist}) prefix.
   * The estimator groups events by it; the sticky-session registry is keyed by it.
   */
  configHash: string
  /**
   * False when no sessionId is available or the adapter answered without retrieval
   * (see bypassReason), so the fraction-under-experiment denominator stays honest.
   */
  holdoutEligible: boolean
  /** Present only on adapter paths that bypassed retrieval, where no suppression could apply. */
  bypassReason?: RetrievalHoldoutBypassReason
  /** The full post-filter eligibility set E, logged on every call (control arm + interference probes). */
  eligible: RetrievalHoldoutEligibleItem[]
  /** Ids in watchlist ∩ E, in eligibility order. */
  watchlistEligible: string[]
  sessionHoldout: boolean
  /** The session's sticky drop target once drawn; distinguishes "target absent from E" from "not yet drawn". */
  sessionTargetId: string | null
  /** The item suppressed in THIS call, or null. */
  droppedId: string | null
  /** 1/|watchlist ∩ E| recorded at draw time; the exact inverse-propensity weight input. */
  pickPropensity: number | null
  /** epsilon * pickPropensity, recorded at draw time so analysis never re-derives assignment probabilities. */
  dropPropensity: number | null
  deliveredIds: string[]
  corpusVersion?: string
}

export interface RetrievalHoldoutSessionState {
  sessionId: string
  /** Calls observed so far in this session. */
  callCount: number
  sessionHoldout: boolean
  /** Sticky drop target; drawn once at the first call whose eligibility set intersects the watchlist. */
  targetId: string | null
  pickPropensity: number | null
}

export interface RetrievalHoldoutCallContext {
  sessionId?: string
  taskId?: string
  /** Raw query; only its sha256 prefix is logged. */
  query?: string
  scope?: AgentMemoryScope
  /** State returned by the previous call of this session; threading it is what makes suppression sticky. */
  session?: RetrievalHoldoutSessionState
}

export interface RetrievalHoldoutResult {
  delivered: AgentMemoryHit[]
  event: RetrievalHoldoutEvent
  session?: RetrievalHoldoutSessionState
}

/** Adapter context paths that answer without retrieval, so no holdout draw can happen. */
export type RetrievalHoldoutBypassReason = 'short-term-context' | 'raw-string-context'
