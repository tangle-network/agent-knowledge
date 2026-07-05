import {
  doublyRobust,
  inverseProbabilityWeighting,
  selfNormalizedImportanceWeighting,
} from '@tangle-network/agent-eval/rl'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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
  resetRetrievalHoldoutRegistry,
  retrievalHoldoutConfigHash,
  toOffPolicyTrajectory,
} from '../src/memory/index'

/** sessionIdHash as events carry it: sha256(sessionId) first 16 hex. */
function sid(sessionId: string): string {
  return sha256(sessionId).slice(0, 16)
}

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
        'configHash',
        'corpusVersion',
        'deliveredIds',
        'droppedId',
        'dropPropensity',
        'eligible',
        'eventId',
        'holdoutEligible',
        'pickPropensity',
        'queryHash',
        'scopeHash',
        'sessionHoldout',
        'sessionIdHash',
        'sessionTargetId',
        'taskId',
        'ts',
        'v',
        'watchlistEligible',
      ].sort(),
    )
    expect(event.v).toBe(1)
    // Default-private: plaintext sessionId/scope are opt-in via includePlaintextIdentifiers.
    expect(event.sessionId).toBeUndefined()
    expect(event.scope).toBeUndefined()
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
    expect(event.sessionIdHash).toBe(sha256('s-1').slice(0, 16))
    expect(event.scopeHash).toBe(sha256('{"namespace":"ns","sessionId":"s-1"}').slice(0, 16))
    expect(event.queryHash).toBe(sha256('the query').slice(0, 16))
    expect(event.config).toEqual({
      epsilon: 1,
      watchlist: ['m1', 'm7'],
      configVersion: '2026-07-04a',
    })
    expect(event.configHash).toBe(
      retrievalHoldoutConfigHash({ epsilon: 1, watchlist: ['m1', 'm7'] }),
    )
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
    expect(event.sessionId).toBeUndefined()
    expect(event.sessionIdHash).toBe(sha256('conv-1').slice(0, 16))
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
    expect(event.sessionIdHash).toBeUndefined()
  })
})

