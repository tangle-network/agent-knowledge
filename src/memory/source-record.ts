import { sha256, stableId } from '../ids'
import type { SourceRecord } from '../types'
import type { AgentMemoryHit, AgentMemoryScope, AgentMemoryWriteResult } from './types'

export function memoryHitToSourceRecord(
  hit: AgentMemoryHit,
  options: { now?: () => Date; scope?: AgentMemoryScope } = {},
): SourceRecord {
  const contentHash = sha256(`${hit.uri}\n${hit.text}`)
  return {
    id: stableId('src', `${hit.uri}:${contentHash}`),
    uri: hit.uri,
    title: hit.title ?? `${hit.kind}:${hit.id}`,
    mediaType: 'text/plain',
    contentHash,
    text: hit.text,
    validUntil: hit.validUntil,
    lastVerifiedAt: hit.lastVerifiedAt,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    metadata: {
      ...(hit.metadata ?? {}),
      source: 'agent-memory',
      memoryId: hit.id,
      memoryKind: hit.kind,
      score: hit.score,
      normalizedScore: hit.normalizedScore,
      confidence: hit.confidence,
      scope: options.scope,
    },
  }
}

export function memoryWriteResultToSourceRecord(
  result: AgentMemoryWriteResult,
  text: string,
  options: { now?: () => Date; scope?: AgentMemoryScope } = {},
): SourceRecord {
  return memoryHitToSourceRecord(
    {
      id: result.id,
      uri: result.uri,
      kind: result.kind,
      text,
      metadata: result.metadata,
    },
    options,
  )
}
