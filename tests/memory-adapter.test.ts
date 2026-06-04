import type { MemoryClient } from '@neo4j-labs/agent-memory'
import { describe, expect, it } from 'vitest'
import {
  AgentMemoryHitSchema,
  createNeo4jAgentMemoryAdapter,
  memoryHitToSourceRecord,
} from '../src/memory/index'

describe('memory adapters', () => {
  it('is type-compatible with the published Neo4j Agent Memory TypeScript SDK', () => {
    type ShortTerm = MemoryClient['shortTerm']
    type LongTerm = MemoryClient['longTerm']
    type Reasoning = MemoryClient['reasoning']

    const addMessageArgs = [
      'session-1',
      'user',
      'hello',
      { metadata: { source: 'agent-knowledge' }, conversationId: 'session-1' },
    ] satisfies Parameters<ShortTerm['addMessage']>
    const addEntityArgs = [
      'Alice Johnson',
      'PERSON',
      { description: 'Software engineer' },
    ] satisfies Parameters<LongTerm['addEntity']>
    const addPreferenceArgs = [
      'writing',
      'Prefers direct answers',
      { context: 'profile' },
    ] satisfies Parameters<LongTerm['addPreference']>
    const addFactArgs = ['Alice Johnson', 'ROLE', 'Software engineer'] satisfies Parameters<
      LongTerm['addFact']
    >
    const searchMessagesArgs = [
      'Alice',
      { limit: 5, sessionId: 'session-1', threshold: 0 },
    ] satisfies Parameters<ShortTerm['searchMessages']>
    const similarTraceArgs = [
      'debug a failed build',
      { limit: 5, successOnly: true },
    ] satisfies Parameters<Reasoning['getSimilarTraces']>

    expect(addMessageArgs[1]).toBe('user')
    expect(addEntityArgs[1]).toBe('PERSON')
    expect(addPreferenceArgs[0]).toBe('writing')
    expect(addFactArgs[2]).toBe('Software engineer')
    expect(searchMessagesArgs[1].limit).toBe(5)
    expect(similarTraceArgs[1].successOnly).toBe(true)
  })

  it('wraps a Neo4j Agent Memory-like client for search and context', async () => {
    const client = {
      async search(query: string, options: Record<string, unknown>) {
        return [
          {
            id: 'pref-1',
            type: 'preference',
            text: `${query}: likes concise answers`,
            score: 0.8,
            normalizedScore: 1,
            userIdentifier: options.userIdentifier,
          },
        ]
      },
    }
    const adapter = createNeo4jAgentMemoryAdapter({ client })

    const hits = await adapter.search('writing style', {
      scope: { userId: 'user-1' },
      limit: 3,
    })
    const context = await adapter.getContext('writing style', {
      scope: { userId: 'user-1' },
      limit: 3,
    })

    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      id: 'pref-1',
      kind: 'preference',
      text: 'writing style: likes concise answers',
      normalizedScore: 1,
    })
    expect(context.text).toContain('likes concise answers')
    expect(context.sourceRecords[0]?.uri).toBe('memory://neo4j-agent-memory/pref-1')
  })

  it('searches the published TypeScript SDK subclients by memory kind', async () => {
    const calls: string[] = []
    const client = {
      shortTerm: {
        async searchMessages(query: string, options: Record<string, unknown>) {
          calls.push(`messages:${query}:${options.sessionId}`)
          return [{ id: 'msg-1', role: 'user', content: 'Prefers concise updates', score: 0.8 }]
        },
      },
      longTerm: {
        async searchEntities(query: string, options: Record<string, unknown>) {
          calls.push(`entities:${query}:${options.type}`)
          return [{ id: 'ent-1', name: 'Acme Corp', type: 'ORGANIZATION', confidence: 0.9 }]
        },
        async searchPreferences(query: string, options: Record<string, unknown>) {
          calls.push(`preferences:${query}:${options.category}`)
          return [{ id: 'pref-1', category: 'writing', preference: 'Use direct answers' }]
        },
      },
      reasoning: {
        async getSimilarTraces(task: string, options: Record<string, unknown>) {
          calls.push(`traces:${task}:${options.successOnly}`)
          return [
            { id: 'trace-1', sessionId: 's-1', task: 'Debug build', steps: [], success: true },
          ]
        },
      },
    }
    const adapter = createNeo4jAgentMemoryAdapter({ client })

    const hits = await adapter.search('project preferences', {
      scope: { sessionId: 'session-1' },
      limit: 10,
      metadata: { type: 'ORGANIZATION', category: 'writing', successOnly: true },
    })

    expect(calls).toEqual([
      'messages:project preferences:session-1',
      'entities:project preferences:ORGANIZATION',
      'preferences:project preferences:writing',
      'traces:project preferences:true',
    ])
    expect(hits.map((hit) => hit.kind).sort()).toEqual([
      'entity',
      'message',
      'preference',
      'reasoning-trace',
    ])
    expect(hits.find((hit) => hit.kind === 'entity')?.text).toBe('Acme Corp')
    expect(hits.find((hit) => hit.kind === 'reasoning-trace')?.text).toContain('Debug build')
  })

  it('uses hosted conversation context from the TypeScript SDK when scoped to a session', async () => {
    const client = {
      shortTerm: {
        async getContext(conversationId: string) {
          return {
            reflections: [{ id: 'ref-1', content: `Reflection for ${conversationId}` }],
            observations: [{ id: 'obs-1', content: 'User prefers terse updates.' }],
            recentMessages: [{ id: 'msg-1', role: 'user', content: 'Keep it brief.' }],
          }
        },
      },
    }
    const adapter = createNeo4jAgentMemoryAdapter({ client })

    const context = await adapter.getContext('style', { scope: { sessionId: 'conversation-1' } })

    expect(context.text).toContain('Reflection for conversation-1')
    expect(context.text).toContain('User prefers terse updates.')
    expect(context.hits.map((hit) => hit.kind)).toEqual(['observation', 'observation', 'message'])
    expect(context.sourceRecords).toHaveLength(3)
    expect(context.sourceRecords[0]?.metadata?.source).toBe('agent-memory')
  })

  it('delegates message writes using the published TypeScript SDK positional signature', async () => {
    const calls: unknown[][] = []
    const client = {
      shortTerm: {
        async addMessage(...args: unknown[]) {
          calls.push(args)
          return { id: 'msg-1' }
        },
      },
    }
    const adapter = createNeo4jAgentMemoryAdapter({ client })

    const result = await adapter.write({
      kind: 'message',
      role: 'assistant',
      text: 'I will keep updates short.',
      scope: { sessionId: 'session-1', userId: 'user-1' },
      metadata: { source: 'test' },
    })

    expect(calls[0]?.[0]).toBe('session-1')
    expect(calls[0]?.[1]).toBe('assistant')
    expect(calls[0]?.[2]).toBe('I will keep updates short.')
    expect(calls[0]?.[3]).toMatchObject({
      conversationId: 'session-1',
      userId: 'user-1',
      metadata: { source: 'test' },
    })
    expect(result.uri).toBe('memory://neo4j-agent-memory/msg-1')
  })

  it('falls back to bridge-style snake_case message writes', async () => {
    const calls: unknown[][] = []
    const client = {
      short_term: {
        async add_message(...args: unknown[]) {
          calls.push(args)
          return { id: 'msg-bridge' }
        },
      },
    }
    const adapter = createNeo4jAgentMemoryAdapter({ client })

    const result = await adapter.write({
      kind: 'message',
      role: 'user',
      text: 'Remember this bridge message.',
      scope: { sessionId: 'session-1', userId: 'user-1' },
    })

    expect(calls[0]?.[0]).toMatchObject({
      session_id: 'session-1',
      role: 'user',
      content: 'Remember this bridge message.',
      user_identifier: 'user-1',
    })
    expect(result.id).toBe('msg-bridge')
  })

  it('uses narrow hosted SDK options for entity and preference writes', async () => {
    const calls: unknown[][] = []
    const client = {
      longTerm: {
        async addEntity(...args: unknown[]) {
          calls.push(['entity', ...args])
          return { id: 'ent-1' }
        },
        async addPreference(...args: unknown[]) {
          calls.push(['preference', ...args])
          return { id: 'pref-1' }
        },
      },
    }
    const adapter = createNeo4jAgentMemoryAdapter({ client })

    await adapter.write({
      kind: 'entity',
      entityName: 'Alice Johnson',
      entityType: 'PERSON',
      text: 'Alice Johnson is a software engineer.',
      metadata: { description: 'Software engineer at Acme Corp' },
      scope: { userId: 'user-1' },
    })
    await adapter.write({
      kind: 'preference',
      category: 'writing',
      text: 'Prefers direct answers',
      metadata: { context: 'profile' },
      scope: { userId: 'user-1' },
    })

    expect(calls[0]).toEqual([
      'entity',
      'Alice Johnson',
      'PERSON',
      { description: 'Software engineer at Acme Corp' },
    ])
    expect(calls[1]).toEqual([
      'preference',
      'writing',
      'Prefers direct answers',
      { context: 'profile' },
    ])
  })

  it('delegates preference writes to long-term memory methods', async () => {
    const calls: unknown[][] = []
    const client = {
      longTerm: {
        async addPreference(...args: unknown[]) {
          calls.push(args)
          return { id: 'pref-1' }
        },
      },
    }
    const adapter = createNeo4jAgentMemoryAdapter({ client })

    const result = await adapter.write({
      kind: 'preference',
      category: 'writing',
      text: 'prefers direct answers',
      scope: { userId: 'user-1' },
    })

    expect(calls[0]?.[0]).toBe('writing')
    expect(calls[0]?.[1]).toBe('prefers direct answers')
    expect(result).toMatchObject({
      accepted: true,
      id: 'pref-1',
      uri: 'memory://neo4j-agent-memory/pref-1',
      kind: 'preference',
    })
    expect(result.sourceRecord?.metadata?.memoryKind).toBe('preference')
  })

  it('uses the configured adapter id for fallback memory URIs', async () => {
    const client = {
      async getContext() {
        return 'Use the private project namespace.'
      },
    }
    const adapter = createNeo4jAgentMemoryAdapter({ client, id: 'neo4j-private' })

    const context = await adapter.getContext('project namespace')

    expect(context.hits[0]?.uri).toMatch(/^memory:\/\/neo4j-private\//)
    expect(context.sourceRecords[0]?.uri).toBe(context.hits[0]?.uri)
  })

  it('converts memory hits into source-grounded evidence records', () => {
    const hit = AgentMemoryHitSchema.parse({
      id: 'fact-1',
      uri: 'memory://neo4j-agent-memory/fact-1',
      kind: 'fact',
      text: 'User prefers short status updates.',
      normalizedScore: 0.9,
    })

    const source = memoryHitToSourceRecord(hit, {
      now: () => new Date('2026-06-05T00:00:00.000Z'),
      scope: { userId: 'user-1' },
    })

    expect(source.id).toMatch(/^src_/)
    expect(source.uri).toBe(hit.uri)
    expect(source.text).toBe(hit.text)
    expect(source.createdAt).toBe('2026-06-05T00:00:00.000Z')
    expect(source.metadata).toMatchObject({
      source: 'agent-memory',
      memoryId: 'fact-1',
      memoryKind: 'fact',
      normalizedScore: 0.9,
    })
  })
})
