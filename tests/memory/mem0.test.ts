import type { MemoryClient } from 'mem0ai'
import type { Memory as OssMemory } from 'mem0ai/oss'
import { describe, expect, it } from 'vitest'
import { buildCandidate } from '../../src/memory/improvement/candidate'
import {
  createAgentMemoryBranch,
  createMem0MemoryAdapter,
  type Mem0ClientLike,
  mem0MemoryAdapterIdentity,
  type RunAgentMemoryImprovementOptions,
} from '../../src/memory/index'

describe('Mem0 adapter', () => {
  it('is type-compatible with both current Mem0 clients', () => {
    const hosted = null as unknown as MemoryClient
    const oss = null as unknown as OssMemory

    expect(createMem0MemoryAdapter({ client: hosted, mode: 'hosted' }).id).toBe('mem0-hosted')
    expect(createMem0MemoryAdapter({ client: oss, mode: 'oss' }).id).toBe('mem0-oss')
  })

  it('writes and searches with the same provider scope', async () => {
    const calls: Array<{ method: string; options?: Record<string, unknown> }> = []
    const client: Mem0ClientLike = {
      async add(_messages, options) {
        calls.push({ method: 'add', options })
        return [{ id: 'memory-1', event: 'ADD' }]
      },
      async search(_query, options) {
        calls.push({ method: 'search', options })
        return {
          results: [
            {
              id: 'memory-1',
              memory: 'Use concise status updates.',
              score: 0.91,
              metadata: {
                memoryKind: 'preference',
                memoryTitle: 'Writing style',
                eventId: 'event-1',
              },
            },
          ],
        }
      },
    }
    const adapter = createMem0MemoryAdapter({ client, mode: 'hosted', rerank: true })
    const scope = {
      tenantId: 'tenant-1',
      userId: 'user-1',
      agentId: 'agent-1',
      teamId: 'team-1',
      namespace: 'branch-1/private',
      sessionId: 'session-1',
      tags: { task: 'support' },
    }

    await adapter.write({
      id: 'event-1',
      kind: 'preference',
      title: 'Writing style',
      text: 'Use concise status updates.',
      scope,
      metadata: { run_id: 'attempted-override', memoryKind: 'entity' },
    })
    const hits = await adapter.search('status style', { scope, limit: 3 })

    const add = calls[0]?.options
    const search = calls[1]?.options
    expect(add).toMatchObject({
      userId: 'user-1',
      agentId: 'agent-1',
      runId: 'branch-1/private',
      infer: true,
      metadata: {
        memoryKind: 'preference',
        tenant_id: 'tenant-1',
        user_id: 'user-1',
        agent_id: 'agent-1',
        team_id: 'team-1',
        run_id: 'branch-1/private',
        session_id: 'session-1',
        tag_task: 'support',
      },
    })
    expect(search).toMatchObject({
      filters: {
        user_id: 'user-1',
        agent_id: 'agent-1',
        run_id: 'branch-1/private',
        tenant_id: 'tenant-1',
        team_id: 'team-1',
        session_id: 'session-1',
        tag_task: 'support',
      },
      topK: 3,
      rerank: true,
    })
    expect(hits[0]).toMatchObject({
      id: 'memory-1',
      kind: 'preference',
      text: 'Use concise status updates.',
      score: 0.91,
      normalizedScore: 0.91,
      metadata: { eventId: 'event-1' },
    })
  })

  it('pushes memory kinds into provider filters before top-k truncation', async () => {
    const searchOptions: Record<string, unknown>[] = []
    const adapter = createMem0MemoryAdapter({
      mode: 'hosted',
      client: {
        async add() {
          return []
        },
        async search(_query, options) {
          searchOptions.push(options ?? {})
          const filters = options?.filters as Record<string, unknown> | undefined
          if (filters?.memoryKind === 'preference') {
            return {
              results: [
                {
                  id: 'preference-1',
                  memory: 'Use concise updates.',
                  metadata: { memoryKind: 'preference' },
                },
              ],
            }
          }
          return {
            results: [
              {
                id: 'fact-1',
                memory: 'Higher-ranked unrelated fact.',
                metadata: { memoryKind: 'fact' },
              },
            ],
          }
        },
      },
    })

    const filtered = await adapter.search('updates', {
      scope: { userId: 'user-1' },
      kinds: ['preference'],
      limit: 1,
    })
    const unfiltered = await adapter.search('updates', {
      scope: { userId: 'user-1' },
      kinds: [],
      limit: 1,
    })

    expect(filtered.map((hit) => hit.id)).toEqual(['preference-1'])
    expect(unfiltered.map((hit) => hit.id)).toEqual(['fact-1'])
    expect(searchOptions[0]).toMatchObject({
      filters: { user_id: 'user-1', memoryKind: 'preference' },
      topK: 1,
    })
    expect(searchOptions[1]).toMatchObject({ filters: { user_id: 'user-1' }, topK: 1 })
  })

  it('rejects legacy asynchronous hosted responses the current SDK cannot produce', async () => {
    const adapter = createMem0MemoryAdapter({
      mode: 'hosted',
      client: {
        async add() {
          return { status: 'PENDING', eventId: 'event-1' }
        },
        async search() {
          return { results: [] }
        },
      },
    })

    await expect(
      adapter.write({
        kind: 'fact',
        text: 'Remember this.',
        scope: { userId: 'user-1' },
      }),
    ).rejects.toThrow('mem0ai 3.x must return a memory array')
  })

  it('requires fresh attempt branches for hosted Mem0', async () => {
    const client: Mem0ClientLike = {
      async add() {
        return []
      },
      async search() {
        return { results: [] }
      },
    }
    const visible = createMem0MemoryAdapter({ mode: 'hosted', client })

    expect(() => createAgentMemoryBranch({ adapter: visible, branchId: 'mem0-resumable' })).toThrow(
      "must use lifetime='attempt'",
    )
    const attempt = createAgentMemoryBranch({
      adapter: visible,
      branchId: 'mem0-attempt',
      lifetime: 'attempt',
    })
    const snapshot = await attempt.snapshot()
    await attempt.close()
    expect(() =>
      createAgentMemoryBranch({
        adapter: visible,
        branchId: 'mem0-attempt',
        snapshot,
      }),
    ).toThrow('attempt snapshots cannot be resumed')
  })

  it('does not journal an empty provider result as an accepted write', async () => {
    const adapter = createMem0MemoryAdapter({
      mode: 'hosted',
      client: {
        async add() {
          return []
        },
        async search() {
          return { results: [] }
        },
      },
    })

    await expect(
      adapter.write({
        kind: 'fact',
        text: 'No provider mutation',
        scope: { userId: 'user-1' },
      }),
    ).resolves.toMatchObject({ accepted: false })
  })

  it('journals and replays Mem0 deletion mutations', async () => {
    const parentCalls: string[] = []
    const childCalls: string[] = []
    const adapter = (calls: string[]) =>
      createMem0MemoryAdapter({
        mode: 'oss',
        client: {
          async add(messages) {
            const text = messages[0]!.content
            calls.push(text)
            return [
              {
                id: text.startsWith('Forget') ? 'memory-old' : 'memory-new',
                metadata: { event: text.startsWith('Forget') ? 'DELETE' : 'ADD' },
              },
            ]
          },
          async search() {
            return { results: [] }
          },
        },
      })
    const parent = createAgentMemoryBranch({
      adapter: adapter(parentCalls),
      branchId: 'mem0-parent',
      baseScope: { agentId: 'agent-1' },
    })

    await parent.write({ kind: 'fact', text: 'Remember the old launch date.' })
    const deletion = await parent.write({ kind: 'fact', text: 'Forget the old launch date.' })
    const snapshot = await parent.snapshot()
    await parent.fork({ branchId: 'mem0-child', adapter: adapter(childCalls) })

    expect(deletion).toMatchObject({ accepted: true, metadata: { event: 'DELETE' } })
    expect(snapshot.journal.map((entry) => entry.input.text)).toEqual([
      'Remember the old launch date.',
      'Forget the old launch date.',
    ])
    expect(childCalls).toEqual(parentCalls)
  })

  it('includes the default scope in the Mem0 adapter identity', () => {
    const base = { mode: 'hosted' as const, id: 'mem0', backendRef: 'mem0-account-a' }
    expect(mem0MemoryAdapterIdentity({ ...base, defaultScope: { tenantId: 'tenant-a' } })).not.toBe(
      mem0MemoryAdapterIdentity({ ...base, defaultScope: { tenantId: 'tenant-b' } }),
    )
    expect(mem0MemoryAdapterIdentity({ ...base, ingestionTimeoutMs: 100 })).not.toBe(
      mem0MemoryAdapterIdentity({ ...base, ingestionTimeoutMs: 200 }),
    )
  })

  it('uses its identity as a memory improvement candidate ref', async () => {
    const config = { provider: 'mem0' } as const
    const ref = mem0MemoryAdapterIdentity({
      mode: 'hosted',
      id: 'mem0',
      backendRef: 'mem0-account-a',
    })
    const options = {
      createCandidate: () => ({
        ref,
        externalCostUsdPerSequence: 0,
        externalRecoveryCostUsdPerAttempt: 0,
        externalCostAccounting: 'exact' as const,
        createAdapter: () => null,
      }),
    } as RunAgentMemoryImprovementOptions<typeof config>

    const candidate = await buildCandidate(options, config, 'mem0')

    expect(candidate.ref).toBe(ref)
    expect(candidate.ref).toMatch(/^sha256:[a-f0-9]{64}$/)
  })

  it('passes OSS entity filters on add', async () => {
    let addOptions: Record<string, unknown> | undefined
    const adapter = createMem0MemoryAdapter({
      mode: 'oss',
      client: {
        async add(_messages, options) {
          addOptions = options
          return { results: [{ id: 'oss-1', memory: 'Remembered' }] }
        },
        async search() {
          return { results: [] }
        },
      },
    })

    await adapter.write({
      kind: 'fact',
      text: 'Remembered',
      scope: { userId: 'user-1', agentId: 'agent-1', namespace: 'run-1' },
    })

    expect(addOptions).toMatchObject({
      userId: 'user-1',
      agentId: 'agent-1',
      runId: 'run-1',
      filters: { user_id: 'user-1', agent_id: 'agent-1', run_id: 'run-1' },
    })
  })

  it('rejects direct OSS operations without a provider entity scope', async () => {
    let providerCalls = 0
    const adapter = createMem0MemoryAdapter({
      mode: 'oss',
      client: {
        async add() {
          providerCalls += 1
          return { results: [] }
        },
        async search() {
          providerCalls += 1
          return { results: [] }
        },
      },
    })

    await expect(adapter.write({ kind: 'fact', text: 'No owner.' })).rejects.toThrow(
      'requires scope.userId, scope.agentId, scope.runId, or scope.namespace',
    )
    await expect(adapter.search('No owner.')).rejects.toThrow(
      'requires scope.userId, scope.agentId, scope.runId, or scope.namespace',
    )
    expect(providerCalls).toBe(0)
  })

  it('rejects unscoped hosted operations before calling Mem0', async () => {
    let providerCalls = 0
    const adapter = createMem0MemoryAdapter({
      mode: 'hosted',
      appId: 'support-app',
      client: {
        async add() {
          providerCalls += 1
          return []
        },
        async search() {
          providerCalls += 1
          return { results: [] }
        },
        async getAll() {
          providerCalls += 1
          return { results: [] }
        },
        async delete() {
          providerCalls += 1
          return { message: 'deleted' }
        },
      },
    })

    await expect(adapter.write({ kind: 'fact', text: 'No owner.' })).rejects.toThrow(
      'Mem0 hosted write requires',
    )
    await expect(adapter.search('No owner.')).rejects.toThrow('Mem0 hosted search requires')
    await expect(adapter.clear?.()).rejects.toThrow('refusing an unscoped Mem0 clear')
    expect(providerCalls).toBe(0)
  })

  it('deletes only memories matching a complete scoped filter', async () => {
    const rows = new Set(['memory-1', 'memory-2'])
    const getAllOptions: Record<string, unknown>[] = []
    let deleteAllCalls = 0
    const adapter = createMem0MemoryAdapter({
      mode: 'hosted',
      appId: 'support-app',
      client: {
        async add() {
          return []
        },
        async search() {
          return { results: [] }
        },
        async getAll(options) {
          getAllOptions.push(options ?? {})
          return { results: [...rows].map((id) => ({ id, memory: id })) }
        },
        async delete(memoryId) {
          rows.delete(memoryId)
          return { message: 'deleted' }
        },
        async deleteAll() {
          deleteAllCalls += 1
          return { message: 'deleted all' }
        },
      },
    })

    await adapter.clear?.({
      tenantId: 'tenant-1',
      userId: 'user-1',
      namespace: 'physical-branch',
      runId: 'logical-run',
      sessionId: 'session-1',
      tags: { visibility: 'private' },
    })

    expect(rows.size).toBe(0)
    expect(deleteAllCalls).toBe(0)
    expect(getAllOptions[0]).toMatchObject({
      filters: {
        app_id: 'support-app',
        user_id: 'user-1',
        run_id: 'physical-branch',
        tenant_id: 'tenant-1',
        logical_run_id: 'logical-run',
        session_id: 'session-1',
        tag_visibility: 'private',
      },
      page: 1,
      pageSize: 100,
      showExpired: true,
    })
  })

  it('waits for hosted deletes to disappear without deleting the same memory twice', async () => {
    let deletedAt: number | undefined
    let getAllCalls = 0
    const deletedIds: string[] = []
    const adapter = createMem0MemoryAdapter({
      mode: 'hosted',
      ingestionTimeoutMs: 50,
      pollIntervalMs: 1,
      client: {
        async add() {
          return []
        },
        async search() {
          return { results: [] }
        },
        async getAll() {
          getAllCalls += 1
          const visible = deletedAt === undefined || Date.now() - deletedAt < 5
          return { results: visible ? [{ id: 'memory-1', memory: 'stale listing' }] : [] }
        },
        async delete(memoryId) {
          deletedIds.push(memoryId)
          deletedAt = Date.now()
          return { message: 'deletion accepted' }
        },
      },
    })

    await adapter.clear?.({ userId: 'user-1', namespace: 'branch-1' })

    expect(deletedIds).toEqual(['memory-1'])
    expect(getAllCalls).toBeGreaterThan(2)
  })

  it('waits for list and search indexes to drop deleted memories before reporting cleanup', async () => {
    let deleted = false
    let getAllCalls = 0
    let searchCalls = 0
    let deleteCalls = 0
    const adapter = createMem0MemoryAdapter({
      mode: 'hosted',
      ingestionTimeoutMs: 50,
      pollIntervalMs: 1,
      client: {
        async add() {
          return []
        },
        async search() {
          searchCalls += 1
          const visible = !deleted || searchCalls === 1
          return { results: visible ? [{ id: 'memory-1', memory: 'stale listing' }] : [] }
        },
        async getAll() {
          getAllCalls += 1
          const visible = !deleted || getAllCalls === 2
          return { results: visible ? [{ id: 'memory-1', memory: 'stale listing' }] : [] }
        },
        async delete() {
          deleteCalls += 1
          deleted = true
          return { message: 'deletion accepted' }
        },
      },
    })

    await adapter.clear?.({ userId: 'user-1', namespace: 'branch-1' })

    expect(deleteCalls).toBe(1)
    expect(getAllCalls).toBeGreaterThan(1)
    expect(searchCalls).toBeGreaterThan(1)
  })

  it('waits for a fresh narrower id-less write when clearing a broader Mem0 scope', async () => {
    const writtenAt = Date.now()
    let deleted = false
    let getAllCalls = 0
    let deleteCalls = 0
    const visible = () => !deleted && Date.now() - writtenAt >= 5
    const adapter = createMem0MemoryAdapter({
      mode: 'hosted',
      ingestionTimeoutMs: 15,
      pollIntervalMs: 1,
      client: {
        async add() {
          return [{ event: 'ADD' }]
        },
        async search() {
          return { results: visible() ? [{ id: 'late-memory', memory: 'late fact' }] : [] }
        },
        async getAll() {
          getAllCalls += 1
          return { results: visible() ? [{ id: 'late-memory', memory: 'late fact' }] : [] }
        },
        async delete(memoryId) {
          expect(memoryId).toBe('late-memory')
          deleteCalls += 1
          deleted = true
          return { message: 'deleted' }
        },
      },
    })

    await adapter.write({
      kind: 'fact',
      text: 'late fact',
      scope: { userId: 'user-1', agentId: 'agent-1', namespace: 'branch-1' },
    })
    await adapter.clear?.({ userId: 'user-1' })

    expect(deleteCalls).toBe(1)
    expect(getAllCalls).toBeGreaterThan(1)
  })

  it('expires pending write probes after the configured visibility window', async () => {
    let searchCalls = 0
    const adapter = createMem0MemoryAdapter({
      mode: 'hosted',
      ingestionTimeoutMs: 1,
      pollIntervalMs: 1,
      client: {
        async add() {
          return [{ event: 'ADD' }]
        },
        async search() {
          searchCalls += 1
          return { results: [] }
        },
        async getAll() {
          return { results: [] }
        },
        async delete() {
          return { message: 'deleted' }
        },
      },
    })

    await adapter.write({
      kind: 'fact',
      text: 'bounded pending fact',
      scope: { userId: 'user-1' },
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
    await adapter.clear?.({ userId: 'user-1' })

    expect(searchCalls).toBe(0)
  })

  it('refuses to clear Mem0 without an exact identity scope', async () => {
    let providerCalls = 0
    const adapter = createMem0MemoryAdapter({
      mode: 'hosted',
      client: {
        async add() {
          return []
        },
        async search() {
          providerCalls += 1
          return { results: [] }
        },
        async getAll() {
          providerCalls += 1
          return { results: [] }
        },
        async delete() {
          providerCalls += 1
          return { message: 'deleted' }
        },
      },
    })

    await expect(adapter.clear?.()).rejects.toThrow('refusing an unscoped Mem0 clear')
    expect(providerCalls).toBe(0)
  })
})
