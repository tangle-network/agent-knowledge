import { canonicalJson } from '@tangle-network/agent-eval'
import { sha256, stableId } from '../ids'
import { defaultGetMemoryContext } from './adapter'
import { mergeRankedMemoryHits } from './rank'
import type {
  AgentMemoryAdapter,
  AgentMemoryScope,
  AgentMemoryWriteInput,
  AgentMemoryWriteResult,
} from './types'

export type AgentMemoryVisibility = 'private' | 'team' | 'shared'
export type AgentMemoryBranchLifetime = 'resumable' | 'attempt'

export interface AgentMemorySharingPolicy {
  read: readonly AgentMemoryVisibility[]
  write: AgentMemoryVisibility
}

export interface AgentMemoryJournalEntry {
  sequence: number
  input: AgentMemoryWriteInput
  result: AgentMemoryWriteResult
}

export interface AgentMemoryBranchSnapshot {
  branchId: string
  lifetime: AgentMemoryBranchLifetime
  parentBranchId?: string
  adapterId: string
  policy: AgentMemorySharingPolicy
  baseScope: AgentMemoryScope
  journal: readonly AgentMemoryJournalEntry[]
  digest: `sha256:${string}`
}

export interface AgentMemoryBranch extends AgentMemoryAdapter {
  readonly branchId: string
  readonly lifetime: AgentMemoryBranchLifetime
  readonly parentBranchId?: string
  readonly policy: AgentMemorySharingPolicy
  snapshot(): Promise<AgentMemoryBranchSnapshot>
  fork(options: {
    branchId: string
    adapter?: AgentMemoryAdapter
    policy?: AgentMemorySharingPolicy
    baseScope?: AgentMemoryScope
    lifetime?: AgentMemoryBranchLifetime
  }): Promise<AgentMemoryBranch>
}

export interface CreateAgentMemoryBranchOptions {
  adapter: AgentMemoryAdapter
  branchId: string
  parentBranchId?: string
  policy?: AgentMemorySharingPolicy
  baseScope?: AgentMemoryScope
  /** Attempt branches use a new ID after a process restart and cannot bind persisted state. */
  lifetime?: AgentMemoryBranchLifetime
  /** Rebind a persisted branch whose external memory is still present. */
  snapshot?: AgentMemoryBranchSnapshot
  /** Optional exact logical scopes allowed to write, used by crash-safe experiments. */
  allowedWriteScopes?: readonly AgentMemoryScope[]
}

export interface ForkAgentMemoryBranchSnapshotOptions {
  snapshot: AgentMemoryBranchSnapshot
  adapter: AgentMemoryAdapter
  branchId: string
  policy?: AgentMemorySharingPolicy
  baseScope?: AgentMemoryScope
  lifetime?: AgentMemoryBranchLifetime
}

const DEFAULT_POLICY: AgentMemorySharingPolicy = {
  read: ['private'],
  write: 'private',
}

interface AdapterLeaseState {
  references: number
  closed: boolean
  activeBranchIds: Set<string>
  closePromise?: Promise<void>
}

const adapterLeases = new WeakMap<AgentMemoryAdapter, AdapterLeaseState>()

/**
 * Isolates one candidate branch and records accepted writes for durable resume
 * or replay into a child branch, including a child backed by another provider.
 */
