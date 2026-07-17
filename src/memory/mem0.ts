import { canonicalJson } from '@tangle-network/agent-eval'
import { stableId } from '../ids'
import { defaultGetMemoryContext } from './adapter'
import { memoryWriteResultToSourceRecord } from './source-record'
import type {
  AgentMemoryAdapter,
  AgentMemoryHit,
  AgentMemoryKind,
  AgentMemoryScope,
  AgentMemorySearchOptions,
  AgentMemoryWriteInput,
} from './types'

export type Mem0ClientMode = 'hosted' | 'oss'

export interface Mem0ClientLike {
  add(
    messages: Array<{ role: string; content: string }>,
    options?: Record<string, unknown>,
  ): Promise<unknown>
  search(query: string, options?: Record<string, unknown>): Promise<unknown>
  getAll?(options?: Record<string, unknown>): Promise<unknown>
  delete?(memoryId: string, options?: Record<string, unknown>): Promise<unknown>
  deleteAll?(options?: Record<string, unknown>): Promise<unknown>
}

export interface Mem0MemoryAdapterOptions {
  client: Mem0ClientLike
  mode: Mem0ClientMode
  id?: string
  appId?: string
  infer?: boolean
  rerank?: boolean
  latestOnly?: boolean
  defaultScope?: AgentMemoryScope
}

/** Connects both the hosted Mem0 client and the open-source `Memory` class. */
export function createMem0MemoryAdapter(options: Mem0MemoryAdapterOptions): AgentMemoryAdapter {
  assertMem0Options(options)
  const id = options.id ?? `mem0-${options.mode}`

  const adapter: AgentMemoryAdapter = {
    id,
    branchIsolation: { mode: 'scoped' },
    async search(query, searchOptions = {}) {
      assertMem0SearchOptions(searchOptions, id)
      if (searchOptions.limit === 0) return []
      const scope = mergeScopes(options.defaultScope, searchOptions.scope)
      const raw = await options.client.search(query, {
        filters: mem0Filters(scope, options.appId),
        topK: searchOptions.limit,
        threshold: searchOptions.minScore,
        ...(options.rerank !== undefined ? { rerank: options.rerank } : {}),
        ...(options.mode === 'hosted' && options.latestOnly !== undefined
          ? { latestOnly: options.latestOnly }
          : {}),
      })
      return normalizeMem0Hits(raw, id, searchOptions)
    },
    async getContext(query, searchOptions = {}) {
      return defaultGetMemoryContext(adapter, query, searchOptions)
    },
    async write(input) {
      const scope = mergeScopes(options.defaultScope, input.scope)
      const scopeMetadata = mem0ScopeMetadata(scope, options.appId)
      const metadata = compactRecord({
        memoryKind: input.kind,
        memoryTitle: input.title,
        entityName: input.entityName,
        entityType: input.entityType,
        category: input.category,
        predicate: input.predicate,
        subject: input.subject,
        object: input.object,
        confidence: input.confidence,
        originalRole: input.role,
        ...input.metadata,
        ...scopeMetadata,
      })
      const entity = mem0Entity(scope, options.appId)
      const raw = await options.client.add([{ role: mem0Role(input.role), content: input.text }], {
        ...entity,
        metadata,
        infer: options.infer ?? true,
        ...(options.mode === 'oss' ? { filters: mem0Filters(scope, options.appId) } : {}),
      })
      const items = extractMem0Items(raw)
      const mutations = items.filter((candidate) => mem0Event(candidate) !== 'NOOP')
      const item = mutations[0] ?? items[0]
      const itemId =
        stringField(item, ['id']) ??
        input.id ??
        stableId(
          'mem',
          canonicalJson(
            compactRecord({ adapterId: id, kind: input.kind, text: input.text, scope }),
          ),
        )
      const event = mem0Event(item)
      const events = [...new Set(mutations.map(mem0Event).filter(Boolean))]
      const result = {
        accepted: mutations.length > 0,
        id: itemId,
        uri: `memory://${id}/${encodeURIComponent(itemId)}`,
        kind: input.kind,
        metadata: {
          provider: 'mem0',
          mode: options.mode,
          ...(event ? { event } : {}),
          ...(events.length > 1 ? { events } : {}),
        },
      } as const
      return {
        ...result,
        sourceRecord: memoryWriteResultToSourceRecord(result, input.text, { scope }),
      }
    },
    async clear(scope) {
      const mergedScope = mergeScopes(options.defaultScope, scope)
      if (options.client.getAll && options.client.delete) {
        let deleted = 0
        for (let batch = 0; batch < 100; batch += 1) {
          const raw = await options.client.getAll(
            options.mode === 'hosted'
              ? {
                  filters: mem0Filters(mergedScope, options.appId),
                  page: 1,
                  pageSize: 100,
                  latestOnly: false,
                  showExpired: true,
                }
              : {
                  filters: mem0Filters(mergedScope, options.appId),
                  topK: 100,
                  showExpired: true,
                },
          )
          const items = extractMem0Items(raw)
          if (items.length === 0) return
          const rawIds = items.map((item) => stringField(item, ['id']))
          if (!rawIds.every((memoryId): memoryId is string => memoryId !== undefined)) {
            throw new Error(`${id}: Mem0 returned memories without ids during scoped clear`)
          }
          const ids = [...new Set(rawIds)]
          for (const memoryId of ids) await options.client.delete(memoryId)
          deleted += ids.length
        }
        throw new Error(`${id}: refused to clear more than ${deleted} Mem0 memories in one call`)
      }
      if (!options.client.deleteAll || !canDeleteAllExactly(mergedScope)) {
        throw new Error(
          `${id}: exact scoped clear requires Mem0 getAll and delete for tenant, team, session, tag, or nested run scopes`,
        )
      }
      await options.client.deleteAll(mem0Entity(mergedScope, options.appId))
    },
  }
  return adapter
}

