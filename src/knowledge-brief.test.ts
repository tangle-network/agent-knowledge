import { canonicalCandidateDigest } from '@tangle-network/agent-interface'
import { describe, expect, it } from 'vitest'
import { buildKnowledgeBrief } from './knowledge-brief'
import {
  assertKnowledgeRetrievalMatchesVisibility,
  createKnowledgeRetrievalReceipt,
  createKnowledgeVisibilitySnapshot,
  verifyKnowledgeRetrievalReceipt,
} from './knowledge-use-receipts'
import { originatedPages } from './run-scoped'
import type { KnowledgePage } from './types'

function page(id: string, text: string, extra: Partial<KnowledgePage> = {}): KnowledgePage {
  return {
    id,
    path: `knowledge/${id}.md`,
    title: id.replace(/-/g, ' '),
    text,
    frontmatter: { id },
    sourceIds: [],
    tags: [],
    outLinks: [],
    ...extra,
  }
}

const live = page(
  'retry-budget',
  'A retry budget caps the retries a run may spend and refuses the run when the budget is exhausted.',
)
const refuted = page(
  'retry-forever',
  'Unbounded retry recovers a run more often than a retry budget does, measured over a hundred runs.',
  {
    invalidation: {
      verdict: 'contradicted',
      observedAt: '2026-08-18T00:00:00.000Z',
      reason: 'The replication measured the opposite direction.',
    },
  },
)

describe('buildKnowledgeBrief', () => {
  it('keeps a refuted page out of the brief unless the caller asks for it', () => {
    const visible = originatedPages([live, refuted])

    expect(buildKnowledgeBrief(visible, 'retry budget').citationIds).toEqual(['retry-budget'])
    expect(
      [
        ...buildKnowledgeBrief(visible, 'retry budget', { excludeInvalidated: false }).citationIds,
      ].sort(),
    ).toEqual(['retry-budget', 'retry-forever'])
  })

  it('renders one line per page and keeps text, ids, and results describing one set', () => {
    const brief = buildKnowledgeBrief(originatedPages([live, refuted]), 'retry budget')

    expect(brief.text).toBe(
      `- [retry-budget] retry budget — ${brief.hits[0]!.snippet.replace(/\s+/g, ' ').trim()}`,
    )
    expect(brief.results.map((result) => result.origin)).toEqual(['here'])

    const bounded = buildKnowledgeBrief(originatedPages([live, refuted]), 'retry budget', {
      excludeInvalidated: false,
      maxChars: 1,
    })
    expect(bounded.text).toBe('')
    expect(bounded.citationIds).toEqual([])
    expect(bounded.results).toEqual([])
  })

  it('produces results a retrieval receipt accepts and a verifier joins to the snapshot', () => {
    const visible = [
      ...originatedPages([live]),
      ...originatedPages(
        [page('retry-storm', 'A retry storm is what a missing retry budget produces.')],
        'shared',
      ),
    ]
    const brief = buildKnowledgeBrief(visible, 'retry budget', { limit: 2 })
    const snapshot = createKnowledgeVisibilitySnapshot(visible)

    const receipt = createKnowledgeRetrievalReceipt({
      runId: 'run-a',
      query: brief.question,
      retriever: {
        id: brief.retrieverId,
        version: '10.4.0',
        configDigest: brief.retrieverConfigDigest,
      },
      visibility: snapshot,
      results: brief.results,
      createdAt: '2026-08-21T00:00:00.000Z',
    })

    assertKnowledgeRetrievalMatchesVisibility(receipt, snapshot)
    expect(verifyKnowledgeRetrievalReceipt(receipt).results.map((result) => result.pageId)).toEqual(
      brief.citationIds,
    )
    expect(receipt.retriever.configDigest).toBe(
      canonicalCandidateDigest({
        limit: 2,
        excludeInvalidated: true,
        tags: null,
        kinds: null,
        maxChars: null,
      }),
    )
  })
})
