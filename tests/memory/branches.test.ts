import { describe, expect, it } from 'vitest'
import {
  type AgentMemoryAdapter,
  type AgentMemoryHit,
  type AgentMemoryScope,
  createAgentMemoryBranch,
  createNeo4jAgentMemoryAdapter,
  forkAgentMemoryBranchSnapshot,
} from '../../src/memory/index'
import { createScopedTestAdapter, hitText } from '../support/memory'

describe('memory branches', () => {
  it('rejects two live handles for the same adapter branch', async () => {
    const adapter = createScopedTestAdapter('duplicate-handle')
    const first = createAgentMemoryBranch({ adapter, branchId: 'same-branch' })

    expect(() => createAgentMemoryBranch({ adapter, branchId: 'same-branch' })).toThrow(
      "memory branch 'same-branch' already has an open handle",
    )

    await first.close?.()
    const resumed = createAgentMemoryBranch({ adapter, branchId: 'same-branch' })
    await resumed.close?.()
  })

  it('rejects adapters that do not declare how branches are isolated', () => {
    const { branchIsolation: _branchIsolation, ...legacy } = createScopedTestAdapter('legacy')

    expect(() =>
      createAgentMemoryBranch({
        adapter: legacy,
        branchId: 'candidate-a',
      }),
    ).toThrow(/adapter must declare branchIsolation/)
  })

  it('rejects Neo4j clients that were not isolated for the exact branch', () => {
    const unscoped = createNeo4jAgentMemoryAdapter({ client: {}, transport: 'rest' })
    expect(() => createAgentMemoryBranch({ adapter: unscoped, branchId: 'candidate-a' })).toThrow(
      'create a separate MemoryClient namespace per branch',
    )

    const scoped = createNeo4jAgentMemoryAdapter({
      client: {},
      transport: 'rest',
      branchId: 'candidate-a',
    })
    expect(
      createAgentMemoryBranch({
        adapter: scoped,
        branchId: 'candidate-a',
        policy: { read: ['shared'], write: 'shared' },
      }).branchId,
    ).toBe('candidate-a')
    expect(() => createAgentMemoryBranch({ adapter: scoped, branchId: 'candidate-a' })).toThrow(
      'only shared memory policy',
    )
    expect(() => createAgentMemoryBranch({ adapter: scoped, branchId: 'candidate-b' })).toThrow(
      "adapter instance belongs to branch 'candidate-a'",
    )
  })

  it('isolates branches and private agents while allowing team sharing', async () => {
    const storage = createScopedTestAdapter('scoped')
    const alpha = createAgentMemoryBranch({
      adapter: storage,
      branchId: 'alpha',
      policy: { read: ['private'], write: 'private' },
      baseScope: { tenantId: 'tenant', userId: 'user' },
    })
    const beta = createAgentMemoryBranch({
      adapter: storage,
      branchId: 'beta',
      policy: { read: ['private'], write: 'private' },
      baseScope: { tenantId: 'tenant', userId: 'user' },
    })

    await alpha.write({
      kind: 'fact',
      text: 'alpha private',
      scope: { agentId: 'agent-a', teamId: 'team-1' },
    })
    await beta.write({
      kind: 'fact',
      text: 'beta private',
      scope: { agentId: 'agent-a', teamId: 'team-1' },
    })

    expect((await alpha.search('private', { scope: { agentId: 'agent-a' } })).map(hitText)).toEqual(
      ['alpha private'],
    )
    expect((await alpha.search('private', { scope: { agentId: 'agent-b' } })).map(hitText)).toEqual(
      [],
    )
    expect((await beta.search('private', { scope: { agentId: 'agent-a' } })).map(hitText)).toEqual([
      'beta private',
    ])

    const team = createAgentMemoryBranch({
      adapter: storage,
      branchId: 'team-branch',
      policy: { read: ['team'], write: 'team' },
      baseScope: { tenantId: 'tenant', userId: 'user' },
    })
    await team.write({
      kind: 'observation',
      text: 'shared with the team',
      scope: { agentId: 'agent-a', teamId: 'team-1' },
    })
    const teamHits = await team.search('team', {
      scope: { agentId: 'agent-b', teamId: 'team-1' },
    })
    expect(teamHits.map(hitText)).toEqual(['shared with the team'])
  })

  it('removes every journal entry in a provider partition cleared through a narrower scope', async () => {
    const branch = createAgentMemoryBranch({
      adapter: createScopedTestAdapter('team-clear'),
      branchId: 'team-clear',
      policy: { read: ['team'], write: 'team' },
      baseScope: { tenantId: 'tenant', teamId: 'team-1' },
    })
    await branch.write({ kind: 'fact', text: 'from a', scope: { agentId: 'agent-a' } })
    await branch.write({ kind: 'fact', text: 'from b', scope: { agentId: 'agent-b' } })

    await branch.clear?.({ agentId: 'agent-a' })

    expect((await branch.snapshot()).journal).toEqual([])
    await expect(branch.search('from b', { scope: { agentId: 'agent-b' } })).resolves.toEqual([])
  })

  it('preserves provider order for unscored branch hits', async () => {
    const hits: AgentMemoryHit[] = [
      { id: 'z-top', uri: 'memory://rank/z', kind: 'fact', text: 'provider first' },
      { id: 'a-lower', uri: 'memory://rank/a', kind: 'fact', text: 'provider second' },
    ]
    const adapter: AgentMemoryAdapter = {
      id: 'provider-ranked',
      branchIsolation: { mode: 'scoped' },
      async search() {
        return hits
      },
      async getContext(query) {
        return { query, text: '', hits: [], sourceRecords: [] }
      },
      async write(input) {
        return { accepted: true, id: 'write', uri: 'memory://rank/write', kind: input.kind }
      },
    }
    const branch = createAgentMemoryBranch({
      adapter,
      branchId: 'provider-ranked',
      baseScope: { agentId: 'agent-a' },
    })

    const ranked = await branch.search('anything', { limit: 1 })

    expect(ranked.map((hit) => hit.id)).toEqual(['z-top'])
  })

  it('fuses unscored visibility lists by provider rank', async () => {
    const adapter: AgentMemoryAdapter = {
      id: 'visibility-ranked',
      branchIsolation: { mode: 'scoped' },
      async search(_query, options) {
        return options?.scope?.tags?.memoryVisibility === 'private'
          ? [
              { id: 'private-1', uri: 'memory://rank/private-1', kind: 'fact', text: 'p1' },
              { id: 'private-2', uri: 'memory://rank/private-2', kind: 'fact', text: 'p2' },
            ]
          : [{ id: 'team-1', uri: 'memory://rank/team-1', kind: 'fact', text: 't1' }]
      },
      async getContext(query) {
        return { query, text: '', hits: [], sourceRecords: [] }
      },
      async write(input) {
        return { accepted: true, id: 'write', uri: 'memory://rank/write', kind: input.kind }
      },
    }
    const branch = createAgentMemoryBranch({
      adapter,
      branchId: 'visibility-ranked',
      policy: { read: ['private', 'team'], write: 'private' },
      baseScope: { agentId: 'agent-a', teamId: 'team-a' },
    })

    const ranked = await branch.search('anything', { limit: 2 })

    expect(ranked.map((hit) => hit.id)).toEqual(['private-1', 'team-1'])
  })

  it('uses rank fusion before incomparable scores from separate provider searches', async () => {
    const adapter: AgentMemoryAdapter = {
      id: 'visibility-scored',
      branchIsolation: { mode: 'scoped' },
      async search(_query, options) {
        return options?.scope?.tags?.memoryVisibility === 'private'
          ? [
              {
                id: 'private-first',
                uri: 'memory://rank/private-first',
                kind: 'fact',
                text: 'private first',
                score: 0.01,
              },
              {
                id: 'private-second',
                uri: 'memory://rank/private-second',
                kind: 'fact',
                text: 'private second',
                score: 1,
              },
            ]
          : [
              {
                id: 'team-first',
                uri: 'memory://rank/team-first',
                kind: 'fact',
                text: 'team first',
                score: 0.02,
              },
            ]
      },
      async getContext(query) {
        return { query, text: '', hits: [], sourceRecords: [] }
      },
      async write(input) {
        return { accepted: true, id: 'write', uri: 'memory://rank/write', kind: input.kind }
      },
    }
    const branch = createAgentMemoryBranch({
      adapter,
      branchId: 'visibility-scored',
      policy: { read: ['private', 'team'], write: 'private' },
      baseScope: { agentId: 'agent-a', teamId: 'team-a' },
    })

    const ranked = await branch.search('anything', { limit: 2 })

    expect(ranked.map((hit) => hit.id)).toEqual(['team-first', 'private-first'])
  })

  it('serializes writes per actor and permits independent actors in parallel', async () => {
    let active = 0
    let maxActive = 0
    const starts: string[] = []
    const storage = createScopedTestAdapter('ordered', async (scope, text) => {
      starts.push(`${scope.agentId}:${text}`)
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
    })
    const branch = createAgentMemoryBranch({
      adapter: storage,
      branchId: 'parallel',
      policy: { read: ['private'], write: 'private' },
    })

    await Promise.all([
      branch.write({ kind: 'message', text: 'a1', scope: { agentId: 'a' } }),
      branch.write({ kind: 'message', text: 'a2', scope: { agentId: 'a' } }),
      branch.write({ kind: 'message', text: 'b1', scope: { agentId: 'b' } }),
    ])

    expect(maxActive).toBe(2)
    expect(starts.indexOf('a:a1')).toBeLessThan(starts.indexOf('a:a2'))
    expect((await branch.snapshot()).journal.map((entry) => entry.input.text)).toEqual([
      'a1',
      'a2',
      'b1',
    ])
  })

  it('preserves one actor ordering across sessions and tags', async () => {
    const completed: string[] = []
    const storage = createScopedTestAdapter('actor-order', async (_scope, text) => {
      if (text === 'first') await new Promise((resolve) => setTimeout(resolve, 20))
      completed.push(text)
    })
    const branch = createAgentMemoryBranch({
      adapter: storage,
      branchId: 'actor-order',
      baseScope: { tenantId: 'tenant', agentId: 'agent-a' },
    })

    await Promise.all([
      branch.write({
        kind: 'fact',
        text: 'first',
        scope: { sessionId: 'session-1', tags: { task: 'one' } },
      }),
      branch.write({
        kind: 'fact',
        text: 'second',
        scope: { sessionId: 'session-2', tags: { task: 'two' } },
      }),
    ])

    expect(completed).toEqual(['first', 'second'])
  })

  it('takes a point-in-time snapshot while later writes wait at the boundary', async () => {
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let reportFirstStarted!: () => void
    const firstStarted = new Promise<void>((resolve) => {
      reportFirstStarted = resolve
    })
    const providerStarts: string[] = []
    const storage = createScopedTestAdapter('snapshot-boundary', async (_scope, text) => {
      providerStarts.push(text)
      if (text === 'first') {
        reportFirstStarted()
        await firstMayFinish
      }
    })
    const branch = createAgentMemoryBranch({
      adapter: storage,
      branchId: 'snapshot-boundary',
      baseScope: { agentId: 'worker' },
    })

    const firstWrite = branch.write({ kind: 'fact', text: 'first' })
    await firstStarted
    const snapshotPromise = branch.snapshot()
    const secondWrite = branch.write({ kind: 'fact', text: 'second' })
    await Promise.resolve()

    expect(providerStarts).toEqual(['first'])
    releaseFirst()
    await firstWrite
    const snapshot = await snapshotPromise
    await secondWrite

    expect(snapshot.journal.map((entry) => entry.input.text)).toEqual(['first'])
    expect(providerStarts).toEqual(['first', 'second'])
  })

  it('does not clear storage while a preceding read is still using it', async () => {
    let finishRead!: () => void
    const readMayFinish = new Promise<void>((resolve) => {
      finishRead = resolve
    })
    let reportReadStarted!: () => void
    const readStarted = new Promise<void>((resolve) => {
      reportReadStarted = resolve
    })
    let clearStarted = false
    const adapter: AgentMemoryAdapter = {
      id: 'read-clear-boundary',
      branchIsolation: { mode: 'scoped' },
      async search() {
        reportReadStarted()
        await readMayFinish
        return []
      },
      async getContext(query) {
        return { query, text: '', hits: [], sourceRecords: [] }
      },
      async write(input) {
        return { accepted: true, id: 'write', uri: 'memory://write', kind: input.kind }
      },
      async clear() {
        clearStarted = true
      },
    }
    const branch = createAgentMemoryBranch({
      adapter,
      branchId: 'read-clear-boundary',
      baseScope: { agentId: 'worker' },
    })

    const read = branch.search('active read')
    await readStarted
    const clear = branch.clear?.()
    await Promise.resolve()
    expect(clearStarted).toBe(false)

    finishRead()
    await read
    await clear
    expect(clearStarted).toBe(true)
  })

  it('clears a touched scope after the provider commits and then throws', async () => {
    let dirty = false
    const clearedScopes: AgentMemoryScope[] = []
    const adapter: AgentMemoryAdapter = {
      id: 'commit-then-error',
      branchIsolation: { mode: 'scoped' },
      async search() {
        return []
      },
      async getContext(query) {
        return { query, text: '', hits: [], sourceRecords: [] }
      },
      async write() {
        dirty = true
        throw new Error('connection lost after commit')
      },
      async clear(scope) {
        clearedScopes.push(scope ?? {})
        dirty = false
      },
    }
    const branch = createAgentMemoryBranch({
      adapter,
      branchId: 'commit-then-error',
      baseScope: { tenantId: 'tenant' },
    })

    await expect(
      branch.write({ kind: 'fact', text: 'partial', scope: { agentId: 'worker' } }),
    ).rejects.toThrow('connection lost after commit')
    await branch.clear?.()

    expect(dirty).toBe(false)
    expect(clearedScopes).toHaveLength(1)
    expect(clearedScopes[0]).toMatchObject({ tenantId: 'tenant', agentId: 'worker' })
  })

  it('rejects non-durable journal data before it can corrupt resume state', async () => {
    let providerWrites = 0
    const adapter = createScopedTestAdapter('durable-journal', async () => {
      providerWrites += 1
    })
    const branch = createAgentMemoryBranch({
      adapter,
      branchId: 'durable-journal',
      baseScope: { agentId: 'worker' },
    })
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic

    await expect(
      branch.write({ kind: 'fact', text: 'bad metadata', metadata: cyclic }),
    ).rejects.toThrow('must not contain cycles')
    expect(providerWrites).toBe(0)
    expect((await branch.snapshot()).journal).toEqual([])
  })

  it('returns snapshots detached from live branch state', async () => {
    const adapter = createScopedTestAdapter('detached-snapshot')
    const branch = createAgentMemoryBranch({
      adapter,
      branchId: 'detached-snapshot',
      baseScope: { tenantId: 'tenant-original', agentId: 'agent-a' },
    })
    await branch.write({
      kind: 'fact',
      text: 'original text',
      metadata: { nested: { status: 'original' } },
    })

    const exposed = await branch.snapshot()
    exposed.baseScope.tenantId = 'tenant-mutated'
    const nested = exposed.journal[0]!.input.metadata!.nested as Record<string, unknown>
    nested.status = 'mutated'
    const current = await branch.snapshot()

    expect(current.baseScope.tenantId).toBe('tenant-original')
    expect(current.journal[0]?.input.metadata).toEqual({ nested: { status: 'original' } })
    expect(await branch.search('original')).toHaveLength(1)
  })

  it('closes a shared adapter once after every branch releases it', async () => {
    let closes = 0
    const base = createScopedTestAdapter('shared-lifecycle')
    const adapter: AgentMemoryAdapter = {
      ...base,
      async close() {
        closes += 1
      },
    }
    const first = createAgentMemoryBranch({
      adapter,
      branchId: 'first',
      baseScope: { agentId: 'agent-1' },
    })
    const second = createAgentMemoryBranch({
      adapter,
      branchId: 'second',
      baseScope: { agentId: 'agent-2' },
    })

    await first.close?.()
    await first.close?.()
    expect(closes).toBe(0)
    await second.close?.()
    await second.close?.()

    expect(closes).toBe(1)
    await expect(first.search('after close')).rejects.toThrow('closed branch')
  })

  it('waits for a concurrent fork to finish before closing the parent', async () => {
    let releaseSnapshot!: () => void
    let releaseReplay!: () => void
    let reportReplayStarted!: () => void
    const snapshotBlocked = new Promise<void>((resolve) => {
      releaseSnapshot = resolve
    })
    const replayBlocked = new Promise<void>((resolve) => {
      releaseReplay = resolve
    })
    const replayStarted = new Promise<void>((resolve) => {
      reportReplayStarted = resolve
    })
    const base = createScopedTestAdapter('fork-close-race')
    let writes = 0
    let flushes = 0
    let closes = 0
    const adapter: AgentMemoryAdapter = {
      ...base,
      async write(input) {
        writes += 1
        if (writes === 2) {
          reportReplayStarted()
          await replayBlocked
        }
        return base.write(input)
      },
      async flush() {
        flushes += 1
        if (flushes === 1) await snapshotBlocked
      },
      async close() {
        closes += 1
      },
    }
    const parent = createAgentMemoryBranch({
      adapter,
      branchId: 'fork-close-parent',
      baseScope: { agentId: 'worker' },
    })
    await parent.write({ kind: 'fact', text: 'replay me' })

    const fork = parent.fork({ branchId: 'fork-close-child' })
    const close = parent.close!()
    let closeSettled = false
    void close.finally(() => {
      closeSettled = true
    })
    releaseSnapshot()
    await replayStarted
    await Promise.resolve()
    await Promise.resolve()

    expect(closeSettled).toBe(false)
    expect(closes).toBe(0)
    releaseReplay()
    const child = await fork
    await close
    expect((await child.search('replay')).map(hitText)).toEqual(['replay me'])
    expect(closes).toBe(0)
    await child.close?.()
    expect(closes).toBe(1)
  })

  it('forks by replaying accepted writes into another adapter and resumes exactly', async () => {
    const parentStorage = createScopedTestAdapter('parent')
    const childStorage = createScopedTestAdapter('child')
    const parent = createAgentMemoryBranch({
      adapter: parentStorage,
      branchId: 'parent',
      policy: { read: ['private'], write: 'private' },
      baseScope: { tenantId: 'tenant', agentId: 'agent-a' },
    })
    await parent.write({ kind: 'fact', text: 'seed fact' })

    await expect(parent.fork({ branchId: 'parent' })).rejects.toThrow(
      'child branchId must differ from its parent',
    )
    expect((await parent.search('fact')).map(hitText)).toEqual(['seed fact'])

    const child = await parent.fork({ branchId: 'child', adapter: childStorage })
    await child.write({ kind: 'fact', text: 'child only' })

    expect((await parent.search('fact')).map(hitText)).toEqual(['seed fact'])
    expect((await child.search('fact')).map(hitText)).toEqual(['seed fact', 'child only'])
    const snapshot = await child.snapshot()
    expect(snapshot.journal.every((entry) => Boolean(entry.input.id))).toBe(true)
    expect(new Set(snapshot.journal.map((entry) => entry.input.id)).size).toBe(2)
    await child.close?.()
    const resumed = createAgentMemoryBranch({
      adapter: childStorage,
      branchId: 'child',
      snapshot,
    })
    snapshot.baseScope.tenantId = 'mutated-after-resume'
    expect((await resumed.search('fact')).map(hitText)).toEqual(['seed fact', 'child only'])
    expect((await resumed.snapshot()).baseScope.tenantId).toBe('tenant')
    expect((await resumed.snapshot()).digest).toBe(snapshot.digest)

    await expect(
      Promise.resolve().then(() =>
        createAgentMemoryBranch({
          adapter: childStorage,
          branchId: 'child',
          snapshot: { ...snapshot, digest: 'sha256:bad' },
        }),
      ),
    ).rejects.toThrow('digest mismatch')
  })

  it('replays an attempt snapshot into a fresh branch', async () => {
    const adapter: AgentMemoryAdapter = {
      ...createScopedTestAdapter('attempt-source'),
      branchIsolation: { mode: 'scoped', processExitSafe: false, recoveryDelayMs: 1 },
    }
    const source = createAgentMemoryBranch({
      adapter,
      branchId: 'attempt-source',
      lifetime: 'attempt',
      baseScope: { agentId: 'worker' },
    })
    await source.write({ kind: 'fact', text: 'durable observation' })
    const snapshot = await source.snapshot()
    const target = await forkAgentMemoryBranchSnapshot({
      snapshot,
      adapter: createScopedTestAdapter('resumable-target'),
      branchId: 'resumable-target',
      lifetime: 'resumable',
    })

    expect((await target.search('observation')).map(hitText)).toEqual(['durable observation'])
    expect(target.parentBranchId).toBe('attempt-source')
    expect(target.lifetime).toBe('resumable')
  })
})
