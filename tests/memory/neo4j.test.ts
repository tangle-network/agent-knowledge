import type { MemoryClient as Neo4jMemoryClient } from '@neo4j-labs/agent-memory'
import { describe, expect, it } from 'vitest'
import { createNeo4jAgentMemoryAdapter } from '../../src/memory/index'

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
