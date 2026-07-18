import { canonicalJson } from '@tangle-network/agent-eval'
import { stableId } from '../ids'
import { defaultGetMemoryContext } from './adapter'
import { emitRetrievalHoldoutBypass } from './holdout'
import { mergeRankedMemoryHits } from './rank'
import { memoryHitToSourceRecord, memoryWriteResultToSourceRecord } from './source-record'
import type {
  AgentMemoryAdapter,
  AgentMemoryHit,
  AgentMemoryScope,
  AgentMemorySearchOptions,
  AgentMemoryWriteInput,
  AgentMemoryWriteResult,
} from './types'

export interface Neo4jAgentMemoryAdapterOptions {
  client: object
  /** Match the transport passed to the official MemoryClient. */
  transport: 'rest' | 'bridge'
  /** Use Neo4j's whole-conversation context instead of query-based search. */
  contextMode?: 'search' | 'native'
  id?: string
  /** Assert that the client owns disposable external state for this exact branch. */
  branchId?: string
}

export function createNeo4jAgentMemoryAdapter(
  options: Neo4jAgentMemoryAdapterOptions,
): AgentMemoryAdapter {
  assertNeo4jOptions(options)
  const client = options.client as Record<string, unknown>
  const id = options.id ?? 'neo4j-agent-memory'
  const adapter: AgentMemoryAdapter = {
    id,
    branchIsolation: options.branchId
      ? { mode: 'instance', branchId: options.branchId, supportsLogicalScopes: false }
      : {
          mode: 'unsupported',
          reason: 'create a separate MemoryClient namespace per branch and pass branchId',
        },
    async search(query, searchOptions = {}) {
      assertNeo4jSearchOptions(searchOptions, id)
      return searchNeo4jMemory(client, query, searchOptions, id, options.transport)
    },
    async getContext(query, searchOptions = {}) {
      assertNeo4jSearchOptions(searchOptions, id)
      assertNeo4jSearchKinds(searchOptions.kinds, options.transport, id)
      const shortTerm = nested(client, ['shortTerm', 'short_term'], {})
      const sessionId = searchOptions.scope?.sessionId
      if (options.contextMode === 'native' && options.transport !== 'rest') {
        throw new Error(`${id}: Neo4j native context requires transport="rest"`)
      }
      if (options.contextMode === 'native' && !sessionId) {
        throw new Error(`${id}: Neo4j native context requires scope.sessionId`)
      }
      if (
        options.contextMode === 'native' &&
        searchOptions.kinds?.some((kind) => kind !== 'message' && kind !== 'observation')
      ) {
        throw new Error(
          `${id}: Neo4j native context only returns message and observation memory kinds`,
        )
      }
      if (options.contextMode === 'native' && options.transport === 'rest' && sessionId) {
        const conversationContext = await callRequired(shortTerm, ['getContext'], [sessionId])
        const hits = normalizeConversationContextHits(conversationContext, searchOptions, id)
        const text = renderHits(hits)
        if (searchOptions.holdout) {
          emitRetrievalHoldoutBypass(
            hits,
            searchOptions.holdout,
            holdoutBypassContext(query, searchOptions),
            'short-term-context',
          )
        }
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

      return defaultGetMemoryContext(adapter, query, searchOptions)
    },
    async write(input) {
      const result = await writeNeo4jMemory(client, input, id, options.transport)
      return {
        ...result,
        sourceRecord: memoryWriteResultToSourceRecord(result, input.text, { scope: input.scope }),
      }
    },
    async close() {
      await callOptional(client, ['close'], [])
    },
  }
  return adapter
}

function assertNeo4jOptions(options: Neo4jAgentMemoryAdapterOptions): void {
  if (typeof options.client !== 'object' || options.client === null) {
    throw new Error('Neo4j agent-memory client must be an object')
  }
  if (options.id !== undefined && (typeof options.id !== 'string' || !options.id.trim())) {
    throw new Error('Neo4j agent-memory id must be a non-empty string')
  }
  if (
    options.branchId !== undefined &&
    (typeof options.branchId !== 'string' || !options.branchId.trim())
  ) {
    throw new Error('Neo4j agent-memory branchId must be a non-empty string')
  }
  if (options.contextMode !== undefined && !['search', 'native'].includes(options.contextMode)) {
    throw new Error('Neo4j agent-memory contextMode must be search or native')
  }
}

function assertNeo4jSearchOptions(options: AgentMemorySearchOptions, adapterId: string): void {
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 0)) {
    throw new Error(`${adapterId}: search limit must be a non-negative safe integer`)
  }
  if (options.minScore !== undefined && !Number.isFinite(options.minScore)) {
    throw new Error(`${adapterId}: minScore must be finite`)
  }
}

