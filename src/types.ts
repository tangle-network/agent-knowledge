export type KnowledgeId = string

export interface SourceAnchor {
  id: string
  sourceId: string
  label?: string
  page?: number
  lineStart?: number
  lineEnd?: number
  charStart?: number
  charEnd?: number
  timestampMs?: number
  metadata?: Record<string, unknown>
}

export interface SourceRecord {
  id: KnowledgeId
  uri: string
  title?: string
  mediaType?: string
  contentHash: string
  text?: string
  anchors?: SourceAnchor[]
  metadata?: Record<string, unknown>
  createdAt: string
}

export interface ClaimRef {
  sourceId: string
  anchorId?: string
  quote?: string
}

export interface KnowledgeClaim {
  id: KnowledgeId
  text: string
  refs: ClaimRef[]
  confidence?: number
  status?: 'draft' | 'active' | 'superseded' | 'rejected'
  metadata?: Record<string, unknown>
}

export interface KnowledgeRelation {
  sourceId: KnowledgeId
  targetId: KnowledgeId
  predicate: string
  weight?: number
  metadata?: Record<string, unknown>
}

export interface KnowledgeUnit {
  id: KnowledgeId
  title: string
  text: string
  claims?: KnowledgeClaim[]
  relations?: KnowledgeRelation[]
  sourceIds?: string[]
  tags?: string[]
  metadata?: Record<string, unknown>
  updatedAt?: string
}

export interface KnowledgePage {
  id: KnowledgeId
  path: string
  title: string
  text: string
  frontmatter: Record<string, unknown>
  sourceIds: string[]
  tags: string[]
  outLinks: string[]
}

export interface KnowledgeGraphNode {
  id: KnowledgeId
  title: string
  path: string
  tags: string[]
  sourceIds: string[]
  outDegree: number
  inDegree: number
}

export interface KnowledgeGraphEdge {
  source: KnowledgeId
  target: KnowledgeId
  weight: number
  reasons: string[]
}

export interface KnowledgeGraph {
  nodes: KnowledgeGraphNode[]
  edges: KnowledgeGraphEdge[]
}

export interface KnowledgeIndex {
  root: string
  generatedAt: string
  pages: KnowledgePage[]
  graph: KnowledgeGraph
}

export interface KnowledgeSearchResult {
  page: KnowledgePage
  score: number
  rank: number
  snippet: string
  reasons: string[]
}

export interface KnowledgeLintFinding {
  type: 'broken-link' | 'orphan' | 'no-outlinks' | 'uncited-claim' | 'missing-source' | 'duplicate-title'
  severity: 'info' | 'warning' | 'error'
  page?: string
  message: string
  metadata?: Record<string, unknown>
}

export interface KnowledgePolicy {
  id: string
  description?: string
  requiredCitationRate?: number
  allowedPathPrefixes?: string[]
  metadata?: Record<string, unknown>
}

export interface KnowledgeBaseCandidate {
  id: KnowledgeId
  units: KnowledgeUnit[]
  retrievalPolicy?: string
  synthesisPolicy?: string
  questionPolicy?: string
  updatePolicy?: string
  metadata?: Record<string, unknown>
}

export interface KnowledgeWriteBlock {
  path: string
  content: string
}

export interface KnowledgeWriteParseResult {
  blocks: KnowledgeWriteBlock[]
  warnings: string[]
}
