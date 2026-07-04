import {
  inverseProbabilityWeighting,
  selfNormalizedImportanceWeighting,
} from '@tangle-network/agent-eval/rl'
import { describe, expect, it } from 'vitest'
import { sha256 } from '../src/ids'
import type {
  AgentMemoryHit,
  RetrievalHoldoutConfig,
  RetrievalHoldoutEvent,
} from '../src/memory/index'
import {
  applyRetrievalHoldout,
  applySessionStickyRetrievalHoldout,
  createNeo4jAgentMemoryAdapter,
  defaultGetMemoryContext,
  deterministicRng,
  emitRetrievalHoldoutBypass,
  renderMemoryContext,
  retrievalHoldoutBehaviorProb,
  toOffPolicyTrajectory,
} from '../src/memory/index'

function hit(id: string, text: string, score: number): AgentMemoryHit {
  return { id, uri: `memory://test/${id}`, kind: 'fact', text, normalizedScore: score }
}

function collectingConfig(
  overrides: Partial<RetrievalHoldoutConfig> & Pick<RetrievalHoldoutConfig, 'epsilon'>,
): { config: RetrievalHoldoutConfig; events: RetrievalHoldoutEvent[] } {
  const events: RetrievalHoldoutEvent[] = []
  return { config: { onEvent: (event) => events.push(event), ...overrides }, events }
}

describe('retrieval holdout: default-off is a byte-identical no-op', () => {
  it('leaves defaultGetMemoryContext untouched when no holdout is configured', async () => {
    const hits = [hit('m1', 'alpha', 0.9), hit('m7', 'beta', 0.8)]
    const context = await defaultGetMemoryContext({ search: async () => hits }, 'q', {
      scope: { sessionId: 's-1' },
    })
    // Same array instance: the unconfigured code path never copies or filters.
    expect(context.hits).toBe(hits)
    // Frozen from the pre-holdout renderer output; a byte-level drift here fails the test.
    expect(context.text).toBe('[1] fact:m1 score=0.900\nalpha\n\n[2] fact:m7 score=0.800\nbeta')
    expect(context.sourceRecords).toHaveLength(2)
  })
})

