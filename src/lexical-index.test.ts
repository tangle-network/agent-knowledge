import { describe, expect, it } from 'vitest'
import { buildKnowledgeLexicalIndex, scoreBm25, tokenizeQuery, tokenizeText } from './lexical-index'
import type { KnowledgePage } from './types'

function page(id: string, title: string, text: string, path = `knowledge/${id}.md`): KnowledgePage {
  return { id, path, title, text, frontmatter: {}, sourceIds: [], tags: [], outLinks: [] }
}

describe('lexical tokenization', () => {
  it('gives the query exactly the distinct terms the index stores, including CJK bigrams', () => {
    const indexed = tokenizeText('机器学习 机器学习 flash attention attention')

    expect(tokenizeQuery('机器学习 机器学习 flash attention attention')).toEqual([
      ...new Set(indexed),
    ])
    expect(indexed).toContain('机器')
    expect(indexed.filter((token) => token === 'attention')).toHaveLength(2)
  })
})

describe('scoreBm25', () => {
  it('ranks a page holding a rare term above pages holding only a corpus-wide term', () => {
    const common = 'research '
    const index = buildKnowledgeLexicalIndex([
      page('rare', 'Page a', `${common.repeat(8)} obstruction`),
      page('common-heavy', 'Page b', common.repeat(30)),
      page('common-c', 'Page c', common.repeat(8)),
      page('common-d', 'Page d', common.repeat(8)),
    ])

    expect(scoreBm25(index, tokenizeQuery('research obstruction'))[0]?.page.id).toBe('rare')
    expect(scoreBm25(index, ['obstruction'])[0]!.score).toBeGreaterThan(
      scoreBm25(index, ['research']).find((hit) => hit.page.id === 'common-heavy')!.score,
    )
  })

  it('ranks the shorter page first at equal term frequency', () => {
    const index = buildKnowledgeLexicalIndex([
      page('short', 'Short', 'tiling tiling'),
      page('long', 'Long', `tiling tiling ${'padding '.repeat(40)}`),
    ])

    expect(scoreBm25(index, ['tiling']).map((hit) => hit.page.id)).toEqual(['short', 'long'])
  })

  it('saturates term frequency so repetition cannot dominate the ranking', () => {
    const index = buildKnowledgeLexicalIndex([
      page('once', 'Once', 'tiling'),
      page('often', 'Often', 'tiling '.repeat(50)),
    ])
    const [often, once] = scoreBm25(index, ['tiling'])

    expect(often!.page.id).toBe('often')
    expect(often!.score / once!.score).toBeLessThan(3)
  })
})
