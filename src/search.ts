import { buildKnowledgeLexicalIndex, type KnowledgeLexicalIndex, scoreBm25 } from './lexical-index'
import type { KnowledgeId, KnowledgeIndex, KnowledgePage, KnowledgeSearchResult } from './types'

const RRF_K = 60

/**
 * Identity of the ranking `searchKnowledge` performs: BM25 over title, path,
 * and body, exact-title and phrase matches ahead of bag-of-words matches, and
 * reciprocal rank fusion with link and shared-source structure. Declare it as
 * the retriever id of a retrieval receipt minted from these results.
 */
export const KNOWLEDGE_SEARCH_RETRIEVER_ID = 'bm25-rrf-v1'

export interface SearchKnowledgeOptions {
  /** Maximum results returned. Defaults to 10. */
  limit?: number
  /** Match pages whose stable id is one of these values. */
  pageIds?: readonly KnowledgeId[]
  /** Match pages carrying at least one of these tags. */
  tags?: readonly string[]
  /** Match the exact string stored in `frontmatter.kind`. */
  kinds?: readonly string[]
  /**
   * Drop pages whose own evidence refuted them. Defaults to false: a caller
   * that reads history needs them, and a silent change of what search returns
   * is worse than an explicit option.
   */
  excludeInvalidated?: boolean
  /** Additional caller-owned filter, applied before either ranking stage. */
  predicate?: (page: KnowledgePage) => boolean
  /**
   * A lexical index built from exactly `index.pages`, supplied by a caller that
   * searches one index repeatedly. When absent, one is built for this call.
   */
  lexicalIndex?: KnowledgeLexicalIndex
}

/**
 * A retrieval result with an explicit citation handle.
 *
 * `citationId` is exactly `page.id`; later writes should persist this value
 * when they cite the page. Keeping it at the result's top level prevents tool
 * renderers from accidentally hiding the only stable handle a model can copy.
 */
export interface KnowledgeSearchHit extends KnowledgeSearchResult {
  citationId: KnowledgeId
}

export function searchKnowledge(
  index: KnowledgeIndex,
  query: string,
  limit?: number,
): KnowledgeSearchHit[]
export function searchKnowledge(
  index: KnowledgeIndex,
  query: string,
  options?: SearchKnowledgeOptions,
): KnowledgeSearchHit[]
export function searchKnowledge(
  index: KnowledgeIndex,
  query: string,
  limitOrOptions: number | SearchKnowledgeOptions = 10,
): KnowledgeSearchHit[] {
  const trimmed = query.trim()
  if (trimmed === '') return []
  const options =
    typeof limitOrOptions === 'number' ? { limit: limitOrOptions } : { ...limitOrOptions }
  const limit = options.limit ?? 10
  if (!Number.isInteger(limit) || limit < 0) {
    throw new Error(`search limit must be a non-negative integer, got ${String(limit)}`)
  }

  const pages = filterPages(index.pages, options)
  const lexicalIndex = options.lexicalIndex
    ? assertLexicalIndexMatches(options.lexicalIndex, index)
    : buildKnowledgeLexicalIndex(index.pages)
  const lexicalRanked = rankLexical(pages, trimmed, lexicalIndex)
  const graphRanked = rankByGraph(pages, lexicalRanked)
  const scores = reciprocalRankFusion([
    lexicalRanked.map((p) => p.id),
    graphRanked.map((p) => p.id),
  ])
  const byId = new Map(pages.map((page) => [page.id, page]))

  const ranked = [...scores.entries()]
    .map(([id, score]) => ({ page: byId.get(id), score }))
    .filter((item): item is { page: KnowledgePage; score: number } => Boolean(item.page))
    .sort((a, b) => b.score - a.score || a.page.path.localeCompare(b.page.path))
    .slice(0, limit)

  // Normalize against the top hit so callers can compare against natural
  // [0, 1] thresholds. Raw RRF values are typically ~0.016, which reads as
  // "no relevance" to humans even when the result is the best available.
  // The top hit becomes 1 by definition; lower-ranked hits scale linearly.
  const topScore = ranked[0]?.score ?? 0

  return ranked.map((item, i) => ({
    citationId: item.page.id,
    page: item.page,
    score: item.score,
    rrfScore: item.score,
    normalizedScore: topScore > 0 ? item.score / topScore : 0,
    rank: i + 1,
    snippet: buildSnippet(item.page.text, trimmed),
    reasons: reasonsFor(item.page, trimmed),
  }))
}

