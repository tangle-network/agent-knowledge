import type {
  KnowledgeLexicalFieldBoosts,
  KnowledgeLexicalIndex,
  KnowledgeLexicalPosting,
} from './lexical-index'
import type { KnowledgePage } from './types'

export const DEFAULT_FIELD_BOOSTS: Readonly<Required<KnowledgeLexicalFieldBoosts>> = Object.freeze({
  title: 3,
  path: 2,
  text: 1,
})

/** Field-boosted term frequencies and length of one page. */
export interface LexicalPageTerms {
  readonly frequencies: ReadonlyMap<string, number>
  readonly length: number
}

export function lexicalPageTerms(
  page: KnowledgePage,
  tokenize: (text: string) => string[],
  fieldBoosts: Readonly<Required<KnowledgeLexicalFieldBoosts>>,
): LexicalPageTerms {
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
  return { frequencies, length }
}

/** Inverted index from per-page terms already computed with `tokenize` and `fieldBoosts`. */
export function assembleLexicalIndex(
  pages: readonly KnowledgePage[],
  terms: readonly LexicalPageTerms[],
  tokenize: (text: string) => string[],
  fieldBoosts: Readonly<Required<KnowledgeLexicalFieldBoosts>>,
): KnowledgeLexicalIndex {
  const postings = new Map<string, KnowledgeLexicalPosting[]>()
  const documentLengths: number[] = []
  let totalLength = 0
  terms.forEach(({ frequencies, length }, ordinal) => {
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
