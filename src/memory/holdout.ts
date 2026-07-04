import { randomUUID } from 'node:crypto'
import { mulberry32 } from '@tangle-network/agent-eval'
import type { OffPolicyTrajectory } from '@tangle-network/agent-eval/rl'
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

/**
 * Deterministic uniform [0,1) for assignment draws. The sha256 key derivation is ours — it makes
 * every draw replayable from the logged keys alone (design rule D5) — while the generator core is
 * the substrate's `mulberry32` (@tangle-network/agent-eval statistics vocabulary), seeded with the
 * top 32 bits of the digest, so the statistical machinery is reused rather than forked.
 */
export function deterministicRng(key: string): number {
  return mulberry32(Number.parseInt(sha256(key).slice(0, 8), 16))()
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
  const sessionId = ctx.sessionId ?? ctx.scope?.sessionId
  const holdoutEligible = typeof sessionId === 'string' && sessionId.length > 0
  const base = holdoutEventBase(hits, config, ctx)

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

  const watchlistEligible = base.watchlistEligible

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
    ...base,
    callIndex: session?.callCount ?? 0,
    holdoutEligible,
    sessionHoldout: session?.sessionHoldout ?? false,
    sessionTargetId: targetId,
    droppedId,
    pickPropensity,
    dropPropensity: pickPropensity !== null ? config.epsilon * pickPropensity : null,
    deliveredIds: delivered.map((hit) => hit.id),
  }
  config.onEvent(event)

  return droppedId === null
    ? { delivered: hits, event, ...(session !== undefined ? { session } : {}) }
    : { delivered, event, ...(session !== undefined ? { session } : {}) }
}

