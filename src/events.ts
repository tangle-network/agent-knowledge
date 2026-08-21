import { stableId } from './ids'
import type { KnowledgeEvent, KnowledgeEventType } from './types'

export interface KnowledgeEventQuery {
  type?: KnowledgeEventType
  target?: string
  limit?: number
}

export function createKnowledgeEvent(input: {
  type: KnowledgeEventType
  actor?: string
  target?: string
  metadata?: Record<string, unknown>
  now?: () => Date
}): KnowledgeEvent {
  const createdAt = (input.now ?? (() => new Date()))().toISOString()
  return {
    id: stableId(
      'evt',
      `${input.type}:${input.target ?? ''}:${createdAt}:${JSON.stringify(input.metadata ?? {})}`,
    ),
    type: input.type,
    createdAt,
    // An absent optional is omitted, never written as `undefined`. An event
    // reaches canonical JSON — through a control-loop state fingerprint and
    // through the event log — and that encoder refuses a key with no value.
    ...(input.actor === undefined ? {} : { actor: input.actor }),
    ...(input.target === undefined ? {} : { target: input.target }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  }
}