export function createAgentMemoryBranch(
  options: CreateAgentMemoryBranchOptions,
): AgentMemoryBranch {
  if (typeof options.branchId !== 'string' || !options.branchId.trim()) {
    throw new Error('memory branchId must be a non-empty string')
  }
  const snapshot = options.snapshot
  if (snapshot && snapshot.branchId !== options.branchId) {
    throw new Error(
      `memory branch snapshot belongs to ${snapshot.branchId}, not ${options.branchId}`,
    )
  }
  if (snapshot && snapshot.adapterId !== options.adapter.id) {
    throw new Error(
      `memory branch snapshot uses ${snapshot.adapterId}, not ${options.adapter.id}; fork it to replay into another adapter`,
    )
  }
  if (snapshot?.lifetime === 'attempt') {
    throw new Error(
      'memory branch attempt snapshots cannot be resumed; replay them into a fresh branch instead',
    )
  }
  if (options.lifetime !== undefined && !['resumable', 'attempt'].includes(options.lifetime)) {
    throw new Error('memory branch lifetime must be resumable or attempt')
  }
  if (snapshot) {
    assertDurableValue(snapshot, `${options.branchId}: branch snapshot`)
    assertSnapshotDigest(snapshot)
  }
  if (
    snapshot &&
    options.policy &&
    canonicalJson(stripUndefined(options.policy)) !== canonicalJson(stripUndefined(snapshot.policy))
  ) {
    throw new Error('memory branch snapshot policy cannot change during resume; fork it instead')
  }
  if (
    snapshot &&
    options.baseScope &&
    canonicalJson(stripUndefined(options.baseScope)) !==
      canonicalJson(stripUndefined(snapshot.baseScope))
  ) {
    throw new Error('memory branch snapshot scope cannot change during resume; fork it instead')
  }
  if (snapshot && options.lifetime && options.lifetime !== snapshot.lifetime) {
    throw new Error('memory branch snapshot lifetime cannot change during resume; fork it instead')
  }

  const branchId = options.branchId
  const parentBranchId = options.parentBranchId ?? snapshot?.parentBranchId
  const lifetime = options.lifetime ?? snapshot?.lifetime ?? 'resumable'
  const policy = normalizePolicy(options.policy ?? snapshot?.policy ?? DEFAULT_POLICY)
  assertBranchIsolation(options.adapter, branchId, policy, lifetime)
  const mergedBaseScope = mergeScopes(undefined, snapshot?.baseScope ?? options.baseScope)
  assertDurableValue(mergedBaseScope, `${branchId}: base scope`)
  const baseScope = cloneDurableValue(mergedBaseScope)
  const allowedWriteScopeKeys = options.allowedWriteScopes
    ? new Set(
        options.allowedWriteScopes.map((scope) =>
          canonicalJson(stripUndefined(mergeScopes(baseScope, scope))),
        ),
      )
    : undefined
  const journal = [...(snapshot?.journal ?? [])].map(cloneJournalEntry)
  let nextSequence = journal.reduce((max, entry) => Math.max(max, entry.sequence + 1), 0)
  const queues = new Map<string, Promise<void>>()
  const pending = new Set<Promise<unknown>>()
  const reads = new Set<Promise<unknown>>()
  const active = new Set<Promise<unknown>>()
  const touchedScopes = new Map<string, AgentMemoryScope>()
  for (const entry of journal) {
    const scope = mergeScopes(baseScope, entry.input.scope)
    touchedScopes.set(canonicalJson(stripUndefined(scope)), scope)
  }
  let mutationBarrier = Promise.resolve()
  const releaseAdapter = retainAdapter(options.adapter, branchId)
  let lifecycle: 'open' | 'closing' | 'closed' = 'open'
  let closePromise: Promise<void> | undefined

  const assertOpen = (operation: string): void => {
    if (lifecycle !== 'open') throw new Error(`${branchId}: cannot ${operation} a closed branch`)
  }
  const track = <T>(operation: Promise<T>): Promise<T> => {
    active.add(operation)
    void operation.then(
      () => active.delete(operation),
      () => active.delete(operation),
    )
    return operation
  }
  const trackRead = <T>(operation: Promise<T>): Promise<T> => {
    reads.add(operation)
    void operation.then(
      () => reads.delete(operation),
      () => reads.delete(operation),
    )
    return track(operation)
  }
  const flushWrites = async (): Promise<void> => {
    const results = await Promise.allSettled([...pending])
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    )
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(failures, `${branchId}: pending memory writes failed`)
    }
  }
  const flushAll = async (): Promise<void> => {
    await flushWrites()
    await options.adapter.flush?.()
  }
  const runExclusive = async <T>(
    operation: () => Promise<T>,
    exclusiveOptions: { failOnOperationError?: boolean; flushAdapter?: boolean } = {},
  ): Promise<T> => {
    const precedingBarrier = mutationBarrier
    const precedingWrites = [...pending]
    const precedingReads = [...reads]
    let releaseBarrier!: () => void
    const ownBarrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve
    })
    mutationBarrier = precedingBarrier.then(() => ownBarrier)
    await precedingBarrier
    const settled = await Promise.allSettled([...precedingWrites, ...precedingReads])
    const failures = settled.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    )
    try {
      if ((exclusiveOptions.failOnOperationError ?? true) && failures.length > 0) {
        if (failures.length === 1) throw failures[0]
        throw new AggregateError(failures, `${branchId}: pending memory operations failed`)
      }
      if (exclusiveOptions.flushAdapter ?? true) await options.adapter.flush?.()
      return await operation()
    } finally {
      releaseBarrier()
    }
  }

  const branch: AgentMemoryBranch = {
    id: `${options.adapter.id}:branch:${stableId('branch', branchId)}`,
    branchId,
    lifetime,
    ...(parentBranchId !== undefined ? { parentBranchId } : {}),
    policy,
    async search(query, searchOptions = {}) {
      assertOpen('search')
      const precedingBarrier = mutationBarrier
      return trackRead(
        (async () => {
          await precedingBarrier
          const logicalScope = mergeScopes(baseScope, searchOptions.scope)
          const scopes = policy.read.map((visibility) =>
            physicalScope(branchId, logicalScope, visibility),
          )
          const groups = await Promise.all(
            scopes.map(async (scope) => {
              const hits = await options.adapter.search(query, {
                ...searchOptions,
                scope,
                holdout: undefined,
              })
              return hits.map((hit) => ({
                ...hit,
                metadata: {
                  ...hit.metadata,
                  memoryBranchId: branchId,
                  memoryVisibility: scope.tags?.memoryVisibility,
                },
              }))
            }),
          )
          return mergeRankedMemoryHits(groups, searchOptions.limit)
        })(),
      )
    },
    async getContext(query, searchOptions = {}) {
      assertOpen('read context from')
      return track(defaultGetMemoryContext(branch, query, searchOptions))
    },
    async write(input) {
      assertOpen('write to')
      const sequence = nextSequence
      nextSequence += 1
      assertDurableValue(input, `${branch.id}: write input`)
      const logicalInput = cloneWriteInput(input)
      logicalInput.id ??= stableId('memory_write', `${branchId}:${sequence}`)
      const logicalScope = mergeScopes(baseScope, logicalInput.scope)
      if (
        allowedWriteScopeKeys &&
        !allowedWriteScopeKeys.has(canonicalJson(stripUndefined(logicalScope)))
      ) {
        throw new Error(
          `${branch.id}: write scope was not declared in the experiment sequence cleanupScopes`,
        )
      }
      const scope = physicalScope(branchId, logicalScope, policy.write)
      const queueKey = writeQueueKey(branchId, logicalScope, policy.write)
      touchedScopes.set(canonicalJson(stripUndefined(logicalScope)), logicalScope)
      const previous = queues.get(queueKey) ?? Promise.resolve()
      const precedingBarrier = mutationBarrier
      let resultPromise: Promise<AgentMemoryWriteResult>
      const queued = Promise.all([previous.catch(() => undefined), precedingBarrier]).then(
        async () => {
          const result = await options.adapter.write({ ...logicalInput, scope })
          if (result.accepted) {
            assertDurableValue(result, `${branch.id}: write result`)
            journal.push({
              sequence,
              input: logicalInput,
              result: cloneWriteResult(result),
            })
          }
          return result
        },
      )
      resultPromise = queued
      const tail = queued.then(
        () => undefined,
        () => undefined,
      )
      queues.set(queueKey, tail)
      pending.add(resultPromise)
      void resultPromise.then(
        () => {
          pending.delete(resultPromise)
          if (queues.get(queueKey) === tail) queues.delete(queueKey)
        },
        () => {
          pending.delete(resultPromise)
          if (queues.get(queueKey) === tail) queues.delete(queueKey)
        },
      )
      return track(resultPromise)
    },
    async clear(scope) {
      assertOpen('clear')
      return track(
        runExclusive(
          async () => {
            if (!options.adapter.clear) {
              throw new Error(`${options.adapter.id}: adapter does not support scoped clear`)
            }
            const flushErrors: unknown[] = []
            try {
              await options.adapter.flush?.()
            } catch (error) {
              flushErrors.push(error)
            }
            const requestedScope = scope ? mergeScopes(baseScope, scope) : undefined
            const logicalScopes = new Map<string, AgentMemoryScope>()
            if (requestedScope) {
              logicalScopes.set(canonicalJson(stripUndefined(requestedScope)), requestedScope)
              for (const touched of touchedScopes.values()) {
                if (scopeMatches(touched, requestedScope)) {
                  logicalScopes.set(canonicalJson(stripUndefined(touched)), touched)
                }
              }
            } else if (touchedScopes.size > 0) {
              for (const [key, touched] of touchedScopes) logicalScopes.set(key, touched)
            } else {
              logicalScopes.set(canonicalJson(stripUndefined(baseScope)), baseScope)
            }
            const visibilities = new Set([...policy.read, policy.write])
            const physicalScopes = new Map<string, AgentMemoryScope>()
            for (const logicalScope of logicalScopes.values()) {
              for (const visibility of visibilities) {
                const physical = physicalScope(branchId, logicalScope, visibility)
                physicalScopes.set(canonicalJson(stripUndefined(physical)), physical)
              }
            }
            const clearErrors: unknown[] = []
            const clearedPhysicalScopes = new Set<string>()
            for (const [key, physical] of physicalScopes) {
              try {
                await options.adapter.clear(physical)
                clearedPhysicalScopes.add(key)
              } catch (error) {
                clearErrors.push(error)
              }
            }
            if (clearedPhysicalScopes.size > 0) {
              for (let index = journal.length - 1; index >= 0; index -= 1) {
                const logical = mergeScopes(baseScope, journal[index]!.input.scope)
                const physical = physicalScope(branchId, logical, policy.write)
                if (clearedPhysicalScopes.has(canonicalJson(stripUndefined(physical)))) {
                  journal.splice(index, 1)
                }
              }
              for (const [key, touched] of touchedScopes) {
                const physical = physicalScope(branchId, touched, policy.write)
                if (clearedPhysicalScopes.has(canonicalJson(stripUndefined(physical)))) {
                  touchedScopes.delete(key)
                }
              }
            }
            const failures = [...flushErrors, ...clearErrors]
            if (failures.length === 1) throw failures[0]
            if (failures.length > 1) {
              throw new AggregateError(failures, `${branchId}: memory clear failed`)
            }
          },
          { failOnOperationError: false, flushAdapter: false },
        ),
      )
    },
    async flush() {
      assertOpen('flush')
      return track(runExclusive(async () => undefined))
    },
    close() {
      if (closePromise) return closePromise
      lifecycle = 'closing'
      closePromise = (async () => {
        const errors: unknown[] = []
        const operations = await Promise.allSettled([...active])
        for (const result of operations) {
          if (result.status === 'rejected') errors.push(result.reason)
        }
        try {
          await flushAll()
        } catch (error) {
          errors.push(error)
        }
        try {
          await releaseAdapter()
        } catch (error) {
          errors.push(error)
        }
        lifecycle = 'closed'
        if (errors.length === 1) throw errors[0]
        if (errors.length > 1) throw new AggregateError(errors, `${branch.id}: close failed`)
      })()
      return closePromise
    },
    async snapshot() {
      assertOpen('snapshot')
      return track(
        runExclusive(async () => {
          return createSnapshot({
            branchId,
            lifetime,
            adapterId: options.adapter.id,
            policy,
            baseScope,
            journal,
            ...(parentBranchId !== undefined ? { parentBranchId } : {}),
          })
        }),
      )
    },
    async fork(forkOptions) {
      assertOpen('fork')
      if (forkOptions.branchId === branchId) {
        throw new Error(`memory branch ${branchId}: child branchId must differ from its parent`)
      }
      return track(
        (async () =>
          forkAgentMemoryBranchSnapshot({
            snapshot: await branch.snapshot(),
            adapter: forkOptions.adapter ?? options.adapter,
            branchId: forkOptions.branchId,
            policy: forkOptions.policy,
            baseScope: forkOptions.baseScope,
            lifetime: forkOptions.lifetime,
          }))(),
      )
    },
  }
  return branch
}