function assertMem0Options(options: Mem0MemoryAdapterOptions): void {
  if (options.id !== undefined && (typeof options.id !== 'string' || !options.id.trim())) {
    throw new Error('Mem0 id must be a non-empty string')
  }
  if (options.appId !== undefined && (typeof options.appId !== 'string' || !options.appId.trim())) {
    throw new Error('Mem0 appId must be a non-empty string')
  }
}

function assertMem0SearchOptions(options: AgentMemorySearchOptions, adapterId: string): void {
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 0)) {
    throw new Error(`${adapterId}: search limit must be a non-negative safe integer`)
  }
  if (options.minScore !== undefined && !Number.isFinite(options.minScore)) {
    throw new Error(`${adapterId}: minScore must be finite`)
  }
}

function normalizeMem0Hits(
  raw: unknown,
  adapterId: string,
  options: AgentMemorySearchOptions,
): AgentMemoryHit[] {
  const limit = options.limit ?? Number.POSITIVE_INFINITY
  const kinds = options.kinds ? new Set(options.kinds) : null
  return extractMem0Items(raw)
    .map((item): AgentMemoryHit | undefined => {
      const text =
        stringField(item, ['memory', 'text', 'content']) ??
        stringField(recordField(item, 'data'), ['memory', 'text', 'content'])
      if (!text) return undefined
      const metadata = recordField(item, 'metadata')
      const kind = mem0Kind(metadata?.memoryKind ?? item?.memoryType)
      if (kinds && !kinds.has(kind)) return undefined
      const score = numberField(item, ['rerankScore', 'rerank_score', 'score'])
      if (options.minScore !== undefined && (score === undefined || score < options.minScore)) {
        return undefined
      }
      const memoryId =
        stringField(item, ['id']) ??
        stableId('mem', canonicalJson(compactRecord({ adapterId, text, metadata, item })))
      const normalizedScore = score !== undefined && score >= 0 && score <= 1 ? score : undefined
      return {
        id: memoryId,
        uri: `memory://${adapterId}/${encodeURIComponent(memoryId)}`,
        kind,
        text,
        ...(stringField(metadata, ['memoryTitle']) ? { title: String(metadata!.memoryTitle) } : {}),
        ...(score !== undefined ? { score } : {}),
        ...(normalizedScore !== undefined ? { normalizedScore } : {}),
        ...(dateField(item, ['createdAt', 'created_at'])
          ? { createdAt: dateField(item, ['createdAt', 'created_at']) }
          : {}),
        ...(dateField(item, ['expirationDate', 'expiration_date'])
          ? { validUntil: dateField(item, ['expirationDate', 'expiration_date']) }
          : {}),
        metadata: compactRecord({
          provider: 'mem0',
          ...metadata,
          categories: item?.categories,
          owner: item?.owner,
          runId: item?.runId,
          agentId: item?.agentId,
          userId: item?.userId,
        }),
      }
    })
    .filter((hit): hit is AgentMemoryHit => hit !== undefined)
    .slice(0, limit)
}

