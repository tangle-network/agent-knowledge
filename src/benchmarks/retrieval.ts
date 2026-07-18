import type { RetrievalGoldTarget } from '../retrieval-eval'

import type {
  BuildRetrievalBenchmarkCasesFromQrelsOptions,
  KnowledgeRetrievalBenchmarkCase,
  KnowledgeRetrievalBenchmarkQrel,
} from './types'

import { compactObject, unique } from './utils'

export function parseKnowledgeBenchmarkJsonl<T = unknown>(text: string): T[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as T
      } catch (error) {
        throw new Error(`invalid JSONL row ${index + 1}: ${(error as Error).message}`)
      }
    })
}

export function parseKnowledgeBenchmarkQrels(text: string): KnowledgeRetrievalBenchmarkQrel[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .flatMap((line, index) => {
      const parts = line.split(/\t|\s+/)
      if (parts.length < 3) return []
      const [queryId, maybeZeroOrDocId, maybeDocIdOrScore, maybeScore] = parts
      if (!queryId || !maybeZeroOrDocId || !maybeDocIdOrScore) return []
      if (queryId.toLowerCase() === 'qid' || queryId.toLowerCase() === 'query-id') return []
      const documentId = maybeScore === undefined ? maybeZeroOrDocId : maybeDocIdOrScore
      const scoreText = maybeScore === undefined ? maybeDocIdOrScore : maybeScore
      const score = Number(scoreText)
      if (!documentId || !Number.isFinite(score)) {
        throw new Error(`invalid qrels row ${index + 1}: expected query id, doc id, score`)
      }
      return [{ queryId, documentId, score }]
    })
}

export function buildRetrievalBenchmarkCasesFromQrels(
  options: BuildRetrievalBenchmarkCasesFromQrelsOptions,
): KnowledgeRetrievalBenchmarkCase[] {
  const qrelsByQuery = new Map<string, KnowledgeRetrievalBenchmarkQrel[]>()
  for (const qrel of options.qrels) {
    if (qrel.score <= 0) continue
    const list = qrelsByQuery.get(qrel.queryId) ?? []
    list.push(qrel)
    qrelsByQuery.set(qrel.queryId, list)
  }

  return options.queries.flatMap((query) => {
    const qrels = qrelsByQuery.get(query.id) ?? []
    if (qrels.length === 0) return []
    const split = query.split ?? options.splitOf?.(query.id)
    const expected = qrels.map((qrel) =>
      options.documentTarget
        ? options.documentTarget(qrel.documentId, qrel)
        : defaultDocumentTarget(qrel.documentId, options.targetKind ?? 'page'),
    )
    return [
      compactObject({
        id: `${options.benchmarkId}:${query.id}`,
        family: options.family,
        taskKind: 'retrieval' as const,
        query: query.text,
        expected,
        k: options.k,
        split,
        tags: unique([...(options.tags ?? []), ...(query.tags ?? []), ...(split ? [split] : [])]),
        source: options.source,
        metadata: query.metadata,
      }) as KnowledgeRetrievalBenchmarkCase,
    ]
  })
}

function defaultDocumentTarget(
  documentId: string,
  targetKind: 'page' | 'page-path' | 'source',
): RetrievalGoldTarget {
  switch (targetKind) {
    case 'page':
      return { kind: 'page', pageId: documentId }
    case 'page-path':
      return { kind: 'page-path', path: documentId }
    case 'source':
      return { kind: 'source', sourceId: documentId }
  }
}