/** Fields shared by randomized and bypass events: identity, attribution, config echo, eligibility. */
function holdoutEventBase(
  hits: AgentMemoryHit[],
  config: RetrievalHoldoutConfig,
  ctx: Omit<RetrievalHoldoutCallContext, 'session'>,
) {
  const sessionId = ctx.sessionId ?? ctx.scope?.sessionId
  const watchlist = config.watchlist ?? []
  const watchlistSet = new Set(watchlist)
  return {
    v: 1 as const,
    eventId: randomUUID(),
    ts: new Date().toISOString(),
    ...(config.adapterId !== undefined ? { adapterId: config.adapterId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(ctx.taskId !== undefined ? { taskId: ctx.taskId } : {}),
    ...(sessionId !== undefined ? { rngKey: sha256(sessionId).slice(0, 16) } : {}),
    ...(ctx.query !== undefined ? { queryHash: sha256(ctx.query).slice(0, 16) } : {}),
    ...(ctx.scope !== undefined ? { scope: ctx.scope } : {}),
    config: {
      epsilon: config.epsilon,
      watchlist: [...watchlist],
      ...(config.configVersion !== undefined ? { configVersion: config.configVersion } : {}),
    },
    eligible: hits.map((hit, index) => ({
      id: hit.id,
      rank: index + 1,
      ...(typeof (hit.normalizedScore ?? hit.score) === 'number'
        ? { score: hit.normalizedScore ?? hit.score }
        : {}),
      kind: hit.kind,
      contentHash: sha256(hit.text).slice(0, 16),
    })),
    watchlistEligible: hits.filter((hit) => watchlistSet.has(hit.id)).map((hit) => hit.id),
    ...(config.corpusVersion !== undefined ? { corpusVersion: config.corpusVersion } : {}),
  }
}

/**
 * Logs a holdout event for adapter context paths that answer WITHOUT going through the
 * search→render seam (Neo4j short-term conversation context, raw-string getContext results),
 * so a consumer with a holdout configured still sees every call and the fraction-under-experiment
 * denominator stays honest instead of silently losing these calls. No suppression is applied:
 * dropping is only meaningful for retrieved memory hits, never for conversation context.
 */
export function emitRetrievalHoldoutBypass(
  hits: AgentMemoryHit[],
  config: RetrievalHoldoutConfig,
  ctx: Omit<RetrievalHoldoutCallContext, 'session'>,
  bypassReason: RetrievalHoldoutBypassReason,
): RetrievalHoldoutEvent {
  const event: RetrievalHoldoutEvent = {
    ...holdoutEventBase(hits, config, ctx),
    callIndex: 0,
    holdoutEligible: false,
    sessionHoldout: false,
    sessionTargetId: null,
    droppedId: null,
    pickPropensity: null,
    dropPropensity: null,
    deliveredIds: hits.map((hit) => hit.id),
    bypassReason,
  }
  config.onEvent(event)
  return event
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

export interface RetrievalHoldoutOffPolicyOptions {
  /** Realized outcome of the call's session/task, joined by the caller — events carry no reward. */
  reward: (event: RetrievalHoldoutEvent) => number
  /**
   * Target-policy probability of the LOGGED delivery. Defaults to the "always deliver in full"
   * policy: 1 when nothing was dropped, 0 when something was.
   */
  targetProb?: (event: RetrievalHoldoutEvent) => number
  /** Reward-model prediction enabling `doublyRobust`; when absent, entries carry qHat null. */
  qHat?: (event: RetrievalHoldoutEvent) => number | null
}

/**
 * Behavior-policy probability of the delivery an event records, reconstructed from the logged
 * propensities alone:
 * - drop events: `dropPropensity` (= epsilon × pickPropensity, recorded at draw time);
 * - no-drop events whose watchlist intersected the eligibility set: 1 − epsilon × pick, where
 *   pick is the logged `pickPropensity` (holdout arm, sticky draw) or 1/|watchlist ∩ E|
 *   (control arm — the uniform draw that would have happened, exact at the session's first
 *   intersecting call);
 * - calls where no drop was possible (bypass paths, holdout-ineligible calls, empty
 *   watchlist ∩ E): 1, because full delivery was the only action the behavior policy could take.
 */
export function retrievalHoldoutBehaviorProb(event: RetrievalHoldoutEvent): number {
  if (event.droppedId !== null) {
    if (event.dropPropensity === null)
      throw new Error(`holdout event ${event.eventId} recorded a drop without dropPropensity`)
    return event.dropPropensity
  }
  if (!event.holdoutEligible) return 1
  const pick =
    event.pickPropensity ??
    (event.watchlistEligible.length > 0 ? 1 / event.watchlistEligible.length : null)
  return pick === null ? 1 : 1 - event.config.epsilon * pick
}

/**
 * Maps holdout log events onto agent-eval's `OffPolicyTrajectory` so EXP-007's analysis consumes
 * the substrate's `inverseProbabilityWeighting` / `selfNormalizedImportanceWeighting` /
 * `doublyRobust` estimators directly instead of re-deriving them from raw events.
 *
 * Field mapping (one trajectory per event):
 * - `runId` ← `eventId`
 * - `reward` ← `options.reward(event)` — joined by the caller, events carry no outcome
 * - `behaviorProb` ← the event's logged pick/drop propensity ({@link retrievalHoldoutBehaviorProb})
 * - `targetProb` ← `options.targetProb(event)`; default models the always-deliver-in-full policy
 * - `qHat` ← `options.qHat(event)`, else null (IPS/SNIPS-only)
 *
 * The per-event mapping treats calls independently; for a strict session-level estimand,
 * aggregate to one trajectory per session (its first watchlist-intersecting call) upstream.
 * Pre-registration for EXP-007 stays in the research repo by design; the manifest vocabulary for
 * it is agent-eval's `HypothesisManifest` / `signManifest` / `evaluateHypothesis` exports.
 */
export function toOffPolicyTrajectory(
  events: RetrievalHoldoutEvent[],
  options: RetrievalHoldoutOffPolicyOptions,
): OffPolicyTrajectory[] {
  return events.map((event) => ({
    runId: event.eventId,
    reward: options.reward(event),
    behaviorProb: retrievalHoldoutBehaviorProb(event),
    targetProb: options.targetProb?.(event) ?? (event.droppedId === null ? 1 : 0),
    qHat: options.qHat?.(event) ?? null,
  }))
}
