import { describe, expect, it } from 'vitest'
import { parseKnowledgeCitationReference, resolveKnowledgeCitation } from './citation-resolution'
import { buildKnowledgeBrief } from './knowledge-brief'
import {
  assertKnowledgeRetrievalMatchesVisibility,
  createKnowledgeRetrievalReceipt,
  createKnowledgeVisibilitySnapshot,
} from './knowledge-use-receipts'
import type { OriginatedPage } from './run-scoped'
import { searchKnowledgePages } from './search'
import type { KnowledgePage } from './types'

const page = (id: string, title: string, text: string, outLinks: string[] = []): KnowledgePage => ({
  id,
  title,
  path: `knowledge/${id}.md`,
  text,
  outLinks,
  tags: [],
  sourceIds: [],
  frontmatter: { id },
})
const quantum = page('state', 'Quantum error correction', 'Quantum syndrome decoding.')
const banana = page('state', 'Banana logistics', 'Banana shipment schedules.')
const visible: OriginatedPage[] = [
  { page: quantum, origin: 'here' },
  { page: banana, origin: 'inherited:prior' },
]

function assertRoundTrips(chain: OriginatedPage[], question: string) {
  const brief = buildKnowledgeBrief(chain, question, { limit: 50 })
  for (const hit of brief.results) {
    const reference = brief.citationIds[hit.rank - 1]!
    const resolved = resolveKnowledgeCitation(chain, parseKnowledgeCitationReference(reference))
    expect(resolved.status).toBe('resolved')
    expect(resolved.resolved?.page).toBe(hit.page)
    expect(resolved.resolved?.origin).toBe(hit.origin)
  }
  const visibility = createKnowledgeVisibilitySnapshot(chain)
  const receipt = createKnowledgeRetrievalReceipt({
    runId: 'origin-test',
    query: brief.question,
    retriever: {
      id: brief.retrieverId,
      version: 'test',
      configDigest: brief.retrieverConfigDigest,
    },
    visibility,
    results: brief.results,
  })
  assertKnowledgeRetrievalMatchesVisibility(receipt, visibility)
  return brief
}

describe('retrieval preserves document identity across origins', () => {
  it('does not replace a matching document with an unrelated same-id document, in either order', () => {
    for (const chain of [visible, [...visible].reverse()]) {
      const raw = searchKnowledgePages(
        chain.map((entry) => entry.page),
        'quantum',
      )
      expect(raw).toHaveLength(1)
      expect(raw[0]!.page).toBe(quantum)
      const brief = assertRoundTrips(chain, 'quantum')
      expect(brief.citationIds).toEqual(['here::state'])
      expect(brief.text).toContain('Quantum error correction')
      expect(brief.text).not.toContain('Banana')
    }
  })

  it('keeps both independently matching same-id pages rather than fusing them into one', () => {
    const a = page('state', 'Quantum A', 'quantum')
    const b = page('state', 'Quantum B', 'quantum')
    expect(searchKnowledgePages([a, b], 'quantum').map((hit) => hit.page)).toEqual([a, b])
  })

  it('can distinguish the same page object exposed at several origins', () => {
    const chain: OriginatedPage[] = ['here', 'shared', 'inherited:prior'].map((origin) => ({
      page: quantum,
      origin: origin as OriginatedPage['origin'],
    }))
    const before = JSON.stringify(chain)
    const result = assertRoundTrips(chain, 'quantum')
    expect(new Set(result.citationIds).size).toBe(3)
    expect(result.results.every((hit) => hit.page === quantum)).toBe(true)
    expect(assertRoundTrips([...chain].reverse(), 'quantum').citationIds).toEqual(
      result.citationIds,
    )
    expect(JSON.stringify(chain)).toBe(before)
  })

  it('qualifies against all visible pages, even when only one duplicate survives the filters', () => {
    const chain: OriginatedPage[] = [
      { origin: 'here', page: { ...quantum, tags: ['selected'] } },
      { origin: 'shared', page: { ...banana, tags: ['excluded'] } },
    ]
    const brief = buildKnowledgeBrief(chain, 'quantum', { tags: ['selected'], limit: 1 })
    expect(brief.citationIds).toEqual(['here::state'])
    expect(
      resolveKnowledgeCitation(chain, parseKnowledgeCitationReference(brief.citationIds[0]!))
        .resolved?.page,
    ).toBe(chain[0]!.page)
  })

  it('preserves unqualified handles for unique ordinary page ids', () => {
    expect(assertRoundTrips([visible[0]!], 'quantum').citationIds).toEqual(['state'])
  })

  it('keeps text, hits and receipt results aligned after the rendering bound', () => {
    const brief = buildKnowledgeBrief(visible, 'quantum', { maxChars: 1 })
    expect(brief.text).toBe('')
    expect(brief.hits).toEqual([])
    expect(brief.results).toEqual([])
    expect(brief.citationIds).toEqual([])
  })

  it('refuses a genuinely ambiguous same-origin citation rather than choosing a page', () => {
    expect(() =>
      buildKnowledgeBrief(
        [
          { origin: 'here', page: quantum },
          { origin: 'here', page: { ...banana, path: 'knowledge/other.md' } },
        ],
        'quantum',
      ),
    ).toThrow(/ambiguous/)
  })

  it('uses the existing citation resolver for graph edges, not bare id coincidence', () => {
    const chain: OriginatedPage[] = [
      ...visible,
      {
        origin: 'here',
        page: page('right-link', 'Correct neighbor', 'A useful neighbor.', ['here::state']),
      },
      {
        origin: 'here',
        page: page('wrong-link', 'Unrelated neighbor', 'Another neighbor.', [
          'inherited:prior::state',
        ]),
      },
      {
        origin: 'here',
        page: page('ambiguous-link', 'Ambiguous neighbor', 'Ambiguous.', ['state']),
      },
    ]
    const brief = assertRoundTrips(chain, 'quantum')
    expect([...brief.citationIds].sort()).toEqual(['here::state', 'right-link'])
  })

  it('does not infer an unscoped graph edge from an ambiguous bare id', () => {
    const linked = page('link', 'Neighbor', 'Neighbor.', ['state'])
    expect(
      searchKnowledgePages([quantum, banana, linked], 'quantum').map((hit) => hit.page),
    ).toEqual([quantum])
  })

  it('keeps searchable evidence with malformed outgoing links without inventing an edge', () => {
    const malformed = { ...quantum, outLinks: ['inherited:::state'] }
    const chain: OriginatedPage[] = [{ origin: 'here', page: malformed }]
    const result = assertRoundTrips(chain, 'quantum')
    expect(result.results[0]!.page).toBe(malformed)
    expect(result.results[0]!.page.outLinks).toEqual(['inherited:::state'])
  })
})
