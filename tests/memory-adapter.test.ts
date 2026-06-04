import { describe, expect, it } from 'vitest'
import {
  AgentMemoryHitSchema,
  createNeo4jAgentMemoryAdapter,
  memoryHitToSourceRecord,
} from '../src/memory/index'

describe('memory adapters', () => {
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
