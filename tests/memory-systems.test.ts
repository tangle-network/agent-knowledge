import type { MemoryClient as Neo4jMemoryClient } from '@neo4j-labs/agent-memory'
import {
  createRunCostLedger,
  inMemoryCampaignStorage,
  type SurfaceProposer,
} from '@tangle-network/agent-eval/campaign'
import type { MemoryClient } from 'mem0ai'
import type { Memory as OssMemory } from 'mem0ai/oss'
import { describe, expect, it } from 'vitest'
import {
  type AgentMemoryAdapter,
  type AgentMemoryHit,
  type AgentMemoryScope,
  agentMemorySequenceJudge,
  buildAgentMemorySequencesFromBenchmarkCases,
  createAgentMemoryBranch,
  createGraphitiMemoryAdapter,
  createMem0MemoryAdapter,
  createNeo4jAgentMemoryAdapter,
  forkAgentMemoryBranchSnapshot,
  type GraphitiMcpClientLike,
  graphitiMemoryAdapterIdentity,
  type Mem0ClientLike,
  mem0MemoryAdapterIdentity,
  type RunAgentMemoryExperimentOptions,
  type RunAgentMemoryImprovementOptions,
  runAgentMemoryExperiment as runAgentMemoryExperimentRaw,
  runAgentMemoryImprovement as runAgentMemoryImprovementRaw,
} from '../src/memory/index'

function withProcessLocalController<
  T extends {
    storage?: unknown
    controllerMode?: 'process-local'
    acquireRunLease?: unknown
  },
>(options: T): T {
  if (!options.storage || options.controllerMode || options.acquireRunLease) return options
  return { ...options, controllerMode: 'process-local' }
}

function runAgentMemoryExperiment(options: RunAgentMemoryExperimentOptions) {
  return runAgentMemoryExperimentRaw(withProcessLocalController(options))
}

function runAgentMemoryImprovement<TConfig>(options: RunAgentMemoryImprovementOptions<TConfig>) {
  return runAgentMemoryImprovementRaw(withProcessLocalController(options))
}

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

  it('waits for the official hosted Mem0 event to succeed', async () => {
    let addOptions: Record<string, unknown> | undefined
    const eventIds: string[] = []
    const adapter = createMem0MemoryAdapter({
      mode: 'hosted',
      ingestionTimeoutMs: 50,
      pollIntervalMs: 1,
      client: {
        async add(_messages, options) {
          addOptions = options
          return { status: 'PENDING', eventId: 'event-1' }
        },
        async search() {
          return { results: [] }
        },
      },
      async getEvent(eventId) {
        eventIds.push(eventId)
        return eventIds.length === 1
          ? { id: eventId, status: 'RUNNING', results: [] }
          : {
              id: eventId,
              status: 'SUCCEEDED',
              results: [
                {
                  id: 'memory-visible',
                  memory: 'Launch is Friday.',
                  metadata: { memoryKind: 'fact' },
                },
              ],
            }
      },
    })

    const result = await adapter.write({
      id: 'source-event',
      kind: 'fact',
      text: 'Launch is Friday.',
      scope: { userId: 'user-1' },
    })

    const metadata = addOptions?.metadata as Record<string, unknown>
    expect(metadata.agentKnowledgeWriteId).toBe('source-event')
    expect(metadata.agentKnowledgeWriteAttemptId).toBeUndefined()
    expect(eventIds).toEqual(['event-1', 'event-1'])
    expect(result).toMatchObject({
      accepted: true,
      id: 'memory-visible',
      metadata: { consistency: 'visible', queued: false },
    })
  })

  it('treats a successful hosted Mem0 event with no results as a no-op', async () => {
    const adapter = createMem0MemoryAdapter({
      mode: 'hosted',
      client: {
        async add() {
          return { status: 'PENDING', eventId: 'event-noop' }
        },
        async search() {
          return { results: [] }
        },
      },
      async getEvent(eventId) {
        return { id: eventId, status: 'SUCCEEDED', results: [] }
      },
    })

    await expect(adapter.write({ kind: 'fact', text: 'No durable fact.' })).resolves.toMatchObject({
      accepted: false,
      id: 'event-noop',
    })
  })

  it('surfaces a failed hosted Mem0 event', async () => {
    const adapter = createMem0MemoryAdapter({
      mode: 'hosted',
      client: {
        async add() {
          return { status: 'PENDING', eventId: 'event-failed' }
        },
        async search() {
          return { results: [] }
        },
      },
      async getEvent(eventId) {
        return { id: eventId, status: 'FAILED', message: 'extraction failed' }
      },
    })

    await expect(adapter.write({ kind: 'fact', text: 'Remember this.' })).rejects.toThrow(
      'Mem0 event event-failed failed: extraction failed',
    )
  })

  it('requires fresh attempt branches for visible hosted Mem0', async () => {
    const client: Mem0ClientLike = {
      async add() {
        return { status: 'PENDING', eventId: 'event-1' }
      },
      async search() {
        return { results: [] }
      },
    }
    const visible = createMem0MemoryAdapter({
      mode: 'hosted',
      client,
      async getEvent(eventId) {
        return { id: eventId, status: 'SUCCEEDED', results: [] }
      },
    })
    const queued = createMem0MemoryAdapter({
      mode: 'hosted',
      consistency: 'queued',
      client,
    })

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
    expect(() => createAgentMemoryBranch({ adapter: queued, branchId: 'mem0-queued' })).toThrow(
      'queued hosted Mem0 writes can become visible after branch cleanup',
    )
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
      adapter.write({ kind: 'fact', text: 'No provider mutation' }),
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
                event: text.startsWith('Forget') ? 'DELETE' : 'ADD',
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
    expect(mem0MemoryAdapterIdentity({ ...base, consistency: 'visible' })).not.toBe(
      mem0MemoryAdapterIdentity({ ...base, consistency: 'queued' }),
    )
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
    let deletedAt: number | undefined
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
          const visible = deletedAt === undefined || Date.now() - deletedAt < 8
          return { results: visible ? [{ id: 'memory-1', memory: 'stale listing' }] : [] }
        },
        async getAll() {
          getAllCalls += 1
          const visible = deletedAt === undefined || Date.now() - deletedAt < 5
          return { results: visible ? [{ id: 'memory-1', memory: 'stale listing' }] : [] }
        },
        async delete() {
          deleteCalls += 1
          deletedAt = Date.now()
          return { message: 'deletion accepted' }
        },
      },
    })

    await adapter.clear?.({ userId: 'user-1', namespace: 'branch-1' })

    expect(deleteCalls).toBe(1)
    expect(getAllCalls).toBeGreaterThan(1)
    expect(searchCalls).toBeGreaterThan(1)
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

