import { describe, expect, it } from 'vitest'
import type { KnowledgeIndex, KnowledgePage } from '../types'
import { scoreKnowledgeBaseIndex } from './knowledge-base'
import { detectNearDuplicatePages, normalizePageText } from './near-duplicates'

const repeated =
  'A verified research page explains the mechanism, records the experiment, names the evidence, and preserves the result for later agents. '

function page(id: string, title: string, text: string): KnowledgePage {
  return {
    id,
    path: `knowledge/${id}.md`,
    title,
    text,
    frontmatter: { id, title },
    sourceIds: [],
    tags: [],
    outLinks: [],
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

describe('detectNearDuplicatePages', () => {
  it('reports exact normalized copies with stable page identity', () => {
    const pages = [
      page('copy-a', 'Same title', repeated.repeat(2)),
      page('copy-b', 'Same title', repeated.repeat(2)),
    ]

    const report = detectNearDuplicatePages(pages)

    expect(report).toMatchObject({
      pageCount: 2,
      eligiblePageCount: 2,
      candidatePairCount: 1,
      comparedPairCount: 1,
      duplicatePairCount: 1,
      duplicatePageCount: 2,
      duplicatePageRate: 1,
      truncated: false,
    })
    expect(report.pairs).toEqual([
      expect.objectContaining({
        leftPageId: 'copy-a',
        rightPageId: 'copy-b',
        similarity: 1,
        exact: true,
      }),
    ])
  })

  it('finds near copies but not unrelated prose', () => {
    const base = `${repeated.repeat(2)} The decisive measured value is forty two.`
    const revised = `${repeated.repeat(2)} The decisive measured value is forty three.`
    const unrelated =
      'A kitchen inventory lists pans, knives, towels, plates, and groceries for a weekend dinner. '.repeat(
        3,
      )

    const report = detectNearDuplicatePages(
      [
        page('base', 'Experiment', base),
        page('revision', 'Experiment', revised),
        page('unrelated', 'Kitchen', unrelated),
      ],
      { threshold: 0.7 },
    )

    expect(report.duplicatePairCount).toBe(1)
    expect(report.pairs[0]).toMatchObject({
      leftPageId: 'base',
      rightPageId: 'revision',
      exact: false,
    })
    expect(report.pairs[0]!.similarity).toBeGreaterThanOrEqual(0.7)
  })

  it('is deterministic under input reordering', () => {
    const pages = [
      page('z', 'Same title', repeated.repeat(2)),
      page('a', 'Same title', repeated.repeat(2)),
      page('m', 'Different title', `${repeated.repeat(2)} extra material`),
    ]

    const forward = detectNearDuplicatePages(pages, { threshold: 0.7 })
    const reverse = detectNearDuplicatePages([...pages].reverse(), { threshold: 0.7 })

    expect(reverse).toEqual(forward)
  })

  it('excludes short pages and reports bounded candidate truncation', () => {
    const short = detectNearDuplicatePages(
      [page('short-a', 'Short', 'same'), page('short-b', 'Short', 'same')],
      { minCharacters: 80 },
    )
    expect(short).toMatchObject({ eligiblePageCount: 0, duplicatePairCount: 0 })

    const bounded = detectNearDuplicatePages(
      Array.from({ length: 4 }, (_, index) =>
        page(`copy-${index}`, 'Same title', repeated.repeat(2)),
      ),
      { maxCandidatePairs: 2 },
    )
    expect(bounded).toMatchObject({
      candidatePairCount: 2,
      comparedPairCount: 2,
      truncated: true,
    })
  })

  it('normalizes Unicode width, case, whitespace, and URL identity', () => {
    expect(normalizePageText('ＡLPHA  https://example.com/a\nBeta')).toBe(
      'alpha <url> beta',
    )
  })

  it('refuses malformed detector limits', () => {
    expect(() => detectNearDuplicatePages([], { threshold: 1.1 })).toThrow(/threshold/)
    expect(() => detectNearDuplicatePages([], { maxCandidatePairs: 0 })).toThrow(
      /maxCandidatePairs/,
    )
    expect(() => detectNearDuplicatePages([], { minCharacters: -1 })).toThrow(/minCharacters/)
  })
})

describe('scoreKnowledgeBaseIndex near-duplicate quality', () => {
  const duplicatePages = [
    page('copy-a', 'Same title', repeated.repeat(2)),
    page('copy-b', 'Same title', repeated.repeat(2)),
    page(
      'independent',
      'Independent result',
      'A separate proof studies a different theorem, with distinct assumptions and a different verification artifact. '.repeat(
        3,
      ),
    ),
  ]

  it('always reports deterministic duplicate metrics without failing by default', () => {
    const report = scoreKnowledgeBaseIndex(index(duplicatePages))

    expect(report.ok).toBe(true)
    expect(report.metrics).toMatchObject({
      near_duplicate_page_rate: 0.666667,
      near_duplicate_page_count: 2,
      near_duplicate_pair_count: 1,
    })
    expect(report.nearDuplicates?.pairs).toHaveLength(1)
  })

  it('fails a configured duplicate-page gate with measured evidence', () => {
    const report = scoreKnowledgeBaseIndex(index(duplicatePages), {
      maxNearDuplicatePageRate: 0.5,
    })

    expect(report.ok).toBe(false)
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'kb:near-duplicate-page-rate',
          severity: 'error',
          evidence: expect.objectContaining({
            near_duplicate_page_rate: 0.666667,
            near_duplicate_pair_count: 1,
          }),
        }),
      ]),
    )
  })

  it('fails closed when a configured gate rests on truncated analysis', () => {
    const report = scoreKnowledgeBaseIndex(
      index(
        Array.from({ length: 4 }, (_, position) =>
          page(`copy-${position}`, 'Same title', repeated.repeat(2)),
        ),
      ),
      {
        nearDuplicates: { maxCandidatePairs: 1 },
        maxNearDuplicatePageRate: 0.9,
      },
    )

    expect(report.ok).toBe(false)
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'kb:near-duplicate-analysis-truncated' }),
      ]),
    )
  })

  it('refuses a malformed quality threshold', () => {
    expect(() =>
      scoreKnowledgeBaseIndex(index(duplicatePages), { maxNearDuplicatePageRate: -0.1 }),
    ).toThrow(/maxNearDuplicatePageRate/)
  })
})