function assertNeo4jSearchKinds(
  kinds: AgentMemorySearchOptions['kinds'],
  transport: 'rest' | 'bridge',
  adapterId: string,
): void {
  if (!kinds?.length) return
  const supported = new Set<AgentMemoryHit['kind']>(
    transport === 'rest'
      ? ['message', 'observation', 'entity']
      : ['message', 'observation', 'entity', 'preference', 'reasoning-trace'],
  )
  const unsupported = [...new Set(kinds.filter((kind) => !supported.has(kind)))]
  if (unsupported.length > 0) {
    throw new Error(
      `${adapterId}: Neo4j ${transport} cannot search memory kinds: ${unsupported.join(', ')}`,
    )
  }
}

function assertNeo4jBridgeCapability(
  transport: 'rest' | 'bridge',
  kind: AgentMemoryWriteInput['kind'],
  adapterId: string,
): void {
  if (transport === 'bridge') return
  throw new Error(
    `${adapterId}: Neo4j REST cannot write ${kind}; use transport="bridge" or map it to an entity/message`,
  )
}

async function writeNeo4jMemory(
  client: Record<string, unknown>,
  input: AgentMemoryWriteInput,
  adapterId: string,
  transport: 'rest' | 'bridge',
): Promise<AgentMemoryWriteResult> {
  const scope = input.scope ?? {}
  const sessionId = scope.sessionId ?? input.metadata?.sessionId
  let result: unknown
  if (input.kind === 'message' || input.kind === 'observation') {
    if (transport === 'rest' && typeof sessionId !== 'string') {
      throw new Error(
        `${adapterId}: Neo4j REST message writes require scope.sessionId as the conversation id`,
      )
    }
    const shortTerm = nested(client, ['shortTerm', 'short_term'], client)
    const metadata = { ...input.metadata, agentKnowledgeKind: input.kind }
    result = await callRequired(
      shortTerm,
      ['addMessage'],
      [
        sessionId,
        neo4jMessageRole(input.role),
        input.text,
        { metadata, conversationId: sessionId },
      ],
    )
  } else if (input.kind === 'entity') {
    const longTerm = nested(client, ['longTerm', 'long_term'], client)
    result = await callRequired(
      longTerm,
      ['addEntity'],
      [
        input.entityName ?? input.title ?? input.text,
        input.entityType ?? 'custom',
        neo4jEntityOptions(input),
      ],
    )
  } else if (input.kind === 'preference') {
    assertNeo4jBridgeCapability(transport, input.kind, adapterId)
    const longTerm = nested(client, ['longTerm', 'long_term'], client)
    result = await callRequired(
      longTerm,
      ['addPreference'],
      [input.category ?? 'general', input.text, neo4jPreferenceOptions(input)],
    )
  } else if (input.kind === 'reasoning-trace') {
    const reasoning = nested(client, ['reasoning'], client)
    const conversationId = sessionId ?? scope.runId
    if (transport === 'rest') {
      if (typeof conversationId !== 'string') {
        throw new Error(
          `${adapterId}: Neo4j REST reasoning writes require scope.sessionId or scope.runId`,
        )
      }
      result = await callRequired(
        reasoning,
        ['recordStep'],
        [
          {
            conversationId,
            reasoning: input.text,
            actionTaken: stringMetadata(input.metadata, 'action') ?? input.title ?? 'memory',
            result:
              stringMetadata(input.metadata, 'result') ??
              stringMetadata(input.metadata, 'observation') ??
              stringMetadata(input.metadata, 'outcome'),
          },
        ],
      )
    } else {
      const trace = await callRequired(
        reasoning,
        ['startTrace'],
        [
          conversationId ?? stableId('session', input.text),
          stringMetadata(input.metadata, 'task') ?? input.title ?? input.text,
        ],
      )
      const traceId = idFromResult(trace)
      if (!traceId) throw new Error(`${adapterId}: Neo4j startTrace returned no trace id`)
      await callRequired(
        reasoning,
        ['addStep'],
        [
          traceId,
          {
            thought: input.text,
            observation: stringMetadata(input.metadata, 'observation'),
            action: stringMetadata(input.metadata, 'action'),
          },
        ],
      )
      result = await callRequired(
        reasoning,
        ['completeTrace'],
        [
          traceId,
          {
            outcome: stringMetadata(input.metadata, 'outcome'),
            success:
              typeof input.metadata?.success === 'boolean' ? input.metadata.success : undefined,
          },
        ],
      )
    }
  } else {
    assertNeo4jBridgeCapability(transport, input.kind, adapterId)
    result = await callRequired(
      nested(client, ['longTerm', 'long_term'], client),
      ['addFact'],
      [
        input.subject ?? input.title ?? input.kind,
        input.predicate ?? 'states',
        input.object ?? input.text,
      ],
    )
  }

  const id =
    idFromResult(result) ??
    input.id ??
    stableId(
      'mem',
      canonicalJson({ adapterId, kind: input.kind, text: input.text, scope: input.scope ?? {} }),
    )
  return {
    accepted: true,
    id,
    uri: `memory://${adapterId}/${encodeURIComponent(id)}`,
    kind: input.kind,
    metadata: { provider: 'neo4j-agent-memory', transport },
  }
}