/** Replays a durable journal into a fresh provider branch. */
export async function forkAgentMemoryBranchSnapshot(
  options: ForkAgentMemoryBranchSnapshotOptions,
): Promise<AgentMemoryBranch> {
  assertDurableValue(options.snapshot, `${options.snapshot.branchId}: branch snapshot`)
  assertSnapshotDigest(options.snapshot)
  if (options.branchId === options.snapshot.branchId) {
    throw new Error(`memory branch ${options.branchId}: child branchId must differ from its parent`)
  }
  const child = createAgentMemoryBranch({
    adapter: options.adapter,
    branchId: options.branchId,
    parentBranchId: options.snapshot.branchId,
    policy: options.policy ?? options.snapshot.policy,
    baseScope: mergeScopes(options.snapshot.baseScope, options.baseScope),
    lifetime: options.lifetime ?? options.snapshot.lifetime,
  })
  try {
    for (const entry of options.snapshot.journal) {
      const result = await child.write(entry.input)
      if (!result.accepted) {
        throw new Error(
          `memory branch ${options.branchId}: adapter rejected replay of journal entry ${entry.sequence}`,
        )
      }
    }
    await child.flush?.()
    return child
  } catch (error) {
    const cleanupErrors: unknown[] = []
    try {
      await child.clear?.()
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError)
    }
    try {
      await child.close?.()
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError)
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `memory branch ${options.branchId}: replay and cleanup failed`,
      )
    }
    throw error
  }
}

