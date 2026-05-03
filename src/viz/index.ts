import type { KnowledgeGraph, KnowledgeGraphEdge, KnowledgeGraphNode } from '../types'

export interface KnowledgeVizNode extends KnowledgeGraphNode {
  degree: number
  community: number
}

export interface KnowledgeVizEdge extends KnowledgeGraphEdge {
  id: string
}

export interface KnowledgeCommunity {
  id: number
  nodeIds: string[]
  topTitles: string[]
  cohesion: number
}

export interface KnowledgeVizGraph {
  nodes: KnowledgeVizNode[]
  edges: KnowledgeVizEdge[]
  communities: KnowledgeCommunity[]
}

export interface KnowledgeGap {
  type: 'isolated-node' | 'sparse-community' | 'bridge-node'
  title: string
  nodeIds: string[]
  suggestion: string
}

export interface SurprisingConnection {
  source: KnowledgeVizNode
  target: KnowledgeVizNode
  score: number
  reasons: string[]
}

export function toKnowledgeVizGraph(graph: KnowledgeGraph): KnowledgeVizGraph {
  const adjacency = buildAdjacency(graph)
  const communities = assignCommunities(graph.nodes, adjacency)
  const communityByNode = new Map<number, number>()
  communities.forEach((community) => {
    for (const nodeId of community.nodeIds) communityByNode.set(hashNode(nodeId), community.id)
  })
  const nodes = graph.nodes.map((node) => ({
    ...node,
    degree: node.inDegree + node.outDegree,
    community: communityByNode.get(hashNode(node.id)) ?? 0,
  }))
  return {
    nodes,
    edges: graph.edges.map((edge) => ({ ...edge, id: `${edge.source}->${edge.target}` })),
    communities,
  }
}

export function detectKnowledgeGaps(graph: KnowledgeVizGraph, limit = 10): KnowledgeGap[] {
  const gaps: KnowledgeGap[] = []
  const isolated = graph.nodes.filter((node) => node.degree <= 1 && !isStructural(node.path))
  if (isolated.length > 0) {
    gaps.push({
      type: 'isolated-node',
      title: `${isolated.length} isolated page${isolated.length === 1 ? '' : 's'}`,
      nodeIds: isolated.map((node) => node.id),
      suggestion: 'Add cross-links, sources, or follow-up research to connect these pages to the knowledge graph.',
    })
  }
  for (const community of graph.communities) {
    if (community.nodeIds.length >= 3 && community.cohesion < 0.15) {
      gaps.push({
        type: 'sparse-community',
        title: `Sparse cluster: ${community.topTitles[0] ?? `community ${community.id}`}`,
        nodeIds: community.nodeIds,
        suggestion: 'This cluster has weak internal evidence. Add synthesis pages or relation links between its strongest concepts.',
      })
    }
  }
  const byCommunityNeighbors = new Map<string, Set<number>>()
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  for (const edge of graph.edges) {
    const source = nodeById.get(edge.source)
    const target = nodeById.get(edge.target)
    if (!source || !target) continue
    if (!byCommunityNeighbors.has(source.id)) byCommunityNeighbors.set(source.id, new Set())
    if (!byCommunityNeighbors.has(target.id)) byCommunityNeighbors.set(target.id, new Set())
    byCommunityNeighbors.get(source.id)!.add(target.community)
    byCommunityNeighbors.get(target.id)!.add(source.community)
  }
  for (const node of graph.nodes) {
    if ((byCommunityNeighbors.get(node.id)?.size ?? 0) >= 3) {
      gaps.push({
        type: 'bridge-node',
        title: `Bridge page: ${node.title}`,
        nodeIds: [node.id],
        suggestion: 'This page connects multiple knowledge areas. Keep it well cited and current.',
      })
    }
  }
  return gaps.slice(0, limit)
}

export function findSurprisingConnections(graph: KnowledgeVizGraph, limit = 10): SurprisingConnection[] {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]))
  const scored: SurprisingConnection[] = []
  for (const edge of graph.edges) {
    const source = nodeById.get(edge.source)
    const target = nodeById.get(edge.target)
    if (!source || !target) continue
    let score = edge.weight
    const reasons = [...edge.reasons]
    if (source.community !== target.community) {
      score += 3
      reasons.push('cross-community')
    }
    if (source.tags.some((tag) => !target.tags.includes(tag))) {
      score += 1
      reasons.push('cross-tag')
    }
    if (score >= 3) scored.push({ source, target, score, reasons })
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit)
}

function buildAdjacency(graph: KnowledgeGraph): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const node of graph.nodes) out.set(node.id, new Set())
  for (const edge of graph.edges) {
    out.get(edge.source)?.add(edge.target)
    out.get(edge.target)?.add(edge.source)
  }
  return out
}

function assignCommunities(nodes: KnowledgeGraphNode[], adjacency: Map<string, Set<string>>): KnowledgeCommunity[] {
  const seen = new Set<string>()
  const communities: KnowledgeCommunity[] = []
  for (const node of nodes) {
    if (seen.has(node.id)) continue
    const queue = [node.id]
    const ids: string[] = []
    seen.add(node.id)
    while (queue.length > 0) {
      const id = queue.shift()!
      ids.push(id)
      for (const next of adjacency.get(id) ?? []) {
        if (!seen.has(next)) {
          seen.add(next)
          queue.push(next)
        }
      }
    }
    const memberNodes = ids.map((id) => nodes.find((candidate) => candidate.id === id)).filter((item): item is KnowledgeGraphNode => Boolean(item))
    communities.push({
      id: communities.length,
      nodeIds: ids,
      topTitles: memberNodes.sort((a, b) => b.inDegree + b.outDegree - (a.inDegree + a.outDegree)).slice(0, 5).map((item) => item.title),
      cohesion: cohesion(ids, adjacency),
    })
  }
  return communities.sort((a, b) => b.nodeIds.length - a.nodeIds.length)
}

function cohesion(ids: string[], adjacency: Map<string, Set<string>>): number {
  if (ids.length < 2) return 0
  let edges = 0
  const idSet = new Set(ids)
  for (const id of ids) {
    for (const next of adjacency.get(id) ?? []) {
      if (idSet.has(next)) edges++
    }
  }
  return edges / (ids.length * (ids.length - 1))
}

function hashNode(id: string): number {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return hash
}

function isStructural(path: string): boolean {
  return path.endsWith('/index.md') || path.endsWith('/log.md')
}