async function searchNeo4jMemory(
  client: Record<string, unknown>,
  query: string,
  options: AgentMemorySearchOptions,
  adapterId: string,
  transport: 'rest' | 'bridge',
): Promise<AgentMemoryHit[]> {
  const limit = options.limit ?? 10
  if (limit === 0) return []
  assertNeo4jSearchKinds(options.kinds, transport, adapterId)
  const searches: Promise<AgentMemoryHit[]>[] = []
  const kinds = options.kinds
  const includeKind = (kind: AgentMemoryHit['kind']) => !kinds?.length || kinds.includes(kind)
  const shortTerm = nested(client, ['shortTerm', 'short_term'], {})
  const longTerm = nested(client, ['longTerm', 'long_term'], {})
  const reasoning = nested(client, ['reasoning'], {})
  const wantsMessages = includeKind('message') || includeKind('observation')
  const hasConversation = typeof options.scope?.sessionId === 'string'

  if (
    transport === 'rest' &&
    wantsMessages &&
    !hasConversation &&
    options.kinds?.some((kind) => kind === 'message' || kind === 'observation')
  ) {
    throw new Error(
      `${adapterId}: Neo4j REST message search requires scope.sessionId as the conversation id`,
    )
  }

  if (wantsMessages && (transport === 'bridge' || hasConversation)) {
    const messageKinds = options.kinds?.filter(
      (kind) => kind === 'message' || kind === 'observation',
    ) ?? ['message', 'observation']
    searches.push(
      callRequired(shortTerm, ['searchMessages'], [query, searchMessagesOptions(options)]).then(
        (result) => normalizeHits(result, { ...options, kinds: messageKinds }, adapterId),
      ),
    )
  }

  if (includeKind('entity')) {
    searches.push(
      callRequired(longTerm, ['searchEntities'], [query, searchEntitiesOptions(options)]).then(
        (result) => normalizeHits(result, { ...options, kinds: ['entity'] }, adapterId),
      ),
    )
  }

  if (transport === 'bridge' && includeKind('preference')) {
    searches.push(
      callRequired(
        longTerm,
        ['searchPreferences'],
        [query, searchPreferencesOptions(options)],
      ).then((result) => normalizeHits(result, { ...options, kinds: ['preference'] }, adapterId)),
    )
  }

  if (transport === 'bridge' && includeKind('reasoning-trace')) {
    searches.push(
      callRequired(reasoning, ['getSimilarTraces'], [query, similarTracesOptions(options)]).then(
        (result) => normalizeHits(result, { ...options, kinds: ['reasoning-trace'] }, adapterId),
      ),
    )
  }

  return mergeRankedMemoryHits(await Promise.all(searches), limit)
}

// Mirrors defaultGetMemoryContext's holdout call context so bypass events join the same log stream.
function holdoutBypassContext(
  query: string,
  options: AgentMemorySearchOptions,
): { query: string; scope?: AgentMemoryScope; taskId?: string } {
  return {
    query,
    ...(options.scope !== undefined ? { scope: options.scope } : {}),
    ...(options.scope?.tags?.taskId !== undefined ? { taskId: options.scope.tags.taskId } : {}),
  }
}

function searchMessagesOptions(options: AgentMemorySearchOptions): Record<string, unknown> {
  return {
    limit: options.limit,
    sessionId: options.scope?.sessionId,
    conversationId: options.scope?.sessionId,
    threshold: options.minScore,
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
    successOnly: options.metadata?.successOnly,
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
  for (const name of names) {
    const fn = target[name]
    if (typeof fn === 'function') return await fn.apply(target, args)
  }
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
    .slice(0, options.limit ?? 10)
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
  const metadata = record(obj.metadata) ?? {}
  const kind = memoryKind(
    stringField(metadata, ['agentKnowledgeKind']) ?? stringField(obj, ['kind', 'type', 'label']),
    obj,
  )
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

function neo4jMessageRole(role: AgentMemoryWriteInput['role']): 'system' | 'user' | 'assistant' {
  return role === 'tool' ? 'assistant' : (role ?? 'user')
}

function stringMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}