function assertBranchIsolation(
  adapter: AgentMemoryAdapter,
  branchId: string,
  policy: AgentMemorySharingPolicy,
  lifetime: AgentMemoryBranchLifetime,
): void {
  const isolation = adapter.branchIsolation
  if (!isolation) {
    throw new Error(
      `${adapter.id}: cannot isolate memory branch '${branchId}': adapter must declare branchIsolation`,
    )
  }
  if (isolation.mode === 'unsupported') {
    throw new Error(
      `${adapter.id}: cannot isolate memory branch '${branchId}': ${isolation.reason}`,
    )
  }
  if (
    isolation.mode === 'scoped' &&
    isolation.processExitSafe === false &&
    lifetime !== 'attempt'
  ) {
    throw new Error(
      `${adapter.id}: memory branch '${branchId}' must use lifetime='attempt' because provider writes can outlive the worker process`,
    )
  }
  if (
    isolation.mode === 'scoped' &&
    isolation.processExitSafe === false &&
    (!Number.isSafeInteger(isolation.recoveryDelayMs) || isolation.recoveryDelayMs! <= 0)
  ) {
    throw new Error(`${adapter.id}: processExitSafe=false requires a positive recoveryDelayMs`)
  }
  if (isolation.mode === 'instance' && isolation.branchId !== branchId) {
    throw new Error(
      `${adapter.id}: adapter instance belongs to branch '${isolation.branchId}', not '${branchId}'`,
    )
  }
  if (
    isolation.mode === 'instance' &&
    isolation.supportsLogicalScopes !== true &&
    (policy.write !== 'shared' || policy.read.length !== 1 || policy.read[0] !== 'shared')
  ) {
    throw new Error(
      `${adapter.id}: dedicated branch instances without logical scope isolation support only shared memory policy`,
    )
  }
}

