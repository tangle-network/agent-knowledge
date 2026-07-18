import type { CampaignStorage } from '@tangle-network/agent-eval/campaign'
import { appendDurableJournalEvent } from '../attempt-log'
import type { AgentMemoryActivationEvent, AgentMemoryActivationJournalState } from './types'

export function appendMemoryActivationEvent(
  storage: CampaignStorage,
  path: string,
  event: AgentMemoryActivationEvent,
): void {
  appendDurableJournalEvent({
    storage,
    path,
    event,
    label: 'memory activation journal',
  })
}

export function readMemoryActivationJournal(
  storage: CampaignStorage,
  path: string,
  expected: Omit<AgentMemoryActivationEvent, 'status' | 'recordedAt' | 'outcome'>,
): AgentMemoryActivationJournalState {
  const stored = storage.read(path)
  if (stored === undefined) {
    if (storage.exists(path)) throw new Error(`cannot read memory activation journal '${path}'`)
    return { prepared: false }
  }
  let prepared = false
  let activated: AgentMemoryActivationEvent | undefined
  for (const [index, line] of stored.split('\n').entries()) {
    if (!line) continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch (error) {
      throw new Error(`invalid memory activation journal '${path}' line ${index + 1}`, {
        cause: error,
      })
    }
    const event = parseMemoryActivationEvent(raw, path, index + 1, expected)
    if (event.status === 'prepared') {
      if (prepared || activated) {
        throw new Error(`memory activation journal '${path}' repeats its prepared event`)
      }
      prepared = true
      continue
    }
    if (!prepared || activated) {
      throw new Error(`memory activation journal '${path}' has an out-of-order activated event`)
    }
    activated = event
  }
  return { prepared, ...(activated ? { activated } : {}) }
}

function parseMemoryActivationEvent(
  value: unknown,
  path: string,
  line: number,
  expected: Omit<AgentMemoryActivationEvent, 'status' | 'recordedAt' | 'outcome'>,
): AgentMemoryActivationEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid memory activation journal '${path}' line ${line}`)
  }
  const event = value as Record<string, unknown>
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (event[key] !== expectedValue) {
      throw new Error(
        `memory activation journal '${path}' line ${line} does not match the measured winner`,
      )
    }
  }
  if (event.status !== 'prepared' && event.status !== 'activated') {
    throw new Error(`invalid memory activation journal '${path}' line ${line} status`)
  }
  if (typeof event.recordedAt !== 'string' || !Number.isFinite(Date.parse(event.recordedAt))) {
    throw new Error(`invalid memory activation journal '${path}' line ${line} recordedAt`)
  }
  if (
    event.status === 'activated' &&
    event.outcome !== 'applied' &&
    event.outcome !== 'recovered' &&
    event.outcome !== 'already-current'
  ) {
    throw new Error(`invalid memory activation journal '${path}' line ${line} outcome`)
  }
  if (event.status === 'prepared' && event.outcome !== undefined) {
    throw new Error(`invalid memory activation journal '${path}' line ${line} prepared outcome`)
  }
  return value as AgentMemoryActivationEvent
}