describe('Graphiti adapter', () => {
  it('uses the full default ingestion window before recovering an abandoned branch', () => {
    const adapter = createGraphitiMemoryAdapter({
      client: {
        async callTool() {
          return { structuredContent: {} }
        },
      },
    })

    expect(adapter.branchIsolation).toEqual({
      mode: 'scoped',
      processExitSafe: false,
      recoveryDelayMs: 120_000,
    })
  })

  it('uses official MCP request shapes and rejoins fact provenance to episodes', async () => {
    const requests: Array<{ name: string; arguments?: Record<string, unknown> }> = []
    const episodes = new Map<string, Record<string, unknown>>()
    const client: GraphitiMcpClientLike = {
      async callTool(request) {
        requests.push(request)
        const args = request.arguments ?? {}
        if (request.name === 'add_memory') {
          episodes.set(String(args.uuid), {
            uuid: args.uuid,
            name: args.name,
            content: args.episode_body,
            source_description: args.source_description,
            group_id: args.group_id,
          })
          return { structuredContent: { message: 'queued' } }
        }
        if (request.name === 'get_episodes') {
          return {
            content: [{ type: 'text', text: JSON.stringify({ episodes: [...episodes.values()] }) }],
          }
        }
        if (request.name === 'search_memory_facts') {
          const episode = [...episodes.values()][0]!
          return {
            structuredContent: {
              facts: [
                {
                  uuid: 'fact-1',
                  name: 'PREFERS',
                  fact: 'The user prefers concise status updates.',
                  group_id: episode.group_id,
                  episodes: [episode.uuid],
                },
              ],
            },
          }
        }
        if (request.name === 'search_nodes') {
          return { structuredContent: { nodes: [] } }
        }
        throw new Error(`unexpected tool ${request.name}`)
      },
    }
    const adapter = createGraphitiMemoryAdapter({
      client,
      search: ['facts'],
      pollIntervalMs: 1,
      ingestionTimeoutMs: 50,
    })

    const write = await adapter.write({
      id: 'event-1',
      kind: 'message',
      role: 'user',
      text: 'I prefer concise status updates.',
      scope: { userId: 'user-1', namespace: 'branch-1' },
      metadata: { actorId: 'user', timestamp: '2026-07-17T12:00:00Z' },
    })
    const hits = await adapter.search('status preference', {
      scope: { userId: 'user-1', namespace: 'branch-1' },
      limit: 5,
    })

    expect(requests[0]).toMatchObject({
      name: 'add_memory',
      arguments: {
        episode_body: 'I prefer concise status updates.',
        source: 'message',
        reference_time: '2026-07-17T12:00:00Z',
      },
    })
    expect(String(requests[0]?.arguments?.group_id)).toMatch(/^ak_[a-f0-9]{32}$/)
    expect(String(requests[0]?.arguments?.uuid)).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/,
    )
    expect(write.metadata).toMatchObject({ consistency: 'visible', queued: false })
    expect(hits[0]).toMatchObject({
      id: 'fact-1',
      kind: 'fact',
      text: 'The user prefers concise status updates.',
      metadata: { eventId: 'event-1', actorId: 'user' },
    })
  })

  it('surfaces Graphiti tool errors', async () => {
    const adapter = createGraphitiMemoryAdapter({
      client: {
        async callTool() {
          return { structuredContent: { error: 'database unavailable' } }
        },
      },
    })

    await expect(adapter.search('anything')).rejects.toThrow('database unavailable')
  })

  it('expands the episode scan when Graphiti truncates a long group', async () => {
    const episodes = Array.from({ length: 150 }, (_, index) => ({
      uuid: `older-${index.toString().padStart(3, '0')}`,
    }))
    const limits: number[] = []
    const adapter = createGraphitiMemoryAdapter({
      pollIntervalMs: 1,
      ingestionTimeoutMs: 50,
      client: {
        async callTool(request) {
          if (request.name === 'add_memory') {
            episodes.push({ uuid: String(request.arguments?.uuid) })
            return { structuredContent: { message: 'queued' } }
          }
          if (request.name === 'get_episodes') {
            const limit = Number(request.arguments?.max_episodes)
            limits.push(limit)
            return { structuredContent: { episodes: episodes.slice(0, limit) } }
          }
          throw new Error(`unexpected tool ${request.name}`)
        },
      },
    })

    await adapter.write({ kind: 'fact', text: 'Visible beyond the first page.' })

    expect(limits).toEqual([100, 200])
  })

  it('keeps polling a full Graphiti group while the new episode becomes visible', async () => {
    const older = Array.from({ length: 100 }, (_, index) => ({ uuid: `older-${index}` }))
    let pendingUuid = ''
    let visible = false
    let polls = 0
    const adapter = createGraphitiMemoryAdapter({
      episodeScanLimit: 100,
      pollIntervalMs: 1,
      ingestionTimeoutMs: 50,
      client: {
        async callTool(request) {
          if (request.name === 'add_memory') {
            pendingUuid = String(request.arguments?.uuid)
            setTimeout(() => {
              visible = true
            }, 5)
            return { structuredContent: { message: 'queued' } }
          }
          if (request.name === 'get_episodes') {
            polls += 1
            return {
              structuredContent: {
                episodes: visible ? [...older.slice(1), { uuid: pendingUuid }] : older,
              },
            }
          }
          throw new Error(`unexpected tool ${request.name}`)
        },
      },
    })

    await expect(
      adapter.write({ kind: 'fact', text: 'Eventually visible.' }),
    ).resolves.toMatchObject({ accepted: true })
    expect(polls).toBeGreaterThan(1)
  })

  it('fails explicitly when visibility cannot be proved within the episode scan limit', async () => {
    const episodes = Array.from({ length: 100 }, (_, index) => ({ uuid: `older-${index}` }))
    const adapter = createGraphitiMemoryAdapter({
      episodeScanLimit: 100,
      pollIntervalMs: 1,
      ingestionTimeoutMs: 50,
      client: {
        async callTool(request) {
          if (request.name === 'add_memory') {
            episodes.push({ uuid: String(request.arguments?.uuid) })
            return { structuredContent: { message: 'queued' } }
          }
          if (request.name === 'get_episodes') {
            return { structuredContent: { episodes: episodes.slice(0, 100) } }
          }
          throw new Error(`unexpected tool ${request.name}`)
        },
      },
    })

    await expect(adapter.write({ kind: 'fact', text: 'Outside the scan window.' })).rejects.toThrow(
      'episodeScanLimit=100',
    )
  })

  it('supports documented tool aliases and does not invent missing relevance scores', async () => {
    const names: string[] = []
    const adapter = createGraphitiMemoryAdapter({
      search: ['facts'],
      toolNames: { searchFacts: 'search_facts' },
      client: {
        async callTool(request) {
          names.push(request.name)
          return {
            structuredContent: {
              facts: [{ uuid: 'fact-1', fact: 'An unscored fact', episodes: [] }],
            },
          }
        },
      },
    })

    const hits = await adapter.search('fact', { minScore: 0.5 })

    expect(names).toEqual(['search_facts'])
    expect(hits).toEqual([])
  })

  it('isolates run, session, and tag scopes into different Graphiti groups', async () => {
    const groupIds: string[] = []
    const adapter = createGraphitiMemoryAdapter({
      search: ['facts'],
      client: {
        async callTool(request) {
          if (request.name === 'search_memory_facts') {
            groupIds.push(String((request.arguments?.group_ids as string[])[0]))
            return { structuredContent: { facts: [] } }
          }
          return { structuredContent: { episodes: [] } }
        },
      },
    })

    await adapter.search('query', {
      scope: { namespace: 'same', runId: 'run-a', sessionId: 'session', tags: { arm: 'a' } },
    })
    await adapter.search('query', {
      scope: { namespace: 'same', runId: 'run-b', sessionId: 'session', tags: { arm: 'b' } },
    })

    expect(new Set(groupIds).size).toBe(2)
  })

  it('keeps caller-identified episode ids stable when groups execute in a different order', async () => {
    const run = async (scopes: AgentMemoryScope[]) => {
      const ids = new Map<string, string>()
      const adapter = createGraphitiMemoryAdapter({
        consistency: 'queued',
        client: {
          async callTool(request) {
            if (request.name === 'add_memory') {
              ids.set(String(request.arguments?.group_id), String(request.arguments?.uuid))
            }
            return { structuredContent: { message: 'queued' } }
          },
        },
      })
      for (const scope of scopes) {
        await adapter.write({ id: 'source-1', kind: 'fact', text: 'same fact', scope })
      }
      return ids
    }
    const first = await run([{ namespace: 'a' }, { namespace: 'b' }])
    const reversed = await run([{ namespace: 'b' }, { namespace: 'a' }])

    expect(first).toEqual(reversed)
  })

  it('uses a new episode id when the content of one source event changes', async () => {
    const episodeIds: string[] = []
    const adapter = createGraphitiMemoryAdapter({
      consistency: 'queued',
      client: {
        async callTool(request) {
          if (request.name === 'add_memory') {
            episodeIds.push(String(request.arguments?.uuid))
          }
          return { structuredContent: { message: 'queued' } }
        },
      },
    })

    await adapter.write({ id: 'source-1', kind: 'fact', text: 'Launch is Friday.' })
    await adapter.write({ id: 'source-1', kind: 'fact', text: 'Launch is Monday.' })

    expect(episodeIds).toHaveLength(2)
    expect(episodeIds[0]).not.toBe(episodeIds[1])
  })

  it('keeps repeated id-less Graphiti writes as distinct episodes', async () => {
    const episodeIds: string[] = []
    const adapter = createGraphitiMemoryAdapter({
      consistency: 'queued',
      client: {
        async callTool(request) {
          if (request.name === 'add_memory') {
            episodeIds.push(String(request.arguments?.uuid))
          }
          return { structuredContent: { message: 'queued' } }
        },
      },
    })

    await adapter.write({ kind: 'fact', text: 'The same observation.' })
    await adapter.write({ kind: 'fact', text: 'The same observation.' })

    expect(episodeIds).toHaveLength(2)
    expect(episodeIds[0]).not.toBe(episodeIds[1])
  })

  it('keeps id-less Graphiti writes distinct across adapter restarts', async () => {
    const episodeIds: string[] = []
    const client: GraphitiMcpClientLike = {
      async callTool(request) {
        if (request.name === 'add_memory') episodeIds.push(String(request.arguments?.uuid))
        return { structuredContent: { message: 'queued' } }
      },
    }

    await createGraphitiMemoryAdapter({ client, consistency: 'queued' }).write({
      kind: 'fact',
      text: 'The same observation.',
    })
    await createGraphitiMemoryAdapter({ client, consistency: 'queued' }).write({
      kind: 'fact',
      text: 'The same observation.',
    })

    expect(episodeIds).toHaveLength(2)
    expect(episodeIds[0]).not.toBe(episodeIds[1])
  })

  it('treats an empty Graphiti kind list as unfiltered search', async () => {
    const names: string[] = []
    const adapter = createGraphitiMemoryAdapter({
      client: {
        async callTool(request) {
          names.push(request.name)
          if (request.name === 'search_memory_facts') {
            return { structuredContent: { facts: [] } }
          }
          if (request.name === 'search_nodes') return { structuredContent: { nodes: [] } }
          throw new Error(`unexpected tool ${request.name}`)
        },
      },
    })

    await adapter.search('anything', { kinds: [] })

    expect(names).toEqual(['search_memory_facts', 'search_nodes'])
  })

  it('fuses unscored Graphiti fact and node rankings before applying the limit', async () => {
    const adapter = createGraphitiMemoryAdapter({
      client: {
        async callTool(request) {
          if (request.name === 'search_memory_facts') {
            return {
              structuredContent: {
                facts: [
                  { uuid: 'fact-1', fact: 'first fact' },
                  { uuid: 'fact-2', fact: 'second fact' },
                ],
              },
            }
          }
          if (request.name === 'search_nodes') {
            return {
              structuredContent: {
                nodes: [
                  { uuid: 'node-1', name: 'first node' },
                  { uuid: 'node-2', name: 'second node' },
                ],
              },
            }
          }
          throw new Error(`unexpected tool ${request.name}`)
        },
      },
    })

    const hits = await adapter.search('anything', { limit: 2 })

    expect(hits.map((hit) => hit.id)).toEqual(['fact-1', 'node-1'])
  })

  it('uses Graphiti clear_graph for exact group cleanup', async () => {
    const requests: Array<{ name: string; arguments?: Record<string, unknown> }> = []
    const adapter = createGraphitiMemoryAdapter({
      client: {
        async callTool(request) {
          requests.push(request)
          return { structuredContent: { message: 'Graph cleared successfully' } }
        },
      },
    })

    await adapter.clear?.({ userId: 'user-1', namespace: 'candidate-1' })

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({
      name: 'clear_graph',
      arguments: { group_ids: [expect.stringMatching(/^ak_[a-f0-9]{32}$/)] },
    })
  })

  it('rejects queued ingestion for resumable branch experiments', () => {
    const adapter = createGraphitiMemoryAdapter({
      consistency: 'queued',
      client: {
        async callTool() {
          return { structuredContent: { message: 'queued' } }
        },
      },
    })

    expect(() => createAgentMemoryBranch({ adapter, branchId: 'candidate-1' })).toThrow(
      'queued Graphiti writes can become visible after a process restart',
    )
  })

  it('includes the default scope in the Graphiti adapter identity', () => {
    expect(
      graphitiMemoryAdapterIdentity({
        id: 'graphiti',
        backendRef: 'graphiti-cluster-a',
        defaultScope: { namespace: 'one' },
      }),
    ).not.toBe(
      graphitiMemoryAdapterIdentity({
        id: 'graphiti',
        backendRef: 'graphiti-cluster-a',
        defaultScope: { namespace: 'two' },
      }),
    )
  })
})

describe('Neo4j Agent Memory adapter', () => {
  it('is type-compatible with the current official client', () => {
    const client = {} as unknown as Neo4jMemoryClient
    expect(
      createNeo4jAgentMemoryAdapter({ client, transport: 'rest', branchId: 'branch-1' }).id,
    ).toBe('neo4j-agent-memory')
  })

  it('stores observations as searchable messages without retrying a successful void write', async () => {
    let camelWrites = 0
    let snakeWrites = 0
    let role: unknown
    let closes = 0
    const adapter = createNeo4jAgentMemoryAdapter({
      transport: 'rest',
      branchId: 'branch-1',
      client: {
        shortTerm: {
          async addMessage(_sessionId: unknown, inputRole: unknown) {
            camelWrites += 1
            role = inputRole
            return undefined
          },
          async add_message() {
            snakeWrites += 1
            return { id: 'duplicate' }
          },
          async searchMessages() {
            return [
              {
                id: 'observation-1',
                role: 'assistant',
                content: 'The deployment completed.',
                metadata: { agentKnowledgeKind: 'observation' },
              },
            ]
          },
        },
        async close() {
          closes += 1
        },
      },
    })

    const write = await adapter.write({
      kind: 'observation',
      role: 'tool',
      text: 'The deployment completed.',
      scope: { sessionId: 'session-1' },
    })
    const hits = await adapter.search('deployment', {
      kinds: ['observation'],
      scope: { sessionId: 'session-1' },
    })
    await adapter.close?.()

    expect(write.accepted).toBe(true)
    expect(camelWrites).toBe(1)
    expect(snakeWrites).toBe(0)
    expect(role).toBe('assistant')
    expect(hits).toMatchObject([{ id: 'observation-1', kind: 'observation' }])
    expect(closes).toBe(1)
  })

  it('fails clearly when REST is asked for bridge-only facts and preferences', async () => {
    const adapter = createNeo4jAgentMemoryAdapter({
      transport: 'rest',
      client: { longTerm: {} },
    })

    await expect(adapter.write({ kind: 'fact', text: 'A fact' })).rejects.toThrow(
      'Neo4j REST cannot write fact',
    )
    await expect(adapter.search('preference', { kinds: ['preference'] })).rejects.toThrow(
      'Neo4j rest cannot search memory kinds: preference',
    )
  })

  it('rejects an incompatible Neo4j client instead of reporting an empty search', async () => {
    const adapter = createNeo4jAgentMemoryAdapter({
      client: { longTerm: {} },
      transport: 'rest',
    })

    await expect(adapter.search('company', { kinds: ['entity'] })).rejects.toThrow(
      'missing method searchEntities',
    )
  })

  it('rejects non-throwing Neo4j write errors', async () => {
    const adapter = createNeo4jAgentMemoryAdapter({
      transport: 'rest',
      client: {
        shortTerm: {
          async addMessage() {
            return { success: false, error: { message: 'database unavailable' } }
          },
        },
      },
    })

    await expect(
      adapter.write({
        kind: 'message',
        text: 'Remember this.',
        scope: { sessionId: 'session-1' },
      }),
    ).rejects.toThrow('database unavailable')
  })

  it('maps hosted reasoning memories to recordStep', async () => {
    let recorded: Record<string, unknown> | undefined
    const adapter = createNeo4jAgentMemoryAdapter({
      transport: 'rest',
      client: {
        reasoning: {
          async recordStep(input: Record<string, unknown>) {
            recorded = input
            return { id: 'step-1', ...input }
          },
        },
      },
    })

    const result = await adapter.write({
      kind: 'reasoning-trace',
      text: 'Check the deployment status.',
      title: 'status-check',
      scope: { sessionId: 'conversation-1' },
      metadata: { action: 'query_status', result: 'healthy' },
    })

    expect(recorded).toEqual({
      conversationId: 'conversation-1',
      reasoning: 'Check the deployment status.',
      actionTaken: 'query_status',
      result: 'healthy',
    })
    expect(result).toMatchObject({ accepted: true, id: 'step-1', kind: 'reasoning-trace' })
  })

  it('uses bridge preference APIs only in bridge mode', async () => {
    const adapter = createNeo4jAgentMemoryAdapter({
      transport: 'bridge',
      client: {
        longTerm: {
          async addPreference(category: string, preference: string) {
            return { id: 'preference-1', category, preference }
          },
          async searchPreferences() {
            return [{ id: 'preference-1', category: 'style', preference: 'Be concise.' }]
          },
        },
      },
    })

    await expect(
      adapter.write({ kind: 'preference', category: 'style', text: 'Be concise.' }),
    ).resolves.toMatchObject({ id: 'preference-1' })
    await expect(adapter.search('concise', { kinds: ['preference'] })).resolves.toMatchObject([
      { id: 'preference-1', kind: 'preference', text: 'Be concise.' },
    ])
  })

  it('fuses unscored Neo4j memory-type rankings before applying the limit', async () => {
    const adapter = createNeo4jAgentMemoryAdapter({
      transport: 'bridge',
      client: {
        shortTerm: {
          async searchMessages() {
            return [
              { id: 'message-1', role: 'user', content: 'first message' },
              { id: 'message-2', role: 'user', content: 'second message' },
            ]
          },
        },
        longTerm: {
          async searchEntities() {
            return [
              { id: 'entity-1', name: 'first entity', type: 'custom' },
              { id: 'entity-2', name: 'second entity', type: 'custom' },
            ]
          },
          async searchPreferences() {
            return []
          },
        },
        reasoning: {
          async getSimilarTraces() {
            return []
          },
        },
      },
    })

    const hits = await adapter.search('anything', { limit: 2 })

    expect(hits.map((hit) => hit.id)).toEqual(['message-1', 'entity-1'])
  })
})

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