describe('retrieval holdout: value-keyed session registry', () => {
  const forcedRng = (key: string) => (key.endsWith('#pick') ? 0.6 : 0)

  beforeEach(() => {
    resetRetrievalHoldoutRegistry()
  })

  it('keeps stickiness when a FRESH config object is built per call', async () => {
    const events: RetrievalHoldoutEvent[] = []
    // The natural adapter pattern: options (and the holdout config inside them) built inline
    // per retrieval. Identity-keyed state would miss on every call.
    const freshConfig = (): RetrievalHoldoutConfig => ({
      epsilon: 1,
      watchlist: ['m1', 'm3', 'm7'],
      rng: forcedRng,
      onEvent: (event) => events.push(event),
    })

    // Reviewer repro: call1 candidates sorted(watchlist ∩ E) = [m1, m7] → floor(0.6·2) = 1 → m7.
    // A registry miss on call2 would re-draw over [m1, m3, m7] (floor(0.6·3) = 1 → m3),
    // logging one session as under-treatment for two different items.
    const call1 = await defaultGetMemoryContext(
      { search: async () => [hit('m1', 'alpha', 0.9), hit('m7', 'beta', 0.8)] },
      'q1',
      { scope: { sessionId: 's-fresh' }, holdout: freshConfig() },
    )
    const call2 = await defaultGetMemoryContext(
      {
        search: async () => [
          hit('m1', 'alpha', 0.9),
          hit('m3', 'gamma', 0.7),
          hit('m7', 'beta', 0.8),
        ],
      },
      'q2',
      { scope: { sessionId: 's-fresh' }, holdout: freshConfig() },
    )

    expect(call1.hits.map((h) => h.id)).toEqual(['m1'])
    expect(call2.hits.map((h) => h.id)).toEqual(['m1', 'm3'])
    expect(events.map((e) => e.callIndex)).toEqual([1, 2])
    expect(events.map((e) => e.droppedId)).toEqual(['m7', 'm7'])
    expect(events.map((e) => e.sessionTargetId)).toEqual(['m7', 'm7'])
    expect(new Set(events.map((e) => e.configHash)).size).toBe(1)
  })

  it('computes configHash order-independently and only from experiment-defining knobs', () => {
    expect(retrievalHoldoutConfigHash({ epsilon: 0.2, watchlist: ['b', 'a'] })).toBe(
      retrievalHoldoutConfigHash({ epsilon: 0.2, watchlist: ['a', 'b'] }),
    )
    expect(retrievalHoldoutConfigHash({ epsilon: 0.2, watchlist: ['a'] })).not.toBe(
      retrievalHoldoutConfigHash({ epsilon: 0.3, watchlist: ['a'] }),
    )
    expect(retrievalHoldoutConfigHash({ epsilon: 0.2 })).toBe(
      retrievalHoldoutConfigHash({ epsilon: 0.2, watchlist: [] }),
    )
  })

  it('evicts oldest-first at the cap and re-drawn targets surface as mixed exposure', () => {
    const events: RetrievalHoldoutEvent[] = []
    const config: RetrievalHoldoutConfig = {
      epsilon: 1,
      watchlist: ['e1', 'e5', 'e9'],
      maxTrackedSessions: 2,
      rng: (key) => (key.endsWith('#pick') ? 0.6 : 0),
      onEvent: (event) => events.push(event),
    }
    // Candidates sorted(watchlist ∩ E) = [e1, e9] → floor(0.6·2) = 1 → e9.
    const richHits = [hit('e1', 'one', 0.9), hit('e9', 'nine', 0.8)]

    const a1 = applySessionStickyRetrievalHoldout(richHits, config, { sessionId: 'evict-a' })
    expect(a1.event.sessionTargetId).toBe('e9')
    applySessionStickyRetrievalHoldout(richHits, config, { sessionId: 'evict-b' })
    // Inserting C at cap 2 evicts A, the oldest-inserted session.
    applySessionStickyRetrievalHoldout(richHits, config, { sessionId: 'evict-c' })

    // B survived: its second call continues callIndex 2 with the same sticky target.
    const b2 = applySessionStickyRetrievalHoldout(richHits, config, { sessionId: 'evict-b' })
    expect(b2.event.callIndex).toBe(2)
    expect(b2.event.sessionTargetId).toBe('e9')

    // A returns after eviction with a narrower eligibility set: state was lost, so the target
    // is re-drawn over [e1] alone — a different item than A's first exposure.
    const a2 = applySessionStickyRetrievalHoldout([hit('e1', 'one', 0.9)], config, {
      sessionId: 'evict-a',
    })
    expect(a2.event.sessionTargetId).toBe('e1')
    expect(a2.event.droppedId).toBe('e1')

    // The detectable mixed-exposure signature the analysis excludes and counts:
    // same session hash, two different targets, callIndex reset to 1.
    const aEvents = events.filter((e) => e.sessionIdHash === sha256('evict-a').slice(0, 16))
    expect(aEvents.map((e) => e.sessionTargetId)).toEqual(['e9', 'e1'])
    expect(aEvents.map((e) => e.callIndex)).toEqual([1, 1])
  })
})

