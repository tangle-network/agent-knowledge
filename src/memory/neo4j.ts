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
      const sdkHits = await searchNeo4jMemory(client, query, searchOptions, id)
      if (sdkHits.length > 0) return sdkHits

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
      const shortTerm = nested(client, ['shortTerm', 'short_term'], {})
      const sessionId = searchOptions.scope?.sessionId
      if (sessionId) {
        const conversationContext = await callOptional(
          shortTerm,
          ['getContext', 'get_context'],
          [sessionId],
        )
        if (conversationContext !== undefined) {
          const hits = normalizeConversationContextHits(conversationContext, searchOptions, id)
          const text =
            textFromConversationContext(conversationContext) ??
            (typeof conversationContext === 'string'
              ? conversationContext
              : hits.length > 0
                ? renderHits(hits)
                : '')
          return {
            query,
            text,
            hits,
            sourceRecords: hits.map((hit) =>
              memoryHitToSourceRecord(hit, { scope: searchOptions.scope }),
            ),
            metadata: { adapter: id, rawContext: conversationContext },
          }
        }
      }

      const result = await callOptional(
        client,
        ['getContext', 'get_context'],
        [query, neo4jOptions(searchOptions)],
      )
      if (result === undefined) {
        return defaultGetMemoryContext(
          {
            search: async () => {
              const sdkHits = await searchNeo4jMemory(client, query, searchOptions, id)
              if (sdkHits.length > 0) return sdkHits
              const searchResult = await callOptional(
                client,
                ['search', 'memory_search'],
                [query, neo4jOptions(searchOptions)],
              )
              return normalizeHits(searchResult, searchOptions, id)
            },
          },
          query,
          searchOptions,
        )
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
    const shortTerm = nested(client, ['shortTerm', 'short_term'], client)
    result = await callOptional(
      shortTerm,
      ['addMessage'],
      [
        sessionId,
        input.role ?? 'user',
        input.text,
        {
          metadata: input.metadata,
          conversationId: sessionId,
          userId: scope.userId,
        },
      ],
    )
    if (result === undefined) {
      result = await callRequired(
        shortTerm,
        ['add_message'],
        [
          {
            session_id: sessionId,
            sessionId,
            role: input.role ?? 'user',
            content: input.text,
            user_identifier: scope.userId,
            userIdentifier: scope.userId,
            metadata: input.metadata,
          },
        ],
      )
    }
  } else if (input.kind === 'entity') {
    const longTerm = nested(client, ['longTerm', 'long_term'], client)
    result = await callOptional(
      longTerm,
      ['addEntity'],
      [
        input.entityName ?? input.title ?? input.text,
        input.entityType ?? 'ENTITY',
        neo4jEntityOptions(input),
      ],
    )
    if (result === undefined) {
      result = await callRequired(
        longTerm,
        ['add_entity'],
        [
          input.entityName ?? input.title ?? input.text,
          input.entityType ?? 'ENTITY',
          neo4jWriteOptions(input),
        ],
      )
    }
  } else if (input.kind === 'preference') {
    const longTerm = nested(client, ['longTerm', 'long_term'], client)
    result = await callOptional(
      longTerm,
      ['addPreference'],
      [input.category ?? 'general', input.text, neo4jPreferenceOptions(input)],
    )
    if (result === undefined) {
      result = await callRequired(
        longTerm,
        ['add_preference'],
        [input.category ?? 'general', input.text, neo4jWriteOptions(input)],
      )
    }
  } else {
    result = await callRequired(
      nested(client, ['longTerm', 'long_term'], client),
      ['addFact', 'add_fact'],
      [
        input.subject ?? input.title ?? input.kind,
        input.predicate ?? 'states',
        input.object ?? input.text,
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

async function searchNeo4jMemory(
  client: Record<string, unknown>,
  query: string,
  options: AgentMemorySearchOptions,
  adapterId: string,
): Promise<AgentMemoryHit[]> {
  const searches: Promise<AgentMemoryHit[]>[] = []
  const kinds = options.kinds
  const includeKind = (kind: AgentMemoryHit['kind']) => !kinds?.length || kinds.includes(kind)
  const shortTerm = nested(client, ['shortTerm', 'short_term'], {})
  const longTerm = nested(client, ['longTerm', 'long_term'], {})
  const reasoning = nested(client, ['reasoning'], {})

  if (includeKind('message')) {
    searches.push(
      callOptional(
        shortTerm,
        ['searchMessages', 'search_messages'],
        [query, searchMessagesOptions(options)],
      ).then((result) => normalizeHits(result, { ...options, kinds: ['message'] }, adapterId)),
    )
  }

  if (includeKind('entity')) {
    searches.push(
      callOptional(
        longTerm,
        ['searchEntities', 'search_entities'],
        [query, searchEntitiesOptions(options)],
      ).then((result) => normalizeHits(result, { ...options, kinds: ['entity'] }, adapterId)),
    )
  }

  if (includeKind('preference')) {
    searches.push(
      callOptional(
        longTerm,
        ['searchPreferences', 'search_preferences'],
        [query, searchPreferencesOptions(options)],
      ).then((result) => normalizeHits(result, { ...options, kinds: ['preference'] }, adapterId)),
    )
  }

  if (includeKind('reasoning-trace')) {
    searches.push(
      callOptional(
        reasoning,
        ['getSimilarTraces', 'get_similar_traces'],
        [query, similarTracesOptions(options)],
      ).then((result) =>
        normalizeHits(result, { ...options, kinds: ['reasoning-trace'] }, adapterId),
      ),
    )
  }

  const hits = (await Promise.all(searches)).flat()
  return hits
    .sort((a, b) => (b.normalizedScore ?? b.score ?? 0) - (a.normalizedScore ?? a.score ?? 0))
    .slice(0, options.limit)
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

function searchMessagesOptions(options: AgentMemorySearchOptions): Record<string, unknown> {
  return {
    limit: options.limit,
    sessionId: options.scope?.sessionId,
    conversationId: options.scope?.sessionId,
    threshold: options.minScore,
    metadata: options.metadata,
  }
}

function searchEntitiesOptions(options: AgentMemorySearchOptions): Record<string, unknown> {
  return {
    limit: options.limit,
    type: options.metadata?.type,
  }
}

function searchPreferencesOptions(options: AgentMemorySearchOptions): Record<string, unknown> {
  return {
    limit: options.limit,
    category: options.metadata?.category,
  }
}

function similarTracesOptions(options: AgentMemorySearchOptions): Record<string, unknown> {
  return {
    limit: options.limit,
    sessionId: options.scope?.sessionId,
    successOnly: options.metadata?.successOnly,
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

function neo4jEntityOptions(input: AgentMemoryWriteInput): Record<string, unknown> {
  return {
    description: input.metadata?.description ?? input.title,
  }
}

function neo4jPreferenceOptions(input: AgentMemoryWriteInput): Record<string, unknown> {
  return {
    context: input.metadata?.context ?? input.title,
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
  const rawHits = rawHitsFrom(value)
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
  const kind = memoryKind(stringField(obj, ['kind', 'type', 'label']), obj)
  const text = textFromHitObject(obj, kind)
  if (!text) return null
  const id = stringField(obj, ['id', 'memoryId', 'uuid']) ?? stableId('mem', text)
  return {
    id,
    uri: stringField(obj, ['uri']) ?? `memory://${adapterId}/${encodeURIComponent(id)}`,
    kind,
    text,
    title: stringField(obj, ['title', 'name', 'task', 'subject']),
    score: numberField(obj, ['score']),
    normalizedScore: numberField(obj, ['normalizedScore', 'normalized_score']),
    confidence: numberField(obj, ['confidence']),
    createdAt: stringField(obj, ['createdAt', 'created_at']),
    validUntil: stringField(obj, ['validUntil', 'valid_until']),
    lastVerifiedAt: stringField(obj, ['lastVerifiedAt', 'last_verified_at']),
    metadata: obj,
  }
}

function memoryKind(
  value: string | undefined,
  obj: Record<string, unknown> = {},
): AgentMemoryHit['kind'] {
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
  if ('role' in obj && 'content' in obj) return 'message'
  if ('name' in obj && ('type' in obj || 'entityType' in obj)) return 'entity'
  if ('preference' in obj && 'category' in obj) return 'preference'
  if ('task' in obj && 'steps' in obj) return 'reasoning-trace'
  return 'fact'
}

function rawHitsFrom(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  const obj = record(value)
  if (!obj) return typeof value === 'string' ? [value] : []
  if (Array.isArray(obj.hits)) return obj.hits
  if (Array.isArray(obj.results)) return obj.results
  if (Array.isArray(obj.messages)) return obj.messages
  if (Array.isArray(obj.recentMessages)) return obj.recentMessages
  if (Array.isArray(obj.observations)) return obj.observations
  if (Array.isArray(obj.reflections)) return obj.reflections
  if (typeof obj.content === 'string' || typeof obj.text === 'string') return [obj]
  return []
}

function textFromHitObject(
  obj: Record<string, unknown>,
  kind: AgentMemoryHit['kind'],
): string | undefined {
  const direct = stringField(obj, [
    'text',
    'content',
    'body',
    'summary',
    'preference',
    'description',
  ])
  if (direct) return direct
  if (kind === 'entity') return stringField(obj, ['name'])
  if (kind === 'fact') {
    const subject = stringField(obj, ['subject'])
    const predicate = stringField(obj, ['predicate'])
    const object = stringField(obj, ['object', 'obj'])
    if (subject && predicate && object) return `${subject} ${predicate} ${object}`
  }
  if (kind === 'reasoning-trace') {
    const task = stringField(obj, ['task'])
    const outcome = stringField(obj, ['outcome'])
    return [task, outcome].filter(Boolean).join('\n') || undefined
  }
  return undefined
}

function textFromConversationContext(value: unknown): string | undefined {
  const obj = record(value)
  if (!obj) return undefined
  const parts = [
    ...rawHitsFrom(obj.reflections).map((hit) => normalizeContextPart(hit)),
    ...rawHitsFrom(obj.observations).map((hit) => normalizeContextPart(hit)),
    ...rawHitsFrom(obj.recentMessages).map((hit) => normalizeContextPart(hit)),
  ].filter(Boolean)
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

function normalizeConversationContextHits(
  value: unknown,
  options: AgentMemorySearchOptions,
  adapterId: string,
): AgentMemoryHit[] {
  const obj = record(value)
  if (!obj) return normalizeHits(value, options, adapterId)
  const raw = [
    ...rawHitsFrom(obj.reflections).map((hit) => tagContextHit(hit, 'observation', 'Reflection')),
    ...rawHitsFrom(obj.observations).map((hit) => tagContextHit(hit, 'observation', 'Observation')),
    ...rawHitsFrom(obj.recentMessages).map((hit) => tagContextHit(hit, 'message')),
  ]
  return raw.length > 0
    ? normalizeHits(raw, options, adapterId)
    : normalizeHits(value, options, adapterId)
}

function tagContextHit(
  value: unknown,
  kind: AgentMemoryHit['kind'],
  title?: string,
): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { kind, title, ...(value as Record<string, unknown>) }
    : { kind, title, content: value }
}

function normalizeContextPart(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  const obj = record(value)
  return obj
    ? textFromHitObject(obj, memoryKind(stringField(obj, ['kind', 'type', 'label']), obj))
    : undefined
}

function renderHits(hits: AgentMemoryHit[]): string {
  return hits.map((hit) => hit.text).join('\n\n')
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