describe('agent memory experiments', () => {
  it('versions memory scoring for resumable cache safety', () => {
    expect(agentMemorySequenceJudge().judgeVersion).toBe('agent-knowledge:memory-sequence:v2')
  })

  it('requires an explicit controller policy for custom storage', async () => {
    await expect(
      runAgentMemoryExperimentRaw({
        experimentId: 'custom-storage-controller',
        sequences: [
          {
            id: 'history',
            family: 'first-party',
            steps: [{ id: 'probe', probes: [{ id: 'probe', query: 'x', referenceAnswer: 'x' }] }],
          },
        ],
        candidates: [
          {
            id: 'memory',
            ref: 'memory:v1',
            createAdapter: () => createScopedTestAdapter('memory'),
          },
        ],
        runDir: '/runs/custom-storage-controller',
        storage: inMemoryCampaignStorage(),
      }),
    ).rejects.toThrow("requires acquireRunLease or controllerMode='process-local'")
  })

  it('bounds provider cleanup and leaves the attempt available for recovery', async () => {
    const storage = inMemoryCampaignStorage()
    let clearCalls = 0
    const adapter = createScopedTestAdapter('bounded-cleanup')
    const clear = adapter.clear!
    adapter.clear = async (scope) => {
      clearCalls += 1
      if (clearCalls > 1) return new Promise<void>(() => {})
      await clear(scope)
    }
    const startedAt = Date.now()

    await expect(
      runAgentMemoryExperiment({
        experimentId: 'bounded-cleanup',
        sequences: [
          {
            id: 'history',
            family: 'first-party',
            steps: [
              {
                id: 'remember',
                scope: { agentId: 'worker' },
                writes: [{ kind: 'fact', text: 'bounded fact' }],
                probes: [{ id: 'probe', query: 'bounded', referenceAnswer: 'bounded fact' }],
              },
            ],
          },
        ],
        candidates: [{ id: 'memory', ref: 'memory:v1', createAdapter: () => adapter }],
        runDir: '/runs/bounded-cleanup',
        storage,
        cleanupTimeoutMs: 10,
      }),
    ).rejects.toThrow('memory experiment cleanup failed after dispatch')

    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(
      storage.read('/runs/bounded-cleanup/memory-attempts.jsonl')?.trim().split('\n'),
    ).toHaveLength(1)
  })

  it('does not charge provider cost when side-effect-free adapter construction fails', async () => {
    const storage = inMemoryCampaignStorage()
    const costLedger = createRunCostLedger({
      storage,
      runDir: '/runs/create-adapter-cost',
      costCeilingUsd: 1,
    })

    await expect(
      runAgentMemoryExperiment({
        experimentId: 'create-adapter-cost',
        sequences: [
          {
            id: 'history',
            family: 'first-party',
            steps: [{ id: 'probe', probes: [{ id: 'probe', query: 'x', referenceAnswer: 'x' }] }],
          },
        ],
        candidates: [
          {
            id: 'paid-memory',
            ref: 'paid-memory:v1',
            externalCostUsdPerSequence: 0.25,
            createAdapter() {
              throw new Error('provider setup rejected')
            },
          },
        ],
        runDir: '/runs/create-adapter-cost',
        storage,
        costLedger,
      }),
    ).rejects.toThrow('memory experiment cleanup failed after dispatch')

    expect(costLedger.summary().totalCostUsd).toBe(0)
  })

  it('accounts for parallel candidates against one shared dollar limit', async () => {
    let releaseFirstCalls: (() => void) | undefined
    const firstCallsReady = new Promise<void>((resolve) => {
      releaseFirstCalls = resolve
    })
    let activeCalls = 0
    let firstCalls = 0
    let maxActiveCalls = 0
    const createAdapter = (id: string): AgentMemoryAdapter => {
      const adapter = createScopedTestAdapter(id)
      const clear = adapter.clear!
      let entered = false
      adapter.clear = async (scope) => {
        if (!entered) {
          entered = true
          firstCalls += 1
          activeCalls += 1
          maxActiveCalls = Math.max(maxActiveCalls, activeCalls)
          if (firstCalls === 2) releaseFirstCalls?.()
          await firstCallsReady
          activeCalls -= 1
        }
        await clear(scope)
      }
      return adapter
    }

    const result = await runAgentMemoryExperiment({
      experimentId: 'parallel-shared-cost',
      sequences: [
        {
          id: 'history',
          family: 'first-party',
          steps: [
            {
              id: 'remember',
              scope: { agentId: 'worker' },
              writes: [{ kind: 'fact', text: 'parallel fact' }],
              probes: [
                {
                  id: 'recall',
                  query: 'parallel',
                  scope: { agentId: 'worker' },
                  referenceAnswer: 'parallel fact',
                },
              ],
            },
          ],
        },
      ],
      candidates: ['first', 'second'].map((id) => ({
        id,
        ref: `${id}:v1`,
        externalCostUsdPerSequence: 0.1,
        createAdapter: () => createAdapter(id),
      })),
      runDir: '/runs/parallel-shared-cost',
      storage: inMemoryCampaignStorage(),
      costCeiling: 0.2,
      maxConcurrency: 2,
    })

    expect(maxActiveCalls).toBe(2)
    expect(result.rows.map((row) => row.totalCostUsd).sort()).toEqual([0.1, 0.1])
    expect(result.campaign.aggregates.totalCostUsd).toBe(0.2)
  })

  it('runs sequential paid histories after exact external-cost receipts', async () => {
    const storage = inMemoryCampaignStorage()
    const costLedger = createRunCostLedger({
      storage,
      runDir: '/runs/sequential-shared-cost',
      costCeilingUsd: 0.2,
    })
    const sequences = ['first', 'second'].map((id) => ({
      id,
      family: 'first-party',
      steps: [
        {
          id: 'remember',
          scope: { agentId: 'worker' },
          writes: [{ kind: 'fact' as const, text: `${id} fact` }],
          probes: [
            {
              id: 'recall',
              query: id,
              scope: { agentId: 'worker' },
              referenceAnswer: `${id} fact`,
            },
          ],
        },
      ],
    }))

    const result = await runAgentMemoryExperiment({
      experimentId: 'sequential-shared-cost',
      sequences,
      candidates: [
        {
          id: 'memory',
          ref: 'memory:v1',
          externalCostUsdPerSequence: 0.1,
          createAdapter: ({ sequence }) => createScopedTestAdapter(sequence.id),
        },
      ],
      runDir: '/runs/sequential-shared-cost',
      storage,
      costLedger,
      maxConcurrency: 1,
    })

    expect(result.rows[0]).toMatchObject({ cellsFailed: 0, totalCostUsd: 0.2 })
    expect(costLedger.summary()).toMatchObject({
      totalCalls: 2,
      totalCostUsd: 0.2,
      accountingComplete: true,
    })
  })

  it('reconciles interrupted paid calls from every parallel memory branch before resuming', async () => {
    const storage = inMemoryCampaignStorage()
    const runDir = '/runs/parallel-interrupted-cost-recovery'
    const abandonedLedger = createRunCostLedger({ storage, runDir, costCeilingUsd: 1 })
    const controllers = [new AbortController(), new AbortController()]
    const releases: Array<() => void> = []
    let started = 0
    let reportStarted: (() => void) | undefined
    const bothStarted = new Promise<void>((resolve) => {
      reportStarted = resolve
    })
    const abandonedCalls = ['one', 'two'].map((branch, index) =>
      abandonedLedger.runPaidCall({
        callId: `abandoned-${branch}`,
        channel: 'agent',
        phase: 'memory.train',
        actor: `agent-knowledge:memory-experiment:${branch}`,
        model: `provider-${branch}`,
        signal: controllers[index]!.signal,
        maximumCharge: { externallyEnforcedMaximumUsd: 0.1 },
        async execute() {
          started += 1
          if (started === 2) reportStarted?.()
          return await new Promise<string>((resolve) => {
            releases[index] = () => resolve('late provider result')
          })
        },
        receipt: () => ({
          model: `provider-${branch}`,
          inputTokens: 0,
          outputTokens: 0,
          actualCostUsd: 0.05,
        }),
      }),
    )

    await bothStarted
    for (const controller of controllers) {
      controller.abort(new Error('simulated process exit'))
    }
    await Promise.all(abandonedCalls)
    expect(abandonedLedger.listPending().map((call) => call.state)).toEqual(['late', 'late'])

    const resumedLedger = createRunCostLedger({ storage, runDir, costCeilingUsd: 1 })
    expect(resumedLedger.listPending().map((call) => call.state)).toEqual([
      'interrupted',
      'interrupted',
    ])

    const result = await runAgentMemoryExperiment({
      experimentId: 'parallel-interrupted-cost-recovery',
      sequences: [
        {
          id: 'history',
          family: 'first-party',
          steps: [
            {
              id: 'remember',
              scope: { agentId: 'worker' },
              writes: [{ kind: 'fact', text: 'resumed fact' }],
              probes: [
                {
                  id: 'recall',
                  query: 'resumed',
                  referenceAnswer: 'resumed fact',
                },
              ],
            },
          ],
        },
      ],
      candidates: [
        {
          id: 'resumed',
          ref: 'resumed:v1',
          createAdapter: () => createScopedTestAdapter('resumed'),
        },
      ],
      runDir,
      storage,
      costLedger: resumedLedger,
    })

    expect(result.rows[0]).toMatchObject({ candidateId: 'resumed', cellsFailed: 0 })
    expect(resumedLedger.summary()).toMatchObject({
      totalCalls: 2,
      unresolvedCalls: 0,
      totalCostUsd: 0.2,
      accountingComplete: true,
    })
    expect(resumedLedger.list().map((receipt) => receipt.error)).toEqual([
      expect.stringContaining('charged the reserved maximum'),
      expect.stringContaining('charged the reserved maximum'),
    ])

    for (const release of releases) release()
    await abandonedLedger.waitForIdle()
  })

  it('does not reuse cells after the candidate implementation reference changes', async () => {
    const storage = inMemoryCampaignStorage()
    const sequence = {
      id: 'candidate-ref',
      family: 'first-party' as const,
      steps: [
        {
          id: 'remember',
          scope: { agentId: 'worker' },
          writes: [{ kind: 'fact' as const, text: 'remember me' }],
          probes: [
            {
              id: 'recall',
              query: 'remember',
              requiredFacts: [{ id: 'fact', anyOf: ['remember me'] }],
            },
          ],
        },
      ],
    }
    let creates = 0
    const run = (ref: string, visible: boolean) =>
      runAgentMemoryExperiment({
        experimentId: 'candidate-ref-cache',
        sequences: [sequence],
        candidates: [
          {
            id: 'memory',
            ref,
            createAdapter() {
              creates += 1
              const adapter = createScopedTestAdapter(`memory:${ref}`)
              if (visible) return adapter
              return {
                ...adapter,
                async search() {
                  return []
                },
              }
            },
          },
        ],
        runDir: '/runs/candidate-ref-cache',
        storage,
      })

    const first = await run('memory:v1', true)
    const cached = await run('memory:v1', false)
    const changed = await run('memory:v2', false)

    expect(first.rows[0]?.scoreMean).toBe(1)
    expect(cached.campaign.cells[0]?.cached).toBe(true)
    expect(cached.rows[0]?.scoreMean).toBe(1)
    expect(changed.campaign.cells[0]?.cached).toBe(false)
    expect(changed.rows[0]?.scoreMean).toBe(0)
    expect(creates).toBe(2)
  })

  it('runs existing ordered memory benchmark cases without reshaping the dataset', async () => {
    const sequences = buildAgentMemorySequencesFromBenchmarkCases([
      {
        id: 'launch-update',
        family: 'longmemeval',
        taskKind: 'memory-temporal',
        split: 'holdout',
        events: [
          { id: 'old', actorId: 'pm', text: 'Launch is April 3.' },
          { id: 'current', actorId: 'pm', text: 'Launch moved to April 17.' },
        ],
        prompt: 'When is launch?',
        requiredFacts: [{ id: 'current-date', anyOf: ['April 17'] }],
        forbiddenFacts: [{ id: 'old-date', anyOf: ['April 3'], obsolete: true }],
        expectedEventIds: ['current'],
        expectedActorIds: ['pm'],
      },
    ])
    const result = await runAgentMemoryExperiment({
      experimentId: 'benchmark-conversion',
      sequences,
      candidates: [
        {
          id: 'literal-memory',
          ref: 'literal-memory:v1',
          createAdapter: () => createScopedTestAdapter('literal-memory'),
        },
      ],
      runDir: '/runs/benchmark-conversion',
      storage: inMemoryCampaignStorage(),
    })

    expect(sequences[0]?.steps.map((step) => step.id)).toEqual([
      'event:old',
      'event:current',
      'probe',
    ])
    expect(result.rows[0]).toMatchObject({
      scoreMean: 0.75,
      totalSequences: 1,
      totalProbes: 1,
      cellsFailed: 0,
    })
    expect(result.rows[0]?.dimensions).toMatchObject({ memory_stale_safe: 0 })
  })

  it('keeps each history ordered while comparing candidate branches in parallel', async () => {
    const storage = inMemoryCampaignStorage()
    const snapshots: string[] = []
    const stepOrder = new Map<string, string[]>()
    let active = 0
    let maxActive = 0
    let release: (() => void) | undefined
    const twoActive = new Promise<void>((resolve) => {
      release = resolve
    })
    const sequence = (id: string) => ({
      id,
      family: 'first-party' as const,
      split: 'holdout' as const,
      steps: [
        {
          id: 'research',
          scope: { agentId: 'researcher', teamId: 'team-1' },
          writes: [
            {
              id: `${id}-event`,
              kind: 'fact' as const,
              text: `${id} launch date is Friday`,
              metadata: { eventId: `${id}-event`, actorId: 'researcher' },
            },
          ],
        },
        {
          id: 'delivery',
          scope: { agentId: 'builder', teamId: 'team-1' },
          probes: [
            {
              id: 'launch-date',
              query: `${id} launch date`,
              requiredFacts: [{ id: 'current', anyOf: [`${id} launch date is Friday`] }],
              expectedEventIds: [`${id}-event`],
              expectedActorIds: ['researcher'],
            },
          ],
        },
      ],
    })

    const result = await runAgentMemoryExperiment({
      experimentId: 'team-sharing-vs-private',
      sequences: [sequence('alpha'), sequence('beta')],
      candidates: [
        {
          id: 'private',
          ref: 'private:v1',
          policy: { read: ['private'], write: 'private' },
          createAdapter: ({ branchId }) => createScopedTestAdapter(`private:${branchId}`),
        },
        {
          id: 'team',
          ref: 'team:v1',
          policy: { read: ['team'], write: 'team' },
          createAdapter: ({ branchId }) => createScopedTestAdapter(`team:${branchId}`),
        },
      ],
      runDir: '/runs/team-sharing-vs-private',
      storage,
      maxConcurrency: 4,
      cleanupBranches: true,
      executeStepRef: 'test-runtime/v1',
      executeStep: async ({ memory, step }) => {
        const order = stepOrder.get(memory.branchId) ?? []
        order.push(step.id)
        stepOrder.set(memory.branchId, order)
        if (step.id === 'research') {
          active += 1
          maxActive = Math.max(maxActive, active)
          if (active === 2) release?.()
          await twoActive
          active -= 1
        }
      },
      onBranchSnapshot: ({ snapshot }) => {
        snapshots.push(snapshot.digest)
      },
    })

    expect(maxActive).toBeGreaterThanOrEqual(2)
    expect(result.rows[0]).toMatchObject({
      rank: 1,
      candidateId: 'team',
      scoreMean: 1,
      passRate: 1,
      totalSequences: 2,
      totalCells: 2,
      totalProbes: 2,
      cellsFailed: 0,
    })
    expect(result.rows[1]?.candidateId).toBe('private')
    expect(result.rows[1]?.scoreMean).toBeLessThan(0.3)
    expect(result.campaign.cells).toHaveLength(4)
    expect(snapshots).toHaveLength(4)
    expect([...stepOrder.values()].every((steps) => steps.join(',') === 'research,delivery')).toBe(
      true,
    )
    expect(storage.read(result.rankingJsonPath)).toContain('"candidateId": "team"')
    expect(storage.read(result.rankingMarkdownPath)).toContain('| 1 | team |')
  })

  it('uses distinct external branch ids for distinct run directories', async () => {
    const branchIds: string[] = []
    const sequence = {
      id: 'branch-id',
      family: 'first-party' as const,
      steps: [
        {
          id: 'probe',
          scope: { agentId: 'worker' },
          probes: [{ id: 'state', query: 'state', referenceAnswer: 'state' }],
        },
      ],
    }
    const run = (runDir: string) =>
      runAgentMemoryExperiment({
        experimentId: 'same-experiment',
        sequences: [sequence],
        candidates: [
          {
            id: 'memory',
            ref: 'memory:v1',
            createAdapter({ branchId }) {
              branchIds.push(branchId)
              return createScopedTestAdapter(branchId)
            },
          },
        ],
        runDir,
        storage: inMemoryCampaignStorage(),
      })

    await run('/runs/branch-id-a')
    await run('/runs/branch-id-b')

    expect(branchIds).toHaveLength(2)
    expect(branchIds[0]).not.toBe(branchIds[1])
  })

  it('uses a fresh external branch id for each distributed execution attempt', async () => {
    const branchIds: string[] = []
    const run = (runDir: string) =>
      runAgentMemoryExperiment({
        experimentId: 'distributed-experiment',
        experimentRunId: 'distributed-run-17',
        sequences: [
          {
            id: 'shared-history',
            family: 'first-party',
            steps: [
              {
                id: 'probe',
                scope: { agentId: 'worker' },
                probes: [{ id: 'state', query: 'state', referenceAnswer: 'state' }],
              },
            ],
          },
        ],
        candidates: [
          {
            id: 'memory',
            ref: 'memory:v1',
            createAdapter({ branchId }) {
              branchIds.push(branchId)
              return createScopedTestAdapter(branchId)
            },
          },
        ],
        runDir,
        storage: inMemoryCampaignStorage(),
      })

    await run('/worker-a/run')
    await run('/worker-b/run')

    expect(branchIds).toHaveLength(2)
    expect(branchIds[0]).not.toBe(branchIds[1])
  })

  it('waits for timed-out provider work to finish cleanup before returning', async () => {
    let releaseWrite!: () => void
    const writeMayFinish = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    let reportWriteStarted!: () => void
    const writeStarted = new Promise<void>((resolve) => {
      reportWriteStarted = resolve
    })
    const rows: AgentMemoryHit[] = []
    let clears = 0
    const adapter: AgentMemoryAdapter = {
      id: 'slow-provider',
      branchIsolation: { mode: 'scoped' },
      async search() {
        return [...rows]
      },
      async getContext(query) {
        return { query, text: rows.map(hitText).join('\n'), hits: [...rows], sourceRecords: [] }
      },
      async write(input) {
        reportWriteStarted()
        await writeMayFinish
        const hit = {
          id: 'late-write',
          uri: 'memory://slow-provider/late-write',
          kind: input.kind,
          text: input.text,
        }
        rows.push(hit)
        return { accepted: true, id: hit.id, uri: hit.uri, kind: hit.kind }
      },
      async clear() {
        clears += 1
        rows.length = 0
      },
    }
    const run = runAgentMemoryExperiment({
      experimentId: 'timeout-cleanup',
      sequences: [
        {
          id: 'slow-history',
          family: 'first-party',
          steps: [
            {
              id: 'write',
              scope: { agentId: 'worker' },
              writes: [{ kind: 'fact', text: 'late fact' }],
              probes: [{ id: 'fact', query: 'fact', referenceAnswer: 'late fact' }],
            },
          ],
        },
      ],
      candidates: [{ id: 'slow', ref: 'slow:v1', createAdapter: () => adapter }],
      runDir: '/runs/timeout-cleanup',
      storage: inMemoryCampaignStorage(),
      dispatchTimeoutMs: 5,
    })
    await writeStarted
    let settled = false
    void run.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 15))

    expect(settled).toBe(false)
    releaseWrite()
    const result = await run

    expect(result.rows[0]).toMatchObject({ cellsFailed: 1 })
    expect(result.campaign.cells[0]?.error).toContain('dispatch exceeded 5ms')
    expect(clears).toBeGreaterThanOrEqual(2)
    expect(rows).toEqual([])
  })

  it('fails when cleanup after a timed-out provider write fails', async () => {
    let releaseWrite!: () => void
    const writeMayFinish = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    let reportWriteStarted!: () => void
    const writeStarted = new Promise<void>((resolve) => {
      reportWriteStarted = resolve
    })
    let clears = 0
    const adapter: AgentMemoryAdapter = {
      id: 'cleanup-failure',
      branchIsolation: { mode: 'scoped' },
      async search() {
        return []
      },
      async getContext(query) {
        return { query, text: '', hits: [], sourceRecords: [] }
      },
      async write(input) {
        reportWriteStarted()
        await writeMayFinish
        return {
          accepted: true,
          id: 'late-write',
          uri: 'memory://cleanup-failure/late-write',
          kind: input.kind,
        }
      },
      async clear() {
        clears += 1
        if (clears > 1) throw new Error('provider cleanup unavailable')
      },
    }
    const run = runAgentMemoryExperiment({
      experimentId: 'timeout-cleanup-failure',
      sequences: [
        {
          id: 'slow-history',
          family: 'first-party',
          steps: [
            {
              id: 'write',
              scope: { agentId: 'worker' },
              writes: [{ kind: 'fact', text: 'late fact' }],
              probes: [{ id: 'fact', query: 'fact', referenceAnswer: 'late fact' }],
            },
          ],
        },
      ],
      candidates: [{ id: 'slow', ref: 'slow:v1', createAdapter: () => adapter }],
      runDir: '/runs/timeout-cleanup-failure',
      storage: inMemoryCampaignStorage(),
      dispatchTimeoutMs: 5,
    })
    await writeStarted
    await new Promise((resolve) => setTimeout(resolve, 10))
    releaseWrite()

    await expect(run).rejects.toThrow('memory experiment cleanup failed after dispatch')
  })

  it('recovers an unfinished provider branch before retrying the history', async () => {
    const storage = inMemoryCampaignStorage()
    const rows = new Map<string, AgentMemoryHit[]>()
    const operations: string[] = []
    const branchIds: Record<'first' | 'recovery' | 'retry', string | undefined> = {
      first: undefined,
      recovery: undefined,
      retry: undefined,
    }
    let firstExecution = true
    const sequence = {
      id: 'recover-history',
      family: 'first-party' as const,
      steps: [
        {
          id: 'remember',
          scope: { agentId: 'worker' },
          writes: [{ kind: 'fact' as const, text: 'sensitive provider fact' }],
          probes: [
            {
              id: 'recall',
              query: 'provider fact',
              referenceAnswer: 'sensitive provider fact',
            },
          ],
        },
      ],
    }
    const candidate = {
      id: 'recoverable',
      ref: 'recoverable:v1',
      externalRecoveryCostUsdPerAttempt: 0.1,
      createAdapter({ branchId, purpose }: { branchId: string; purpose: 'execute' | 'recovery' }) {
        const executionLabel =
          purpose === 'recovery' ? 'recovery' : firstExecution ? 'first' : 'retry'
        branchIds[executionLabel] = branchId
        operations.push(`create:${executionLabel}`)
        let clearCalls = 0
        const adapter: AgentMemoryAdapter = {
          id: 'recoverable-provider',
          branchIsolation: { mode: 'scoped' },
          async search(_query, options) {
            return [...(rows.get(options.scope?.namespace ?? '') ?? [])]
          },
          async getContext(query, options) {
            const hits = await adapter.search(query, options)
            return { query, text: hits.map(hitText).join('\n'), hits, sourceRecords: [] }
          },
          async write(input) {
            operations.push(`write:${executionLabel}`)
            const namespace = input.scope?.namespace ?? ''
            const hit = {
              id: input.id ?? `${executionLabel}-fact`,
              uri: `memory://recoverable/${executionLabel}`,
              kind: input.kind,
              text: input.text,
            }
            rows.set(namespace, [...(rows.get(namespace) ?? []), hit])
            return { accepted: true, id: hit.id, uri: hit.uri, kind: hit.kind }
          },
          async clear(scope) {
            clearCalls += 1
            operations.push(`clear:${executionLabel}`)
            if (executionLabel === 'first' && clearCalls > 1) {
              throw new Error('provider cleanup unavailable')
            }
            rows.delete(scope?.namespace ?? '')
          },
        }
        if (purpose === 'execute') firstExecution = false
        return adapter
      },
    }
    const run = () =>
      runAgentMemoryExperiment({
        experimentId: 'restart-recovery',
        sequences: [sequence],
        candidates: [candidate],
        runDir: '/runs/restart-recovery',
        storage,
        costCeiling: 1,
      })

    await expect(run()).rejects.toThrow('memory experiment cleanup failed after dispatch')
    expect(rows.size).toBe(1)

    const result = await run()

    expect(result.rows[0]).toMatchObject({ candidateId: 'recoverable', cellsFailed: 0 })
    expect(result.rows[0]?.totalCostUsd).toBe(0.1)
    expect(result.campaign.aggregates.totalCostUsd).toBe(0.1)
    expect(branchIds.recovery).toBe(branchIds.first)
    expect(branchIds.retry).not.toBe(branchIds.first)
    expect(operations.indexOf('clear:recovery')).toBeLessThan(operations.indexOf('write:retry'))
    expect(rows.size).toBe(0)
    const attemptEvents = storage
      .read(result.attemptLogPath)!
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { status: string; recovery: boolean })
    expect(attemptEvents.map(({ status, recovery }) => ({ status, recovery }))).toEqual([
      { status: 'started', recovery: false },
      { status: 'cleaned', recovery: true },
      { status: 'started', recovery: false },
      { status: 'cleaned', recovery: false },
    ])
  })

  it('reconciles a crash after provider recovery but before its cost receipt', async () => {
    const storage = inMemoryCampaignStorage()
    const append = storage.append!.bind(storage)
    let failRecoveryReceipt = false
    storage.append = (path, value, expectedBytes) => {
      if (
        failRecoveryReceipt &&
        path.endsWith('/cost-ledger.jsonl') &&
        value.includes('"status":"settled"') &&
        value.includes('agent-knowledge:memory-recovery')
      ) {
        failRecoveryReceipt = false
        throw new Error('simulated process exit before recovery receipt')
      }
      return append(path, value, expectedBytes)
    }

    let firstExecution = true
    let recoveryClears = 0
    const candidate = {
      id: 'crash-recoverable',
      ref: 'crash-recoverable:v1',
      externalCostUsdPerSequence: 0.1,
      externalRecoveryCostUsdPerAttempt: 0.1,
      createAdapter({ purpose }: { purpose: 'execute' | 'recovery' }) {
        const adapter = createScopedTestAdapter(`crash-recoverable:${purpose}`)
        const clear = adapter.clear!
        let clearCalls = 0
        const failThisExecution = purpose === 'execute' && firstExecution
        if (purpose === 'execute') firstExecution = false
        adapter.clear = async (scope) => {
          clearCalls += 1
          if (purpose === 'recovery') recoveryClears += 1
          if (failThisExecution && clearCalls === 2) {
            throw new Error('leave the first branch active')
          }
          await clear(scope)
        }
        return adapter
      },
    }
    const run = () =>
      runAgentMemoryExperiment({
        experimentId: 'recovery-receipt-crash',
        sequences: [
          {
            id: 'history',
            family: 'first-party',
            steps: [
              {
                id: 'remember',
                scope: { agentId: 'worker' },
                writes: [{ kind: 'fact', text: 'durable recovery fact' }],
                probes: [
                  {
                    id: 'recall',
                    query: 'durable',
                    referenceAnswer: 'durable recovery fact',
                  },
                ],
              },
            ],
          },
        ],
        candidates: [candidate],
        runDir: '/runs/recovery-receipt-crash',
        storage,
        costCeiling: 1,
      })

    await expect(run()).rejects.toThrow('memory experiment cleanup failed after dispatch')
    failRecoveryReceipt = true
    await expect(run()).rejects.toThrow('failed to persist')
    expect(
      storage.read('/runs/recovery-receipt-crash/memory-attempts.jsonl')?.trim().split('\n'),
    ).toHaveLength(1)

    const result = await run()
    const costLedger = createRunCostLedger({
      storage,
      runDir: '/runs/recovery-receipt-crash',
      costCeilingUsd: 1,
    })

    expect(result.rows[0]).toMatchObject({ candidateId: 'crash-recoverable', cellsFailed: 0 })
    expect(recoveryClears).toBe(2)
    expect(costLedger.summary()).toMatchObject({
      unresolvedCalls: 0,
      totalCostUsd: 0.4,
      accountingComplete: true,
    })
  })

  it('recovers independent abandoned branches in parallel before retrying them', async () => {
    const storage = inMemoryCampaignStorage()
    let phase: 'leave-active' | 'recover' = 'leave-active'
    let activeRecoveries = 0
    let maxActiveRecoveries = 0
    let releaseRecoveries: (() => void) | undefined
    const recoveriesStarted = new Promise<void>((resolve) => {
      releaseRecoveries = resolve
    })
    const sequences = ['one', 'two'].map((id) => ({
      id,
      family: 'first-party' as const,
      steps: [
        {
          id: 'remember',
          scope: { agentId: 'worker' },
          writes: [{ kind: 'fact' as const, text: `${id} fact` }],
          probes: [{ id: 'recall', query: id, referenceAnswer: `${id} fact` }],
        },
      ],
    }))
    const run = () =>
      runAgentMemoryExperiment({
        experimentId: 'parallel-recovery',
        sequences,
        candidates: [
          {
            id: 'memory',
            ref: 'memory:v1',
            async createAdapter({ purpose }) {
              if (purpose === 'recovery') {
                activeRecoveries += 1
                maxActiveRecoveries = Math.max(maxActiveRecoveries, activeRecoveries)
                if (activeRecoveries === 2) releaseRecoveries?.()
                await recoveriesStarted
                activeRecoveries -= 1
                return null
              }
              if (phase === 'leave-active') return null
              return createScopedTestAdapter('parallel-recovery')
            },
          },
        ],
        runDir: '/runs/parallel-recovery',
        storage,
        maxConcurrency: 2,
      })

    await expect(run()).rejects.toThrow('memory experiment cleanup failed after dispatch')
    phase = 'recover'
    const result = await run()

    expect(maxActiveRecoveries).toBe(2)
    expect(result.rows[0]).toMatchObject({ candidateId: 'memory', cellsFailed: 0 })
    const recovered = storage
      .read(result.attemptLogPath)!
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { status: string; recovery: boolean })
      .filter((event) => event.status === 'cleaned' && event.recovery)
    expect(recovered).toHaveLength(2)
  })

  it('closes an attempt whose provider was never created before retrying it', async () => {
    const storage = inMemoryCampaignStorage()
    const purposes: Array<'execute' | 'recovery'> = []
    let executionCalls = 0
    const sequence = {
      id: 'provider-creation',
      family: 'first-party' as const,
      steps: [
        {
          id: 'remember',
          scope: { agentId: 'worker' },
          writes: [{ kind: 'fact' as const, text: 'created provider fact' }],
          probes: [
            {
              id: 'recall',
              query: 'provider fact',
              referenceAnswer: 'created provider fact',
            },
          ],
        },
      ],
    }
    const run = () =>
      runAgentMemoryExperiment({
        experimentId: 'provider-creation-recovery',
        sequences: [sequence],
        candidates: [
          {
            id: 'sometimes-created',
            ref: 'sometimes-created:v1',
            externalRecoveryCostUsdPerAttempt: 0.1,
            createAdapter({ purpose }) {
              purposes.push(purpose)
              if (purpose === 'recovery') return null
              executionCalls += 1
              if (executionCalls === 1) return null
              return createScopedTestAdapter('created-provider')
            },
          },
        ],
        runDir: '/runs/provider-creation-recovery',
        storage,
        costCeiling: 1,
      })

    await expect(run()).rejects.toThrow('memory experiment cleanup failed after dispatch')
    const result = await run()

    expect(result.rows[0]).toMatchObject({ candidateId: 'sometimes-created', cellsFailed: 0 })
    expect(result.rows[0]?.totalCostUsd).toBe(0)
    expect(purposes).toEqual(['execute', 'recovery', 'execute'])
    const attemptEvents = storage
      .read(result.attemptLogPath)!
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { status: string; recovery: boolean })
    expect(attemptEvents.map(({ status, recovery }) => ({ status, recovery }))).toEqual([
      { status: 'started', recovery: false },
      { status: 'cleaned', recovery: true },
      { status: 'started', recovery: false },
      { status: 'cleaned', recovery: false },
    ])
  })

  it('uses a retired candidate only to clean its unfinished branch', async () => {
    const storage = inMemoryCampaignStorage()
    const runDir = '/runs/retired-recovery-candidate'
    const sequence = {
      id: 'history',
      family: 'first-party' as const,
      steps: [
        {
          id: 'remember',
          scope: { agentId: 'worker' },
          writes: [{ kind: 'fact' as const, text: 'active fact' }],
          probes: [{ id: 'recall', query: 'active', referenceAnswer: 'active fact' }],
        },
      ],
    }
    storage.write(
      `${runDir}/memory-attempts.jsonl`,
      `${JSON.stringify({
        schema: 1,
        status: 'started',
        branchId: 'retired-branch',
        candidateId: 'retired',
        candidateRef: 'retired:v1',
        sequenceId: sequence.id,
        rep: 0,
        seed: 1,
        cleanupBranches: true,
        recordedAt: '2026-01-01T00:00:00.000Z',
        recovery: false,
      })}\n`,
    )
    const purposes: string[] = []
    let retiredClears = 0
    const result = await runAgentMemoryExperiment({
      experimentId: 'retired-recovery-candidate',
      sequences: [sequence],
      candidates: [
        {
          id: 'active',
          ref: 'active:v1',
          createAdapter({ purpose }) {
            purposes.push(`active:${purpose}`)
            return createScopedTestAdapter('active')
          },
        },
      ],
      recoveryCandidates: [
        {
          id: 'retired',
          ref: 'retired:v1',
          createAdapter({ purpose }) {
            purposes.push(`retired:${purpose}`)
            const adapter = createScopedTestAdapter('retired')
            adapter.clear = async () => {
              retiredClears += 1
            }
            return adapter
          },
        },
      ],
      runDir,
      storage,
      resumable: false,
    })

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.candidateId).toBe('active')
    expect(purposes).toEqual(['retired:recovery', 'active:execute'])
    expect(retiredClears).toBeGreaterThan(0)
  })

  it('refuses a recovery backlog larger than maxRecoveryAttempts', async () => {
    const storage = inMemoryCampaignStorage()
    const runDir = '/runs/recovery-backlog-limit'
    const sequence = {
      id: 'history',
      family: 'first-party' as const,
      steps: [
        {
          id: 'probe',
          scope: { agentId: 'worker' },
          probes: [{ id: 'recall', query: 'fact', referenceAnswer: 'fact' }],
        },
      ],
    }
    storage.write(
      `${runDir}/memory-attempts.jsonl`,
      `${[
        {
          schema: 1,
          status: 'started',
          branchId: 'branch-1',
          candidateId: 'memory',
          candidateRef: 'memory:v1',
          sequenceId: sequence.id,
          rep: 0,
          seed: 1,
          cleanupBranches: true,
          recordedAt: '2026-01-01T00:00:00.000Z',
          recovery: false,
        },
        {
          schema: 1,
          status: 'started',
          branchId: 'branch-2',
          candidateId: 'memory',
          candidateRef: 'memory:v1',
          sequenceId: sequence.id,
          rep: 0,
          seed: 2,
          cleanupBranches: true,
          recordedAt: '2026-01-01T00:00:00.000Z',
          recovery: false,
        },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n')}\n`,
    )
    let providerCreates = 0

    await expect(
      runAgentMemoryExperiment({
        experimentId: 'recovery-backlog-limit',
        sequences: [sequence],
        candidates: [
          {
            id: 'memory',
            ref: 'memory:v1',
            createAdapter() {
              providerCreates += 1
              return createScopedTestAdapter('memory')
            },
          },
        ],
        runDir,
        storage,
        maxRecoveryAttempts: 1,
      }),
    ).rejects.toThrow('2 unfinished attempts; maxRecoveryAttempts is 1')
    expect(providerCreates).toBe(0)
  })

  it('allows one controller per run while its history workers run in parallel', async () => {
    const storage = inMemoryCampaignStorage()
    let reportStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve
    })
    let releaseWorker: (() => void) | undefined
    const continueWorker = new Promise<void>((resolve) => {
      releaseWorker = resolve
    })
    const options: RunAgentMemoryExperimentOptions = {
      experimentId: 'single-controller',
      sequences: [
        {
          id: 'one',
          family: 'first-party',
          steps: [
            {
              id: 'work',
              scope: { agentId: 'worker' },
              writes: [{ kind: 'fact', text: 'parallel worker fact' }],
              probes: [
                {
                  id: 'recall',
                  query: 'worker fact',
                  referenceAnswer: 'parallel worker fact',
                },
              ],
            },
          ],
        },
      ],
      candidates: [
        {
          id: 'memory',
          ref: 'memory:v1',
          createAdapter: () => createScopedTestAdapter('single-controller'),
        },
      ],
      runDir: '/runs/single-controller',
      storage,
      executeStepRef: 'blocking-step:v1',
      async executeStep() {
        reportStarted?.()
        await continueWorker
      },
    }

    const firstRun = runAgentMemoryExperiment(options)
    await started
    await expect(
      runAgentMemoryExperiment({ ...options, storage: inMemoryCampaignStorage() }),
    ).rejects.toThrow('active controller')
    releaseWorker?.()
    const result = await firstRun

    expect(result.rows[0]).toMatchObject({ candidateId: 'memory', cellsFailed: 0 })
  })

  it('leaves a lost controller branch for the next owner and accepts duplicate cleanup receipts', async () => {
    const storage = inMemoryCampaignStorage()
    let firstControllerOwned = true
    let expireFirstController = true
    let controllerCount = 0
    let searches = 0
    let clears = 0
    let closes = 0
    let factVisible = false
    const purposes: string[] = []
    const options: RunAgentMemoryExperimentOptions = {
      experimentId: 'lost-controller',
      sequences: [
        {
          id: 'one',
          family: 'first-party',
          steps: [
            {
              id: 'work',
              scope: { agentId: 'worker' },
              writes: [{ kind: 'fact', text: 'must be cleaned' }],
              probes: [{ id: 'probe', query: 'must', referenceAnswer: 'must be cleaned' }],
            },
          ],
        },
      ],
      candidates: [
        {
          id: 'memory',
          ref: 'memory:v1',
          createAdapter({ purpose }) {
            purposes.push(purpose)
            const adapter: AgentMemoryAdapter = {
              id: 'lost-controller',
              branchIsolation: { mode: 'scoped' },
              async search() {
                searches += 1
                return factVisible
                  ? [
                      {
                        id: 'write',
                        uri: 'memory://lost-controller/write',
                        kind: 'fact',
                        text: 'must be cleaned',
                      },
                    ]
                  : []
              },
              async getContext(query, searchOptions) {
                const hits = await adapter.search(query, searchOptions)
                return { query, text: hits.map(hitText).join('\n'), hits, sourceRecords: [] }
              },
              async write(input) {
                factVisible = true
                return {
                  accepted: true,
                  id: 'write',
                  uri: 'memory://lost-controller/write',
                  kind: input.kind,
                }
              },
              async clear() {
                clears += 1
                factVisible = false
              },
              async close() {
                closes += 1
              },
            }
            return adapter
          },
        },
      ],
      runDir: '/runs/lost-controller',
      storage,
      acquireRunLease: async () => {
        controllerCount += 1
        const controller = controllerCount
        return {
          assertOwned() {
            if (controller === 1 && !firstControllerOwned) {
              throw new Error('controller ownership expired')
            }
          },
          release() {},
        }
      },
      executeStepRef: 'expire-controller:v1',
      async executeStep() {
        if (expireFirstController) {
          expireFirstController = false
          firstControllerOwned = false
        }
      },
    }
    const run = () => runAgentMemoryExperiment(options)

    await expect(run()).rejects.toThrow('controller ownership expired')
    expect(searches).toBe(0)
    expect(clears).toBe(1)
    expect(closes).toBe(1)
    expect(factVisible).toBe(true)

    const result = await run()
    expect(result.rows[0]).toMatchObject({ candidateId: 'memory', cellsFailed: 0 })
    expect(purposes).toEqual(['execute', 'recovery', 'execute'])
    expect(clears).toBe(4)
    expect(closes).toBe(3)
    expect(factVisible).toBe(false)

    const journal = storage.read(result.attemptLogPath)!
    const lines = journal.trim().split('\n')
    const last = lines.at(-1)!
    expect(storage.append!(result.attemptLogPath, `${last}\n`, Buffer.byteLength(journal))).toBe(
      Buffer.byteLength(journal) + Buffer.byteLength(`${last}\n`),
    )
    const callsBeforeCachedRun = {
      purposes: purposes.length,
      searches,
      clears,
      closes,
    }
    const cached = await run()
    expect(cached.campaign.aggregates.cellsCached).toBe(1)
    expect({ purposes: purposes.length, searches, clears, closes }).toEqual(callsBeforeCachedRun)
  })

  it('preserves both the run failure and controller release failure', async () => {
    const error = await runAgentMemoryExperiment({
      experimentId: 'run-and-release-failure',
      sequences: [
        {
          id: 'one',
          family: 'first-party',
          steps: [
            {
              id: 'probe',
              probes: [{ id: 'probe', query: 'state', referenceAnswer: 'state' }],
            },
          ],
        },
      ],
      candidates: [
        {
          id: 'unused',
          ref: 'unused:v1',
          createAdapter: () => createScopedTestAdapter('unused'),
        },
      ],
      runDir: '/runs/run-and-release-failure',
      storage: inMemoryCampaignStorage(),
      acquireRunLease: async () => ({
        assertOwned() {
          throw new Error('run ownership failed')
        },
        release() {
          throw new Error('release failed')
        },
      }),
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors.map((item) => String(item))).toEqual([
      'Error: run ownership failed',
      'Error: release failed',
    ])
  })

  it('uses the same random seed for every candidate on one history and repetition', async () => {
    const seeds = new Map<string, number>()
    const sequence = {
      id: 'paired-history',
      family: 'first-party' as const,
      steps: [
        {
          id: 'probe',
          scope: { agentId: 'worker' },
          probes: [{ id: 'state', query: 'state', referenceAnswer: 'state' }],
        },
      ],
    }
    await runAgentMemoryExperiment({
      experimentId: 'paired-seeds',
      sequences: [sequence],
      candidates: ['a', 'b'].map((candidateId) => ({
        id: candidateId,
        ref: `${candidateId}:v1`,
        createAdapter: ({ sequence: candidateSequence, rep, seed }) => {
          seeds.set(`${candidateId}:${candidateSequence.id}:${rep}`, seed)
          return createScopedTestAdapter(`${candidateId}:${rep}`)
        },
      })),
      reps: 2,
      runDir: '/runs/paired-seeds',
      storage: inMemoryCampaignStorage(),
      maxConcurrency: 4,
    })

    expect(seeds.get('a:paired-history:0')).toBe(seeds.get('b:paired-history:0'))
    expect(seeds.get('a:paired-history:1')).toBe(seeds.get('b:paired-history:1'))
    expect(seeds.get('a:paired-history:0')).not.toBe(seeds.get('a:paired-history:1'))
  })

  it('fails the experiment when accepted writes cannot be cleared after a failed step', async () => {
    let clears = 0
    let closes = 0
    let disposals = 0
    const run = runAgentMemoryExperiment({
      experimentId: 'failed-step-cleanup',
      sequences: [
        {
          id: 'failure',
          family: 'first-party',
          steps: [
            {
              id: 'write-then-fail',
              scope: { agentId: 'worker' },
              writes: [{ kind: 'fact', text: 'partial state' }],
              probes: [{ id: 'state', query: 'partial state', referenceAnswer: 'partial state' }],
            },
          ],
        },
      ],
      candidates: [
        {
          id: 'scoped',
          ref: 'scoped:v1',
          createAdapter() {
            const base = createScopedTestAdapter('failure')
            return {
              ...base,
              async clear(scope) {
                clears += 1
                await base.clear?.(scope)
                if (clears > 1) throw new Error('provider clear failed')
              },
              async close() {
                closes += 1
              },
            }
          },
          async disposeAdapter() {
            disposals += 1
          },
        },
      ],
      runDir: '/runs/failed-step-cleanup',
      storage: inMemoryCampaignStorage(),
      cleanupBranches: true,
      executeStepRef: 'failing-worker/v1',
      async executeStep() {
        throw new Error('worker failed')
      },
    })

    await expect(run).rejects.toThrow('memory experiment cleanup failed after dispatch')
    expect(clears).toBe(2)
    expect(closes).toBe(1)
    expect(disposals).toBe(1)
  })

  it('cleans an unjournaled provider side effect and ranks failed histories below complete ones', async () => {
    let dirtyRows = 0
    let clears = 0
    const result = await runAgentMemoryExperiment({
      experimentId: 'provider-side-effect-cleanup',
      sequences: [
        {
          id: 'one',
          family: 'first-party',
          steps: [
            {
              id: 'remember',
              scope: { agentId: 'worker' },
              writes: [{ kind: 'fact', text: 'Launch is Friday.' }],
              probes: [{ id: 'launch', query: 'launch', referenceAnswer: 'Launch is Friday.' }],
            },
          ],
        },
      ],
      candidates: [
        {
          id: 'side-effect-then-error',
          ref: 'side-effect-then-error:v1',
          createAdapter: () => ({
            id: 'side-effect-then-error',
            branchIsolation: { mode: 'scoped' },
            async search() {
              return []
            },
            async getContext(query) {
              return { query, text: '', hits: [], sourceRecords: [] }
            },
            async write() {
              dirtyRows += 1
              throw new Error('provider disconnected after commit')
            },
            async clear() {
              clears += 1
              dirtyRows = 0
            },
          }),
        },
        {
          id: 'complete',
          ref: 'complete:v1',
          createAdapter: () => createScopedTestAdapter('complete'),
        },
      ],
      runDir: '/runs/provider-side-effect-cleanup',
      storage: inMemoryCampaignStorage(),
      cleanupBranches: true,
      maxConcurrency: 2,
    })

    expect(dirtyRows).toBe(0)
    expect(clears).toBe(2)
    expect(result.rows[0]).toMatchObject({
      candidateId: 'complete',
      cellsFailed: 0,
      scoreMean: 1,
    })
    expect(result.rows[1]).toMatchObject({
      candidateId: 'side-effect-then-error',
      cellsFailed: 1,
      scoreMean: 0,
      passRate: 0,
    })
  })

  it('closes and disposes an adapter when branch validation fails', async () => {
    let closes = 0
    let disposals = 0
    const result = await runAgentMemoryExperiment({
      experimentId: 'invalid-branch-cleanup',
      sequences: [
        {
          id: 'one',
          family: 'first-party',
          steps: [
            {
              id: 'probe',
              scope: { agentId: 'worker' },
              probes: [{ id: 'state', query: 'state', referenceAnswer: 'state' }],
            },
          ],
        },
      ],
      candidates: [
        {
          id: 'legacy',
          ref: 'legacy:v1',
          createAdapter() {
            const { branchIsolation: _branchIsolation, ...legacy } =
              createScopedTestAdapter('legacy')
            return {
              ...legacy,
              async close() {
                closes += 1
              },
            }
          },
          async disposeAdapter() {
            disposals += 1
          },
        },
      ],
      runDir: '/runs/invalid-branch-cleanup',
      storage: inMemoryCampaignStorage(),
      cleanupBranches: false,
    })

    expect(result.rows[0]).toMatchObject({ cellsFailed: 1 })
    expect(result.campaign.cells[0]?.error).toContain('adapter must declare branchIsolation')
    expect(closes).toBe(1)
    expect(disposals).toBe(1)
  })

  it('fails closed when cleanup is requested for an adapter without scoped clear', async () => {
    let disposals = 0
    const result = await runAgentMemoryExperiment({
      experimentId: 'unsupported-cleanup',
      sequences: [
        {
          id: 'one',
          family: 'first-party',
          steps: [
            {
              id: 'probe',
              scope: { agentId: 'worker' },
              probes: [{ id: 'state', query: 'state', referenceAnswer: 'state' }],
            },
          ],
        },
      ],
      candidates: [
        {
          id: 'no-clear',
          ref: 'no-clear:v1',
          createAdapter() {
            const { clear: _clear, ...adapter } = createScopedTestAdapter('no-clear')
            return adapter
          },
          async disposeAdapter() {
            disposals += 1
          },
        },
      ],
      runDir: '/runs/unsupported-cleanup',
      storage: inMemoryCampaignStorage(),
      cleanupBranches: true,
    })

    expect(result.rows[0]).toMatchObject({ cellsFailed: 1 })
    expect(result.campaign.cells[0]?.error).toContain('requires an adapter with scoped clear')
    expect(disposals).toBe(1)
  })

  it('rejects dynamic writes whose scope cannot be cleaned after a crash', async () => {
    let providerWrites = 0
    const result = await runAgentMemoryExperiment({
      experimentId: 'undeclared-dynamic-scope',
      sequences: [
        {
          id: 'one',
          family: 'first-party',
          steps: [
            {
              id: 'agent-step',
              scope: { agentId: 'declared' },
              probes: [{ id: 'state', query: 'state', referenceAnswer: 'state' }],
            },
          ],
        },
      ],
      candidates: [
        {
          id: 'scoped',
          ref: 'scoped:v1',
          createAdapter: () =>
            createScopedTestAdapter('scoped', async () => {
              providerWrites += 1
            }),
        },
      ],
      runDir: '/runs/undeclared-dynamic-scope',
      storage: inMemoryCampaignStorage(),
      cleanupBranches: true,
      executeStepRef: 'dynamic-scope-test/v1',
      executeStep: async ({ memory }) => {
        await memory.write({
          kind: 'fact',
          text: 'must not reach the provider',
          scope: { agentId: 'undeclared' },
        })
      },
    })

    expect(result.rows[0]).toMatchObject({ cellsFailed: 1 })
    expect(result.campaign.cells[0]?.error).toContain(
      'write scope was not declared in the experiment sequence cleanupScopes',
    )
    expect(providerWrites).toBe(0)
  })

  it('requires an external-state disposer when scoped cleanup is disabled', async () => {
    let creates = 0
    await expect(
      runAgentMemoryExperiment({
        experimentId: 'missing-disposer',
        sequences: [
          {
            id: 'one',
            family: 'first-party',
            steps: [
              {
                id: 'probe',
                scope: { agentId: 'worker' },
                probes: [{ id: 'state', query: 'state', referenceAnswer: 'state' }],
              },
            ],
          },
        ],
        candidates: [
          {
            id: 'persistent',
            ref: 'persistent:v1',
            createAdapter() {
              creates += 1
              return createScopedTestAdapter('persistent')
            },
          },
        ],
        runDir: '/runs/missing-disposer',
        storage: inMemoryCampaignStorage(),
        cleanupBranches: false,
      }),
    ).rejects.toThrow('requires disposeAdapter')

    expect(creates).toBe(0)
  })

  it('rejects probes that cannot distinguish a useful memory system', async () => {
    await expect(
      runAgentMemoryExperiment({
        experimentId: 'no-target',
        sequences: [
          {
            id: 'one',
            family: 'first-party',
            steps: [
              {
                id: 'probe',
                scope: { agentId: 'worker' },
                probes: [{ id: 'state', query: 'state' }],
              },
            ],
          },
        ],
        candidates: [
          {
            id: 'memory',
            ref: 'memory:v1',
            createAdapter: () => createScopedTestAdapter('memory'),
          },
        ],
        runDir: '/runs/no-target',
        storage: inMemoryCampaignStorage(),
      }),
    ).rejects.toThrow('has no measurable target')
  })
})

