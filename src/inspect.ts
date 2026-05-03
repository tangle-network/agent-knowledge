import type { KnowledgeIndex, KnowledgeLintFinding, KnowledgePage } from './types'
import { lintKnowledgeIndex } from './lint'
import { searchKnowledge } from './search'

export interface KnowledgeInspection {
  pageCount: number
  sourceCount: number
  edgeCount: number
  findingCount: number
  blockingFindingCount: number
  topPages: Array<{ path: string; title: string; degree: number; sources: number }>
  findings: KnowledgeLintFinding[]
}

export function inspectKnowledgeIndex(index: KnowledgeIndex): KnowledgeInspection {
  const findings = lintKnowledgeIndex(index)
  const degree = new Map(index.graph.nodes.map((node) => [node.id, node.inDegree + node.outDegree]))
  return {
    pageCount: index.pages.length,
    sourceCount: index.sources.length,
    edgeCount: index.graph.edges.length,
    findingCount: findings.length,
    blockingFindingCount: findings.filter((finding) => finding.severity === 'error').length,
    topPages: [...index.pages]
      .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
      .slice(0, 10)
      .map((page) => ({ path: page.path, title: page.title, degree: degree.get(page.id) ?? 0, sources: page.sourceIds.length })),
    findings,
  }
}

export interface KnowledgeExplanation {
  target: string
  page?: KnowledgePage
  sources: Array<{ id: string; title?: string; uri: string }>
  links: string[]
  inbound: string[]
  related: Array<{ path: string; title: string; score: number }>
}

export function explainKnowledgeTarget(index: KnowledgeIndex, target: string): KnowledgeExplanation {
  const page = index.pages.find((candidate) => candidate.path === target || candidate.id === target || candidate.title.toLowerCase() === target.toLowerCase())
  const inbound = page
    ? index.graph.edges.filter((edge) => edge.target === page.id).map((edge) => index.pages.find((candidate) => candidate.id === edge.source)?.path ?? edge.source)
    : []
  const related = page
    ? searchKnowledge(index, `${page.title} ${page.tags.join(' ')}`, 6)
        .filter((result) => result.page.id !== page.id)
        .map((result) => ({ path: result.page.path, title: result.page.title, score: result.score }))
    : searchKnowledge(index, target, 6).map((result) => ({ path: result.page.path, title: result.page.title, score: result.score }))
  return {
    target,
    page,
    sources: page ? index.sources.filter((source) => page.sourceIds.includes(source.id)).map((source) => ({ id: source.id, title: source.title, uri: source.uri })) : [],
    links: page?.outLinks ?? [],
    inbound,
    related,
  }
}