describe('retrieval holdout: privacy defaults on event identifiers', () => {
  it('emits plaintext sessionId and scope only with includePlaintextIdentifiers', () => {
    const scope = { sessionId: 's-pii', userId: 'user-9', tags: { team: 'gtm' } }
    const { config, events } = collectingConfig({ epsilon: 0, watchlist: ['m1'] })
    applyRetrievalHoldout([hit('m1', 'alpha', 0.9)], config, { scope })
    const { config: openConfig, events: openEvents } = collectingConfig({
      epsilon: 0,
      watchlist: ['m1'],
      includePlaintextIdentifiers: true,
    })
    applyRetrievalHoldout([hit('m1', 'alpha', 0.9)], openConfig, { scope })

    const priv = events[0]!
    expect(priv.sessionId).toBeUndefined()
    expect(priv.scope).toBeUndefined()
    expect(priv.sessionIdHash).toBe(sha256('s-pii').slice(0, 16))
    expect(priv.scopeHash).toBe(
      sha256('{"sessionId":"s-pii","tags":{"team":"gtm"},"userId":"user-9"}').slice(0, 16),
    )

    const open = openEvents[0]!
    expect(open.sessionId).toBe('s-pii')
    expect(open.scope).toEqual(scope)
    // Hashes stay present either way, so both log shapes share the same join keys.
    expect(open.sessionIdHash).toBe(priv.sessionIdHash)
    expect(open.scopeHash).toBe(priv.scopeHash)
  })

  it('canonical hashing rejects bigint values instead of hashing a lossy form', () => {
    const { config } = collectingConfig({ epsilon: 0 })
    expect(() =>
      applyRetrievalHoldout([], config, {
        scope: { tags: { n: 1n as unknown as string } },
      }),
    ).toThrow(TypeError)
  })
})

describe('retrieval holdout: onEvent sink failures never break retrieval', () => {
  it('logs and continues when the sink throws, identically on randomized and bypass paths', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const config: RetrievalHoldoutConfig = {
        epsilon: 1,
        watchlist: ['m1'],
        rng: () => 0,
        onEvent: () => {
          throw new Error('sink down')
        },
      }
      const hits = [hit('m1', 'alpha', 0.9), hit('m2', 'beta', 0.8)]
      const { delivered, event } = applyRetrievalHoldout(hits, config, { sessionId: 's-sink' })
      // Suppression still applied and the event still returned: only persistence was lost.
      expect(delivered.map((h) => h.id)).toEqual(['m2'])
      expect(event.droppedId).toBe('m1')
      const bypass = emitRetrievalHoldoutBypass(hits, config, { query: 'q' }, 'raw-string-context')
      expect(bypass.bypassReason).toBe('raw-string-context')
      expect(errorSpy).toHaveBeenCalledTimes(2)
    } finally {
      errorSpy.mockRestore()
    }
  })
})

describe('retrieval holdout: config validation fails loud', () => {
  const onEvent = () => {}

  it('rejects epsilon outside [0, 1]', () => {
    expect(() =>
      applyRetrievalHoldout(
        [hit('m1', 'alpha', 0.9)],
        { epsilon: 1.5, watchlist: ['m1'], onEvent },
        { sessionId: 's-v1' },
      ),
    ).toThrow('epsilon must be a number in [0, 1]')
    expect(() => applyRetrievalHoldout([], { epsilon: -0.1, onEvent })).toThrow(
      'epsilon must be a number in [0, 1]',
    )
    expect(() => applyRetrievalHoldout([], { epsilon: Number.NaN, onEvent })).toThrow('epsilon')
  })

  it('rejects a watchlist that is not an array of strings', () => {
    expect(() =>
      applyRetrievalHoldout([], { epsilon: 0.5, watchlist: [7 as unknown as string], onEvent }),
    ).toThrow('watchlist must be an array of item-id strings')
    expect(() =>
      emitRetrievalHoldoutBypass(
        [],
        { epsilon: 0.5, watchlist: 'm1' as unknown as string[], onEvent },
        {},
        'raw-string-context',
      ),
    ).toThrow('watchlist must be an array of item-id strings')
  })

  it('validates before the sticky wrapper touches the registry', () => {
    expect(() =>
      applySessionStickyRetrievalHoldout([], { epsilon: 2, onEvent }, { sessionId: 's-v2' }),
    ).toThrow('epsilon must be a number in [0, 1]')
  })
})