describe('agent memory improvement', () => {
  it('fails fast when a JavaScript caller uses the removed onPromote option', async () => {
    await expect(
      runAgentMemoryImprovementRaw({
        onPromote() {},
      } as unknown as RunAgentMemoryImprovementOptions<unknown>),
    ).rejects.toThrow(
      'onPromote was removed; use activation.readCurrent and activation.compareAndSet',
    )
  })

  it('requires an explicit controller policy for custom improvement storage', async () => {
    await expect(
      runAgentMemoryImprovementRaw({
        experimentId: 'custom-improvement-storage',
        trainSequences: [improvementSequence('train', 'train')],
        holdoutSequences: [improvementSequence('holdout', 'holdout')],
        seeds: [
          {
            config: { mode: 'baseline' },
            track: 'baseline',
            proposer: 'default',
          },
        ],
        createCandidate: () => ({
          ref: 'memory:v1',
          createAdapter: () => createScopedTestAdapter('memory'),
        }),
        proposer: { kind: 'noop', propose: async () => [] },
        improvementRef: 'custom-improvement-storage:v1',
        budget: { maxSteps: 1 },
        runDir: '/runs/custom-improvement-storage',
        storage: inMemoryCampaignStorage(),
      }),
    ).rejects.toThrow("requires acquireRunLease or controllerMode='process-local'")
  })

  it('searches isolated configs and activates only a fresh holdout win', async () => {
    type Config = { visibility: 'private' | 'team' | 'shared' }
    const storage = inMemoryCampaignStorage()
    const promoted: Config[] = []
    let activeConfig: Config = { visibility: 'private' }
    const activationIds: string[] = []
    const contenderIds = new Set<string>()
    const activeContenderCalls = new Map<string, number>()
    let maxConcurrentConfigs = 0
    let reportContendersActive: (() => void) | undefined
    const contendersActive = new Promise<void>((resolve) => {
      reportContendersActive = resolve
    })
    let releaseContenders: (() => void) | undefined
    const continueContenders = new Promise<void>((resolve) => {
      releaseContenders = resolve
    })
    let proposalCalls = 0
    const proposer: SurfaceProposer = {
      kind: 'team-sharing-proposer',
      async propose() {
        proposalCalls += 1
        return [
          {
            surface: JSON.stringify({ visibility: 'team' }),
            label: 'share within the team',
            rationale: "the second agent needs the first agent's accepted fact",
          },
          {
            surface: JSON.stringify({ visibility: 'shared' }),
            label: 'share globally',
            rationale: 'compare a broader sharing policy under the same histories',
          },
        ]
      },
    }

    const options: RunAgentMemoryImprovementOptions<Config> = {
      experimentId: 'improve-team-memory',
      trainSequences: [
        improvementSequence('train-a', 'train'),
        improvementSequence('train-b', 'train'),
      ],
      holdoutSequences: [
        improvementSequence('holdout-a', 'holdout'),
        improvementSequence('holdout-b', 'holdout'),
      ],
      seeds: [
        {
          config: { visibility: 'private' },
          track: 'baseline',
          proposer: 'seed',
        },
      ],
      proposer,
      improvementRef: 'team-memory-policy/v1',
      budget: { maxSteps: 1 },
      populationSize: 2,
      candidateConcurrency: 2,
      sequenceConcurrency: 4,
      runDir: '/runs/improve-team-memory',
      storage,
      significance: { minProductiveRuns: 2, resamples: 200, seed: 7 },
      createCandidate: ({ config, candidateId }) => {
        if (config.visibility !== 'private') contenderIds.add(candidateId)
        return {
          ref: `visibility:${config.visibility}:v1`,
          label: config.visibility,
          policy: { read: [config.visibility], write: config.visibility },
          createAdapter: ({ branchId }) => createScopedTestAdapter(`${candidateId}:${branchId}`),
        }
      },
      executeStepRef: 'parallel-config-proof/v1',
      executeStep: async ({ candidateId, step }) => {
        if (step.id !== 'research' || !contenderIds.has(candidateId)) return
        activeContenderCalls.set(candidateId, (activeContenderCalls.get(candidateId) ?? 0) + 1)
        maxConcurrentConfigs = Math.max(maxConcurrentConfigs, activeContenderCalls.size)
        if (activeContenderCalls.size === 2) reportContendersActive?.()
        try {
          await continueContenders
        } finally {
          const remaining = (activeContenderCalls.get(candidateId) ?? 1) - 1
          if (remaining === 0) activeContenderCalls.delete(candidateId)
          else activeContenderCalls.set(candidateId, remaining)
        }
      },
      activation: {
        ref: 'memory-policy/live:v1',
        async readCurrent() {
          return structuredClone(activeConfig)
        },
        async compareAndSet({ activationId, expectedConfig, config }) {
          expect(activeConfig).toEqual(expectedConfig)
          activationIds.push(activationId)
          activeConfig = structuredClone(config)
          promoted.push(structuredClone(config))
        },
      },
    }
    const firstRun = runAgentMemoryImprovement(options)
    await contendersActive
    await expect(runAgentMemoryImprovement(options)).rejects.toThrow('active controller')
    releaseContenders?.()
    const result = await firstRun

    expect(result.decision).toMatchObject({
      status: 'promote',
      reasons: [],
      baselineScore: 0.25,
      winnerScore: 1,
      lift: 0.75,
    })
    expect(result.decision.significance).toMatchObject({ n: 2, significant: true })
    expect(result.winnerConfig).toEqual({ visibility: 'team' })
    expect(result.holdout?.campaign.cells).toHaveLength(4)
    expect(maxConcurrentConfigs).toBe(2)
    expect(promoted).toEqual([{ visibility: 'team' }])
    expect(result.activation).toMatchObject({ status: 'activated' })
    expect(storage.read(result.resultJsonPath)).toContain('"status": "promote"')
    expect(
      JSON.parse(storage.read('/runs/improve-team-memory/memory-improvement-manifest.json') ?? '{}')
        .identity?.schema,
    ).toBe(5)

    const resumed = await runAgentMemoryImprovement(options)
    expect(proposalCalls).toBe(1)
    expect(promoted).toEqual([{ visibility: 'team' }])
    expect(activationIds).toEqual([result.activation.id])
    expect(resumed.activation).toEqual({
      ...result.activation,
      status: 'already-activated',
    })
    expect(activeConfig).toEqual({ visibility: 'team' })
    await expect(
      runAgentMemoryImprovement({ ...options, budget: { maxSteps: 2 } }),
    ).rejects.toThrow('does not match its persisted inputs or implementationRef')
    await expect(runAgentMemoryImprovement({ ...options, minHoldoutScore: 0.99 })).rejects.toThrow(
      'does not match its persisted inputs or implementationRef',
    )
    await expect(
      runAgentMemoryImprovement({ ...options, improvementRef: 'team-memory-policy/v2' }),
    ).rejects.toThrow('does not match its persisted inputs or implementationRef')
  })

  it('recovers when the live config changes before the activation event is persisted', async () => {
    type Config = { visibility: 'private' | 'team' }
    const storage = inMemoryCampaignStorage()
    const append = storage.append!.bind(storage)
    let rejectActivatedEvent = true
    storage.append = (path, value, expectedBytes) => {
      if (
        rejectActivatedEvent &&
        path.includes('/activations/') &&
        value.includes('"status":"activated"')
      ) {
        rejectActivatedEvent = false
        throw new Error('activation journal unavailable')
      }
      return append(path, value, expectedBytes)
    }
    let activeConfig: Config = { visibility: 'private' }
    let compareAndSetCalls = 0
    const options: RunAgentMemoryImprovementOptions<Config> = {
      experimentId: 'recover-memory-activation',
      trainSequences: [
        improvementSequence('activation-train-a', 'train'),
        improvementSequence('activation-train-b', 'train'),
      ],
      holdoutSequences: [
        improvementSequence('activation-holdout-a', 'holdout'),
        improvementSequence('activation-holdout-b', 'holdout'),
      ],
      seeds: [
        {
          config: { visibility: 'private' },
          track: 'baseline',
          proposer: 'seed',
        },
      ],
      proposer: {
        kind: 'team-sharing-proposer',
        async propose() {
          return [
            {
              surface: JSON.stringify({ visibility: 'team' }),
              label: 'share with team',
              rationale: 'the second agent needs the accepted fact',
            },
          ]
        },
      },
      improvementRef: 'recover-memory-activation:v1',
      budget: { maxSteps: 1 },
      runDir: '/runs/recover-memory-activation',
      storage,
      significance: { minProductiveRuns: 2, resamples: 200, seed: 11 },
      createCandidate: ({ config, candidateId }) => ({
        ref: `visibility:${config.visibility}:v1`,
        policy: { read: [config.visibility], write: config.visibility },
        createAdapter: ({ branchId }) => createScopedTestAdapter(`${candidateId}:${branchId}`),
      }),
      activation: {
        ref: 'memory-policy/live:v1',
        async readCurrent() {
          return structuredClone(activeConfig)
        },
        async compareAndSet({ expectedConfig, config }) {
          expect(activeConfig).toEqual(expectedConfig)
          compareAndSetCalls += 1
          activeConfig = structuredClone(config)
        },
      },
    }

    await expect(runAgentMemoryImprovement(options)).rejects.toThrow(
      'activation journal unavailable',
    )
    expect(activeConfig).toEqual({ visibility: 'team' })
    expect(compareAndSetCalls).toBe(1)

    const recovered = await runAgentMemoryImprovement(options)
    expect(recovered.activation.status).toBe('recovered')
    expect(compareAndSetCalls).toBe(1)
    const resumed = await runAgentMemoryImprovement(options)
    expect(resumed.activation.status).toBe('already-activated')
    expect(compareAndSetCalls).toBe(1)
  })

  it('routes independent tracks to their named proposers with track context', async () => {
    type Config = { visibility: 'private' | 'team' }
    const trackContexts: Array<{
      id?: string
      operation?: string
      vision?: string
      generation: number
      costPhase?: string
      hasCostLedger: boolean
    }> = []
    let governorCostPhase: string | undefined
    let governorHasCostLedger = false
    const trackProposer: SurfaceProposer = {
      kind: 'team-memory-researcher',
      async propose(context) {
        trackContexts.push({
          id: context.track?.id,
          operation: context.track?.operation,
          vision: context.track?.vision,
          generation: context.generation,
          costPhase: context.costPhase,
          hasCostLedger: context.costLedger !== undefined,
        })
        return [JSON.stringify({ visibility: 'team' })]
      },
    }

    await runAgentMemoryImprovement<Config>({
      experimentId: 'named-track-proposers',
      trainSequences: [improvementSequence('track-train', 'train')],
      holdoutSequences: [improvementSequence('track-holdout', 'holdout')],
      seeds: [
        { config: { visibility: 'private' }, track: 'baseline', proposer: 'baseline' },
        {
          config: { visibility: 'private' },
          track: 'sharing-research',
          proposer: 'team-memory-researcher',
          vision: 'test whether team memory transfers accepted facts',
        },
      ],
      proposer: {
        kind: 'unexpected-fallback',
        async propose() {
          throw new Error('named track should not use the fallback proposer')
        },
      },
      proposers: { 'team-memory-researcher': trackProposer },
      governor: {
        decide(context) {
          governorCostPhase = context.costPhase
          governorHasCostLedger = context.costLedger !== undefined
          return { op: 'extend', track: 'sharing-research' }
        },
      },
      improvementRef: 'named-track-proposers/v1',
      budget: { maxSteps: 1 },
      populationSize: 1,
      runDir: '/runs/named-track-proposers',
      storage: inMemoryCampaignStorage(),
      createCandidate: ({ config, candidateId }) => ({
        ref: `visibility:${config.visibility}:v1`,
        policy: { read: [config.visibility], write: config.visibility },
        createAdapter: ({ branchId }) => createScopedTestAdapter(`${candidateId}:${branchId}`),
      }),
    })

    expect(trackContexts).toEqual([
      {
        id: 'sharing-research',
        operation: 'extend',
        vision: 'test whether team memory transfers accepted facts',
        generation: 1,
        costPhase: 'memory.proposal.sharing-research',
        hasCostLedger: true,
      },
    ])
    expect(governorCostPhase).toBe('memory.governor')
    expect(governorHasCostLedger).toBe(true)
  })

  it('holds a winner when holdout histories do not test a critical dimension', async () => {
    type Config = { visibility: 'private' | 'team' }
    const result = await runAgentMemoryImprovement<Config>({
      experimentId: 'missing-critical-dimension',
      trainSequences: [improvementSequence('critical-train', 'train')],
      holdoutSequences: [
        improvementSequence('critical-holdout-a', 'holdout', false),
        improvementSequence('critical-holdout-b', 'holdout', false),
        improvementSequence('critical-holdout-c', 'holdout', false),
      ],
      seeds: [{ config: { visibility: 'private' }, track: 'baseline', proposer: 'sharing' }],
      proposer: {
        kind: 'sharing',
        async propose() {
          return [JSON.stringify({ visibility: 'team' })]
        },
      },
      improvementRef: 'missing-critical-dimension/v1',
      budget: { maxSteps: 1 },
      populationSize: 1,
      runDir: '/runs/missing-critical-dimension',
      storage: inMemoryCampaignStorage(),
      significance: { minProductiveRuns: 1, resamples: 100, seed: 9 },
      criticalDimensions: ['memory_stale_safe'],
      createCandidate: ({ config, candidateId }) => ({
        ref: `visibility:${config.visibility}:v1`,
        policy: { read: [config.visibility], write: config.visibility },
        createAdapter: ({ branchId }) => createScopedTestAdapter(`${candidateId}:${branchId}`),
      }),
    })

    expect(result.decision.status).toBe('hold')
    expect(result.decision.criticalDimensions).toEqual([
      expect.objectContaining({
        dimension: 'memory_stale_safe',
        n: 0,
        expectedN: 0,
        measured: false,
      }),
    ])
    expect(result.decision.reasons).toContain(
      'critical dimension memory_stale_safe has no applicable holdout histories',
    )
  })

  it('stops before a proposer call would exceed the run-wide cost limit', async () => {
    let proposerExecuted = false

    await expect(
      runAgentMemoryImprovement({
        experimentId: 'proposer-cost-limit',
        trainSequences: [improvementSequence('cost-train', 'train')],
        holdoutSequences: [improvementSequence('cost-holdout', 'holdout')],
        seeds: [
          {
            config: { visibility: 'private' as const },
            track: 'baseline',
            proposer: 'costed',
          },
        ],
        proposer: {
          kind: 'costed',
          async propose(context) {
            if (!context.costLedger) throw new Error('missing run cost ledger')
            const paid = await context.costLedger.runPaidCall({
              actor: 'memory-config-proposer',
              channel: 'agent',
              phase: context.costPhase,
              model: 'fixture-model',
              maximumCharge: { externallyEnforcedMaximumUsd: 0.06 },
              execute: async () => {
                proposerExecuted = true
                return JSON.stringify({ visibility: 'team' })
              },
              receipt: () => ({
                model: 'fixture-model',
                inputTokens: 0,
                outputTokens: 0,
                usageUnknown: true,
                actualCostUsd: 0.06,
              }),
            })
            if (!paid.succeeded) throw paid.error
            return [paid.value]
          },
        },
        improvementRef: 'proposer-cost-limit/v1',
        budget: { maxSteps: 1 },
        maxTotalCostUsd: 0.05,
        runDir: '/runs/proposer-cost-limit',
        storage: inMemoryCampaignStorage(),
        createCandidate: ({ config, candidateId }) => ({
          ref: `visibility:${config.visibility}:v1`,
          policy: { read: [config.visibility], write: config.visibility },
          createAdapter: ({ branchId }) => createScopedTestAdapter(`${candidateId}:${branchId}`),
        }),
      }),
    ).rejects.toThrow('would exceed ceiling 0.05')
    expect(proposerExecuted).toBe(false)
  })

  it('charges an interrupted proposer reservation before resuming the search', async () => {
    type Config = { visibility: 'private' | 'team' }
    const storage = inMemoryCampaignStorage()
    const runDir = '/runs/interrupted-proposer-recovery'
    const append = storage.append!.bind(storage)
    let failFirstProposerReceipt = true
    storage.append = (path, value, expectedBytes) => {
      if (
        failFirstProposerReceipt &&
        path.endsWith('/cost-ledger.jsonl') &&
        value.includes('"status":"settled"') &&
        value.includes('memory-config-proposer')
      ) {
        failFirstProposerReceipt = false
        throw new Error('simulated process exit before proposer receipt')
      }
      return append(path, value, expectedBytes)
    }
    let proposerCalls = 0
    const options: RunAgentMemoryImprovementOptions<Config> = {
      experimentId: 'interrupted-proposer-recovery',
      trainSequences: [improvementSequence('proposer-train', 'train')],
      holdoutSequences: [improvementSequence('proposer-holdout', 'holdout')],
      seeds: [
        {
          config: { visibility: 'private' },
          track: 'baseline',
          proposer: 'costed',
        },
      ],
      proposer: {
        kind: 'costed',
        async propose(context) {
          proposerCalls += 1
          if (!context.costLedger) throw new Error('missing run cost ledger')
          const paid = await context.costLedger.runPaidCall({
            actor: 'memory-config-proposer',
            channel: 'agent',
            phase: context.costPhase,
            model: 'fixture-model',
            maximumCharge: { externallyEnforcedMaximumUsd: 0.1 },
            execute: async () => JSON.stringify({ visibility: 'team' }),
            receipt: () => ({
              model: 'fixture-model',
              inputTokens: 0,
              outputTokens: 0,
              actualCostUsd: 0.1,
            }),
          })
          if (!paid.succeeded) throw paid.error
          return [paid.value]
        },
      },
      improvementRef: 'interrupted-proposer-recovery/v1',
      budget: { maxSteps: 1 },
      maxTotalCostUsd: 0.2,
      runDir,
      storage,
      createCandidate: ({ config, candidateId }) => ({
        ref: `visibility:${config.visibility}:v1`,
        policy: { read: [config.visibility], write: config.visibility },
        createAdapter: ({ branchId }) => createScopedTestAdapter(`${candidateId}:${branchId}`),
      }),
    }

    await expect(runAgentMemoryImprovement(options)).rejects.toThrow('failed to persist')
    const interruptedLedger = createRunCostLedger({
      storage,
      runDir,
      costCeilingUsd: 0.2,
    })
    expect(interruptedLedger.listPending()).toEqual([
      expect.objectContaining({ actor: 'memory-config-proposer', state: 'interrupted' }),
    ])

    const result = await runAgentMemoryImprovement(options)
    const resumedLedger = createRunCostLedger({ storage, runDir, costCeilingUsd: 0.2 })

    expect(proposerCalls).toBe(2)
    expect(result.totalCostUsd).toBe(0.2)
    expect(resumedLedger.summary()).toMatchObject({
      totalCalls: 2,
      unresolvedCalls: 0,
      totalCostUsd: 0.2,
      accountingComplete: true,
    })
    expect(resumedLedger.list()[0]).toMatchObject({
      actor: 'memory-config-proposer',
      costUsd: 0.1,
      error: expect.stringContaining('charged the reserved maximum'),
    })
  })

  it('rejects train and holdout histories with the same id', async () => {
    const sequence = improvementSequence('duplicate', 'train')
    await expect(
      runAgentMemoryImprovement({
        experimentId: 'overlap',
        trainSequences: [sequence],
        holdoutSequences: [{ ...sequence, split: 'holdout' }],
        seeds: [{ config: {}, track: 'baseline', proposer: 'seed' }],
        proposer: {
          kind: 'unused',
          async propose() {
            return []
          },
        },
        improvementRef: 'overlap-test/v1',
        budget: { maxSteps: 1 },
        runDir: '/runs/overlap',
        storage: inMemoryCampaignStorage(),
        createCandidate: () => ({
          ref: 'unused:v1',
          createAdapter: () => createScopedTestAdapter('unused'),
        }),
      }),
    ).rejects.toThrow('train/holdout overlap: duplicate')
  })

  it('rejects a holdout history copied under a different id', async () => {
    const train = improvementSequence('train-original', 'train')
    await expect(
      runAgentMemoryImprovement({
        experimentId: 'renamed-overlap',
        trainSequences: [train],
        holdoutSequences: [{ ...train, id: 'renamed-holdout', split: 'holdout' }],
        seeds: [{ config: {}, track: 'baseline', proposer: 'seed' }],
        proposer: {
          kind: 'unused',
          async propose() {
            return []
          },
        },
        improvementRef: 'renamed-overlap/v1',
        budget: { maxSteps: 0 },
        runDir: '/runs/renamed-overlap',
        storage: inMemoryCampaignStorage(),
        createCandidate: () => ({
          ref: 'unused:v1',
          createAdapter: () => createScopedTestAdapter('unused'),
        }),
      }),
    ).rejects.toThrow('histories duplicate content')
  })
})

