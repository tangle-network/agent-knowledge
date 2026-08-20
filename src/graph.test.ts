import { describe, expect, it } from 'vitest'
import { buildKnowledgeGraph, knowledgePageRelations } from './graph'
import { buildKnowledgeRelationGraph, neighbors } from './relation-graph'
import type { KnowledgeGraph, KnowledgePage } from './types'

function page(
  input: Partial<KnowledgePage> & Pick<KnowledgePage, 'id' | 'title' | 'path'>,
): KnowledgePage {
  return {
    text: `${input.title} body`,
    frontmatter: {},
    sourceIds: [],
    tags: [],
    outLinks: [],
    ...input,
  }
}

// Covers: a link and a citation that resolve to the same page twice each, a
// missing link target, a self link, an origin-qualified citation, a malformed
// citation, an ambiguous duplicate id, a wikilink resolved through a path
// basename, and a `contradicts` entry at every resolution outcome.
const pages: KnowledgePage[] = [
  page({
    id: 'attention',
    title: 'Attention',
    path: 'knowledge/concepts/attention.md',
    sourceIds: ['s1', 's2'],
    tags: ['transformer'],
    outLinks: ['flash-attention', 'Flash Attention', 'missing-page', 'attention'],
    cites: ['flash-attention', 'here::flash-attention'],
    contradicts: ['orphan'],
  }),
  page({
    id: 'flash-attention',
    title: 'Flash Attention',
    path: 'knowledge/concepts/flash-attention.md',
    sourceIds: ['s1'],
    outLinks: ['attention'],
  }),
  page({ id: 'orphan', title: 'Orphan', path: 'knowledge/orphan.md', sourceIds: ['s2', 's3'] }),
  page({ id: 'dup', title: 'Dup A', path: 'knowledge/dup-a.md', sourceIds: ['s3'] }),
  page({ id: 'dup', title: 'Dup B', path: 'knowledge/dup-b.md', sourceIds: ['s3'] }),
  page({
    id: 'citer',
    title: 'Citer',
    path: 'knowledge/citer.md',
    outLinks: ['dup-a', 'orphan.md'],
    cites: ['dup', 'citer', 'here::', 'orphan'],
    contradicts: ['citer', 'dup', 'orphan'],
  }),
]

// Recorded from `buildKnowledgeGraph` before it derived its edges from
// `knowledgePageRelations`. Key order, edge order, weights, and degrees are the
// published index shape and must not move.
const goldenGraph: KnowledgeGraph = {
  nodes: [
    {
      id: 'attention',
      title: 'Attention',
      path: 'knowledge/concepts/attention.md',
      tags: ['transformer'],
      sourceIds: ['s1', 's2'],
      outDegree: 4,
      inDegree: 1,
    },
    {
      id: 'flash-attention',
      title: 'Flash Attention',
      path: 'knowledge/concepts/flash-attention.md',
      tags: [],
      sourceIds: ['s1'],
      outDegree: 1,
      inDegree: 4,
    },
    {
      id: 'orphan',
      title: 'Orphan',
      path: 'knowledge/orphan.md',
      tags: [],
      sourceIds: ['s2', 's3'],
      outDegree: 0,
      inDegree: 2,
    },
    {
      id: 'dup',
      title: 'Dup A',
      path: 'knowledge/dup-a.md',
      tags: [],
      sourceIds: ['s3'],
      outDegree: 0,
      inDegree: 1,
    },
    {
      id: 'dup',
      title: 'Dup B',
      path: 'knowledge/dup-b.md',
      tags: [],
      sourceIds: ['s3'],
      outDegree: 0,
      inDegree: 1,
    },
    {
      id: 'citer',
      title: 'Citer',
      path: 'knowledge/citer.md',
      tags: [],
      sourceIds: [],
      outDegree: 3,
      inDegree: 0,
    },
  ],
  edges: [
    {
      source: 'attention',
      target: 'flash-attention',
      weight: 4.5,
      reasons: ['wikilink', 'citation', 'shared-source'],
    },
    { source: 'citer', target: 'orphan', weight: 2, reasons: ['wikilink', 'citation'] },
    { source: 'flash-attention', target: 'attention', weight: 1, reasons: ['wikilink'] },
    { source: 'citer', target: 'dup', weight: 1, reasons: ['wikilink'] },
    { source: 'orphan', target: 'dup', weight: 1, reasons: ['shared-source'] },
    { source: 'attention', target: 'orphan', weight: 0.5, reasons: ['shared-source'] },
    { source: 'dup', target: 'dup', weight: 0.5, reasons: ['shared-source'] },
  ],
}

