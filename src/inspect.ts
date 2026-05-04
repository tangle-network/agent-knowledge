import type { KnowledgeIndex, KnowledgeLintFinding, KnowledgePage } from './types'
import { lintKnowledgeIndex } from './lint'
import { searchKnowledge } from './search'

export interface KnowledgeInspection {
  pageCount: number
  sourceCount: number
  expiredSourceCount: number
  staleSourceCount: number
  edgeCount: number
  findingCount: number
  blockingFindingCount: number
  topPages: Array<{ path: string; title: string; degree: number; sources: number }>
  sourceFreshness: SourceFreshnessInspection[]
  findings: KnowledgeLintFinding[]
}

export interface SourceFreshnessInspection {
  id: string
  title?: string
  uri: string
  status: 'fresh' | 'expired' | 'unknown'
  validUntil?: string
  lastVerifiedAt?: string
}

export function inspectKnowledgeIndex(index: KnowledgeIndex, options: { now?: Date } = {}): KnowledgeInspection {
  const now = options.now ?? new Date()
  const findings = lintKnowledgeIndex(index)
  const degree = new Map(index.graph.nodes.map((node) => [node.id, node.inDegree + node.outDegree]))
  const sourceFreshness = index.sources.map((source) => inspectSourceFreshness(source, now))
  return {
    pageCount: index.pages.length,
    sourceCount: index.sources.length,
    expiredSourceCount: sourceFreshness.filter((source) => source.status === 'expired').length,
    staleSourceCount: sourceFreshness.filter((source) => source.status !== 'fresh').length,
    edgeCount: index.graph.edges.length,
    findingCount: findings.length,
    blockingFindingCount: findings.filter((finding) => finding.severity === 'error').length,
    topPages: [...index.pages]
      .sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
      .slice(0, 10)
      .map((page) => ({ path: page.path, title: page.title, degree: degree.get(page.id) ?? 0, sources: page.sourceIds.length })),
    sourceFreshness,
    findings,
  }
}

function inspectSourceFreshness(source: KnowledgeIndex['sources'][number], now: Date): SourceFreshnessInspection {
  const validUntil = source.validUntil ?? stringMetadata(source.metadata, 'validUntil') ?? stringMetadata(source.metadata, 'expiresAt')
  const lastVerifiedAt = source.lastVerifiedAt ?? stringMetadata(source.metadata, 'lastVerifiedAt')
  const status = validUntil && Number.isFinite(Date.parse(validUntil))
    ? Date.parse(validUntil) <= now.getTime() ? 'expired' : 'fresh'
    : 'unknown'
  return { id: source.id, title: source.title, uri: source.uri, status, validUntil, lastVerifiedAt }
}

function stringMetadata(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key]
  return typeof value === 'string' ? value : undefined
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