function extractMem0Items(raw: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(raw)) return raw.filter(isRecord)
  if (!isRecord(raw)) return []
  for (const key of ['results', 'memories', 'data']) {
    if (Array.isArray(raw[key])) return raw[key].filter(isRecord)
  }
  return [raw]
}

function mem0Event(item: Record<string, unknown> | undefined): string | undefined {
  return stringField(item, ['event'])?.toUpperCase()
}

function mem0Entity(scope: AgentMemoryScope, appId?: string): Record<string, string> {
  return compactStringRecord({
    userId: scope.userId,
    agentId: scope.agentId,
    appId,
    runId: scope.namespace ?? scope.runId,
  })
}

function mem0Filters(scope: AgentMemoryScope, appId?: string): Record<string, string> {
  return mem0ScopeMetadata(scope, appId)
}

function mem0ScopeMetadata(scope: AgentMemoryScope, appId?: string): Record<string, string> {
  const metadata = compactStringRecord({
    user_id: scope.userId,
    agent_id: scope.agentId,
    run_id: scope.namespace ?? scope.runId,
    logical_run_id: scope.namespace ? scope.runId : undefined,
    app_id: appId,
    tenant_id: scope.tenantId,
    team_id: scope.teamId,
    session_id: scope.sessionId,
  })
  for (const [key, value] of Object.entries(scope.tags ?? {})) {
    metadata[`tag_${key}`] = value
  }
  return metadata
}

function canDeleteAllExactly(scope: AgentMemoryScope): boolean {
  return (
    scope.tenantId === undefined &&
    scope.teamId === undefined &&
    scope.sessionId === undefined &&
    (!scope.tags || Object.keys(scope.tags).length === 0) &&
    !(scope.namespace && scope.runId)
  )
}

function mem0Role(role: AgentMemoryWriteInput['role']): 'user' | 'assistant' {
  return role === 'assistant' || role === 'tool' ? 'assistant' : 'user'
}

function mem0Kind(value: unknown): AgentMemoryKind {
  switch (value) {
    case 'message':
    case 'entity':
    case 'fact':
    case 'preference':
    case 'observation':
    case 'reasoning-trace':
      return value
    default:
      return 'fact'
  }
}

function mergeScopes(base?: AgentMemoryScope, extra?: AgentMemoryScope): AgentMemoryScope {
  return {
    ...(base ?? {}),
    ...(extra ?? {}),
    tags: { ...(base?.tags ?? {}), ...(extra?.tags ?? {}) },
  }
}

function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
}

function compactStringRecord(input: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function recordField(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const field = value?.[key]
  return isRecord(field) ? field : undefined
}

function stringField(
  value: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const field = value?.[key]
    if (typeof field === 'string' && field.length > 0) return field
  }
  return undefined
}

function numberField(
  value: Record<string, unknown> | undefined,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const field = value?.[key]
    if (typeof field === 'number' && Number.isFinite(field)) return field
  }
  return undefined
}

function dateField(
  value: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const field = value?.[key]
    if (typeof field === 'string' && field.length > 0) return field
    if (field instanceof Date && !Number.isNaN(field.valueOf())) return field.toISOString()
  }
  return undefined
}

/** Stable identity useful for dispatch/cache keys without exposing client credentials. */
export function mem0MemoryAdapterIdentity(
  options: Pick<
    Mem0MemoryAdapterOptions,
    'mode' | 'id' | 'appId' | 'infer' | 'rerank' | 'latestOnly' | 'defaultScope'
  >,
): string {
  return stableId('mem0', canonicalJson(compactRecord(options)))
}
