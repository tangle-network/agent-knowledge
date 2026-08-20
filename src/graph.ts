import { parseKnowledgeCitationReference } from './citation-resolution'
import type {
  KnowledgeGraph,
  KnowledgeGraphEdge,
  KnowledgeGraphNode,
  KnowledgePage,
  KnowledgeRelation,
} from './types'
import { normalizeLinkTarget } from './wikilinks'

export type KnowledgePageRelationPredicate =
  | 'wikilink'
  | 'citation'
  | 'shared-source'
  | 'contradicts'

/** One labeled relation between two pages; `weight` counts the occurrences that produced it. */
export interface KnowledgePageRelation extends KnowledgeRelation {
  predicate: KnowledgePageRelationPredicate
  weight: number
}

/**
 * The labeled relations between pages, one per `(sourceId, targetId, predicate)`.
 *
 * `wikilink`, `citation`, and `contradicts` follow an authored link, `cites`
 * entry, or `contradicts` entry to the one page it resolves to; a missing,
 * ambiguous, or self-referencing target emits nothing. `shared-source` joins
 * every pair of pages that registers a common source, in page order, weighted
 * 0.5 per shared source id, with the shared ids in `metadata.sourceIds`. It is
 * implicit, so it is listed after the authored relations and never counts
 * toward a page's degree in `buildKnowledgeGraph`.
 */
export function knowledgePageRelations(pages: KnowledgePage[]): KnowledgePageRelation[] {
  const bySlug = new Map<string, KnowledgePage>()
  const byId = new Map<string, KnowledgePage[]>()
  for (const page of pages) {
    byId.set(page.id, [...(byId.get(page.id) ?? []), page])
    bySlug.set(normalizeLinkTarget(page.id), page)
    bySlug.set(normalizeLinkTarget(page.title), page)
    bySlug.set(normalizeLinkTarget(page.path.split('/').pop()!.replace(/\.md$/, '')), page)
  }

  const authored = new Map<string, KnowledgePageRelation>()
  const count = (
    source: KnowledgePage,
    target: KnowledgePage,
    predicate: KnowledgePageRelationPredicate,
  ): void => {
    const key = JSON.stringify([source.id, target.id, predicate])
    const relation = authored.get(key)
    if (relation) relation.weight += 1
    else authored.set(key, { sourceId: source.id, targetId: target.id, predicate, weight: 1 })
  }
  const uniqueTarget = (id: string): KnowledgePage | undefined => {
    const targets = byId.get(id) ?? []
    return targets.length === 1 ? targets[0] : undefined
  }

  for (const page of pages) {
    for (const raw of page.outLinks) {
      const target = bySlug.get(normalizeLinkTarget(raw))
      if (!target || target.id === page.id) continue
      count(page, target, 'wikilink')
    }
    for (const persisted of page.cites ?? []) {
      const target = uniqueTarget(citedPageId(persisted))
      if (!target || target.id === page.id) continue
      count(page, target, 'citation')
    }
    for (const contradicted of page.contradicts ?? []) {
      const target = uniqueTarget(contradicted)
      if (!target || target.id === page.id) continue
      count(page, target, 'contradicts')
    }
  }

  const relations: KnowledgePageRelation[] = [...authored.values()]
  for (let i = 0; i < pages.length; i++) {
    for (let j = i + 1; j < pages.length; j++) {
      const a = pages[i]!
      const b = pages[j]!
      const overlap = a.sourceIds.filter((source) => b.sourceIds.includes(source))
      if (overlap.length === 0) continue
      relations.push({
        sourceId: a.id,
        targetId: b.id,
        predicate: 'shared-source',
        weight: overlap.length * 0.5,
        metadata: { sourceIds: overlap },
      })
    }
  }
  return relations
}

/**
 * The weighted page graph: `knowledgePageRelations` collapsed to one edge per
 * ordered page pair, with the predicates merged into `reasons` and the weights
 * summed. `contradicts` stays out of this projection; read it from the relation
 * list. Node degrees count the authored `wikilink` and `citation` occurrences.
 */
export function buildKnowledgeGraph(pages: KnowledgePage[]): KnowledgeGraph {
  const incoming = new Map<string, number>()
  const outgoing = new Map<string, number>()
  for (const page of pages) {
    outgoing.set(page.id, 0)
    incoming.set(page.id, 0)
  }

  const edgesByKey = new Map<string, KnowledgeGraphEdge>()
  for (const relation of knowledgePageRelations(pages)) {
    if (relation.predicate === 'contradicts') continue
    const key = `${relation.sourceId}->${relation.targetId}`
    let edge = edgesByKey.get(key)
    if (!edge) {
      edge = { source: relation.sourceId, target: relation.targetId, weight: 0, reasons: [] }
      edgesByKey.set(key, edge)
    }
    edge.weight += relation.weight
    if (!edge.reasons.includes(relation.predicate)) edge.reasons.push(relation.predicate)
    if (relation.predicate === 'wikilink' || relation.predicate === 'citation') {
      outgoing.set(relation.sourceId, (outgoing.get(relation.sourceId) ?? 0) + relation.weight)
      incoming.set(relation.targetId, (incoming.get(relation.targetId) ?? 0) + relation.weight)
    }
  }

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

/**
 * An origin-qualified citation (`here::x`, `inherited:<run>::x`, `shared::x`)
 * must keep its graph edge: qualification is the documented remedy for an
 * ambiguous id, so it cannot cost the citation signal. A value the parser
 * rejects stays a literal page id so index builds never fail on stored data.
 */
function citedPageId(persisted: string): string {
  try {
    return parseKnowledgeCitationReference(persisted).pageId
  } catch {
    return persisted
  }
}
