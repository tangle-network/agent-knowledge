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

/**
 * Inverted index from per-page terms already computed with `tokenize` and `fieldBoosts`.
 *
 * Posting lists are built when a term is first looked up, not up front. A query reads a handful of
 * terms, while assembling every list walks every distinct term of every page: on a 910-page run
 * store that was about 440 ms of each search that followed a write, because every write starts a
 * new page view and so a new index (agent-knowledge#203). Enumerating the postings builds them all
 * once, so the map behaves exactly as an eagerly built one.
 */
export function assembleLexicalIndex(
  pages: readonly KnowledgePage[],
  terms: readonly LexicalPageTerms[],
  tokenize: (text: string) => string[],
  fieldBoosts: Readonly<Required<KnowledgeLexicalFieldBoosts>>,
): KnowledgeLexicalIndex {
  const documentLengths: number[] = []
  let totalLength = 0
  for (const { length } of terms) {
    documentLengths.push(length)
    totalLength += length
  }
  return {
    pages,
    postings: new LazyPostings(terms),
    documentLengths,
    averageDocumentLength: pages.length > 0 ? totalLength / pages.length : 0,
    documentCount: pages.length,
    tokenize,
    fieldBoosts,
  }
}

const NO_POSTINGS: readonly KnowledgeLexicalPosting[] = Object.freeze([])

/** A read-only postings map that builds one term's list on first lookup, in ordinal order. */
class LazyPostings implements ReadonlyMap<string, readonly KnowledgeLexicalPosting[]> {
  readonly #terms: readonly LexicalPageTerms[]
  readonly #lists = new Map<string, readonly KnowledgeLexicalPosting[]>()
  #all: Map<string, readonly KnowledgeLexicalPosting[]> | undefined

  constructor(terms: readonly LexicalPageTerms[]) {
    this.#terms = terms
  }

  get(term: string): readonly KnowledgeLexicalPosting[] | undefined {
    if (this.#all) return this.#all.get(term)
    let list = this.#lists.get(term)
    if (list === undefined) {
      const found: KnowledgeLexicalPosting[] = []
      this.#terms.forEach(({ frequencies }, ordinal) => {
        const tf = frequencies.get(term)
        if (tf !== undefined) found.push({ ordinal, tf })
      })
      list = found.length === 0 ? NO_POSTINGS : found
      this.#lists.set(term, list)
    }
    return list.length === 0 ? undefined : list
  }

  has(term: string): boolean {
    return this.get(term) !== undefined
  }

  get size(): number {
    return this.#every().size
  }

  forEach(
    callback: (
      value: readonly KnowledgeLexicalPosting[],
      key: string,
      map: ReadonlyMap<string, readonly KnowledgeLexicalPosting[]>,
    ) => void,
    thisArg?: unknown,
  ): void {
    for (const [term, list] of this.#every()) callback.call(thisArg, list, term, this)
  }

  entries(): MapIterator<[string, readonly KnowledgeLexicalPosting[]]> {
    return this.#every().entries()
  }

  keys(): MapIterator<string> {
    return this.#every().keys()
  }

  values(): MapIterator<readonly KnowledgeLexicalPosting[]> {
    return this.#every().values()
  }

  [Symbol.iterator](): MapIterator<[string, readonly KnowledgeLexicalPosting[]]> {
    return this.entries()
  }

  #every(): Map<string, readonly KnowledgeLexicalPosting[]> {
    if (this.#all) return this.#all
    const all = new Map<string, KnowledgeLexicalPosting[]>()
    this.#terms.forEach(({ frequencies }, ordinal) => {
      for (const [term, tf] of frequencies) {
        let list = all.get(term)
        if (!list) {
          list = []
          all.set(term, list)
        }
        list.push({ ordinal, tf })
      }
    })
    this.#lists.clear()
    this.#all = all
    return all
  }
}