describe('retrieval holdout: enabled behavior and event schema', () => {
  // Forces holdout (epsilon 1) and picks index floor(0.6 * |candidates|) deterministically.
  const forcedRng = (key: string) => (key.endsWith('#pick') ? 0.6 : 0)

  it('drops exactly one watchlist item and emits the registered event schema', () => {
    const { config, events } = collectingConfig({
      epsilon: 1,
      watchlist: ['m1', 'm7'],
      configVersion: '2026-07-04a',
      adapterId: 'test-adapter',
      corpusVersion: 'kb-test-1',
      rng: forcedRng,
    })
    const hits = [hit('m1', 'alpha', 0.9), hit('m7', 'beta', 0.8), hit('m3', 'gamma', 0.7)]
    const { delivered, event } = applyRetrievalHoldout(hits, config, {
      sessionId: 's-1',
      taskId: 'task-17',
      query: 'the query',
      scope: { sessionId: 's-1', namespace: 'ns' },
    })

    // sorted(watchlist ∩ E) = ['m1', 'm7']; floor(0.6 * 2) = 1 → 'm7'.
    expect(delivered.map((h) => h.id)).toEqual(['m1', 'm3'])
    expect(events).toHaveLength(1)
    expect(Object.keys(event).sort()).toEqual(
      [
        'adapterId',
        'callIndex',
        'config',
        'corpusVersion',
        'deliveredIds',
        'droppedId',
        'dropPropensity',
        'eligible',
        'eventId',
        'holdoutEligible',
        'pickPropensity',
        'queryHash',
        'rngKey',
        'scope',
        'sessionHoldout',
        'sessionId',
        'sessionTargetId',
        'taskId',
        'ts',
        'v',
        'watchlistEligible',
      ].sort(),
    )
    expect(event.v).toBe(1)
    expect(event.sessionId).toBe('s-1')
    expect(event.taskId).toBe('task-17')
    expect(event.callIndex).toBe(1)
    expect(event.holdoutEligible).toBe(true)
    expect(event.sessionHoldout).toBe(true)
    expect(event.sessionTargetId).toBe('m7')
    expect(event.droppedId).toBe('m7')
    // Draw rule: pick uniform over |watchlist ∩ E| = 2, drop = epsilon * pick.
    expect(event.pickPropensity).toBe(0.5)
    expect(event.dropPropensity).toBe(0.5)
    expect(event.deliveredIds).toEqual(['m1', 'm3'])
    expect(event.watchlistEligible).toEqual(['m1', 'm7'])
    expect(event.eligible).toEqual([
      { id: 'm1', rank: 1, score: 0.9, kind: 'fact', contentHash: sha256('alpha').slice(0, 16) },
      { id: 'm7', rank: 2, score: 0.8, kind: 'fact', contentHash: sha256('beta').slice(0, 16) },
      { id: 'm3', rank: 3, score: 0.7, kind: 'fact', contentHash: sha256('gamma').slice(0, 16) },
    ])
    expect(event.rngKey).toBe(sha256('s-1').slice(0, 16))
    expect(event.queryHash).toBe(sha256('the query').slice(0, 16))
    expect(event.config).toEqual({
      epsilon: 1,
      watchlist: ['m1', 'm7'],
      configVersion: '2026-07-04a',
    })
    expect(event.adapterId).toBe('test-adapter')
    expect(event.corpusVersion).toBe('kb-test-1')
    // The manipulation is invisible: the rendered context renumbers with no gap (design rule D6).
    expect(renderMemoryContext(delivered)).toBe(
      '[1] fact:m1 score=0.900\nalpha\n\n[2] fact:m3 score=0.700\ngamma',
    )
  })

  it('suppresses the same target on every call of the session (sticky), via the adapter path', async () => {
    const { config, events } = collectingConfig({
      epsilon: 1,
      watchlist: ['m1', 'm7'],
      rng: forcedRng,
    })
    const options = { scope: { sessionId: 's-2', tags: { taskId: 'task-9' } }, holdout: config }
    const call1 = await defaultGetMemoryContext(
      { search: async () => [hit('m1', 'alpha', 0.9), hit('m7', 'beta', 0.8)] },
      'q1',
      options,
    )
    const call2 = await defaultGetMemoryContext(
      { search: async () => [hit('m7', 'beta', 0.8), hit('m3', 'gamma', 0.7)] },
      'q2',
      options,
    )
    // Third call's eligibility set no longer contains the target: nothing is dropped,
    // but the sticky target is still reported for mixed-exposure audits.
    const call3 = await defaultGetMemoryContext(
      { search: async () => [hit('m3', 'gamma', 0.7)] },
      'q3',
      options,
    )

    expect(call1.hits.map((h) => h.id)).toEqual(['m1'])
    expect(call2.hits.map((h) => h.id)).toEqual(['m3'])
    expect(call3.hits.map((h) => h.id)).toEqual(['m3'])
    expect(events.map((e) => e.callIndex)).toEqual([1, 2, 3])
    expect(events.map((e) => e.droppedId)).toEqual(['m7', 'm7', null])
    expect(events.map((e) => e.sessionTargetId)).toEqual(['m7', 'm7', 'm7'])
    expect(events.map((e) => e.taskId)).toEqual(['task-9', 'task-9', 'task-9'])
    expect(events.every((e) => e.sessionHoldout)).toBe(true)
  })

  it('emits control-arm events on no-drop calls, including at epsilon 0', () => {
    const { config, events } = collectingConfig({
      epsilon: 0,
      watchlist: ['m1'],
    })
    const hits = [hit('m1', 'alpha', 0.9), hit('m2', 'beta', 0.8)]
    const { delivered, event } = applyRetrievalHoldout(hits, config, { sessionId: 's-3' })

    expect(delivered).toBe(hits)
    expect(events).toHaveLength(1)
    expect(event.holdoutEligible).toBe(true)
    expect(event.sessionHoldout).toBe(false)
    expect(event.droppedId).toBeNull()
    expect(event.sessionTargetId).toBeNull()
    expect(event.pickPropensity).toBeNull()
    expect(event.dropPropensity).toBeNull()
    // The full eligibility set is still logged: control-arm membership is half the data.
    expect(event.eligible.map((e) => e.id)).toEqual(['m1', 'm2'])
    expect(event.deliveredIds).toEqual(['m1', 'm2'])
  })

  it('records pickPropensity 1 and dropPropensity epsilon when one watchlist item is eligible', () => {
    const { config } = collectingConfig({
      epsilon: 0.2,
      watchlist: ['m7', 'm-absent'],
      rng: () => 0,
    })
    const { event } = applyRetrievalHoldout(
      [hit('m7', 'beta', 0.8), hit('m3', 'gamma', 0.7)],
      config,
      {
        sessionId: 's-4',
      },
    )
    expect(event.droppedId).toBe('m7')
    expect(event.pickPropensity).toBe(1)
    expect(event.dropPropensity).toBeCloseTo(0.2, 12)
  })

  it('marks calls without a sessionId as holdout-ineligible and never drops', () => {
    const { config, events } = collectingConfig({ epsilon: 1, watchlist: ['m1'], rng: () => 0 })
    const hits = [hit('m1', 'alpha', 0.9)]
    const { delivered, event } = applyRetrievalHoldout(hits, config, {})

    expect(delivered).toBe(hits)
    expect(events).toHaveLength(1)
    expect(event.holdoutEligible).toBe(false)
    expect(event.sessionHoldout).toBe(false)
    expect(event.droppedId).toBeNull()
    expect(event.callIndex).toBe(0)
  })

  it('threads explicit session state through the pure function identically to the sticky wrapper', () => {
    const { config: pureConfig } = collectingConfig({
      epsilon: 1,
      watchlist: ['m1', 'm7'],
      rng: forcedRng,
    })
    const { config: stickyConfig } = collectingConfig({
      epsilon: 1,
      watchlist: ['m1', 'm7'],
      rng: forcedRng,
    })
    const call1Hits = [hit('m1', 'alpha', 0.9), hit('m7', 'beta', 0.8)]
    const call2Hits = [hit('m7', 'beta', 0.8), hit('m3', 'gamma', 0.7)]

    const pure1 = applyRetrievalHoldout(call1Hits, pureConfig, { sessionId: 's-5' })
    const pure2 = applyRetrievalHoldout(call2Hits, pureConfig, {
      sessionId: 's-5',
      session: pure1.session,
    })
    const sticky1 = applySessionStickyRetrievalHoldout(call1Hits, stickyConfig, {
      sessionId: 's-5',
    })
    const sticky2 = applySessionStickyRetrievalHoldout(call2Hits, stickyConfig, {
      sessionId: 's-5',
    })

    expect(pure1.event.droppedId).toBe(sticky1.event.droppedId)
    expect(pure2.event.droppedId).toBe(sticky2.event.droppedId)
    expect(pure2.event.droppedId).toBe('m7')
    expect(pure2.event.callIndex).toBe(2)
  })
})

