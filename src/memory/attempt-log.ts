import type { CampaignStorage, CostLedgerHandle } from '@tangle-network/agent-eval/campaign'

export interface AttemptJournalEvent {
  status: 'started' | 'cleaned'
  recordedAt: string
}

interface RecoveryAttemptEvent {
  attemptId: string
  generation: number
  recordedAt: string
}

const journalByteLengths = new WeakMap<CampaignStorage, Map<string, number>>()

export const DEFAULT_MEMORY_RECOVERY_RETRIES_PER_ATTEMPT = 3

const MEMORY_PROVIDER_ACTOR_PREFIXES = [
  'agent-knowledge:memory-adapter:',
  'agent-knowledge:memory-adapter-recovery:',
  'agent-knowledge:memory-experiment:',
  'agent-knowledge:memory-recovery:',
] as const

export function reconcileInterruptedMemoryPaidCalls(costLedger: CostLedgerHandle): void {
  reconcileInterruptedPaidCallsAtMaximum(
    costLedger,
    (actor) => isMemoryProviderActor(actor),
    'external memory provider',
  )
}

export function reconcileInterruptedRunPaidCalls(
  costLedger: CostLedgerHandle,
  label: string,
): void {
  reconcileInterruptedPaidCallsAtMaximum(costLedger, () => true, label)
}

function reconcileInterruptedPaidCallsAtMaximum(
  costLedger: CostLedgerHandle,
  ownsActor: (actor: string) => boolean,
  label: string,
): void {
  if (costLedger.summary().unresolvedCalls === 0) return
  const pending = requirePendingCostCallInspection(costLedger)
  for (const call of pending) {
    if (call.state !== 'interrupted' || !ownsActor(call.actor)) continue
    if (call.maximumCostUsd === undefined) {
      throw new Error(
        `cannot recover unbounded interrupted ${label} call '${call.callId}' for '${call.actor}'`,
      )
    }
    try {
      costLedger.reconcile(
        call.callId,
        {
          model: call.model,
          inputTokens: 0,
          outputTokens: 0,
          actualCostUsd: call.maximumCostUsd,
        },
        {
          error: `process exited before the ${label} receipt for '${call.actor}' was recorded; charged the reserved maximum`,
        },
      )
    } catch (error) {
      if (isMissingPendingCostCall(error, call.callId)) continue
      throw error
    }
  }
}

export function assertNoInterruptedPaidCalls(costLedger: CostLedgerHandle, label: string): void {
  const unresolved = costLedger.summary().unresolvedCalls
  if (unresolved === 0) return
  const pending = requirePendingCostCallInspection(costLedger)
  const blocked = pending.filter((call) => call.state !== 'active')
  throw new Error(
    `${label} has ${unresolved} unresolved paid call(s) that cannot be resumed: ${blocked
      .map((call) => `${call.callId} (${call.actor}, ${call.state})`)
      .join(', ')}`,
  )
}

export function hasSettledPaidCall(costLedger: CostLedgerHandle, callId: string): boolean {
  return costLedger.list().some((receipt) => receipt.callId === callId)
}

export function appendAttemptJournalEvent<TEvent extends AttemptJournalEvent>(input: {
  storage: CampaignStorage
  path: string
  event: TEvent
  label: string
}): void {
  appendDurableJournalEvent(input)
}

export function appendDurableJournalEvent<TEvent extends object>(input: {
  storage: CampaignStorage
  path: string
  event: TEvent
  label: string
}): void {
  const { storage, path, event, label } = input
  if (!storage.append) throw new Error(`${label} requires CampaignStorage.append`)
  const line = `${JSON.stringify(event)}\n`
  const byteLengths = journalByteLengths.get(storage) ?? new Map<string, number>()
  journalByteLengths.set(storage, byteLengths)
  for (let retry = 0; retry < 100; retry += 1) {
    let expectedBytes = byteLengths.get(path)
    if (expectedBytes === undefined) {
      const current = storage.read(path)
      if (current === undefined && storage.exists(path)) {
        throw new Error(`cannot read ${label} '${path}'`)
      }
      expectedBytes = new TextEncoder().encode(current ?? '').byteLength
      byteLengths.set(path, expectedBytes)
    }
    const appendedBytes = storage.append(path, line, expectedBytes)
    if (appendedBytes !== undefined) {
      byteLengths.set(path, appendedBytes)
      return
    }
    byteLengths.delete(path)
  }
  throw new Error(`${label} '${path}' remained contended after 100 retries`)
}