export function reciprocalRankFusion(rankLists: string[][], k = RRF_K): Map<string, number> {
  const scores = new Map<string, number>()
  for (const list of rankLists) {
    list.forEach((id, idx) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + idx + 1))
    })
  }
  return scores
}

function filterPages(pages: KnowledgePage[], options: SearchKnowledgeOptions): KnowledgePage[] {
  const pageIds = options.pageIds ? new Set(options.pageIds) : null
  const tags = options.tags ? new Set(options.tags) : null
  const kinds = options.kinds ? new Set(options.kinds) : null

  return pages.filter((page) => {
    if (options.excludeInvalidated && page.invalidation !== undefined) return false
    if (pageIds && !pageIds.has(page.id)) return false
    if (tags && !page.tags.some((tag) => tags.has(tag))) return false
    if (kinds) {
      const kind = page.frontmatter.kind
      if (typeof kind !== 'string' || !kinds.has(kind)) return false
    }
    return options.predicate?.(page) ?? true
  })
}

function assertLexicalIndexMatches(
  lexicalIndex: KnowledgeLexicalIndex,
  index: KnowledgeIndex,
): KnowledgeLexicalIndex {
  if (
    lexicalIndex.pages.length !== index.pages.length ||
    lexicalIndex.pages.some((page, ordinal) => page !== index.pages[ordinal])
  ) {
    throw new Error('lexical index was not built from the pages of the searched index')
  }
  return lexicalIndex
}

/**
 * The lexical rank list. An exact title or path match outranks a title that
 * contains the query, which outranks a body that contains the query, which
 * outranks a bag-of-words match; BM25 orders pages inside each of those tiers.
 * The tiers are an ordering, not a score, so a strong bag-of-words page cannot
 * overtake an exact match by term repetition alone.
 */
function rankLexical(
  pages: KnowledgePage[],
  query: string,
  lexicalIndex: KnowledgeLexicalIndex,
): KnowledgePage[] {
  const tokens = [...new Set(lexicalIndex.tokenize(query))]
  const bm25 = new Map(scoreBm25(lexicalIndex, tokens).map((hit) => [hit.page, hit.score]))
  const phrase = query.toLowerCase()
  return pages
    .flatMap((page) => {
      const score = bm25.get(page) ?? 0
      // A query that tokenizes to nothing (stop words, single characters) can
      // still match as a phrase; otherwise only pages with a scored term are
      // candidates, and every phrase match is one of them.
      if (score === 0 && tokens.length > 0) return []
      const tier = phraseTier(page, phrase)
      if (score === 0 && tier === 0) return []
      return [{ page, tier, score }]
    })
    .sort((a, b) => b.tier - a.tier || b.score - a.score || a.page.path.localeCompare(b.page.path))
    .map((item) => item.page)
}

function phraseTier(page: KnowledgePage, phrase: string): number {
  const title = page.title.toLowerCase()
  if (title === phrase || page.path.toLowerCase().endsWith(`${phrase}.md`)) return 3
  if (title.includes(phrase)) return 2
  if (page.text.toLowerCase().includes(phrase)) return 1
  return 0
}

function rankByGraph(pages: KnowledgePage[], lexicalRanked: KnowledgePage[]): KnowledgePage[] {
  if (lexicalRanked.length === 0) return []
  const seeds = new Set(lexicalRanked.slice(0, 5).map((page) => page.id))
  return pages
    .map((page) => ({
      page,
      score:
        page.outLinks.filter((link) => seeds.has(link)).length +
        page.sourceIds.filter((source) =>
          lexicalRanked.some((seed) => seed.sourceIds.includes(source)),
        ).length,
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.page.path.localeCompare(b.page.path))
    .map((item) => item.page)
}

function buildSnippet(text: string, query: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  const idx = compact.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) return compact.slice(0, 180)
  return compact.slice(Math.max(0, idx - 80), Math.min(compact.length, idx + query.length + 100))
}

function reasonsFor(page: KnowledgePage, query: string): string[] {
  const lower = `${page.title}\n${page.text}`.toLowerCase()
  const reasons: string[] = []
  if (lower.includes(query.toLowerCase())) reasons.push('phrase')
  if (page.sourceIds.length > 0) reasons.push('sourced')
  if (page.outLinks.length > 0) reasons.push('linked')
  return reasons
}