function improvementSequence(id: string, split: 'train' | 'holdout', includeStaleTarget = true) {
  return {
    id,
    family: 'first-party' as const,
    split,
    steps: [
      {
        id: 'research',
        scope: { agentId: 'researcher', teamId: 'team-1' },
        writes: [
          {
            id: `${id}-event`,
            kind: 'fact' as const,
            text: `${id} launch date is Friday`,
            metadata: { eventId: `${id}-event`, actorId: 'researcher' },
          },
        ],
      },
      {
        id: 'delivery',
        scope: { agentId: 'builder', teamId: 'team-1' },
        probes: [
          {
            id: 'launch-date',
            query: `${id} launch date`,
            requiredFacts: [{ id: 'current', anyOf: [`${id} launch date is Friday`] }],
            ...(includeStaleTarget
              ? {
                  forbiddenFacts: [
                    {
                      id: 'stale',
                      anyOf: [`${id} launch date is Thursday`],
                      obsolete: true,
                    },
                  ],
                }
              : {}),
            expectedEventIds: [`${id}-event`],
            expectedActorIds: ['researcher'],
          },
        ],
      },
    ],
  }
}

function hitText(hit: AgentMemoryHit): string {
  return hit.text
}

function createScopedTestAdapter(
  id: string,
  beforeWrite?: (scope: AgentMemoryScope, text: string) => Promise<void>,
): AgentMemoryAdapter {
  const rows: Array<{ scope: AgentMemoryScope; hit: AgentMemoryHit }> = []
  let sequence = 0
  return {
    id,
    branchIsolation: { mode: 'scoped' },
    async search(_query, options = {}) {
      return rows.filter((row) => sameScope(row.scope, options.scope)).map((row) => row.hit)
    },
    async getContext(query, options = {}) {
      const hits = await this.search(query, options)
      return { query, hits, text: hits.map(hitText).join('\n'), sourceRecords: [] }
    },
    async write(input) {
      const scope = input.scope ?? {}
      await beforeWrite?.(scope, input.text)
      sequence += 1
      const memoryId = input.id ?? `${id}-${sequence}`
      const hit: AgentMemoryHit = {
        id: memoryId,
        uri: `memory://${id}/${memoryId}`,
        kind: input.kind,
        text: input.text,
        metadata: input.metadata,
      }
      rows.push({ scope, hit })
      return { accepted: true, id: memoryId, uri: hit.uri, kind: input.kind }
    },
    async clear(scope) {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (sameScope(rows[index]!.scope, scope)) rows.splice(index, 1)
      }
    },
  }
}

function sameScope(left: AgentMemoryScope, right: AgentMemoryScope = {}): boolean {
  for (const key of [
    'tenantId',
    'userId',
    'agentId',
    'teamId',
    'runId',
    'sessionId',
    'namespace',
  ] as const) {
    if (right[key] !== undefined && left[key] !== right[key]) return false
  }
  for (const [key, value] of Object.entries(right.tags ?? {})) {
    if (left.tags?.[key] !== value) return false
  }
  return true
}
