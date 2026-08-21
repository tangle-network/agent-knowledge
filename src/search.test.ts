import { describe, expect, it } from 'vitest'
import { buildKnowledgeLexicalIndex } from './lexical-index'
import { type SearchKnowledgeOptions, searchKnowledge } from './search'
import type { KnowledgeIndex, KnowledgePage } from './types'

function page(
  id: string,
  title: string,
  text: string,
  options: { kind?: string; tags?: string[]; outLinks?: string[]; sourceIds?: string[] } = {},
): KnowledgePage {
  return {
    id,
    path: `knowledge/${id}.md`,
    title,
    text,
    frontmatter: options.kind ? { kind: options.kind } : {},
    sourceIds: options.sourceIds ?? [],
    tags: options.tags ?? [],
    outLinks: options.outLinks ?? [],
  }
}

function index(pages: KnowledgePage[]): KnowledgeIndex {
  return {
    root: '/kb',
    generatedAt: '2026-08-17T00:00:00.000Z',
    sources: [],
    pages,
    graph: { nodes: [], edges: [] },
  }
}

describe('searchKnowledge filters', () => {
  const pages = [
    page('prior-alpha', 'Alpha exact prior', 'alpha alpha alpha', {
      kind: 'prior',
      tags: ['curated', 'math'],
    }),
    page('finding-alpha', 'Alpha measured finding', 'alpha measurement', {
      kind: 'finding',
      tags: ['measured', 'math'],
    }),
    page('profile-alpha', 'Alpha profile', 'alpha track record', {
      kind: 'profile',
      tags: ['agent'],
    }),
  ]

  it('keeps the numeric limit overload and returns an explicit citation handle', () => {
    const hits = searchKnowledge(index(pages), 'alpha', 1)

    expect(hits).toHaveLength(1)
    expect(hits[0]?.citationId).toBe(hits[0]?.page.id)
    expect(hits[0]?.rank).toBe(1)
  })

  it('applies kind and tag filters before either ranking stage', () => {
    const hits = searchKnowledge(index(pages), 'alpha', {
      kinds: ['finding'],
      tags: ['measured'],
    })

    expect(hits.map((hit) => hit.citationId)).toEqual(['finding-alpha'])
    expect(hits[0]?.normalizedScore).toBe(1)
  })

  it('combines stable ids with a caller-owned predicate', () => {
    const options: SearchKnowledgeOptions = {
      pageIds: ['prior-alpha', 'finding-alpha'],
      predicate: (candidate) => candidate.title.includes('prior'),
    }

    expect(searchKnowledge(index(pages), 'alpha', options).map((hit) => hit.citationId)).toEqual([
      'prior-alpha',
    ])
  })

  it('treats an explicit empty filter as matching no pages', () => {
    expect(searchKnowledge(index(pages), 'alpha', { kinds: [] })).toEqual([])
    expect(searchKnowledge(index(pages), 'alpha', { tags: [] })).toEqual([])
    expect(searchKnowledge(index(pages), 'alpha', { pageIds: [] })).toEqual([])
  })

  it('refuses a malformed limit instead of changing its meaning', () => {
    expect(() => searchKnowledge(index(pages), 'alpha', -1)).toThrow(/non-negative integer/)
    expect(() => searchKnowledge(index(pages), 'alpha', { limit: 1.5 })).toThrow(
      /non-negative integer/,
    )
  })
})

describe('searchKnowledge ranking', () => {
  it('keeps an exact title match ahead of a page that repeats the query terms', () => {
    const pages = [
      page(
        'benchmarks',
        'Flash Attention benchmarks',
        'flash attention numbers measured again. '.repeat(20),
      ),
      page('exact', 'Flash Attention', 'IO aware attention.'),
    ]

    expect(
      searchKnowledge(index(pages), 'Flash Attention', 2).map((hit) => hit.citationId),
    ).toEqual(['exact', 'benchmarks'])
  })

  it('returns identical hits when the indexed pages are reordered', () => {
    const pages = [
      page('with-rare', 'Verifier notes', 'research verifier obstruction'),
      page('common-heavy', 'Research log', 'research '.repeat(40)),
      page('linked', 'Linked page', 'verifier prose', { outLinks: ['with-rare'] }),
    ]

    const forward = searchKnowledge(index(pages), 'verifier obstruction', 5)
    const reverse = searchKnowledge(index([...pages].reverse()), 'verifier obstruction', 5)

    expect(reverse.map((hit) => [hit.citationId, hit.score, hit.rank])).toEqual(
      forward.map((hit) => [hit.citationId, hit.score, hit.rank]),
    )
  })

  it('recalls every member of a near-duplicate cluster ahead of unrelated prose', () => {
    const repeated =
      'A verified research page explains the mechanism, records the experiment, names the evidence, and preserves the result for later agents. '
    const pages = [
      page('copy-a', 'Same title', repeated.repeat(2)),
      page('copy-b', 'Same title', repeated.repeat(2)),
      page('revision', 'Same title', `${repeated.repeat(2)} The decisive measured value moved.`),
      page(
        'unrelated',
        'Kitchen',
        'A kitchen inventory lists pans, knives, towels, plates, and groceries. '.repeat(3),
      ),
    ]

    const hits = searchKnowledge(index(pages), repeated.trim(), 4)

    expect(
      hits
        .slice(0, 3)
        .map((hit) => hit.citationId)
        .sort(),
    ).toEqual(['copy-a', 'copy-b', 'revision'])
    expect(hits.map((hit) => hit.citationId)).not.toContain('unrelated')
  })

  it('scores a filtered search against a whole-corpus lexical index and refuses a foreign one', () => {
    const pages = [
      page('prior-alpha', 'Alpha exact prior', 'alpha alpha alpha', { kind: 'prior' }),
      page('finding-alpha', 'Alpha measured finding', 'alpha measurement', { kind: 'finding' }),
    ]
    const searched = index(pages)
    const lexicalIndex = buildKnowledgeLexicalIndex(searched.pages)

    expect(searchKnowledge(searched, 'alpha', { limit: 2, lexicalIndex })).toEqual(
      searchKnowledge(searched, 'alpha', 2),
    )
    expect(
      searchKnowledge(searched, 'alpha', { kinds: ['finding'], lexicalIndex }).map(
        (hit) => hit.citationId,
      ),
    ).toEqual(['finding-alpha'])
    expect(() =>
      searchKnowledge(searched, 'alpha', {
        lexicalIndex: buildKnowledgeLexicalIndex([pages[0]!]),
      }),
    ).toThrow(/lexical index/)
  })
})