/** Reserves one durable recovery generation per attempt before provider work starts. */
export function reserveRecoveryAttempts(input: {
  storage: CampaignStorage
  path: string
  attemptIds: readonly string[]
  maxRetriesPerAttempt: number
  label: string
  now?: () => Date
}): ReadonlyMap<string, number> {
  const { storage, path, attemptIds, maxRetriesPerAttempt, label } = input
  if (!Number.isSafeInteger(maxRetriesPerAttempt) || maxRetriesPerAttempt <= 0) {
    throw new Error(`${label} maxRetriesPerAttempt must be a positive safe integer`)
  }
  const uniqueAttemptIds = new Set(attemptIds)
  if (uniqueAttemptIds.size !== attemptIds.length || attemptIds.some((id) => !id.trim())) {
    throw new Error(`${label} attempt ids must be unique non-empty strings`)
  }
  const generations = readRecoveryAttemptGenerations(storage, path, label)
  for (const attemptId of attemptIds) {
    const prior = generations.get(attemptId) ?? 0
    if (prior >= maxRetriesPerAttempt) {
      throw new Error(
        `${label} '${attemptId}' exhausted ${maxRetriesPerAttempt} recovery attempts; increase maxRecoveryRetriesPerAttempt only after inspecting provider state`,
      )
    }
  }
  const reserved = new Map<string, number>()
  for (const attemptId of attemptIds) {
    const generation = (generations.get(attemptId) ?? 0) + 1
    appendDurableJournalEvent({
      storage,
      path,
      label,
      event: {
        attemptId,
        generation,
        recordedAt: (input.now ?? (() => new Date()))().toISOString(),
      } satisfies RecoveryAttemptEvent,
    })
    generations.set(attemptId, generation)
    reserved.set(attemptId, generation)
  }
  return reserved
}

export function readActiveAttemptJournal<TEvent extends AttemptJournalEvent>(input: {
  storage: CampaignStorage
  path: string
  label: string
  parse(value: unknown, path: string, line: number): TEvent
  id(event: TEvent): string
  sameAttempt(left: TEvent, right: TEvent): boolean
}): TEvent[] {
  const { storage, path, label, parse, id, sameAttempt } = input
  const stored = storage.read(path)
  if (stored === undefined) {
    if (storage.exists(path)) throw new Error(`cannot read ${label} '${path}'`)
    return []
  }
  const active = new Map<string, TEvent>()
  const completed = new Map<string, TEvent>()
  for (const [index, line] of stored.split('\n').entries()) {
    if (!line) continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch (error) {
      throw new Error(`invalid ${label} '${path}' line ${index + 1}`, { cause: error })
    }
    const event = parse(raw, path, index + 1)
    const attemptId = id(event)
    if (event.status === 'started') {
      if (active.has(attemptId) || completed.has(attemptId)) {
        throw new Error(`${label} '${path}' repeats attempt '${attemptId}'`)
      }
      active.set(attemptId, event)
      continue
    }

    const started = active.get(attemptId)
    if (started && sameAttempt(started, event)) {
      active.delete(attemptId)
      completed.set(attemptId, started)
      continue
    }

    const prior = completed.get(attemptId)
    if (prior && sameAttempt(prior, event)) continue
    throw new Error(`${label} '${path}' has an unmatched cleanup for '${attemptId}'`)
  }
  return [...active.values()]
}

function readRecoveryAttemptGenerations(
  storage: CampaignStorage,
  path: string,
  label: string,
): Map<string, number> {
  const stored = storage.read(path)
  if (stored === undefined) {
    if (storage.exists(path)) throw new Error(`cannot read ${label} '${path}'`)
    return new Map()
  }
  const generations = new Map<string, number>()
  for (const [index, line] of stored.split('\n').entries()) {
    if (!line) continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch (error) {
      throw new Error(`invalid ${label} '${path}' line ${index + 1}`, { cause: error })
    }
    const event = parseRecoveryAttemptEvent(raw, path, index + 1, label)
    const expected = (generations.get(event.attemptId) ?? 0) + 1
    if (event.generation !== expected) {
      throw new Error(
        `${label} '${path}' has recovery generation ${event.generation} for '${event.attemptId}', expected ${expected}`,
      )
    }
    generations.set(event.attemptId, event.generation)
  }
  return generations
}

function parseRecoveryAttemptEvent(
  value: unknown,
  path: string,
  line: number,
  label: string,
): RecoveryAttemptEvent {
  const event = value as Partial<RecoveryAttemptEvent> | null
  const valid =
    typeof event === 'object' &&
    event !== null &&
    typeof event.attemptId === 'string' &&
    event.attemptId.length > 0 &&
    Number.isSafeInteger(event.generation) &&
    event.generation! > 0 &&
    typeof event.recordedAt === 'string' &&
    !Number.isNaN(Date.parse(event.recordedAt))
  if (!valid) throw new Error(`invalid ${label} '${path}' line ${line}`)
  return value as RecoveryAttemptEvent
}

function isMissingPendingCostCall(error: unknown, callId: string): boolean {
  return error instanceof Error && error.message === `CostLedger: no pending call '${callId}'`
}

function requirePendingCostCallInspection(costLedger: CostLedgerHandle) {
  if (!costLedger.listPending) {
    throw new Error('interrupted memory recovery requires CostLedger.listPending() support')
  }
  return costLedger.listPending()
}

function isMemoryProviderActor(actor: string): boolean {
  return MEMORY_PROVIDER_ACTOR_PREFIXES.some((prefix) => actor.startsWith(prefix))
}