describe('retrieval holdout: adapter bypass paths still log the call', () => {
  it('emits a short-term-context bypass event instead of silently skipping the hook', async () => {
    const { config, events } = collectingConfig({
      epsilon: 1,
      watchlist: ['obs-1'],
      adapterId: 'neo4j-test',
      rng: () => 0,
    })
    const client = {
      shortTerm: {
        async getContext(conversationId: string) {
          return {
            observations: [{ id: 'obs-1', content: `Observation for ${conversationId}` }],
            recentMessages: [{ id: 'msg-1', role: 'user', content: 'Keep it brief.' }],
          }
        },
      },
    }
    const adapter = createNeo4jAgentMemoryAdapter({ client })

    const context = await adapter.getContext('style', {
      scope: { sessionId: 'conv-1', tags: { taskId: 'task-3' } },
      holdout: config,
    })

    // The bypass never suppresses: dropping is only meaningful for retrieved memory hits.
    expect(context.hits.map((h) => h.id)).toEqual(['obs-1', 'msg-1'])
    expect(context.text).toContain('Observation for conv-1')
    expect(events).toHaveLength(1)
    const event = events[0]!
    expect(event.bypassReason).toBe('short-term-context')
    expect(event.holdoutEligible).toBe(false)
    expect(event.sessionHoldout).toBe(false)
    expect(event.droppedId).toBeNull()
    expect(event.sessionTargetId).toBeNull()
    expect(event.pickPropensity).toBeNull()
    expect(event.dropPropensity).toBeNull()
    expect(event.callIndex).toBe(0)
    expect(event.sessionId).toBe('conv-1')
    expect(event.taskId).toBe('task-3')
    expect(event.adapterId).toBe('neo4j-test')
    expect(event.watchlistEligible).toEqual(['obs-1'])
    expect(event.eligible.map((e) => e.id)).toEqual(['obs-1', 'msg-1'])
    expect(event.deliveredIds).toEqual(['obs-1', 'msg-1'])
    expect(event.queryHash).toBe(sha256('style').slice(0, 16))
  })

  it('emits a raw-string-context bypass event for string getContext results', async () => {
    const { config, events } = collectingConfig({ epsilon: 1, watchlist: ['w-1'], rng: () => 0 })
    const client = {
      async getContext() {
        return 'Use the private project namespace.'
      },
    }
    const adapter = createNeo4jAgentMemoryAdapter({ client, id: 'neo4j-private' })

    const context = await adapter.getContext('project namespace', { holdout: config })

    expect(context.text).toBe('Use the private project namespace.')
    expect(context.hits).toHaveLength(1)
    expect(events).toHaveLength(1)
    const event = events[0]!
    expect(event.bypassReason).toBe('raw-string-context')
    expect(event.holdoutEligible).toBe(false)
    expect(event.droppedId).toBeNull()
    expect(event.eligible).toEqual([
      {
        id: context.hits[0]!.id,
        rank: 1,
        score: 1,
        kind: 'fact',
        contentHash: sha256('Use the private project namespace.').slice(0, 16),
      },
    ])
    expect(event.deliveredIds).toEqual([context.hits[0]!.id])
    expect(event.sessionId).toBeUndefined()
    expect(event.rngKey).toBeUndefined()
  })
})

