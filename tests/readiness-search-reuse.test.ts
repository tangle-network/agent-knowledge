import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildEvalKnowledgeBundle, defineReadinessSpec } from '../src/eval-readiness'
import * as lexical from '../src/lexical-index'
import { searchKnowledge } from '../src/search'
import type { KnowledgeIndex, KnowledgePage } from '../src/types'

const now = new Date('2026-10-14T00:00:00.000Z')
const queries = ['attention', 'memory bandwidth', '', '  ', 'the', 'unmatched', '中文知识']

function page(id: string, path: string, title: string, text: string): KnowledgePage {
  return { id, path, title, text, frontmatter: {}, sourceIds: ['source'], tags: [], outLinks: [] }
}

function index(): KnowledgeIndex {
  return {
    root: '/unused-readiness-fixture',
    generatedAt: now.toISOString(),
    sources: [],
    pages: [
      page('duplicate', 'ancestor/attention.md', 'Attention', 'Memory bandwidth attention notes'),
      page('duplicate', 'child/attention.md', 'New attention', 'The attention implementation'),
      page('bandwidth', 'memory.md', 'Memory bandwidth', 'IO aware memory notes'),
      page('cjk', 'knowledge.md', '中文知识', '中文知识的检索'),
    ],
    graph: { nodes: [], edges: [] },
  }
}

function specs(values = queries) {
  return values.map((query, i) =>
    defineReadinessSpec({
      id: `requirement-${i}`,
      description: `Grounding ${i}`,
      query,
      requiredFor: ['task'],
    }),
  )
}

afterEach(() => vi.restoreAllMocks())

describe('request-local readiness search reuse', () => {
  it('returns byte-identical ranks, scores and citations for multiple queries and duplicate ids', () => {
    const view = index()
    const expected = Object.fromEntries(
      specs().map((spec) => [spec.id, searchKnowledge(view, spec.query, 3)]),
    )
    const actual = buildEvalKnowledgeBundle({
      taskId: 'task',
      index: view,
      specs: specs(),
      searchLimit: 3,
      now,
    }).searchResultsByRequirement
    expect(JSON.stringify(actual)).toBe(JSON.stringify(expected))
    for (const spec of specs()) {
      actual[spec.id]!.forEach((hit, i) => {
        expect(hit.page).toBe(expected[spec.id]![i]!.page)
      })
    }
    expect(actual['requirement-0']?.filter((hit) => hit.page.id === 'duplicate')).toHaveLength(2)
  })

  it('tokenizes each page field once per bundle, then only the nonempty queries', () => {
    const view = index()
    const build = lexical.buildKnowledgeLexicalIndex
    const tokenize = vi.fn(lexical.tokenizeText)
    const builds = vi
      .spyOn(lexical, 'buildKnowledgeLexicalIndex')
      .mockImplementation((pages, options) => build(pages, { ...options, tokenize }))
    buildEvalKnowledgeBundle({ taskId: 'task', index: view, specs: specs(), now })
    expect(builds).toHaveBeenCalledTimes(1)
    expect(builds.mock.calls[0]?.[0]).toBe(view.pages)
    expect(tokenize.mock.calls.map(([text]) => text)).toEqual([
      ...view.pages.flatMap((item) => [item.title, item.path.replace(/\.md$/, ''), item.text]),
      ...queries.map((query) => query.trim()).filter(Boolean),
    ])

    // A later call must build its own index even when given the same page array.
    view.pages[0]!.text = 'Replacement evidence only'
    const nextSpecs = specs(['replacement'])
    const next = buildEvalKnowledgeBundle({ taskId: 'task', index: view, specs: nextSpecs, now })
    expect(builds).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(next.searchResultsByRequirement['requirement-0'])).toBe(
      JSON.stringify(searchKnowledge(view, 'replacement', 5)),
    )
  })

  it.each([{ values: [] }, { values: ['', '  '] }])(
    'does not tokenize pages for empty query sets: $values',
    ({ values }) => {
      const builds = vi.spyOn(lexical, 'buildKnowledgeLexicalIndex')
      const actual = buildEvalKnowledgeBundle({
        taskId: 'task',
        index: index(),
        specs: specs(values),
        now,
      })
      expect(builds).not.toHaveBeenCalled()
      expect(
        Object.values(actual.searchResultsByRequirement).every((hits) => hits.length === 0),
      ).toBe(true)
    },
  )
})