function retainAdapter(adapter: AgentMemoryAdapter, branchId: string): () => Promise<void> {
  const existing = adapterLeases.get(adapter)
  if (existing?.closed) throw new Error(`${adapter.id}: adapter is already closed`)
  const state = existing ?? { references: 0, closed: false, activeBranchIds: new Set<string>() }
  if (state.activeBranchIds.has(branchId)) {
    throw new Error(`${adapter.id}: memory branch '${branchId}' already has an open handle`)
  }
  state.activeBranchIds.add(branchId)
  state.references += 1
  adapterLeases.set(adapter, state)
  let released = false
  return async () => {
    if (released) return
    released = true
    state.activeBranchIds.delete(branchId)
    state.references -= 1
    if (state.references > 0) return
    if (!adapter.close) {
      adapterLeases.delete(adapter)
      return
    }
    state.closed = true
    state.closePromise ??= adapter.close()
    await state.closePromise
  }
}

function physicalScope(
  branchId: string,
  logical: AgentMemoryScope,
  visibility: AgentMemoryVisibility,
): AgentMemoryScope {
  if (visibility === 'private' && !logical.agentId) {
    throw new Error('private memory requires scope.agentId')
  }
  if (visibility === 'team' && !logical.teamId) {
    throw new Error('team memory requires scope.teamId')
  }
  const principal =
    visibility === 'private' ? logical.agentId! : visibility === 'team' ? logical.teamId! : 'all'
  const namespace = [
    logical.namespace ?? 'default',
    stableId('branch', branchId),
    visibility,
    stableId('principal', principal),
  ].join('/')
  const physical: AgentMemoryScope = {
    ...logical,
    namespace,
    tags: {
      ...(logical.tags ?? {}),
      memoryBranchId: branchId,
      memoryVisibility: visibility,
      logicalNamespace: logical.namespace ?? 'default',
    },
  }
  if (visibility === 'shared') {
    delete physical.agentId
    delete physical.teamId
  } else if (visibility === 'team') {
    delete physical.agentId
  }
  return physical
}

