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
   * Emit plaintext sessionId and scope on events. Default false: events carry only
   * sessionIdHash/scopeHash, so PII-bearing identifiers (tenantId/userId/tags) never reach a
   * consumer-controlled sink unless the consumer explicitly owns that decision. Note that
   * replaying assignment draws from logs alone needs the plaintext sessionId, so
   * privacy-default logs require the consumer's own sessionId mapping for replay audits.
   */
  includePlaintextIdentifiers?: boolean
  /**
   * Cap on tracked sessions per experiment config in the sticky wrapper's registry.
   * Exists so tests can exercise eviction; production should keep the default (10,000).
   */
  maxTrackedSessions?: number
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
  /** Plaintext session id — emitted ONLY when config.includePlaintextIdentifiers is true. */
  sessionId?: string
  /** Consumer-supplied experiment/outcome join id (scope.tags.taskId); deliberately plaintext. */
  taskId?: string
  /** 1-based call counter within the session; 0 when the call is outside session randomization. */
  callIndex: number
  /**
   * sha256(sessionId) prefix — the default privacy-preserving session join key AND the seed-key
   * reference for the assignment draws (previously named rngKey; identical derivation, deduped).
   */
  sessionIdHash?: string
  queryHash?: string
  /** Verbatim scope — emitted ONLY when config.includePlaintextIdentifiers is true (PII risk). */
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

/**
 * Deterministic uniform [0,1) for assignment draws. The sha256 key derivation is ours — it makes
 * every draw replayable from the logged keys alone (design rule D5) — while the generator core is
 * the substrate's `mulberry32` (@tangle-network/agent-eval statistics vocabulary), seeded with the
 * top 32 bits of the digest, so the statistical machinery is reused rather than forked.
 */
export function deterministicRng(key: string): number {
  return mulberry32(Number.parseInt(sha256(key).slice(0, 8), 16))()
}

// Deterministic serialization for hashing: keys sorted, undefined-valued entries stripped, so
// the same logical scope/config always produces the same hash regardless of construction order.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
}

/**
 * Value-hash of the knobs that DEFINE the experiment (epsilon + watchlist, order-independent).
 * Everything else on the config (callbacks, attribution stamps, privacy flags) does not change
 * which assignments are drawn, so it stays out of the hash.
 */
export function retrievalHoldoutConfigHash(
  config: Pick<RetrievalHoldoutConfig, 'epsilon' | 'watchlist'>,
): string {
  return sha256(
    canonicalJson({ epsilon: config.epsilon, watchlist: [...(config.watchlist ?? [])].sort() }),
  ).slice(0, 16)
}

// Malformed knobs silently corrupt propensities (epsilon>1 forces holdout with dropPropensity>1;
// epsilon<0 disables it while still logging a control-arm-shaped stream), so fail loud instead.
function assertValidHoldoutConfig(config: RetrievalHoldoutConfig): void {
  const { epsilon, watchlist } = config
  if (typeof epsilon !== 'number' || !Number.isFinite(epsilon) || epsilon < 0 || epsilon > 1) {
    throw new Error(`retrieval holdout epsilon must be a number in [0, 1], got ${String(epsilon)}`)
  }
  if (
    watchlist !== undefined &&
    (!Array.isArray(watchlist) || watchlist.some((id) => typeof id !== 'string'))
  ) {
    throw new Error('retrieval holdout watchlist must be an array of item-id strings')
  }
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
  assertValidHoldoutConfig(config)
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
  const plaintext = config.includePlaintextIdentifiers === true
  return {
    v: 1 as const,
    eventId: randomUUID(),
    ts: new Date().toISOString(),
    ...(config.adapterId !== undefined ? { adapterId: config.adapterId } : {}),
    ...(plaintext && sessionId !== undefined ? { sessionId } : {}),
    ...(ctx.taskId !== undefined ? { taskId: ctx.taskId } : {}),
    ...(sessionId !== undefined ? { sessionIdHash: sha256(sessionId).slice(0, 16) } : {}),
    ...(ctx.query !== undefined ? { queryHash: sha256(ctx.query).slice(0, 16) } : {}),
    ...(plaintext && ctx.scope !== undefined ? { scope: ctx.scope } : {}),
    ...(ctx.scope !== undefined
      ? { scopeHash: sha256(canonicalJson(ctx.scope)).slice(0, 16) }
      : {}),
    config: {
      epsilon: config.epsilon,
      watchlist: [...watchlist],
      ...(config.configVersion !== undefined ? { configVersion: config.configVersion } : {}),
    },
    configHash: retrievalHoldoutConfigHash(config),
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
  assertValidHoldoutConfig(config)
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
// shows up in the log as a mixed-exposure session (same sessionIdHash, different sessionTargetId,
// callIndex restarting at 1), which analysis excludes and counts.
const DEFAULT_MAX_TRACKED_SESSIONS = 10_000
// Keyed by configHash VALUE, not config object identity: callers building options inline pass a
// fresh config object per call (the natural adapter pattern), and identity-keying would silently
// reset callIndex and re-draw the "sticky" target mid-session — one session logged as
// under-treatment for two different items, invalidating the per-item estimate. The outer map is
// bounded by the number of distinct experiment configs, in practice a handful.
const sessionRegistry = new Map<string, Map<string, RetrievalHoldoutSessionState>>()

/**
 * Convenience wrapper that threads session state internally, keyed by the VALUE of the
 * experiment-defining knobs (configHash = epsilon + sorted watchlist) plus sessionId, so a fresh
 * config object per call — the natural pattern when options are built inline — keeps full
 * stickiness. Distinct experiments never share session state; two config objects with the same
 * epsilon/watchlist are the same experiment by definition.
 */
export function applySessionStickyRetrievalHoldout(
  hits: AgentMemoryHit[],
  config: RetrievalHoldoutConfig,
  ctx: Omit<RetrievalHoldoutCallContext, 'session'> = {},
): RetrievalHoldoutResult {
  assertValidHoldoutConfig(config)
  const sessionId = ctx.sessionId ?? ctx.scope?.sessionId
  const configHash = retrievalHoldoutConfigHash(config)
  let sessions = sessionRegistry.get(configHash)
  if (!sessions) {
    sessions = new Map()
    sessionRegistry.set(configHash, sessions)
  }
  const prior = sessionId !== undefined ? sessions.get(sessionId) : undefined
  const result = applyRetrievalHoldout(hits, config, {
    ...ctx,
    ...(prior ? { session: prior } : {}),
  })
  if (sessionId !== undefined && result.session) {
    const cap = config.maxTrackedSessions ?? DEFAULT_MAX_TRACKED_SESSIONS
    if (!sessions.has(sessionId) && sessions.size >= cap) {
      // Oldest-inserted-first: Map preserves insertion order and updates keep position.
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
 * Join keys: events carry `sessionIdHash` (= sha256(sessionId) first 16 hex) by default — compute
 * the same prefix over the outcome table's session ids to join rewards, or set
 * `includePlaintextIdentifiers: true` on the config to join on raw ids. Group and filter by
 * `configHash` so trajectories from different experiment configs are never pooled.
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
