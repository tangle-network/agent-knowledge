import type { KnowledgeEvent, KnowledgeEventType } from './types'
import { stableId } from './ids'

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
    id: stableId('evt', `${input.type}:${input.target ?? ''}:${createdAt}:${JSON.stringify(input.metadata ?? {})}`),
    type: input.type,
    createdAt,
    actor: input.actor,
    target: input.target,
    metadata: input.metadata,
  }
}
