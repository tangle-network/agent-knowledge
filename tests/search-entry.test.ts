import { describe, expect, it } from 'vitest'
import {
  buildKnowledgeLexicalIndex,
  KNOWLEDGE_SEARCH_RETRIEVER_ID,
  type KnowledgePage,
  searchKnowledgePages,
} from '../src/search/index'

const page = (id: string, text: string, sourceId = id): KnowledgePage => ({
  id,
  path: `${id}.md`,
  title: id,
  text,
  frontmatter: {},
  sourceIds: [sourceId],
  tags: [],
  outLinks: [],
})

describe('Worker-safe search entry', () => {
  it('reuses maintained ranking and returns source-backed pages with or without a prebuilt index', () => {
    const pages = [
      page('refunds', 'Refunds are available within thirty days.', 'policy-v3'),
      page('delivery', 'Delivery takes five days.'),
    ]
    const results = searchKnowledgePages(pages, 'refunds thirty days')
    expect(results[0]?.page.id).toBe('refunds')
    expect(results[0]?.page.sourceIds).toEqual(['policy-v3'])
    expect(
      searchKnowledgePages(pages, 'refunds thirty days', {
        lexicalIndex: buildKnowledgeLexicalIndex(pages),
      }),
    ).toEqual(results)
    expect(KNOWLEDGE_SEARCH_RETRIEVER_ID).toBe('bm25-rrf-v1')
  })
  it('honors the host selection and exposes no off-scope pages', () => {
    const pages = [
      page('allowed', 'Refund policy summary.'),
      page('private', 'Secret refund policy.'),
    ]
    expect(
      searchKnowledgePages(pages, 'refund', { pageIds: ['allowed'] }).map((hit) => hit.page.id),
    ).toEqual(['allowed'])
    expect(searchKnowledgePages([], 'refund')).toEqual([])
  })
})
