import { describe, expect, it } from 'vitest'
import { buildKnowledgeLexicalIndex, scoreBm25, tokenizeQuery, tokenizeText } from './lexical-index'
import type { KnowledgePage } from './types'

function page(id: string, title: string, text: string, path = `knowledge/${id}.md`): KnowledgePage {
  return { id, path, title, text, frontmatter: {}, sourceIds: [], tags: [], outLinks: [] }
}

describe('tokenizeText and tokenizeQuery', () => {
  it('keeps repeats in the stream and removes them from the query', () => {
    expect(tokenizeText('Alpha alpha, the beta')).toEqual(['alpha', 'alpha', 'beta'])
    expect(tokenizeQuery('Alpha alpha, the beta')).toEqual(['alpha', 'beta'])
  })

  it('expands a CJK run into bigrams and characters on both sides', () => {
    const stream = tokenizeText('机器学习')
    expect(stream).toEqual(['机器', '器学', '学习', '机', '器', '学', '习', '机器学习'])
    expect(tokenizeQuery('机器学习 机器学习')).toEqual(stream)
  })
})

describe('buildKnowledgeLexicalIndex', () => {
  it('records field-boosted term frequencies, document lengths, and the average length', () => {
    const index = buildKnowledgeLexicalIndex([
      page('one', 'Alpha', 'alpha beta', 'knowledge/concepts/alpha.md'),
      page('two', 'Beta', 'beta beta gamma'),
    ])

    expect(index.documentCount).toBe(2)
    expect(index.postings.get('alpha')).toEqual([{ ordinal: 0, tf: 3 + 2 + 1 }])
    expect(index.postings.get('beta')).toEqual([
      { ordinal: 0, tf: 1 },
      { ordinal: 1, tf: 3 + 2 },
    ])
    expect(index.postings.get('concepts')).toEqual([{ ordinal: 0, tf: 2 }])
    expect(index.postings.get('knowledge')).toEqual([
      { ordinal: 0, tf: 2 },
      { ordinal: 1, tf: 2 },
    ])
    expect(index.documentLengths).toEqual([3 + 2 * 3 + 2, 3 + 2 * 2 + 3])
    expect(index.averageDocumentLength).toBe((11 + 10) / 2)
  })

  it('applies caller field boosts and a caller tokenizer to every field', () => {
    const index = buildKnowledgeLexicalIndex([page('one', 'A-B', 'a-b a-b')], {
      fieldBoosts: { title: 1, path: 0, text: 1 },
      tokenize: (text) => text.toLowerCase().split(/\s+/).filter(Boolean),
    })

    expect(index.postings.get('a-b')).toEqual([{ ordinal: 0, tf: 3 }])
    expect(index.postings.has('knowledge')).toBe(false)
    expect(index.documentLengths).toEqual([3])
  })

  it('refuses a negative or non-finite field boost', () => {
    expect(() => buildKnowledgeLexicalIndex([], { fieldBoosts: { title: -1 } })).toThrow(/title/)
    expect(() =>
      buildKnowledgeLexicalIndex([], { fieldBoosts: { text: Number.POSITIVE_INFINITY } }),
    ).toThrow(/text/)
  })
})

describe('scoreBm25', () => {
  const corpusWide = 'research '
  const pages = [
    page('a', 'Page a', `${corpusWide.repeat(8)} obstruction`),
    page('b', 'Page b', `${corpusWide.repeat(30)}`),
    page('c', 'Page c', `${corpusWide.repeat(8)}`),
    page('d', 'Page d', `${corpusWide.repeat(8)}`),
  ]

  it('discounts a term that occurs in every document below a rare term', () => {
    const index = buildKnowledgeLexicalIndex(pages)
    const hits = scoreBm25(index, tokenizeQuery('research obstruction'))

    expect(hits[0]?.page.id).toBe('a')
    expect(hits.map((hit) => hit.page.id)).toEqual(['a', 'b', 'c', 'd'])
    const rareOnly = scoreBm25(index, ['obstruction'])[0]!.score
    const commonOnly = scoreBm25(index, ['research']).find((hit) => hit.page.id === 'b')!.score
    expect(rareOnly).toBeGreaterThan(commonOnly)
  })

  it('prefers the shorter document at equal term frequency', () => {
    const index = buildKnowledgeLexicalIndex([
      page('short', 'Short', 'tiling tiling'),
      page('long', 'Long', `tiling tiling ${'padding '.repeat(40)}`),
    ])
    const hits = scoreBm25(index, ['tiling'])

    expect(hits.map((hit) => hit.page.id)).toEqual(['short', 'long'])
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)
  })

  it('saturates term frequency instead of growing without bound', () => {
    const index = buildKnowledgeLexicalIndex([
      page('once', 'Once', 'tiling'),
      page('often', 'Often', 'tiling '.repeat(50)),
    ])
    const [often, once] = scoreBm25(index, ['tiling'])
    expect(often!.page.id).toBe('often')
    expect(often!.score / once!.score).toBeLessThan(3)
  })

  it('omits documents without a matching term and ties on path', () => {
    const index = buildKnowledgeLexicalIndex([
      page('z', 'Same', 'same text'),
      page('a', 'Same', 'same text'),
      page('none', 'Other', 'unrelated'),
    ])
    const hits = scoreBm25(index, ['same'])
    expect(hits.map((hit) => hit.page.id)).toEqual(['a', 'z'])
    expect(hits[0]!.score).toBe(hits[1]!.score)
    expect(scoreBm25(index, ['missing'])).toEqual([])
  })

  it('does not depend on page order', () => {
    const forward = scoreBm25(buildKnowledgeLexicalIndex(pages), ['research', 'obstruction'])
    const reverse = scoreBm25(buildKnowledgeLexicalIndex([...pages].reverse()), [
      'research',
      'obstruction',
    ])
    expect(reverse.map((hit) => [hit.page.id, hit.score])).toEqual(
      forward.map((hit) => [hit.page.id, hit.score]),
    )
  })

  it('refuses malformed parameters', () => {
    const index = buildKnowledgeLexicalIndex(pages)
    expect(() => scoreBm25(index, ['research'], { k1: -1 })).toThrow(/k1/)
    expect(() => scoreBm25(index, ['research'], { b: 1.5 })).toThrow(/b must lie/)
  })
})
