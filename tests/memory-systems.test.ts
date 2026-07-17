import type { MemoryClient as Neo4jMemoryClient } from '@neo4j-labs/agent-memory'
import { inMemoryCampaignStorage, type SurfaceProposer } from '@tangle-network/agent-eval/campaign'
import type { MemoryClient } from 'mem0ai'
import type { Memory as OssMemory } from 'mem0ai/oss'
import { describe, expect, it } from 'vitest'
import {
  type AgentMemoryAdapter,
  type AgentMemoryHit,
  type AgentMemoryScope,
  buildAgentMemorySequencesFromBenchmarkCases,
  createAgentMemoryBranch,
  createGraphitiMemoryAdapter,
  createMem0MemoryAdapter,
  createNeo4jAgentMemoryAdapter,
  type GraphitiMcpClientLike,
  graphitiMemoryAdapterIdentity,
  type Mem0ClientLike,
  mem0MemoryAdapterIdentity,
  type RunAgentMemoryImprovementOptions,
  runAgentMemoryExperiment,
  runAgentMemoryImprovement,
} from '../src/memory/index'

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
      metadata: { run_id: 'attempted-override' },
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
        tenant_id: 'tenant-1',
        user_id: 'user-1',
        agent_id: 'agent-1',
        team_id: 'team-1',
        run_id: 'branch-1/private',
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
        mode: 'hosted',
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
    const base = { mode: 'hosted' as const, id: 'mem0' }
    expect(mem0MemoryAdapterIdentity({ ...base, defaultScope: { tenantId: 'tenant-a' } })).not.toBe(
      mem0MemoryAdapterIdentity({ ...base, defaultScope: { tenantId: 'tenant-b' } }),
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
        tenant_id: 'tenant-1',
        user_id: 'user-1',
        run_id: 'physical-branch',
        logical_run_id: 'logical-run',
        session_id: 'session-1',
        tag_visibility: 'private',
      },
      page: 1,
      pageSize: 100,
      showExpired: true,
    })
  })
})

describe('Graphiti adapter', () => {
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

  it('keeps episode ids stable when independent groups execute in a different order', async () => {
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
        await adapter.write({ kind: 'fact', text: 'same fact', scope })
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
      graphitiMemoryAdapterIdentity({ id: 'graphiti', defaultScope: { namespace: 'one' } }),
    ).not.toBe(
      graphitiMemoryAdapterIdentity({ id: 'graphiti', defaultScope: { namespace: 'two' } }),
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
})

describe('memory branches', () => {
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
})

describe('agent memory experiments', () => {
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
          policy: { read: ['private'], write: 'private' },
          createAdapter: ({ branchId }) => createScopedTestAdapter(`private:${branchId}`),
        },
        {
          id: 'team',
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

  it('uses a stable external branch id across worker paths when experimentRunId matches', async () => {
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
    expect(branchIds[0]).toBe(branchIds[1])
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
      candidates: [{ id: 'slow', createAdapter: () => adapter }],
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
      candidates: [{ id: 'slow', createAdapter: () => adapter }],
      runDir: '/runs/timeout-cleanup-failure',
      storage: inMemoryCampaignStorage(),
      dispatchTimeoutMs: 5,
    })
    await writeStarted
    await new Promise((resolve) => setTimeout(resolve, 10))
    releaseWrite()

    await expect(run).rejects.toThrow('memory experiment cleanup failed after dispatch')
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

  it('clears accepted writes and disposes the adapter after a failed step', async () => {
    let clears = 0
    let closes = 0
    let disposals = 0
    const result = await runAgentMemoryExperiment({
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

    expect(result.rows[0]).toMatchObject({ cellsFailed: 1 })
    expect(result.campaign.cells[0]?.error).toContain(
      'memory branch cleanup failed after: worker failed',
    )
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
    const result = await runAgentMemoryExperiment({
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
          createAdapter() {
            creates += 1
            return createScopedTestAdapter('persistent')
          },
        },
      ],
      runDir: '/runs/missing-disposer',
      storage: inMemoryCampaignStorage(),
      cleanupBranches: false,
    })

    expect(creates).toBe(0)
    expect(result.rows[0]).toMatchObject({ cellsFailed: 1, scoreMean: 0 })
    expect(result.campaign.cells[0]?.error).toContain('requires disposeAdapter')
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
        candidates: [{ id: 'memory', createAdapter: () => createScopedTestAdapter('memory') }],
        runDir: '/runs/no-target',
        storage: inMemoryCampaignStorage(),
      }),
    ).rejects.toThrow('has no measurable target')
  })
})

describe('agent memory improvement', () => {
  it('searches isolated configs and activates only a fresh holdout win', async () => {
    type Config = { visibility: 'private' | 'team' | 'shared' }
    const storage = inMemoryCampaignStorage()
    const promoted: Config[] = []
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
      onPromote: async ({ activationId, config }) => {
        activationIds.push(activationId)
        promoted.push(config)
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
      baselineScore: 0,
      winnerScore: 1,
      lift: 1,
    })
    expect(result.decision.significance).toMatchObject({ n: 2, significant: true })
    expect(result.winnerConfig).toEqual({ visibility: 'team' })
    expect(result.holdout?.campaign.cells).toHaveLength(4)
    expect(maxConcurrentConfigs).toBe(2)
    expect(promoted).toEqual([{ visibility: 'team' }])
    expect(result.activation).toMatchObject({ status: 'activated' })
    expect(storage.read(result.resultJsonPath)).toContain('"status": "promote"')

    const resumed = await runAgentMemoryImprovement(options)
    expect(proposalCalls).toBe(1)
    expect(promoted).toEqual([{ visibility: 'team' }])
    expect(activationIds).toEqual([result.activation.id])
    expect(resumed.activation).toEqual({
      ...result.activation,
      status: 'already-activated',
    })
    const resumedWithoutCallback = await runAgentMemoryImprovement({
      ...options,
      onPromote: undefined,
    })
    expect(resumedWithoutCallback.activation.status).toBe('already-activated')
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

  it('holds a winner when a configured critical dimension is missing', async () => {
    type Config = { visibility: 'private' | 'team' }
    const result = await runAgentMemoryImprovement<Config>({
      experimentId: 'missing-critical-dimension',
      trainSequences: [improvementSequence('critical-train', 'train')],
      holdoutSequences: [
        improvementSequence('critical-holdout-a', 'holdout'),
        improvementSequence('critical-holdout-b', 'holdout'),
        improvementSequence('critical-holdout-c', 'holdout'),
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
      criticalDimensions: ['missing_safety'],
      createCandidate: ({ config, candidateId }) => ({
        policy: { read: [config.visibility], write: config.visibility },
        createAdapter: ({ branchId }) => createScopedTestAdapter(`${candidateId}:${branchId}`),
      }),
    })

    expect(result.decision.status).toBe('hold')
    expect(result.decision.criticalDimensions).toEqual([
      expect.objectContaining({ dimension: 'missing_safety', n: 0, measured: false }),
    ])
    expect(result.decision.reasons).toContain(
      'critical dimension missing_safety was measured on 0/3 paired holdout cells',
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
          policy: { read: [config.visibility], write: config.visibility },
          createAdapter: ({ branchId }) => createScopedTestAdapter(`${candidateId}:${branchId}`),
        }),
      }),
    ).rejects.toThrow('would exceed ceiling 0.05')
    expect(proposerExecuted).toBe(false)
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
          createAdapter: () => createScopedTestAdapter('unused'),
        }),
      }),
    ).rejects.toThrow('histories duplicate content')
  })
})

function improvementSequence(id: string, split: 'train' | 'holdout') {
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
