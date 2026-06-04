import { memoryHitToSourceRecord } from './source-record'
import type {
  AgentMemoryAdapter,
  AgentMemoryContext,
  AgentMemoryHit,
  AgentMemorySearchOptions,
} from './types'

export async function defaultGetMemoryContext(
  adapter: Pick<AgentMemoryAdapter, 'search'>,
  query: string,
  options: AgentMemorySearchOptions = {},
): Promise<AgentMemoryContext> {
  const hits = await adapter.search(query, options)
  return {
    query,
    hits,
    sourceRecords: hits.map((hit) => memoryHitToSourceRecord(hit, { scope: options.scope })),
    text: renderMemoryContext(hits),
  }
}

export function renderMemoryContext(hits: AgentMemoryHit[]): string {
  return hits
    .map((hit, index) => {
      const label = hit.title ?? `${hit.kind}:${hit.id}`
      const score =
        typeof hit.normalizedScore === 'number' ? ` score=${hit.normalizedScore.toFixed(3)}` : ''
      return [`[${index + 1}] ${label}${score}`, hit.text].join('\n')
    })
    .join('\n\n')
}
