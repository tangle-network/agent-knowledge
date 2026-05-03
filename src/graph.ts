import type { KnowledgeGraph, KnowledgeGraphEdge, KnowledgeGraphNode, KnowledgePage } from './types'
import { normalizeLinkTarget } from './wikilinks'

export function buildKnowledgeGraph(pages: KnowledgePage[]): KnowledgeGraph {
  const byId = new Map<string, KnowledgePage>()
  const bySlug = new Map<string, KnowledgePage>()
  for (const page of pages) {
    byId.set(page.id, page)
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
      const key = `${page.id}->${target.id}`
      const edge = edgesByKey.get(key)
      if (edge) edge.weight += 1
      else edgesByKey.set(key, { source: page.id, target: target.id, weight: 1, reasons: ['wikilink'] })
      outgoing.set(page.id, (outgoing.get(page.id) ?? 0) + 1)
      incoming.set(target.id, (incoming.get(target.id) ?? 0) + 1)
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

function addSourceOverlapEdges(pages: KnowledgePage[], edges: Map<string, KnowledgeGraphEdge>): void {
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
        edge.reasons.push('shared-source')
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