describe('retrieval holdout: watchlist and score edge cases', () => {
  it('with an empty or omitted watchlist the event is still emitted and nothing is ever dropped', () => {
    const { config, events } = collectingConfig({ epsilon: 1, watchlist: [], rng: () => 0 })
    const hits = [hit('m1', 'alpha', 0.9), hit('m2', 'beta', 0.8)]
    const { delivered, event } = applyRetrievalHoldout(hits, config, { sessionId: 's-empty' })

    // Delivery identity is preserved on the no-drop path even in a holdout-arm session.
    expect(delivered).toBe(hits)
    expect(events).toHaveLength(1)
    // The epsilon coin is independent of the watchlist, but no target can ever be drawn.
    expect(event.sessionHoldout).toBe(true)
    expect(event.sessionTargetId).toBeNull()
    expect(event.droppedId).toBeNull()
    expect(event.pickPropensity).toBeNull()
    expect(event.watchlistEligible).toEqual([])
    expect(event.eligible.map((e) => e.id)).toEqual(['m1', 'm2'])
    expect(event.deliveredIds).toEqual(['m1', 'm2'])

    const { config: omitted, events: omittedEvents } = collectingConfig({
      epsilon: 1,
      rng: () => 0,
    })
    const result = applyRetrievalHoldout(hits, omitted, { sessionId: 's-omitted' })
    expect(result.delivered).toBe(hits)
    expect(omittedEvents).toHaveLength(1)
    expect(omittedEvents[0]!.droppedId).toBeNull()
    expect(omittedEvents[0]!.config.watchlist).toEqual([])
  })

  it('falls back to the raw score when normalizedScore is absent', () => {
    const { config } = collectingConfig({ epsilon: 0 })
    const scoreOnly: AgentMemoryHit = {
      id: 'm-s',
      uri: 'memory://test/m-s',
      kind: 'fact',
      text: 'raw',
      score: 0.42,
    }
    const { event } = applyRetrievalHoldout([scoreOnly], config, { sessionId: 's-score' })
    expect(event.eligible[0]).toEqual({
      id: 'm-s',
      rank: 1,
      score: 0.42,
      kind: 'fact',
      contentHash: sha256('raw').slice(0, 16),
    })
  })
})