describe('retrieval holdout: off-policy conversion for agent-eval estimators', () => {
  // Forces holdout (epsilon 1) and picks index floor(0.6 * |candidates|) deterministically.
  const forcedRng = (key: string) => (key.endsWith('#pick') ? 0.6 : 0)

  it('maps drop, keep, and control events onto OffPolicyTrajectory propensities', () => {
    const { config, events } = collectingConfig({
      epsilon: 1,
      watchlist: ['m1', 'm7'],
      rng: forcedRng,
    })
    const drop = applyRetrievalHoldout([hit('m1', 'alpha', 0.9), hit('m7', 'beta', 0.8)], config, {
      sessionId: 's-ope',
    })
    // Same session, sticky target m7 absent from E: nothing dropped, propensity still logged.
    applyRetrievalHoldout([hit('m3', 'gamma', 0.7)], config, {
      sessionId: 's-ope',
      session: drop.session,
    })
    const { config: controlConfig, events: controlEvents } = collectingConfig({
      epsilon: 0.2,
      watchlist: ['m1', 'm7'],
      // Coin 0.99 >= epsilon: control arm, no pick is ever drawn.
      rng: () => 0.99,
    })
    applyRetrievalHoldout(
      [hit('m1', 'alpha', 0.9), hit('m7', 'beta', 0.8), hit('m3', 'gamma', 0.7)],
      controlConfig,
      { sessionId: 's-ctl' },
    )

    const all = [...events, ...controlEvents]
    const trajectories = toOffPolicyTrajectory(all, {
      reward: (event) => (event.droppedId === null ? 1 : 0),
    })

    // Drop event: behaviorProb = dropPropensity = epsilon * pick = 1 * (1/2).
    expect(trajectories[0]).toEqual({
      runId: all[0]!.eventId,
      reward: 0,
      behaviorProb: 0.5,
      targetProb: 0,
      qHat: null,
    })
    // Keep event in the holdout arm: 1 - epsilon * logged sticky pickPropensity.
    expect(trajectories[1]).toEqual({
      runId: all[1]!.eventId,
      reward: 1,
      behaviorProb: 0.5,
      targetProb: 1,
      qHat: null,
    })
    // Control event: no draw was logged; counterfactual uniform pick over |watchlist ∩ E| = 2.
    expect(trajectories[2]!.behaviorProb).toBeCloseTo(1 - 0.2 * 0.5, 12)
    expect(trajectories[2]!.targetProb).toBe(1)
    expect(trajectories[2]!.reward).toBe(1)
  })

  it('assigns behaviorProb 1 whenever no drop was possible', () => {
    // Holdout-ineligible call: no sessionId, no randomization happened.
    const { config } = collectingConfig({ epsilon: 1, watchlist: ['m1'], rng: () => 0 })
    const ineligible = applyRetrievalHoldout([hit('m1', 'alpha', 0.9)], config, {}).event
    expect(retrievalHoldoutBehaviorProb(ineligible)).toBe(1)

    // Control session whose eligibility set never intersects the watchlist.
    const { config: missConfig } = collectingConfig({
      epsilon: 0.2,
      watchlist: ['m-absent'],
      rng: () => 0.99,
    })
    const miss = applyRetrievalHoldout([hit('m3', 'gamma', 0.7)], missConfig, {
      sessionId: 's-miss',
    }).event
    expect(retrievalHoldoutBehaviorProb(miss)).toBe(1)

    // Adapter bypass event: the call never reached retrieval.
    const { config: bypassConfig } = collectingConfig({ epsilon: 1, watchlist: ['m1'] })
    const bypass = emitRetrievalHoldoutBypass(
      [hit('m1', 'alpha', 0.9)],
      bypassConfig,
      { query: 'q', scope: { sessionId: 's-bypass' } },
      'short-term-context',
    )
    expect(retrievalHoldoutBehaviorProb(bypass)).toBe(1)
  })

  it('fails loud on a corrupt drop event missing its propensity', () => {
    const { config } = collectingConfig({ epsilon: 1, watchlist: ['m1'], rng: () => 0 })
    const { event } = applyRetrievalHoldout([hit('m1', 'alpha', 0.9)], config, {
      sessionId: 's-bad',
    })
    expect(() => retrievalHoldoutBehaviorProb({ ...event, dropPropensity: null })).toThrow(
      'without dropPropensity',
    )
  })

  it('honors custom targetProb and qHat callbacks', () => {
    const { config, events } = collectingConfig({ epsilon: 1, watchlist: ['m1'], rng: () => 0 })
    applyRetrievalHoldout([hit('m1', 'alpha', 0.9)], config, { sessionId: 's-custom' })

    const [trajectory] = toOffPolicyTrajectory(events, {
      reward: () => 0.75,
      targetProb: () => 0.25,
      qHat: () => 0.5,
    })
    expect(trajectory).toEqual({
      runId: events[0]!.eventId,
      reward: 0.75,
      behaviorProb: 1,
      targetProb: 0.25,
      qHat: 0.5,
    })
  })

  it('feeds converted logs into agent-eval IPS/SNIPS end to end', () => {
    // 10 holdout + 10 control sessions at epsilon 0.5 with a single watchlist item:
    // drops have behaviorProb 0.5, keeps 0.5, so the always-deliver target policy
    // (weight 0 on drops, 2 on keeps) recovers the delivered-arm mean reward exactly.
    const { config, events } = collectingConfig({
      epsilon: 0.5,
      watchlist: ['m1'],
      rng: (key) => (key.includes('holdout-session') ? 0 : 0.99),
    })
    for (let i = 0; i < 10; i += 1) {
      applyRetrievalHoldout([hit('m1', 'alpha', 0.9), hit('m2', 'beta', 0.8)], config, {
        sessionId: `holdout-session-${i}`,
      })
      applyRetrievalHoldout([hit('m1', 'alpha', 0.9), hit('m2', 'beta', 0.8)], config, {
        sessionId: `control-session-${i}`,
      })
    }
    const trajectories = toOffPolicyTrajectory(events, {
      reward: (event) => (event.droppedId === null ? 1 : 0),
    })

    expect(events.filter((e) => e.droppedId !== null)).toHaveLength(10)
    const ips = inverseProbabilityWeighting(trajectories)
    const snips = selfNormalizedImportanceWeighting(trajectories)
    expect(ips.n).toBe(20)
    expect(ips.value).toBeCloseTo(1, 12)
    expect(snips.value).toBeCloseTo(1, 12)
    expect(ips.maxImportanceWeight).toBeCloseTo(2, 12)
  })
})

