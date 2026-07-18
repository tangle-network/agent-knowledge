import type { CampaignStorage } from '@tangle-network/agent-eval/campaign'

export interface AttemptJournalEvent {
  status: 'started' | 'cleaned'
  recordedAt: string
}

export function appendAttemptJournalEvent<TEvent extends AttemptJournalEvent>(input: {
  storage: CampaignStorage
  path: string
  event: TEvent
  label: string
}): void {
  const { storage, path, event, label } = input
  if (!storage.append) throw new Error(`${label} requires CampaignStorage.append`)
  const line = `${JSON.stringify(event)}\n`
  for (let retry = 0; retry < 100; retry += 1) {
    const current = storage.read(path)
    if (current === undefined && storage.exists(path)) {
      throw new Error(`cannot read ${label} '${path}'`)
    }
    const expectedBytes = new TextEncoder().encode(current ?? '').byteLength
    if (storage.append(path, line, expectedBytes) !== undefined) return
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