describe('retrieval holdout: session-level off-policy conversion', () => {
  // Forces holdout (epsilon 1) and picks index floor(0.6 * |candidates|) deterministically.
  const forcedRng = (key: string) => (key.endsWith('#pick') ? 0.6 : 0)

  it('emits ONE trajectory per session; t>1 target-absent calls fold in without a propensity', () => {
    const { config, events } = collectingConfig({
      epsilon: 1,
      watchlist: ['m1', 'm7'],
      rng: forcedRng,
    })
    const drop = applyRetrievalHoldout([hit('m1', 'alpha', 0.9), hit('m7', 'beta', 0.8)], config, {
      sessionId: 's-ope',
    })
    // Second call of the SAME session with the sticky target absent from E: this is a repeated
    // observation within one randomization, never an independent draw.
    applyRetrievalHoldout([hit('m3', 'gamma', 0.7)], config, {
      sessionId: 's-ope',
      session: drop.session,
    })

    const result = toOffPolicyTrajectory(events, { rewards: { [sid('s-ope')]: 0 } })
    expect(result.trajectories).toHaveLength(1)
    expect(result.trajectories[0]).toEqual({
      runId: `${events[0]!.configHash}:${sid('s-ope')}`,
      reward: 0,
      // Session-level P(drop m7) = epsilon / |watchlist ∩ E_first| = 1/2, the logged
      // draw-time dropPropensity.
      behaviorProb: 0.5,
      targetProb: 0,
      qHat: null,
    })
    expect(result.sessions[0]).toMatchObject({
      callCount: 2,
      bypassCallCount: 0,
      droppedId: 'm7',
      sessionTargetId: 'm7',
      firstCandidateCount: 2,
      mixedExposure: false,
    })
    expect(result.excluded).toHaveLength(0)
    expect(result.unattributableEvents).toBe(0)
  })

  it('assigns control sessions behaviorProb 1 − epsilon, the session-level assignment probability', () => {
    const { config, events } = collectingConfig({
      epsilon: 0.2,
      watchlist: ['m1', 'm7'],
      // Coin 0.99 >= epsilon: control arm.
      rng: () => 0.99,
    })
    applyRetrievalHoldout(
      [hit('m1', 'alpha', 0.9), hit('m7', 'beta', 0.8), hit('m3', 'gamma', 0.7)],
      config,
      { sessionId: 's-ctl' },
    )
    const { trajectories } = toOffPolicyTrajectory(events, { rewards: { [sid('s-ctl')]: 1 } })
    // NOT 1 − epsilon·pick (a per-item survival probability): P(control) = 1 − epsilon.
    expect(trajectories[0]!.behaviorProb).toBeCloseTo(0.8, 12)
    expect(trajectories[0]!.targetProb).toBe(1)
    expect(trajectories[0]!.reward).toBe(1)
  })

  it('property: session-level action probabilities sum to 1 over the (epsilon, k) grid', () => {
    for (const epsilon of [0.1, 0.5, 0.9]) {
      for (const k of [1, 2, 5]) {
        const ids = Array.from({ length: k }, (_, i) => `w${i}`)
        const hits = ids.map((id, i) => hit(id, `text-${id}`, 1 - i * 0.01))
        const rewards: Record<string, number> = {}
        const events: RetrievalHoldoutEvent[] = []
        const mkConfig = (rig: (key: string) => number): RetrievalHoldoutConfig => ({
          epsilon,
          watchlist: ids,
          rng: rig,
          onEvent: (event) => events.push(event),
        })
        // One control session plus k holdout sessions realizing each drop action once
        // (the pick rig lands on candidate i exactly: floor(((i + 0.5) / k) · k) = i).
        const ctlSession = `grid-ctl-${epsilon}-${k}`
        applyRetrievalHoldout(
          hits,
          mkConfig(() => 0.999999),
          { sessionId: ctlSession },
        )
        rewards[sid(ctlSession)] = 1
        for (let i = 0; i < k; i += 1) {
          const holdoutSession = `grid-h-${epsilon}-${k}-${i}`
          applyRetrievalHoldout(
            hits,
            mkConfig((key) => (key.endsWith('#pick') ? (i + 0.5) / k : 0)),
            { sessionId: holdoutSession },
          )
          rewards[sid(holdoutSession)] = 1
        }

        const { trajectories, sessions } = toOffPolicyTrajectory(events, { rewards })
        expect(trajectories).toHaveLength(k + 1)
        const drops = sessions.filter((s) => s.droppedId !== null)
        // All k drop actions enumerated, each with probability epsilon / k.
        expect(new Set(drops.map((s) => s.droppedId)).size).toBe(k)
        for (const s of drops) expect(s.behaviorProb).toBeCloseTo(epsilon / k, 12)
        const control = sessions.find((s) => s.droppedId === null)
        expect(control!.behaviorProb).toBeCloseTo(1 - epsilon, 12)
        const total = control!.behaviorProb + drops.reduce((acc, s) => acc + s.behaviorProb, 0)
        expect(total).toBeCloseTo(1, 12)
      }
    }
  })

  it('regression: IPS recovers 1.000 on the audit 100-session scenario (per-call gave 0.667)', () => {
    const rewards: Record<string, number> = {}
    const { config, events } = collectingConfig({
      epsilon: 0.5,
      watchlist: ['m1', 'm7'],
      rng: (key) => (key.includes(':h:') ? (key.endsWith('#pick') ? 0.6 : 0) : 0.99),
    })
    for (let i = 0; i < 50; i += 1) {
      const holdoutSession = `sim:h:${i}`
      const controlSession = `sim:c:${i}`
      applyRetrievalHoldout([hit('m1', 'alpha', 0.9), hit('m7', 'beta', 0.8)], config, {
        sessionId: holdoutSession,
      })
      applyRetrievalHoldout([hit('m1', 'alpha', 0.9), hit('m7', 'beta', 0.8)], config, {
        sessionId: controlSession,
      })
      rewards[sid(holdoutSession)] = 0
      rewards[sid(controlSession)] = 1
    }

    const { trajectories, sessions } = toOffPolicyTrajectory(events, { rewards })
    expect(trajectories).toHaveLength(100)
    expect(sessions.filter((s) => s.droppedId !== null)).toHaveLength(50)
    const ips = inverseProbabilityWeighting(trajectories)
    const snips = selfNormalizedImportanceWeighting(trajectories)
    expect(ips.n).toBe(100)
    // True always-deliver value is 1: controls weigh 1/(1−ε) = 2, drops weigh 0.
    // The per-call converter weighed controls 1/(1−ε·pick) = 4/3 and measured 0.667 here.
    expect(ips.value).toBeCloseTo(1, 12)
    expect(snips.value).toBeCloseTo(1, 12)
    expect(ips.maxImportanceWeight).toBeCloseTo(2, 12)
  })

  it('IPS and SNIPS diverge under arm imbalance with mixed candidate counts; DR recovers with a truthful qHat', () => {
    const rewards: Record<string, number> = {}
    const events: RetrievalHoldoutEvent[] = []
    const cfg = (rig: (key: string) => number): RetrievalHoldoutConfig => ({
      epsilon: 0.5,
      watchlist: ['m1', 'm7'],
      rng: rig,
      onEvent: (event) => events.push(event),
    })
    for (let i = 0; i < 4; i += 1) {
      const s = `div-c-${i}`
      applyRetrievalHoldout(
        [hit('m1', 'alpha', 0.9), hit('m7', 'beta', 0.8)],
        cfg(() => 0.99),
        { sessionId: s },
      )
      rewards[sid(s)] = 1
    }
    // Two holdout sessions with DIFFERENT candidate-set sizes: k=2 → ε/k = 0.25, k=1 → 0.5.
    applyRetrievalHoldout(
      [hit('m1', 'alpha', 0.9), hit('m7', 'beta', 0.8)],
      cfg((key) => (key.endsWith('#pick') ? 0.6 : 0)),
      { sessionId: 'div-h-k2' },
    )
    rewards[sid('div-h-k2')] = 0
    applyRetrievalHoldout(
      [hit('m7', 'beta', 0.8)],
      cfg(() => 0),
      { sessionId: 'div-h-k1' },
    )
    rewards[sid('div-h-k1')] = 0

    const { trajectories, sessions } = toOffPolicyTrajectory(events, { rewards })
    expect(
      sessions
        .filter((s) => s.droppedId !== null)
        .map((s) => s.behaviorProb)
        .sort((a, b) => a - b),
    ).toEqual([0.25, 0.5])
    const ips = inverseProbabilityWeighting(trajectories)
    const snips = selfNormalizedImportanceWeighting(trajectories)
    // 4 controls at weight 2, 2 drops at weight 0: Σw·r = 8 over n = 6 vs Σw = 8.
    expect(ips.value).toBeCloseTo(8 / 6, 12)
    expect(snips.value).toBeCloseTo(1, 12)
    expect(Math.abs(ips.value - snips.value)).toBeGreaterThan(0.2)
    // Doubly-robust with a truthful per-session qHat is exact despite the imbalance.
    const dr = doublyRobust(toOffPolicyTrajectory(events, { rewards, qHat: () => 1 }).trajectories)
    expect(dr.value).toBeCloseTo(1, 12)
  })

  it('honors custom targetProb and qHat callbacks per session', () => {
    const { config, events } = collectingConfig({
      epsilon: 0.2,
      watchlist: ['m1'],
      rng: () => 0.99,
    })
    applyRetrievalHoldout([hit('m1', 'alpha', 0.9)], config, { sessionId: 's-cb' })
    const { trajectories } = toOffPolicyTrajectory(events, {
      rewards: { [sid('s-cb')]: 0.75 },
      targetProb: (session) => (session.droppedId === null ? 0.25 : 0),
      qHat: () => 0.5,
    })
    expect(trajectories[0]).toMatchObject({
      reward: 0.75,
      behaviorProb: 0.8,
      targetProb: 0.25,
      qHat: 0.5,
    })
  })

  it('excludes mixed-exposure and bypass-only sessions, surfacing them with reasons', () => {
    const { config, events } = collectingConfig({
      epsilon: 1,
      watchlist: ['e1', 'e9'],
      rng: (key) => (key.endsWith('#pick') ? 0.6 : 0),
    })
    // Two calls of one session WITHOUT threaded state and with different eligibility sets:
    // fresh draws land on different targets — the mixed-exposure signature.
    applyRetrievalHoldout([hit('e1', 'one', 0.9), hit('e9', 'nine', 0.8)], config, {
      sessionId: 's-mixed',
    })
    applyRetrievalHoldout([hit('e1', 'one', 0.9)], config, { sessionId: 's-mixed' })
    // A session that only ever hit adapter bypass paths.
    emitRetrievalHoldoutBypass(
      [hit('m1', 'alpha', 0.9)],
      config,
      { query: 'q', scope: { sessionId: 's-bypass-only' } },
      'short-term-context',
    )
    // An event with no session at all.
    applyRetrievalHoldout([hit('e1', 'one', 0.9)], config, {})

    const result = toOffPolicyTrajectory(events, { rewards: {} })
    expect(result.trajectories).toHaveLength(0)
    expect(result.excluded.map((s) => s.exclusionReason).sort()).toEqual([
      'mixed-exposure',
      'no-randomized-calls',
    ])
    const mixed = result.excluded.find((s) => s.exclusionReason === 'mixed-exposure')
    expect(mixed).toMatchObject({ mixedExposure: true, sessionIdHash: sid('s-mixed') })
    const bypassOnly = result.excluded.find((s) => s.exclusionReason === 'no-randomized-calls')
    expect(bypassOnly).toMatchObject({ callCount: 0, bypassCallCount: 1 })
    expect(result.unattributableEvents).toBe(1)
  })

  it('fails loud when an included session has no reward', () => {
    const { config, events } = collectingConfig({ epsilon: 0, watchlist: ['m1'] })
    applyRetrievalHoldout([hit('m1', 'alpha', 0.9)], config, { sessionId: 's-unscored' })
    expect(() => toOffPolicyTrajectory(events, { rewards: {} })).toThrow('no reward for session')
  })

  it('fails loud on a corrupt drop event and on a batch missing the draw call', () => {
    const { config, events } = collectingConfig({ epsilon: 1, watchlist: ['m1'], rng: () => 0 })
    const drop = applyRetrievalHoldout([hit('m1', 'alpha', 0.9)], config, {
      sessionId: 's-corrupt',
    })
    const corrupted = events.map((event) => ({ ...event, dropPropensity: null }))
    expect(() => toOffPolicyTrajectory(corrupted, { rewards: { [sid('s-corrupt')]: 0 } })).toThrow(
      'without dropPropensity',
    )

    // Batch containing only the t=2 target-absent call: the drawn target proves the draw call
    // is missing, and weighting the partial session would bias the estimate.
    const { event: absentCall } = applyRetrievalHoldout([hit('m3', 'gamma', 0.7)], config, {
      sessionId: 's-corrupt',
      session: drop.session,
    })
    expect(absentCall.sessionTargetId).toBe('m1')
    expect(absentCall.droppedId).toBeNull()
    expect(() =>
      toOffPolicyTrajectory([absentCall], { rewards: { [sid('s-corrupt')]: 0 } }),
    ).toThrow('missing this session draw call')
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
