import { describe, expect, it } from 'vitest'
import { searchKnowledge, type SearchKnowledgeOptions } from './search'
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
