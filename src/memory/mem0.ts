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
export type Mem0Consistency = 'queued' | 'visible'

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
  consistency?: Mem0Consistency
  /** Reads `GET /v1/event/{eventId}/`; required when a hosted add is asynchronous. */
  getEvent?: (eventId: string) => Promise<unknown>
  ingestionTimeoutMs?: number
  pollIntervalMs?: number
  /** Stable deployment/account identity for cache-key helpers. Never put credentials here. */
  backendRef?: string
  defaultScope?: AgentMemoryScope
}

/** Connects both the hosted Mem0 client and the open-source `Memory` class. */
export function createMem0MemoryAdapter(options: Mem0MemoryAdapterOptions): AgentMemoryAdapter {
  assertMem0Options(options)
  const id = options.id ?? `mem0-${options.mode}`
  const consistency = options.mode === 'oss' ? 'visible' : (options.consistency ?? 'visible')
  const pendingWrites = new Map<string, AgentMemoryScope>()

  const adapter: AgentMemoryAdapter = {
    id,
    branchIsolation:
      options.mode === 'oss'
        ? { mode: 'scoped' }
        : consistency === 'visible'
          ? {
              mode: 'scoped',
              processExitSafe: false,
              recoveryDelayMs: options.ingestionTimeoutMs ?? 30_000,
            }
          : {
              mode: 'unsupported',
              reason:
                'queued hosted Mem0 writes can become visible after branch cleanup; use consistency="visible" with an attempt branch',
            },
    async search(query, searchOptions = {}) {
      assertMem0SearchOptions(searchOptions, id)
      if (searchOptions.limit === 0) return []
      const scope = mergeScopes(options.defaultScope, searchOptions.scope)
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
      const writeId = input.id ?? randomUUID()
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
      const raw = await options.client.add([{ role: mem0Role(input.role), content: input.text }], {
        ...entity,
        metadata,
        infer: options.infer ?? true,
        ...(options.mode === 'oss' ? { filters: mem0Filters(scope, options.appId) } : {}),
      })
      let items = extractMem0Items(raw)
      const pending = options.mode === 'hosted' && mem0ResponsePending(raw)
      const eventId = stringField(isRecord(raw) ? raw : undefined, ['eventId', 'event_id'])
      if (pending) {
        if (!eventId) throw new Error(`${id}: asynchronous Mem0 add returned no event_id`)
        pendingWrites.set(eventId, cloneScope(scope))
        if (consistency === 'visible') {
          const terminal = await waitForMem0Event(options, eventId)
          pendingWrites.delete(eventId)
          assertMem0EventSucceeded(terminal, id, eventId)
          items = extractMem0Items(terminal)
        }
      } else if (options.mode === 'hosted' && isRecord(raw) && mem0Status(raw) === 'FAILED') {
        assertMem0EventSucceeded(raw, id, eventId ?? 'unknown')
      }
      const mutations = items.filter((candidate) => mem0Event(candidate) !== 'NOOP')
      const item = mutations[0] ?? items[0]
      const itemId = stringField(item, ['id']) ?? eventId ?? writeId
      const event = mem0Event(item)
      const events = [...new Set(mutations.map(mem0Event).filter(Boolean))]
      const result = {
        accepted: pending && consistency === 'queued' ? true : mutations.length > 0,
        id: itemId,
        uri: `memory://${id}/${encodeURIComponent(itemId)}`,
        kind: input.kind,
        metadata: {
          provider: 'mem0',
          mode: options.mode,
          consistency,
          queued: pending && consistency === 'queued',
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
      const clearFilters = mem0Filters(mergedScope, options.appId)
      if (Object.keys(clearFilters).length === 0) {
        throw new Error(`${id}: refusing an unscoped Mem0 clear`)
      }
      await settlePendingMem0Writes(options, pendingWrites, mergedScope, false)
      if (options.client.getAll && options.client.delete) {
        const deletedIds = new Set<string>()
        const deletedSearchProbes = new Map<string, Set<string>>()
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
            if (
              !(await deletedMem0IdsRemainSearchable(
                options,
                clearFilters,
                deletedIds,
                deletedSearchProbes,
              ))
            ) {
              return
            }
            const remainingMs = visibilityDeadline - Date.now()
            if (remainingMs <= 0) {
              throw new Error(
                `${id}: deleted Mem0 memories remained searchable after ${visibilityTimeoutMs}ms`,
              )
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
            const idsForText = deletedSearchProbes.get(text) ?? new Set<string>()
            idsForText.add(memoryId)
            deletedSearchProbes.set(text, idsForText)
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
    async flush() {
      await settlePendingMem0Writes(options, pendingWrites, undefined, true)
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
  if (options.mode === 'oss' && options.consistency === 'queued') {
    throw new Error('Mem0 OSS writes are synchronous and do not support consistency="queued"')
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
    const key = `${hit.uri}\n${hit.text}`
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
  return stringField(item, ['event'])?.toUpperCase()
}

function mem0ResponsePending(raw: unknown): boolean {
  if (!isRecord(raw)) return false
  const status = stringField(raw, ['status'])?.toUpperCase()
  return status === 'PENDING' || status === 'RUNNING' || status === 'QUEUED'
}

async function waitForMem0Event(
  options: Mem0MemoryAdapterOptions,
  eventId: string,
): Promise<Record<string, unknown>> {
  if (!options.getEvent) {
    throw new Error(
      `${options.id ?? 'mem0-hosted'}: hosted asynchronous writes require getEvent(eventId) for GET /v1/event/{eventId}/`,
    )
  }
  const timeoutMs = options.ingestionTimeoutMs ?? 30_000
  const pollIntervalMs = options.pollIntervalMs ?? 250
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const raw = await options.getEvent(eventId)
    if (!isRecord(raw)) throw new Error(`${options.id ?? 'mem0-hosted'}: invalid event response`)
    const status = mem0Status(raw)
    if (status === 'SUCCEEDED' || status === 'FAILED') return raw
    if (status !== 'PENDING' && status !== 'RUNNING' && status !== 'QUEUED') {
      throw new Error(
        `${options.id ?? 'mem0-hosted'}: event ${eventId} returned unsupported status ${status ?? 'missing'}`,
      )
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error(
        `${options.id ?? 'mem0-hosted'}: event ${eventId} did not finish within ${timeoutMs}ms`,
      )
    }
    await sleep(Math.min(pollIntervalMs, remaining))
  }
}

function assertMem0EventSucceeded(
  event: Record<string, unknown>,
  adapterId: string,
  eventId: string,
): void {
  if (mem0Status(event) === 'SUCCEEDED') return
  const detail =
    stringField(event, ['message', 'error', 'errorMessage', 'error_message']) ??
    stringField(recordField(event, 'metadata'), ['message', 'error'])
  throw new Error(`${adapterId}: Mem0 event ${eventId} failed${detail ? `: ${detail}` : ''}`)
}

function mem0Status(raw: Record<string, unknown>): string | undefined {
  return stringField(raw, ['status'])?.toUpperCase()
}

async function settlePendingMem0Writes(
  options: Mem0MemoryAdapterOptions,
  pendingWrites: Map<string, AgentMemoryScope>,
  requestedScope?: AgentMemoryScope,
  failOnProviderFailure = true,
): Promise<void> {
  const pending = [...pendingWrites].filter(
    ([, scope]) => !requestedScope || scopeMatches(scope, requestedScope),
  )
  const settled = await Promise.allSettled(
    pending.map(async ([eventId]) => {
      const terminal = await waitForMem0Event(options, eventId)
      pendingWrites.delete(eventId)
      if (failOnProviderFailure) {
        assertMem0EventSucceeded(terminal, options.id ?? 'mem0-hosted', eventId)
      }
    }),
  )
  const failures = settled.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  )
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(failures, `${options.id ?? 'mem0-hosted'}: pending writes failed`)
  }
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

async function deletedMem0IdsRemainSearchable(
  options: Mem0MemoryAdapterOptions,
  filters: Record<string, unknown>,
  deletedIds: ReadonlySet<string>,
  probes: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<boolean> {
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
    if (results.some((ids) => ids.some((memoryId) => deletedIds.has(memoryId)))) return true
  }
  return false
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

function cloneScope(scope: AgentMemoryScope): AgentMemoryScope {
  return { ...scope, tags: { ...(scope.tags ?? {}) } }
}

function scopeMatches(actual: AgentMemoryScope, requested: AgentMemoryScope): boolean {
  for (const key of [
    'tenantId',
    'userId',
    'agentId',
    'teamId',
    'runId',
    'sessionId',
    'namespace',
  ] as const) {
    if (requested[key] !== undefined && actual[key] !== requested[key]) return false
  }
  for (const [key, value] of Object.entries(requested.tags ?? {})) {
    if (actual.tags?.[key] !== value) return false
  }
  return true
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
    | 'consistency'
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
