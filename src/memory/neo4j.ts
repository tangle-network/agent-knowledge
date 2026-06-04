import { stableId } from '../ids'
import { defaultGetMemoryContext } from './adapter'
import { memoryHitToSourceRecord, memoryWriteResultToSourceRecord } from './source-record'
import type {
  AgentMemoryAdapter,
  AgentMemoryHit,
  AgentMemorySearchOptions,
  AgentMemoryWriteInput,
  AgentMemoryWriteResult,
} from './types'

export interface Neo4jAgentMemoryAdapterOptions {
  client: Record<string, unknown>
  id?: string
}

export function createNeo4jAgentMemoryAdapter(
  options: Neo4jAgentMemoryAdapterOptions,
): AgentMemoryAdapter {
  const client = options.client
  const id = options.id ?? 'neo4j-agent-memory'
  return {
    id,
    async search(query, searchOptions = {}) {
      const result = await callOptional(
        client,
        ['search', 'memory_search'],
        [query, neo4jOptions(searchOptions)],
      )
      if (result !== undefined) return normalizeHits(result, searchOptions, id)

      const context = await callOptional(
        client,
        ['getContext', 'get_context'],
        [query, neo4jOptions(searchOptions)],
      )
      if (context !== undefined) return normalizeHits(context, searchOptions, id)
      return []
    },
    async getContext(query, searchOptions = {}) {
      const result = await callOptional(
        client,
        ['getContext', 'get_context'],
        [query, neo4jOptions(searchOptions)],
      )
      if (result === undefined) {
        const searchResult = await callOptional(
          client,
          ['search', 'memory_search'],
          [query, neo4jOptions(searchOptions)],
        )
        const hits = normalizeHits(searchResult, searchOptions, id)
        return defaultGetMemoryContext({ search: async () => hits }, query, searchOptions)
      }
      if (typeof result === 'string') {
        const hit: AgentMemoryHit = {
          id: stableId('mem', `${id}:${query}:${result}`),
          uri: `memory://${id}/context/${stableId('ctx', query)}`,
          kind: 'fact',
          text: result,
          title: 'Memory context',
          normalizedScore: 1,
        }
        return {
          query,
          text: result,
          hits: [hit],
          sourceRecords: [memoryHitToSourceRecord(hit, { scope: searchOptions.scope })],
          metadata: { adapter: id },
        }
      }
      const hits = normalizeHits(result, searchOptions, id)
      if (hits.length > 0)
        return defaultGetMemoryContext({ search: async () => hits }, query, searchOptions)
      return defaultGetMemoryContext({ search: async () => [] }, query, searchOptions)
    },
    async write(input) {
      const result = await writeNeo4jMemory(client, input, id)
      return {
        ...result,
        sourceRecord: memoryWriteResultToSourceRecord(result, input.text, { scope: input.scope }),
      }
    },
  }
}

async function writeNeo4jMemory(
  client: Record<string, unknown>,
  input: AgentMemoryWriteInput,
  adapterId: string,
): Promise<AgentMemoryWriteResult> {
  const scope = input.scope ?? {}
  const sessionId = scope.sessionId ?? input.metadata?.sessionId
  let result: unknown
  if (input.kind === 'message') {
    result = await callRequired(
      nested(client, ['shortTerm', 'short_term'], client),
      ['addMessage', 'add_message'],
      [
        {
          session_id: sessionId,
          sessionId,
          role: input.role ?? 'user',
          content: input.text,
          user_identifier: scope.userId,
          userIdentifier: scope.userId,
        },
      ],
    )
  } else if (input.kind === 'entity') {
    result = await callRequired(
      nested(client, ['longTerm', 'long_term'], client),
      ['addEntity', 'add_entity'],
      [
        input.entityName ?? input.title ?? input.text,
        input.entityType ?? 'ENTITY',
        neo4jWriteOptions(input),
      ],
    )
  } else if (input.kind === 'preference') {
    result = await callRequired(
      nested(client, ['longTerm', 'long_term'], client),
      ['addPreference', 'add_preference'],
      [input.category ?? 'general', input.text, neo4jWriteOptions(input)],
    )
  } else {
    result = await callRequired(
      nested(client, ['longTerm', 'long_term'], client),
      ['addFact', 'add_fact'],
      [
        input.subject ?? input.title ?? input.kind,
        input.predicate ?? 'states',
        input.object ?? input.text,
        neo4jWriteOptions(input),
      ],
    )
  }

  const id = idFromResult(result) ?? input.id ?? stableId('mem', `${input.kind}:${input.text}`)
  return {
    accepted: true,
    id,
    uri: `memory://${adapterId}/${encodeURIComponent(id)}`,
    kind: input.kind,
    metadata: { rawResult: result },
  }
}

