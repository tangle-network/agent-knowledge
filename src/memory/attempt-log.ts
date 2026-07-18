import type { CampaignStorage, CostLedgerHandle } from '@tangle-network/agent-eval/campaign'

export interface AttemptJournalEvent {
  status: 'started' | 'cleaned'
  recordedAt: string
}

const journalByteLengths = new WeakMap<CampaignStorage, Map<string, number>>()

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

function isMissingPendingCostCall(error: unknown, callId: string): boolean {
  return error instanceof Error && error.message === `CostLedger: no pending call '${callId}'`
}

function requirePendingCostCallInspection(costLedger: CostLedgerHandle) {
  if (!costLedger.listPending) {
    throw new Error(
      'interrupted memory recovery requires CostLedger.listPending() from @tangle-network/agent-eval 0.122.8 or newer',
    )
  }
  return costLedger.listPending()
}

function isMemoryProviderActor(actor: string): boolean {
  return MEMORY_PROVIDER_ACTOR_PREFIXES.some((prefix) => actor.startsWith(prefix))
}
