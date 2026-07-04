import { applySessionStickyRetrievalHoldout } from './holdout'
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
  // The holdout applies between search (eligibility set) and render (delivered set), and only
  // when explicitly configured: the unconfigured path must stay byte-identical, including
  // hit-array identity, so default behavior cannot drift.
  const delivered = options.holdout
    ? applySessionStickyRetrievalHoldout(hits, options.holdout, {
        query,
        ...(options.scope !== undefined ? { scope: options.scope } : {}),
        ...(options.scope?.tags?.taskId !== undefined ? { taskId: options.scope.tags.taskId } : {}),
      }).delivered
    : hits
  return {
    query,
    hits: delivered,
    sourceRecords: delivered.map((hit) => memoryHitToSourceRecord(hit, { scope: options.scope })),
    text: renderMemoryContext(delivered),
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