function writeQueueKey(
  branchId: string,
  logical: AgentMemoryScope,
  visibility: AgentMemoryVisibility,
): string {
  return canonicalJson(
    stripUndefined({
      branchId,
      visibility,
      tenantId: logical.tenantId,
      userId: logical.userId,
      agentId: logical.agentId,
      fallbackTeamId: logical.agentId === undefined ? logical.teamId : undefined,
      fallbackPrincipal:
        logical.agentId === undefined && logical.teamId === undefined ? 'unattributed' : undefined,
    }),
  )
}

function normalizePolicy(policy: AgentMemorySharingPolicy): AgentMemorySharingPolicy {
  const allowed = new Set<AgentMemoryVisibility>(['private', 'team', 'shared'])
  if (!allowed.has(policy.write) || policy.read.some((visibility) => !allowed.has(visibility))) {
    throw new Error('memory sharing policy contains an unsupported visibility')
  }
  const read = [...new Set(policy.read)]
  if (read.length === 0) throw new Error('memory sharing policy must read at least one visibility')
  return { read, write: policy.write }
}

function createSnapshot(
  input: Omit<AgentMemoryBranchSnapshot, 'digest'>,
): AgentMemoryBranchSnapshot {
  const payload = cloneDurableValue({
    ...input,
    journal: [...input.journal].sort((a, b) => a.sequence - b.sequence),
  })
  assertDurableValue(payload, `${input.branchId}: branch snapshot`)
  return {
    ...payload,
    digest: `sha256:${sha256(canonicalJson(stripUndefined(payload)))}`,
  }
}

function assertSnapshotDigest(snapshot: AgentMemoryBranchSnapshot): void {
  const { digest, ...payload } = snapshot
  const actual = `sha256:${sha256(canonicalJson(stripUndefined(payload)))}`
  if (actual !== digest)
    throw new Error(`memory branch snapshot digest mismatch: ${digest} != ${actual}`)
}

function mergeScopes(base?: AgentMemoryScope, extra?: AgentMemoryScope): AgentMemoryScope {
  return {
    ...(base ?? {}),
    ...(extra ?? {}),
    tags: { ...(base?.tags ?? {}), ...(extra?.tags ?? {}) },
  }
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

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUndefined)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, stripUndefined(child)]),
  )
}

function cloneWriteInput(input: AgentMemoryWriteInput): AgentMemoryWriteInput {
  return cloneDurableValue(input)
}

function cloneWriteResult(result: AgentMemoryWriteResult): AgentMemoryWriteResult {
  return cloneDurableValue(result)
}

function cloneJournalEntry(entry: AgentMemoryJournalEntry): AgentMemoryJournalEntry {
  return {
    sequence: entry.sequence,
    input: cloneWriteInput(entry.input),
    result: cloneWriteResult(entry.result),
  }
}

function assertDurableValue(value: unknown, label: string, seen = new WeakSet<object>()): void {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return
  }
  if (value === undefined) return
  if (typeof value !== 'object') {
    throw new Error(`${label} must contain only JSON-compatible values`)
  }
  if (seen.has(value)) throw new Error(`${label} must not contain cycles`)
  seen.add(value)
  if (Array.isArray(value)) {
    for (const child of value) {
      if (child === undefined) {
        throw new Error(`${label} arrays must not contain undefined values`)
      }
      assertDurableValue(child, label, seen)
    }
  } else {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} must contain only plain objects`)
    }
    for (const child of Object.values(value)) assertDurableValue(child, label, seen)
  }
  seen.delete(value)
}

function cloneDurableValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((child) => cloneDurableValue(child)) as T
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, cloneDurableValue(child)]),
  ) as T
}
