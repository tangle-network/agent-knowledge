import { memoryHitToSourceRecord, memoryWriteResultToSourceRecord } from '../memory/source-record'

import type {
  AgentMemoryAdapter,
  AgentMemoryHit,
  AgentMemoryScope,
  AgentMemoryWriteInput,
} from '../memory/types'

export function createNoopMemoryBenchmarkAdapter(id = 'no-memory'): AgentMemoryAdapter {
  return {
    id,
    branchIsolation: { mode: 'scoped' },
    async search() {
      return []
    },
    async getContext(query) {
      return { query, text: '', hits: [], sourceRecords: [] }
    },
    async write(input) {
      return {
        accepted: false,
        id: input.id ?? `${id}:ignored`,
        uri: `memory://${id}/ignored`,
        kind: input.kind,
      }
    },
    async clear() {},
    async flush() {},
  }
}

export function createInMemoryBenchmarkAdapter(options: { id?: string } = {}): AgentMemoryAdapter {
  const id = options.id ?? 'in-memory'
  const rows: Array<{
    seq: number
    input: AgentMemoryWriteInput
    hit: AgentMemoryHit
  }> = []
  let seq = 0
  const adapter: AgentMemoryAdapter = {
    id,
    branchIsolation: { mode: 'scoped' },
    async search(query, searchOptions = {}) {
      const scored = rows
        .filter((row) => memoryScopeMatches(row.input.scope, searchOptions.scope))
        .filter((row) => !searchOptions.kinds?.length || searchOptions.kinds.includes(row.hit.kind))
        .map((row) => {
          const lexical = tokenOverlap(query, row.hit.text)
          const recency = row.seq / Math.max(1, seq)
          return {
            ...row.hit,
            score: lexical + recency * 0.01,
            normalizedScore: lexical,
          }
        })
        .filter((hit) =>
          searchOptions.minScore === undefined ? true : hit.score! >= searchOptions.minScore,
        )
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      return scored.slice(0, searchOptions.limit ?? 5)
    },
    async getContext(query, searchOptions = {}) {
      const hits = await adapter.search(query, searchOptions)
      return {
        query,
        hits,
        sourceRecords: hits.map((hit) =>
          memoryHitToSourceRecord(hit, { scope: searchOptions.scope }),
        ),
        text: renderMemoryHits(hits),
      }
    },
    async write(input) {
      seq += 1
      const memoryId = input.id ?? `${id}:${seq}`
      const hit: AgentMemoryHit = {
        id: memoryId,
        uri: `memory://${id}/${encodeURIComponent(memoryId)}`,
        kind: input.kind,
        text: input.text,
        title: input.title,
        score: 1,
        normalizedScore: 1,
        createdAt: input.metadata?.timestamp as string | undefined,
        metadata: {
          ...(input.metadata ?? {}),
          scope: input.scope,
        },
      }
      rows.push({ seq, input, hit })
      return {
        accepted: true,
        id: memoryId,
        uri: hit.uri,
        kind: input.kind,
        sourceRecord: memoryWriteResultToSourceRecord(
          {
            accepted: true,
            id: memoryId,
            uri: hit.uri,
            kind: input.kind,
            metadata: hit.metadata,
          },
          input.text,
          { scope: input.scope },
        ),
        metadata: hit.metadata,
      }
    },
    async clear(scope) {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (memoryScopeMatches(rows[index]!.input.scope, scope)) rows.splice(index, 1)
      }
    },
    async flush() {},
  }
  return adapter
}

export function memoryEventId(hit: AgentMemoryHit): string | undefined {
  const eventId = hit.metadata?.eventId
  return typeof eventId === 'string' ? eventId : undefined
}

export function memoryActorId(hit: AgentMemoryHit): string | undefined {
  const actorId = hit.metadata?.actorId
  return typeof actorId === 'string' ? actorId : undefined
}

function memoryScopeMatches(stored?: AgentMemoryScope, requested?: AgentMemoryScope): boolean {
  if (!requested) return true
  if (requested.tenantId !== undefined && stored?.tenantId !== requested.tenantId) return false
  if (requested.userId !== undefined && stored?.userId !== requested.userId) return false
  if (requested.agentId !== undefined && stored?.agentId !== requested.agentId) return false
  if (requested.teamId !== undefined && stored?.teamId !== requested.teamId) return false
  if (requested.runId !== undefined && stored?.runId !== requested.runId) return false
  if (requested.sessionId !== undefined && stored?.sessionId !== requested.sessionId) return false
  if (requested.namespace !== undefined && stored?.namespace !== requested.namespace) return false
  for (const [key, value] of Object.entries(requested.tags ?? {})) {
    if (stored?.tags?.[key] !== value) return false
  }
  return true
}

function tokenOverlap(query: string, text: string): number {
  const queryTokens = new Set(tokenize(query))
  if (queryTokens.size === 0) return 0
  const textTokens = new Set(tokenize(text))
  let matched = 0
  for (const token of queryTokens) {
    if (textTokens.has(token)) matched += 1
  }
  return matched / queryTokens.size
}

function tokenize(text: string): string[] {
  const stop = new Set([
    'the',
    'and',
    'for',
    'this',
    'that',
    'with',
    'what',
    'should',
    'agent',
    'user',
    'current',
    'now',
    'use',
  ])
  return text
    .toLowerCase()
    .split(/[^a-z0-9/]+/)
    .filter((token) => token.length > 2 && !stop.has(token))
}

function renderMemoryHits(hits: readonly AgentMemoryHit[]): string {
  return hits
    .map((hit, index) => {
      const eventId = memoryEventId(hit)
      const actorId = memoryActorId(hit)
      return [
        `[${index + 1}] ${hit.title ?? hit.id}`,
        eventId ? `event=${eventId}` : '',
        actorId ? `actor=${actorId}` : '',
        hit.text,
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n\n')
}
