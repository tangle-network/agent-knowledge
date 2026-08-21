import type { KnowledgePage } from './types'

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

/**
 * The token stream of one text: lower-cased, split on whitespace and
 * punctuation, single characters and stop words removed, and a CJK run
 * expanded into its bigrams and characters. Repeats are kept so a term
 * frequency can be counted. Indexing and querying share this function, so the
 * two vocabularies cannot drift.
 */
export function tokenizeText(text: string): string[] {
  const raw = text
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
  return tokens
}

/** The distinct query terms, in first-occurrence order. */
export function tokenizeQuery(query: string): string[] {
  return [...new Set(tokenizeText(query))]
}

export interface KnowledgeLexicalFieldBoosts {
  /** Multiplier for a term occurrence in the page title. Defaults to 3. */
  title?: number
  /** Multiplier for a term occurrence in the page path without its extension. Defaults to 2. */
  path?: number
  /** Multiplier for a term occurrence in the page body. Defaults to 1. */
  text?: number
}

export interface KnowledgeLexicalIndexOptions {
  /** Token stream of one text. Defaults to `tokenizeText`. */
  tokenize?: (text: string) => string[]
  fieldBoosts?: KnowledgeLexicalFieldBoosts
}

export interface KnowledgeLexicalPosting {
  /** Position of the page in `KnowledgeLexicalIndex.pages`. */
  ordinal: number
  /** Field-boosted term frequency in that page. */
  tf: number
}

/**
 * Inverted index over a fixed page list.
 *
 * Ordinals are positions in `pages`. `documentLengths` are field-boosted token
 * counts, so length normalization and term frequency use one scale.
 */
export interface KnowledgeLexicalIndex {
  readonly pages: readonly KnowledgePage[]
  readonly postings: ReadonlyMap<string, readonly KnowledgeLexicalPosting[]>
  readonly documentLengths: readonly number[]
  readonly averageDocumentLength: number
  readonly documentCount: number
  readonly tokenize: (text: string) => string[]
  readonly fieldBoosts: Readonly<Required<KnowledgeLexicalFieldBoosts>>
}

export interface Bm25Options {
  /** Term-frequency saturation. Defaults to 1.2. */
  k1?: number
  /** Length-normalization strength in [0, 1]. Defaults to 0.75. */
  b?: number
}

export interface Bm25Hit {
  page: KnowledgePage
  score: number
}

const DEFAULT_FIELD_BOOSTS: Readonly<Required<KnowledgeLexicalFieldBoosts>> = Object.freeze({
  title: 3,
  path: 2,
  text: 1,
})

export function buildKnowledgeLexicalIndex(
  pages: readonly KnowledgePage[],
  options: KnowledgeLexicalIndexOptions = {},
): KnowledgeLexicalIndex {
  const tokenize = options.tokenize ?? tokenizeText
  const fieldBoosts = resolveFieldBoosts(options.fieldBoosts)
  const postings = new Map<string, KnowledgeLexicalPosting[]>()
  const documentLengths: number[] = []
  let totalLength = 0

  pages.forEach((page, ordinal) => {
    const frequencies = new Map<string, number>()
    let length = 0
    for (const [text, boost] of [
      [page.title, fieldBoosts.title],
      [page.path.replace(/\.md$/, ''), fieldBoosts.path],
      [page.text, fieldBoosts.text],
    ] as const) {
      if (boost === 0) continue
      for (const token of tokenize(text)) {
        frequencies.set(token, (frequencies.get(token) ?? 0) + boost)
        length += boost
      }
    }
    documentLengths.push(length)
    totalLength += length
    for (const [term, tf] of frequencies) {
      let list = postings.get(term)
      if (!list) {
        list = []
        postings.set(term, list)
      }
      list.push({ ordinal, tf })
    }
  })

  return {
    pages,
    postings,
    documentLengths,
    averageDocumentLength: pages.length > 0 ? totalLength / pages.length : 0,
    documentCount: pages.length,
    tokenize,
    fieldBoosts,
  }
}

/**
 * Okapi BM25 over the distinct query terms, with the Lucene inverse document
 * frequency `ln(1 + (N - df + 0.5) / (df + 0.5))`, which is positive for every
 * indexed term. Pages with no matching term are absent. The result is ordered
 * by score, then by path, so it does not depend on page order.
 */
export function scoreBm25(
  index: KnowledgeLexicalIndex,
  tokens: readonly string[],
  options: Bm25Options = {},
): Bm25Hit[] {
  const k1 = options.k1 ?? 1.2
  const b = options.b ?? 0.75
  if (!Number.isFinite(k1) || k1 < 0) throw new Error(`bm25 k1 must be >= 0, got ${String(k1)}`)
  if (!Number.isFinite(b) || b < 0 || b > 1) {
    throw new Error(`bm25 b must lie in [0, 1], got ${String(b)}`)
  }
  const scores = new Map<number, number>()
  const { documentCount, averageDocumentLength, documentLengths } = index
  for (const term of new Set(tokens)) {
    const list = index.postings.get(term)
    if (!list) continue
    const df = list.length
    const idf = Math.log(1 + (documentCount - df + 0.5) / (df + 0.5))
    for (const { ordinal, tf } of list) {
      const lengthRatio =
        averageDocumentLength > 0 ? documentLengths[ordinal]! / averageDocumentLength : 1
      const saturated = (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * lengthRatio))
      scores.set(ordinal, (scores.get(ordinal) ?? 0) + idf * saturated)
    }
  }
  return [...scores.entries()]
    .map(([ordinal, score]) => ({ page: index.pages[ordinal]!, score }))
    .sort(
      (left, right) => right.score - left.score || left.page.path.localeCompare(right.page.path),
    )
}

function resolveFieldBoosts(
  boosts: KnowledgeLexicalFieldBoosts | undefined,
): Readonly<Required<KnowledgeLexicalFieldBoosts>> {
  const resolved = { ...DEFAULT_FIELD_BOOSTS, ...boosts }
  for (const [field, boost] of Object.entries(resolved)) {
    if (!Number.isFinite(boost) || boost < 0) {
      throw new Error(`lexical field boost ${field} must be >= 0, got ${String(boost)}`)
    }
  }
  return Object.freeze(resolved)
}