function neo4jOptions(options: AgentMemorySearchOptions): Record<string, unknown> {
  return {
    limit: options.limit,
    k: options.limit,
    min_score: options.minScore,
    minScore: options.minScore,
    user_identifier: options.scope?.userId,
    userIdentifier: options.scope?.userId,
    session_id: options.scope?.sessionId,
    sessionId: options.scope?.sessionId,
    namespace: options.scope?.namespace,
    tenant_id: options.scope?.tenantId,
    tenantId: options.scope?.tenantId,
    kinds: options.kinds,
    metadata: options.metadata,
  }
}

function neo4jWriteOptions(input: AgentMemoryWriteInput): Record<string, unknown> {
  return {
    user_identifier: input.scope?.userId,
    userIdentifier: input.scope?.userId,
    session_id: input.scope?.sessionId,
    sessionId: input.scope?.sessionId,
    namespace: input.scope?.namespace,
    confidence: input.confidence,
    metadata: input.metadata,
  }
}

async function callOptional(
  target: Record<string, unknown>,
  names: string[],
  args: unknown[],
): Promise<unknown> {
  for (const name of names) {
    const fn = target[name]
    if (typeof fn === 'function') return await fn.apply(target, args)
  }
  return undefined
}

async function callRequired(
  target: Record<string, unknown>,
  names: string[],
  args: unknown[],
): Promise<unknown> {
  const result = await callOptional(target, names, args)
  if (result !== undefined) return result
  throw new Error(`Neo4j agent-memory client is missing method ${names.join(' or ')}`)
}

function nested(
  target: Record<string, unknown>,
  names: string[],
  fallback: Record<string, unknown>,
): Record<string, unknown> {
  for (const name of names) {
    const value = target[name]
    if (value && typeof value === 'object') return value as Record<string, unknown>
  }
  return fallback
}

function normalizeHits(
  value: unknown,
  options: AgentMemorySearchOptions,
  adapterId: string,
): AgentMemoryHit[] {
  const rawHits: unknown[] = Array.isArray(value)
    ? value
    : Array.isArray(record(value)?.hits)
      ? (record(value)!.hits as unknown[])
      : Array.isArray(record(value)?.results)
        ? (record(value)!.results as unknown[])
        : typeof value === 'string'
          ? [value]
          : []
  return rawHits
    .map((hit, index) => normalizeHit(hit, index, adapterId))
    .filter((hit): hit is AgentMemoryHit => hit !== null)
    .filter((hit) =>
      options.minScore === undefined
        ? true
        : (hit.normalizedScore ?? hit.score ?? 0) >= options.minScore!,
    )
    .filter((hit) => (options.kinds?.length ? options.kinds.includes(hit.kind) : true))
    .slice(0, options.limit)
}

function normalizeHit(value: unknown, index: number, adapterId: string): AgentMemoryHit | null {
  if (typeof value === 'string') {
    return {
      id: stableId('mem', value),
      uri: `memory://${adapterId}/${stableId('mem', value)}`,
      kind: 'fact',
      text: value,
      normalizedScore: index === 0 ? 1 : undefined,
    }
  }
  const obj = record(value)
  if (!obj) return null
  const text = stringField(obj, ['text', 'content', 'body', 'summary'])
  if (!text) return null
  const id = stringField(obj, ['id', 'memoryId', 'uuid']) ?? stableId('mem', text)
  return {
    id,
    uri: stringField(obj, ['uri']) ?? `memory://${adapterId}/${encodeURIComponent(id)}`,
    kind: memoryKind(stringField(obj, ['kind', 'type', 'label'])),
    text,
    title: stringField(obj, ['title', 'name']),
    score: numberField(obj, ['score']),
    normalizedScore: numberField(obj, ['normalizedScore', 'normalized_score']),
    confidence: numberField(obj, ['confidence']),
    createdAt: stringField(obj, ['createdAt', 'created_at']),
    validUntil: stringField(obj, ['validUntil', 'valid_until']),
    lastVerifiedAt: stringField(obj, ['lastVerifiedAt', 'last_verified_at']),
    metadata: obj,
  }
}

function memoryKind(value: string | undefined): AgentMemoryHit['kind'] {
  if (
    value === 'message' ||
    value === 'entity' ||
    value === 'fact' ||
    value === 'preference' ||
    value === 'observation' ||
    value === 'reasoning-trace'
  ) {
    return value
  }
  return 'fact'
}

function idFromResult(value: unknown): string | undefined {
  const obj = record(value)
  return obj ? stringField(obj, ['id', 'memoryId', 'uuid']) : undefined
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function stringField(obj: Record<string, unknown>, names: string[]): string | undefined {
  for (const name of names) {
    const value = obj[name]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

function numberField(obj: Record<string, unknown>, names: string[]): number | undefined {
  for (const name of names) {
    const value = obj[name]
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}
