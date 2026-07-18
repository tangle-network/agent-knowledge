import { describe, expect, it } from 'vitest'
import {
  type AgentMemoryScope,
  createAgentMemoryBranch,
  createGraphitiMemoryAdapter,
  type GraphitiMcpClientLike,
  graphitiMemoryAdapterIdentity,
} from '../../src/memory/index'

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
            groupIds.push(String((request.arguments?.group_ids as string[] | undefined)?.[0]))
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
