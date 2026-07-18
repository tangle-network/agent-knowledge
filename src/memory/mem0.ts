import { randomUUID } from 'node:crypto'
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
}

export interface Mem0MemoryAdapterOptions {
  client: Mem0ClientLike
  mode: Mem0ClientMode
  id?: string
  appId?: string
  infer?: boolean
  rerank?: boolean
  latestOnly?: boolean
  /** Bounds delayed-delete visibility checks and abandoned hosted-write recovery waits. */
  ingestionTimeoutMs?: number
  pollIntervalMs?: number
  /** Stable deployment/account identity for cache-key helpers. Never put credentials here. */
  backendRef?: string
  defaultScope?: AgentMemoryScope
}

interface Mem0PendingWriteProbe {
  text: string
  providerIds: Set<string>
  filters: Record<string, unknown>
  expiresAt: number
}

/** Connects both the hosted Mem0 client and the open-source `Memory` class. */
export function createMem0MemoryAdapter(options: Mem0MemoryAdapterOptions): AgentMemoryAdapter {
  assertMem0Options(options)
  const id = options.id ?? `mem0-${options.mode}`
  const pendingWrites = new Set<Mem0PendingWriteProbe>()

  const adapter: AgentMemoryAdapter = {
    id,
    branchIsolation:
      options.mode === 'oss'
        ? { mode: 'scoped' }
        : {
            mode: 'scoped',
            processExitSafe: false,
            recoveryDelayMs: options.ingestionTimeoutMs ?? 30_000,
          },
    async search(query, searchOptions = {}) {
      assertMem0SearchOptions(searchOptions, id)
      if (searchOptions.limit === 0) return []
      const scope = mergeScopes(options.defaultScope, searchOptions.scope)
      assertMem0ProviderScope(scope, options.mode, id, 'search')
      const requestedKinds = [...new Set(searchOptions.kinds ?? [])]
      const kindQueries = requestedKinds.length > 0 ? requestedKinds : [undefined]
      const payloads = await Promise.all(
        kindQueries.map((kind) =>
          options.client.search(query, {
            filters: mem0Filters(scope, options.appId, kind),
            topK: searchOptions.limit,
            threshold: searchOptions.minScore,
            ...(options.rerank !== undefined ? { rerank: options.rerank } : {}),
            ...(options.mode === 'hosted' && options.latestOnly !== undefined
              ? { latestOnly: options.latestOnly }
              : {}),
          }),
        ),
      )
      return mergeMem0Hits(
        payloads.flatMap((raw) => normalizeMem0Hits(raw, id, searchOptions)),
        searchOptions.limit,
      )
    },
    async getContext(query, searchOptions = {}) {
      return defaultGetMemoryContext(adapter, query, searchOptions)
    },
    async write(input) {
      const scope = mergeScopes(options.defaultScope, input.scope)
      assertMem0ProviderScope(scope, options.mode, id, 'write')
      pruneExpiredMem0PendingWrites(pendingWrites)
      const writeId = input.id ?? randomUUID()
      const writeFilters = mem0Filters(scope, options.appId)
      const pendingProbe: Mem0PendingWriteProbe = {
        text: input.text,
        providerIds: new Set(),
        filters: writeFilters,
        expiresAt: Number.POSITIVE_INFINITY,
      }
      pendingWrites.add(pendingProbe)
      const scopeMetadata = mem0ScopeMetadata(scope, options.appId)
      const metadata = compactRecord({
        ...input.metadata,
        agentKnowledgeWriteId: writeId,
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
        ...scopeMetadata,
      })
      const entity = mem0Entity(scope, options.appId)
      let raw: unknown
      try {
        raw = await options.client.add([{ role: mem0Role(input.role), content: input.text }], {
          ...entity,
          metadata,
          infer: options.infer ?? true,
          ...(options.mode === 'oss' ? { filters: writeFilters } : {}),
        })
      } finally {
        pendingProbe.expiresAt = Date.now() + (options.ingestionTimeoutMs ?? 30_000)
      }
      if (options.mode === 'hosted' && !Array.isArray(raw)) {
        throw new Error(
          `${id}: hosted Mem0 add returned an unsupported response; mem0ai 3.x must return a memory array`,
        )
      }
      const items = extractMem0Items(raw)
      const mutations = items.filter((candidate) => mem0Event(candidate) !== 'NOOP')
      const durableMutations = mutations.filter((candidate) => mem0Event(candidate) !== 'DELETE')
      for (const candidate of durableMutations) {
        const providerId = stringField(candidate, ['id'])
        if (providerId) pendingProbe.providerIds.add(providerId)
      }
      if (durableMutations.length === 0) {
        pendingWrites.delete(pendingProbe)
      }
      const item = mutations[0] ?? items[0]
      const itemId = stringField(item, ['id']) ?? writeId
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
      assertMem0ProviderScope(mergedScope, options.mode, id, 'clear')
      pruneExpiredMem0PendingWrites(pendingWrites)
      const clearFilters = mem0Filters(mergedScope, options.appId)
      if (Object.keys(clearFilters).length === 0) {
        throw new Error(`${id}: refusing an unscoped Mem0 clear`)
      }
      if (options.client.getAll && options.client.delete) {
        const pendingForClear = [...pendingWrites].filter((pending) =>
          mem0FiltersInclude(pending.filters, clearFilters),
        )
        const deletedIds = new Set<string>()
        const searchProbes = new Map<string, Set<string>>()
        const observedPending = new Set<Mem0PendingWriteProbe>()
        for (const pending of pendingForClear) {
          const ids = searchProbes.get(pending.text) ?? new Set<string>()
          for (const providerId of pending.providerIds) ids.add(providerId)
          searchProbes.set(pending.text, ids)
          if (pending.providerIds.size > 0) observedPending.add(pending)
        }
        for (const pending of pendingForClear) {
          for (const providerId of pending.providerIds) {
            if (deletedIds.has(providerId)) continue
            await options.client.delete(providerId)
            deletedIds.add(providerId)
          }
        }
        const visibilityTimeoutMs = options.ingestionTimeoutMs ?? 30_000
        const pollIntervalMs = options.pollIntervalMs ?? 250
        let visibilityDeadline = Date.now() + visibilityTimeoutMs
        for (let batch = 0; batch < 100; ) {
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
          if (items.length === 0) {
            const searchableByQuery = await searchableMem0IdsForCleanup(
              options,
              clearFilters,
              searchProbes,
            )
            const searchableIds = new Set(
              [...searchableByQuery.values()].flatMap((ids) => [...ids]),
            )
            const unseenSearchIds = [...searchableIds].filter(
              (memoryId) => !deletedIds.has(memoryId),
            )
            for (const [query, ids] of searchableByQuery) {
              const known = searchProbes.get(query) ?? new Set<string>()
              for (const memoryId of ids) known.add(memoryId)
              searchProbes.set(query, known)
              if (ids.size > 0) {
                for (const pending of pendingForClear) {
                  if (pending.text === query) observedPending.add(pending)
                }
              }
            }
            if (unseenSearchIds.length > 0) {
              for (const memoryId of unseenSearchIds) {
                await options.client.delete(memoryId)
                deletedIds.add(memoryId)
              }
              batch += 1
              visibilityDeadline = Date.now() + visibilityTimeoutMs
              continue
            }
            const unresolvedPending = pendingForClear.some(
              (pending) => !observedPending.has(pending),
            )
            const needsQuietWindow = pendingForClear.some(
              (pending) => pending.providerIds.size === 0,
            )
            const remainingMs = visibilityDeadline - Date.now()
            if (remainingMs <= 0) {
              if (!unresolvedPending && searchableIds.size === 0) {
                removeMem0PendingWrites(pendingWrites, pendingForClear)
                return
              }
              if (searchableIds.size > 0) {
                throw new Error(
                  `${id}: deleted Mem0 memories remained searchable after ${visibilityTimeoutMs}ms`,
                )
              }
              throw new Error(
                `${id}: a Mem0 write never became visible for exact cleanup within ${visibilityTimeoutMs}ms`,
              )
            }
            if (!unresolvedPending && searchableIds.size === 0 && !needsQuietWindow) {
              removeMem0PendingWrites(pendingWrites, pendingForClear)
              return
            }
            await sleep(Math.min(pollIntervalMs, remainingMs))
            continue
          }
          const rawIds = items.map((item) => stringField(item, ['id']))
          if (!rawIds.every((memoryId): memoryId is string => memoryId !== undefined)) {
            throw new Error(`${id}: Mem0 returned memories without ids during scoped clear`)
          }
          const ids = [...new Set(rawIds)]
          for (const item of items) {
            const memoryId = stringField(item, ['id'])!
            const text =
              stringField(item, ['memory', 'text', 'content']) ??
              stringField(recordField(item, 'data'), ['memory', 'text', 'content'])
            if (!text) continue
            const idsForText = searchProbes.get(text) ?? new Set<string>()
            idsForText.add(memoryId)
            searchProbes.set(text, idsForText)
            for (const pending of pendingForClear) {
              if (pending.text === text || pending.providerIds.has(memoryId)) {
                observedPending.add(pending)
              }
            }
          }
          const unseenIds = ids.filter((memoryId) => !deletedIds.has(memoryId))
          if (unseenIds.length === 0) {
            const remainingMs = visibilityDeadline - Date.now()
            if (remainingMs <= 0) {
              throw new Error(
                `${id}: deleted Mem0 memories remained visible after ${visibilityTimeoutMs}ms`,
              )
            }
            await sleep(Math.min(pollIntervalMs, remainingMs))
            continue
          }
          for (const memoryId of unseenIds) {
            await options.client.delete(memoryId)
            deletedIds.add(memoryId)
          }
          batch += 1
          visibilityDeadline = Date.now() + visibilityTimeoutMs
        }
        throw new Error(
          `${id}: refused to clear more than ${deletedIds.size} Mem0 memories in one call`,
        )
      }
      throw new Error(`${id}: exact scoped clear requires Mem0 getAll plus per-memory delete`)
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
  if (
    options.backendRef !== undefined &&
    (typeof options.backendRef !== 'string' || !options.backendRef.trim())
  ) {
    throw new Error('Mem0 backendRef must be a non-empty string')
  }
  for (const [name, value] of [
    ['ingestionTimeoutMs', options.ingestionTimeoutMs],
    ['pollIntervalMs', options.pollIntervalMs],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`Mem0 ${name} must be a positive safe integer`)
    }
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

function assertMem0ProviderScope(
  scope: AgentMemoryScope,
  mode: Mem0ClientMode,
  adapterId: string,
  operation: 'search' | 'write' | 'clear',
): void {
  if (scope.userId || scope.agentId || scope.runId || scope.namespace) return
  if (operation === 'clear') {
    throw new Error(
      `${adapterId}: refusing an unscoped Mem0 clear; provide scope.userId, scope.agentId, scope.runId, or scope.namespace`,
    )
  }
  throw new Error(
    `${adapterId}: Mem0 ${mode} ${operation} requires scope.userId, scope.agentId, scope.runId, or scope.namespace`,
  )
}

function normalizeMem0Hits(
  raw: unknown,
  adapterId: string,
  options: AgentMemorySearchOptions,
): AgentMemoryHit[] {
  const limit = options.limit ?? Number.POSITIVE_INFINITY
  const kinds = options.kinds && options.kinds.length > 0 ? new Set(options.kinds) : null
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

function mergeMem0Hits(hits: readonly AgentMemoryHit[], limit?: number): AgentMemoryHit[] {
  const unique = new Map<string, { hit: AgentMemoryHit; index: number; score?: number }>()
  for (const [index, hit] of hits.entries()) {
    const key = JSON.stringify([hit.uri, hit.text])
    const score = hit.normalizedScore ?? hit.score
    const finiteScore = score !== undefined && Number.isFinite(score) ? score : undefined
    const prior = unique.get(key)
    if (!prior) {
      unique.set(key, { hit, index, score: finiteScore })
    } else if (
      finiteScore !== undefined &&
      (prior.score === undefined || finiteScore > prior.score)
    ) {
      unique.set(key, { hit, index: prior.index, score: finiteScore })
    }
  }
  return [...unique.values()]
    .sort(
      (left, right) =>
        Number(right.score !== undefined) - Number(left.score !== undefined) ||
        (right.score ?? 0) - (left.score ?? 0) ||
        left.index - right.index,
    )
    .map(({ hit }) => hit)
    .slice(0, limit ?? Number.POSITIVE_INFINITY)
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
  return (
    stringField(item, ['event']) ?? stringField(recordField(item, 'metadata'), ['event'])
  )?.toUpperCase()
}

function mem0Entity(scope: AgentMemoryScope, appId?: string): Record<string, string> {
  return compactStringRecord({
    userId: scope.userId,
    agentId: scope.agentId,
    appId,
    runId: scope.namespace ?? scope.runId,
  })
}

function mem0Filters(
  scope: AgentMemoryScope,
  appId: string | undefined,
  kind?: AgentMemoryKind,
): Record<string, unknown> {
  const entity = mem0EntityFilters(scope, appId)
  const customMetadata = compactRecord({
    ...mem0CustomScopeMetadata(scope),
    memoryKind: kind,
  })
  return compactRecord({ ...entity, ...customMetadata })
}

function mem0ScopeMetadata(scope: AgentMemoryScope, appId?: string): Record<string, string> {
  return { ...mem0EntityFilters(scope, appId), ...mem0CustomScopeMetadata(scope) }
}

function mem0EntityFilters(scope: AgentMemoryScope, appId?: string): Record<string, string> {
  return compactStringRecord({
    user_id: scope.userId,
    agent_id: scope.agentId,
    run_id: scope.namespace ?? scope.runId,
    app_id: appId,
  })
}

function mem0CustomScopeMetadata(scope: AgentMemoryScope): Record<string, string> {
  const metadata = compactStringRecord({
    logical_run_id: scope.namespace ? scope.runId : undefined,
    tenant_id: scope.tenantId,
    team_id: scope.teamId,
    session_id: scope.sessionId,
  })
  for (const [key, value] of Object.entries(scope.tags ?? {})) {
    metadata[`tag_${key}`] = value
  }
  return metadata
}

async function searchableMem0IdsForCleanup(
  options: Mem0MemoryAdapterOptions,
  filters: Record<string, unknown>,
  probes: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<ReadonlyMap<string, ReadonlySet<string>>> {
  const searchable = new Map<string, ReadonlySet<string>>()
  const entries = [...probes]
  for (let offset = 0; offset < entries.length; offset += 8) {
    const results = await Promise.all(
      entries.slice(offset, offset + 8).map(async ([query, expectedIds]) => {
        const raw = await options.client.search(query, {
          filters,
          topK: Math.min(100, Math.max(10, expectedIds.size)),
          ...(options.mode === 'hosted' ? { latestOnly: false, showExpired: true } : {}),
        })
        return extractMem0Items(raw).map((item) => {
          const memoryId = stringField(item, ['id'])
          if (!memoryId) {
            throw new Error(
              `${options.id ?? `mem0-${options.mode}`}: Mem0 search returned a memory without an id during clear verification`,
            )
          }
          return memoryId
        })
      }),
    )
    for (const [index, ids] of results.entries()) {
      const query = entries[offset + index]![0]
      searchable.set(query, new Set(ids))
    }
  }
  return searchable
}

function mem0FiltersInclude(
  candidate: Readonly<Record<string, unknown>>,
  requested: Readonly<Record<string, unknown>>,
): boolean {
  return Object.entries(requested).every(([key, value]) => Object.is(candidate[key], value))
}

function removeMem0PendingWrites(
  pendingWrites: Set<Mem0PendingWriteProbe>,
  removed: readonly Mem0PendingWriteProbe[],
): void {
  for (const pending of removed) pendingWrites.delete(pending)
}

function pruneExpiredMem0PendingWrites(pendingWrites: Set<Mem0PendingWriteProbe>): void {
  const now = Date.now()
  for (const pending of pendingWrites) {
    if (pending.expiresAt <= now) pendingWrites.delete(pending)
  }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
    | 'mode'
    | 'id'
    | 'appId'
    | 'infer'
    | 'rerank'
    | 'latestOnly'
    | 'ingestionTimeoutMs'
    | 'pollIntervalMs'
    | 'defaultScope'
  > & { backendRef: string },
): string {
  if (typeof options.backendRef !== 'string' || !options.backendRef.trim()) {
    throw new Error('Mem0 backendRef must be a non-empty string')
  }
  return stableId('mem0', canonicalJson(compactRecord(options)))
}
