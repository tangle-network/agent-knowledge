import type {
  KnowledgeId,
  KnowledgeIndex,
  KnowledgePage,
  KnowledgeSearchResult,
} from './types'

const RRF_K = 60
const STOP_WORDS = new Set([
  'the',
  'is',
  'a',
  'an',
  'what',
  'how',
  'are',
  'was',
  'were',
  'to',
  'for',
  'of',
  'with',
  'by',
  'in',
  'on',
  'and',
])

export interface SearchKnowledgeOptions {
  /** Maximum results returned. Defaults to 10. */
  limit?: number
  /** Match pages whose stable id is one of these values. */
  pageIds?: readonly KnowledgeId[]
  /** Match pages carrying at least one of these tags. */
  tags?: readonly string[]
  /** Match the exact string stored in `frontmatter.kind`. */
  kinds?: readonly string[]
  /** Additional caller-owned filter, applied before either ranking stage. */
  predicate?: (page: KnowledgePage) => boolean
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
  const tokenRanked = rankByTokens(pages, trimmed)
  const graphRanked = rankByGraph(pages, tokenRanked)
  const scores = reciprocalRankFusion([tokenRanked.map((p) => p.id), graphRanked.map((p) => p.id)])
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

export function tokenizeQuery(query: string): string[] {
  const raw = query
    .toLowerCase()
    .split(/[\s,，。！？、；：""''（）()\-_/\\·~～…]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
  const tokens: string[] = []
  for (const token of raw) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(token) && token.length > 2) {
      const chars = [...token]
      for (let i = 0; i < chars.length - 1; i++) tokens.push(chars[i]! + chars[i + 1]!)
      tokens.push(...chars)
    }
    tokens.push(token)
  }
  return [...new Set(tokens)]
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
    if (pageIds && !pageIds.has(page.id)) return false
    if (tags && !page.tags.some((tag) => tags.has(tag))) return false
    if (kinds) {
      const kind = page.frontmatter.kind
      if (typeof kind !== 'string' || !kinds.has(kind)) return false
    }
    return options.predicate?.(page) ?? true
  })
}

function rankByTokens(pages: KnowledgePage[], query: string): KnowledgePage[] {
  const tokens = tokenizeQuery(query)
  const effective = tokens.length > 0 ? tokens : [query.toLowerCase()]
  return pages
    .map((page) => ({ page, score: tokenScore(page, query, effective) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.page.path.localeCompare(b.page.path))
    .map((item) => item.page)
}

function rankByGraph(pages: KnowledgePage[], tokenRanked: KnowledgePage[]): KnowledgePage[] {
  if (tokenRanked.length === 0) return []
  const seeds = new Set(tokenRanked.slice(0, 5).map((page) => page.id))
  return pages
    .map((page) => ({
      page,
      score:
        page.outLinks.filter((link) => seeds.has(link)).length +
        page.sourceIds.filter((source) =>
          tokenRanked.some((seed) => seed.sourceIds.includes(source)),
        ).length,
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.page.path.localeCompare(b.page.path))
    .map((item) => item.page)
}

function tokenScore(page: KnowledgePage, query: string, tokens: string[]): number {
  const title = page.title.toLowerCase()
  const path = page.path.toLowerCase()
  const body = page.text.toLowerCase()
  const phrase = query.toLowerCase()
  let score = 0
  if (path.endsWith(`${phrase}.md`) || title === phrase) score += 200
  if (title.includes(phrase)) score += 50
  if (body.includes(phrase)) score += 20
  for (const token of tokens) {
    if (title.includes(token)) score += 5
    if (body.includes(token)) score += 1
    if (path.includes(token)) score += 3
  }
  return score
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