describe('knowledgePageRelations', () => {
  it('emits one labeled relation per (source, target, predicate) with occurrence weights', () => {
    expect(knowledgePageRelations(pages)).toEqual([
      { sourceId: 'attention', targetId: 'flash-attention', predicate: 'wikilink', weight: 2 },
      { sourceId: 'attention', targetId: 'flash-attention', predicate: 'citation', weight: 2 },
      { sourceId: 'attention', targetId: 'orphan', predicate: 'contradicts', weight: 1 },
      { sourceId: 'flash-attention', targetId: 'attention', predicate: 'wikilink', weight: 1 },
      { sourceId: 'citer', targetId: 'dup', predicate: 'wikilink', weight: 1 },
      { sourceId: 'citer', targetId: 'orphan', predicate: 'wikilink', weight: 1 },
      { sourceId: 'citer', targetId: 'orphan', predicate: 'citation', weight: 1 },
      { sourceId: 'citer', targetId: 'orphan', predicate: 'contradicts', weight: 1 },
      {
        sourceId: 'attention',
        targetId: 'flash-attention',
        predicate: 'shared-source',
        weight: 0.5,
        metadata: { sourceIds: ['s1'] },
      },
      {
        sourceId: 'attention',
        targetId: 'orphan',
        predicate: 'shared-source',
        weight: 0.5,
        metadata: { sourceIds: ['s2'] },
      },
      {
        sourceId: 'orphan',
        targetId: 'dup',
        predicate: 'shared-source',
        weight: 0.5,
        metadata: { sourceIds: ['s3'] },
      },
      {
        sourceId: 'orphan',
        targetId: 'dup',
        predicate: 'shared-source',
        weight: 0.5,
        metadata: { sourceIds: ['s3'] },
      },
      {
        sourceId: 'dup',
        targetId: 'dup',
        predicate: 'shared-source',
        weight: 0.5,
        metadata: { sourceIds: ['s3'] },
      },
    ])
  })

  it('keeps two predicates between one pair as two relations in a relation graph', () => {
    const relations = knowledgePageRelations(pages).filter(
      (relation) => relation.predicate !== 'shared-source',
    )
    const graph = buildKnowledgeRelationGraph({ relations })
    const out = neighbors(graph, 'attention', { direction: 'out' })
    expect(out.map((neighbor) => [neighbor.nodeId, neighbor.relation.predicate])).toEqual([
      ['flash-attention', 'wikilink'],
      ['flash-attention', 'citation'],
      ['orphan', 'contradicts'],
    ])
    expect(neighbors(graph, 'orphan', { direction: 'in', predicate: 'contradicts' })).toHaveLength(
      2,
    )
  })

  it('emits nothing for a missing, ambiguous, or self target', () => {
    const relations = knowledgePageRelations(pages)
    expect(relations.some((relation) => relation.targetId === 'missing-page')).toBe(false)
    expect(
      relations.some(
        (relation) =>
          relation.sourceId === relation.targetId && relation.predicate !== 'shared-source',
      ),
    ).toBe(false)
    expect(
      relations.some(
        (relation) =>
          relation.sourceId === 'citer' &&
          relation.targetId === 'dup' &&
          relation.predicate !== 'wikilink',
      ),
    ).toBe(false)
  })
})

describe('buildKnowledgeGraph', () => {
  it('is byte-identical to the recorded collapsed page graph', () => {
    expect(JSON.stringify(buildKnowledgeGraph(pages))).toBe(JSON.stringify(goldenGraph))
  })

  it('sums the relation weights per ordered pair and leaves contradicts out', () => {
    const graph = buildKnowledgeGraph(pages)
    const pairWeights = new Map<string, number>()
    for (const relation of knowledgePageRelations(pages)) {
      if (relation.predicate === 'contradicts') continue
      const key = `${relation.sourceId}->${relation.targetId}`
      pairWeights.set(key, (pairWeights.get(key) ?? 0) + relation.weight)
    }
    expect(
      new Map(graph.edges.map((edge) => [`${edge.source}->${edge.target}`, edge.weight])),
    ).toEqual(pairWeights)
    expect(graph.edges.some((edge) => edge.reasons.includes('contradicts'))).toBe(false)
  })
})
