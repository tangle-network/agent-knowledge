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

  it('renders bridge preference search results as memory context', async () => {
    const client = {
      longTerm: {
        async searchPreferences(query: string) {
          return [{ id: 'pref-1', category: 'writing', preference: `${query}: concise answers` }]
        },
      },
    }
    const adapter = createNeo4jAgentMemoryAdapter({
      client,
      transport: 'bridge',
      branchId: 'branch-1',
    })

    const hits = await adapter.search('writing style', {
      kinds: ['preference'],
      limit: 3,
    })
    const context = await adapter.getContext('writing style', {
      kinds: ['preference'],
      limit: 3,
    })

    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      id: 'pref-1',
      kind: 'preference',
      text: 'writing style: concise answers',
    })
    expect(context.text).toContain('concise answers')
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
    const adapter = createNeo4jAgentMemoryAdapter({
      client,
      transport: 'bridge',
      branchId: 'branch-1',
    })

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
    const adapter = createNeo4jAgentMemoryAdapter({
      client,
      transport: 'rest',
      contextMode: 'native',
    })

    const context = await adapter.getContext('style', { scope: { sessionId: 'conversation-1' } })

    expect(context.text).toContain('Reflection for conversation-1')
    expect(context.text).toContain('User prefers terse updates.')
    expect(context.hits.map((hit) => hit.kind)).toEqual(['observation', 'observation', 'message'])
    expect(context.sourceRecords).toHaveLength(3)
    expect(context.sourceRecords[0]?.metadata?.source).toBe('agent-memory')
  })

  it('keeps provider-native context explicit when requested kinds require query search', async () => {
    const adapter = createNeo4jAgentMemoryAdapter({
      client: { shortTerm: { async getContext() {} } },
      transport: 'rest',
      contextMode: 'native',
    })

    await expect(
      adapter.getContext('company', {
        scope: { sessionId: 'conversation-1' },
        kinds: ['entity'],
      }),
    ).rejects.toThrow('native context only returns message and observation')
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
    const adapter = createNeo4jAgentMemoryAdapter({ client, transport: 'rest' })

    const result = await adapter.write({
      kind: 'message',
      role: 'assistant',
      text: 'I will keep updates short.',
      scope: { sessionId: 'session-1' },
      metadata: { source: 'test' },
    })

    expect(calls[0]?.[0]).toBe('session-1')
    expect(calls[0]?.[1]).toBe('assistant')
    expect(calls[0]?.[2]).toBe('I will keep updates short.')
    expect(calls[0]?.[3]).toMatchObject({
      conversationId: 'session-1',
      metadata: { source: 'test' },
    })
    expect(result.uri).toBe('memory://neo4j-agent-memory/msg-1')
  })

  it('rejects clients that do not expose the official addMessage method', async () => {
    const calls: unknown[][] = []
    const client = {
      short_term: {
        async add_message(...args: unknown[]) {
          calls.push(args)
          return { id: 'msg-bridge' }
        },
      },
    }
    const adapter = createNeo4jAgentMemoryAdapter({ client, transport: 'bridge' })

    await expect(
      adapter.write({
        kind: 'message',
        role: 'user',
        text: 'Remember this bridge message.',
        scope: { sessionId: 'session-1' },
      }),
    ).rejects.toThrow('missing method addMessage')
    expect(calls).toEqual([])
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
    const adapter = createNeo4jAgentMemoryAdapter({ client, transport: 'bridge' })

    await adapter.write({
      kind: 'entity',
      entityName: 'Alice Johnson',
      entityType: 'PERSON',
      text: 'Alice Johnson is a software engineer.',
      metadata: { description: 'Software engineer at Acme Corp' },
    })
    await adapter.write({
      kind: 'preference',
      category: 'writing',
      text: 'Prefers direct answers',
      metadata: { context: 'profile' },
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
    const adapter = createNeo4jAgentMemoryAdapter({ client, transport: 'bridge' })

    const result = await adapter.write({
      kind: 'preference',
      category: 'writing',
      text: 'prefers direct answers',
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

  it('rejects direct scopes the Neo4j SDK cannot enforce before provider calls', async () => {
    let providerCalls = 0
    const adapter = createNeo4jAgentMemoryAdapter({
      transport: 'bridge',
      client: {
        shortTerm: {
          async searchMessages() {
            providerCalls += 1
            return []
          },
        },
        longTerm: {
          async searchEntities() {
            providerCalls += 1
            return []
          },
          async addEntity() {
            providerCalls += 1
            return { id: 'entity-1' }
          },
        },
        reasoning: {
          async recordStep() {
            providerCalls += 1
            return { id: 'reasoning-1' }
          },
        },
      },
    })

    await expect(
      adapter.search('company', { kinds: ['entity'], scope: { tenantId: 'tenant-1' } }),
    ).rejects.toThrow('cannot enforce scope fields: tenantId')
    await expect(adapter.search('anything', { scope: { sessionId: 'session-1' } })).rejects.toThrow(
      'cannot enforce scope fields: sessionId',
    )
    await expect(
      adapter.write({ kind: 'entity', text: 'Acme', scope: { sessionId: 'session-1' } }),
    ).rejects.toThrow('cannot enforce scope fields: sessionId')
    await expect(
      adapter.write({
        kind: 'reasoning-trace',
        text: 'Investigated the issue.',
        scope: { sessionId: 'session-1', runId: 'run-1' },
      }),
    ).rejects.toThrow('cannot enforce both sessionId and runId')
    expect(providerCalls).toBe(0)
  })

  it('preserves Neo4j SDK unsupported errors instead of masking them with fallbacks', async () => {
    const calls: string[] = []
    const client = {
      longTerm: {
        async addPreference() {
          calls.push('addPreference')
          throw new Error('Operation add_preference is not supported by this transport')
        },
        async add_preference() {
          calls.push('add_preference')
          return { id: 'should-not-write' }
        },
      },
    }
    const adapter = createNeo4jAgentMemoryAdapter({ client, transport: 'bridge' })

    await expect(
      adapter.write({
        kind: 'preference',
        category: 'writing',
        text: 'prefers direct answers',
      }),
    ).rejects.toThrow('not supported')
    expect(calls).toEqual(['addPreference'])
  })

  it('uses the configured adapter id for memory URIs', async () => {
    const client = {
      shortTerm: {
        async searchMessages() {
          return [{ id: 'message-1', role: 'user', content: 'Use the private project namespace.' }]
        },
      },
    }
    const adapter = createNeo4jAgentMemoryAdapter({
      client,
      transport: 'rest',
      id: 'neo4j-private',
    })

    const context = await adapter.getContext('project namespace', {
      scope: { sessionId: 'conversation-1' },
      kinds: ['message'],
    })

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