describe('retrieval holdout: empirical calibration of the default rng', () => {
  it('drops at a rate matching epsilon over 10^4 simulated sessions', () => {
    const epsilon = 0.2
    const { config, events } = collectingConfig({ epsilon, watchlist: ['m1', 'm7'] })
    const n = 10_000
    for (let i = 0; i < n; i += 1) {
      applyRetrievalHoldout([hit('m1', 'alpha', 0.9), hit('m7', 'beta', 0.8)], config, {
        sessionId: `session-${i}`,
      })
    }
    const drops = events.filter((e) => e.droppedId !== null)
    const dropRate = drops.length / n
    // Binomial sd at n=1e4, p=0.2 is 0.004; ±0.015 is ~3.75 sd, and the default rng is
    // deterministic so this either always passes or flags a real bias.
    expect(dropRate).toBeGreaterThan(epsilon - 0.015)
    expect(dropRate).toBeLessThan(epsilon + 0.015)
    // The uniform pick over two sorted candidates should split drops roughly evenly.
    const m1Share = drops.filter((e) => e.droppedId === 'm1').length / drops.length
    expect(m1Share).toBeGreaterThan(0.4)
    expect(m1Share).toBeLessThan(0.6)
    // Replayability (design rule D5): the same sessionId reproduces the same decision.
    expect(deterministicRng('session-0#holdout')).toBe(deterministicRng('session-0#holdout'))
  })
})
