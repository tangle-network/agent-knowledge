import { randomUUID } from 'node:crypto'
import { sha256 } from '../ids'
import type { AgentMemoryHit, AgentMemoryScope } from './types'

// Randomized retrieval holdout (epsilon-dropout) for per-item treatment-effect logging.
// Default-off: nothing in this module runs unless a consumer passes a RetrievalHoldoutConfig.
// The library never does I/O here; persistence is the consumer's job via onEvent.
// Design + estimator + sample-size analysis: research repo,
// projects/probabilistic-agent-optimization/notes/2026-07-03-DRAFT-o3-holdout-design.md (O3 / EXP-007).

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
   * Uniform-[0,1) generator keyed by a string. Defaults to a sha256-derived deterministic
   * generator so every assignment is replayable from the logged keys alone (design rule D5).
   */
  rng?: (key: string) => number
  /** Receives one event per retrieval call, INCLUDING no-drop calls: control-arm membership is half the data. */
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
  sessionId?: string
  taskId?: string
  /** 1-based call counter within the session; 0 when the call is outside session randomization. */
  callIndex: number
  /** sha256(sessionId) prefix — the seed key for the replayable assignment draws. */
  rngKey?: string
  queryHash?: string
  scope?: AgentMemoryScope
  config: { epsilon: number; watchlist: string[]; configVersion?: string }
  /** False when no sessionId is available, so the fraction-under-experiment denominator stays honest. */
  holdoutEligible: boolean
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

/** Deterministic uniform [0,1): 13 hex chars = 52 bits, exactly representable in a double. */
export function deterministicRng(key: string): number {
  return Number.parseInt(sha256(key).slice(0, 13), 16) / 16 ** 13
}

/**
 * Pure per-call holdout: takes post-filter hits, returns delivered hits plus the log event
 * and the next session state. Suppression only removes items (no backfill), and it happens
 * before rendering so a drop session's context is byte-identical to a natural smaller retrieval.
 */
export function applyRetrievalHoldout(
  hits: AgentMemoryHit[],
  config: RetrievalHoldoutConfig,
  ctx: RetrievalHoldoutCallContext = {},
): RetrievalHoldoutResult {
  const rng = config.rng ?? deterministicRng
  const watchlist = config.watchlist ?? []
  const sessionId = ctx.sessionId ?? ctx.scope?.sessionId
  const holdoutEligible = typeof sessionId === 'string' && sessionId.length > 0

  let session: RetrievalHoldoutSessionState | undefined
  if (holdoutEligible) {
    const prior = ctx.session?.sessionId === sessionId ? ctx.session : undefined
    session = prior ?? {
      sessionId,
      callCount: 0,
      // The epsilon coin depends only on sessionId, so assignment is independent of task
      // features by construction and exactly replayable (design rules D1 + D5).
      sessionHoldout: rng(`${sessionId}#holdout`) < config.epsilon,
      targetId: null,
      pickPropensity: null,
    }
    session = { ...session, callCount: session.callCount + 1 }
  }

  const watchlistSet = new Set(watchlist)
  const watchlistEligible = hits.filter((hit) => watchlistSet.has(hit.id)).map((hit) => hit.id)

  if (session?.sessionHoldout && session.targetId === null && watchlistEligible.length > 0) {
    // Draw once, uniformly over watchlist ∩ E at the first intersecting call, then stay sticky.
    // Candidates are sorted by id so the draw does not depend on retrieval ordering.
    const candidates = [...watchlistEligible].sort()
    const index = Math.min(
      Math.floor(rng(`${session.sessionId}#pick`) * candidates.length),
      candidates.length - 1,
    )
    const picked = candidates[index]
    if (picked !== undefined) {
      session = { ...session, targetId: picked, pickPropensity: 1 / candidates.length }
    }
  }

  const targetId = session?.sessionHoldout ? (session.targetId ?? null) : null
  const droppedId = targetId !== null && hits.some((hit) => hit.id === targetId) ? targetId : null
  const delivered = droppedId === null ? hits : hits.filter((hit) => hit.id !== droppedId)

  const pickPropensity = session?.sessionHoldout ? (session.pickPropensity ?? null) : null
  const event: RetrievalHoldoutEvent = {
    v: 1,
    eventId: randomUUID(),
    ts: new Date().toISOString(),
    ...(config.adapterId !== undefined ? { adapterId: config.adapterId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(ctx.taskId !== undefined ? { taskId: ctx.taskId } : {}),
    callIndex: session?.callCount ?? 0,
    ...(sessionId !== undefined ? { rngKey: sha256(sessionId).slice(0, 16) } : {}),
    ...(ctx.query !== undefined ? { queryHash: sha256(ctx.query).slice(0, 16) } : {}),
    ...(ctx.scope !== undefined ? { scope: ctx.scope } : {}),
    config: {
      epsilon: config.epsilon,
      watchlist: [...watchlist],
      ...(config.configVersion !== undefined ? { configVersion: config.configVersion } : {}),
    },
    holdoutEligible,
    eligible: hits.map((hit, index) => ({
      id: hit.id,
      rank: index + 1,
      ...(typeof (hit.normalizedScore ?? hit.score) === 'number'
        ? { score: hit.normalizedScore ?? hit.score }
        : {}),
      kind: hit.kind,
      contentHash: sha256(hit.text).slice(0, 16),
    })),
    watchlistEligible,
    sessionHoldout: session?.sessionHoldout ?? false,
    sessionTargetId: targetId,
    droppedId,
    pickPropensity,
    dropPropensity: pickPropensity !== null ? config.epsilon * pickPropensity : null,
    deliveredIds: delivered.map((hit) => hit.id),
    ...(config.corpusVersion !== undefined ? { corpusVersion: config.corpusVersion } : {}),
  }
  config.onEvent(event)

  return droppedId === null
    ? { delivered: hits, event, ...(session !== undefined ? { session } : {}) }
    : { delivered, event, ...(session !== undefined ? { session } : {}) }
}

// Session states are tiny (5 scalar fields); the cap only guards unbounded long-lived processes.
// Evicting a live session degrades detectably, not silently: a re-drawn target that differs
// shows up in the log as a mixed-exposure session, which analysis excludes and counts.
const MAX_TRACKED_SESSIONS = 10_000
const sessionRegistry = new WeakMap<
  RetrievalHoldoutConfig,
  Map<string, RetrievalHoldoutSessionState>
>()

/**
 * Convenience wrapper that threads session state internally, keyed by config object identity.
 * Reuse ONE config object across all calls of a session (normally one per harness) or
 * stickiness falls back to the deterministic per-session draws alone.
 */
export function applySessionStickyRetrievalHoldout(
  hits: AgentMemoryHit[],
  config: RetrievalHoldoutConfig,
  ctx: Omit<RetrievalHoldoutCallContext, 'session'> = {},
): RetrievalHoldoutResult {
  const sessionId = ctx.sessionId ?? ctx.scope?.sessionId
  let sessions = sessionRegistry.get(config)
  if (!sessions) {
    sessions = new Map()
    sessionRegistry.set(config, sessions)
  }
  const prior = sessionId !== undefined ? sessions.get(sessionId) : undefined
  const result = applyRetrievalHoldout(hits, config, {
    ...ctx,
    ...(prior ? { session: prior } : {}),
  })
  if (sessionId !== undefined && result.session) {
    if (!sessions.has(sessionId) && sessions.size >= MAX_TRACKED_SESSIONS) {
      const oldest = sessions.keys().next().value
      if (oldest !== undefined) sessions.delete(oldest)
    }
    sessions.set(sessionId, result.session)
  }
  return result
}
