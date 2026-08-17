import type { KnowledgeGraph, KnowledgeGraphEdge, KnowledgeGraphNode, KnowledgePage } from './types'
import { normalizeLinkTarget } from './wikilinks'

export function buildKnowledgeGraph(pages: KnowledgePage[]): KnowledgeGraph {
  const bySlug = new Map<string, KnowledgePage>()
  const byId = new Map<string, KnowledgePage[]>()
  for (const page of pages) {
    byId.set(page.id, [...(byId.get(page.id) ?? []), page])
    bySlug.set(normalizeLinkTarget(page.id), page)
    bySlug.set(normalizeLinkTarget(page.title), page)
    bySlug.set(normalizeLinkTarget(page.path.split('/').pop()!.replace(/\.md$/, '')), page)
  }

  const incoming = new Map<string, number>()
  const outgoing = new Map<string, number>()
  const edgesByKey = new Map<string, KnowledgeGraphEdge>()
  for (const page of pages) {
    outgoing.set(page.id, 0)
    incoming.set(page.id, 0)
  }

  for (const page of pages) {
    for (const raw of page.outLinks) {
      const target = bySlug.get(normalizeLinkTarget(raw))
      if (!target || target.id === page.id) continue
      addDirectedEdge(page, target, 'wikilink', edgesByKey, incoming, outgoing)
    }
    for (const citedId of page.cites ?? []) {
      const targets = byId.get(citedId) ?? []
      if (targets.length !== 1 || targets[0]!.id === page.id) continue
      addDirectedEdge(page, targets[0]!, 'citation', edgesByKey, incoming, outgoing)
    }
  }

  addSourceOverlapEdges(pages, edgesByKey)

  const nodes: KnowledgeGraphNode[] = pages.map((page) => ({
    id: page.id,
    title: page.title,
    path: page.path,
    tags: page.tags,
    sourceIds: page.sourceIds,
    outDegree: outgoing.get(page.id) ?? 0,
    inDegree: incoming.get(page.id) ?? 0,
  }))
  return { nodes, edges: [...edgesByKey.values()].sort((a, b) => b.weight - a.weight) }
}

function addDirectedEdge(
  source: KnowledgePage,
  target: KnowledgePage,
  reason: string,
  edges: Map<string, KnowledgeGraphEdge>,
  incoming: Map<string, number>,
  outgoing: Map<string, number>,
): void {
  const key = `${source.id}->${target.id}`
  const edge = edges.get(key)
  if (edge) {
    edge.weight += 1
    if (!edge.reasons.includes(reason)) edge.reasons.push(reason)
  } else {
    edges.set(key, {
      source: source.id,
      target: target.id,
      weight: 1,
      reasons: [reason],
    })
  }
  outgoing.set(source.id, (outgoing.get(source.id) ?? 0) + 1)
  incoming.set(target.id, (incoming.get(target.id) ?? 0) + 1)
}

function addSourceOverlapEdges(
  pages: KnowledgePage[],
  edges: Map<string, KnowledgeGraphEdge>,
): void {
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      const a = pages[i]!
      const b = pages[j]!
      const overlap = a.sourceIds.filter((source) => b.sourceIds.includes(source))
      if (overlap.length === 0) continue
      const key = `${a.id}->${b.id}`
      const edge = edges.get(key)
      if (edge) {
        edge.weight += overlap.length * 0.5
        if (!edge.reasons.includes('shared-source')) edge.reasons.push('shared-source')
      } else {
        edges.set(key, {
          source: a.id,
          target: b.id,
          weight: overlap.length * 0.5,
          reasons: ['shared-source'],
        })
      }
    }
  }
}
