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

export interface SourceRegistry {
  generatedAt: string
  sources: SourceRecord[]
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
  sources: SourceRecord[]
  pages: KnowledgePage[]
  graph: KnowledgeGraph
}

export interface KnowledgeSearchResult {
  page: KnowledgePage
  /**
   * Raw reciprocal rank fusion score. Mathematically meaningful for ordering
   * but not on a [0, 1] confidence scale — typical absolute values are in the
   * 0.01–0.05 range. Equal to `rrfScore`; preserved as `score` for backward
   * compatibility with consumers built against earlier releases.
   */
  score: number
  /** Alias of `score` — the raw RRF value. Use this when intent matters. */
  rrfScore: number
  /**
   * Score linearly normalized to [0, 1] relative to the top hit *in this
   * result set*. The top hit is always 1 (when present); subsequent hits are
   * `score / topScore`. Designed to match human intuition for "how confident
   * is this match" — safe to compare against fixed thresholds. Note: this is
   * a within-set ranking, not a cross-query absolute confidence.
   */
  normalizedScore: number
  rank: number
  snippet: string
  reasons: string[]
}

export interface KnowledgeLintFinding {
  type:
    | 'broken-link'
    | 'orphan'
    | 'no-outlinks'
    | 'uncited-claim'
    | 'missing-source'
    | 'duplicate-title'
    | 'duplicate-page-id'
    | 'duplicate-source-hash'
    | 'missing-frontmatter'
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

export type KnowledgeEventType =
  | 'source.added'
  | 'proposal.applied'
  | 'index.built'
  | 'lint.run'
  | 'optimization.run'
  | 'release.promoted'
  | 'release.rejected'

export interface KnowledgeEvent {
  id: string
  type: KnowledgeEventType
  createdAt: string
  actor?: string
  target?: string
  metadata?: Record<string, unknown>
}

export interface KnowledgeRelease {
  id: string
  candidateId: string
  createdAt: string
  promoted: boolean
  scorecard?: unknown
  runRecordIds?: string[]
  metadata?: Record<string, unknown>
}
