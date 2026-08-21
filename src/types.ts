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
  /** ISO timestamp after which consumers should treat this source as stale. */
  validUntil?: string
  /** ISO timestamp for the last successful source freshness verification. */
  lastVerifiedAt?: string
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

/** A caller-declared vertex of a labeled relation graph. */
export interface KnowledgeRelationNode {
  id: KnowledgeId
  /** Caller vocabulary, such as `run`, `claim`, `page`, or `model`. */
  kind: string
  label?: string
  metadata?: Record<string, unknown>
}

/** A labeled multi-edge graph with one edge per `(sourceId, targetId, predicate)`. */
export interface KnowledgeRelationGraph {
  /** Declared nodes in declaration order; empty when the graph was built from relations alone. */
  nodes: KnowledgeRelationNode[]
  edges: KnowledgeRelation[]
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

/**
 * A page that its own independently executed evidence has refuted.
 *
 * This is deliberately asymmetric. A competing page can remain live while this
 * page is dead because the check recorded on this page contradicted it. An
 * unresolved disagreement belongs in the claim ledger's symmetric `contested`
 * relation instead and must not be encoded as an invalidation.
 */
export interface KnowledgePageInvalidation {
  verdict: 'contradicted'
  observedAt: string
  reason: string
  evidencePath?: string
  grader?: string
  metadata?: Record<string, unknown>
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
  /** Stable page ids this page explicitly builds on. */
  cites?: KnowledgeId[]
  /** Page ids this page explicitly refutes. */
  contradicts?: KnowledgeId[]
  /** Present only when this page's own evidence has refuted the page. */
  invalidation?: KnowledgePageInvalidation
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
    | 'broken-citation'
    | 'ambiguous-citation'
    | 'orphan'
    | 'no-outlinks'
    | 'uncited-claim'
    | 'missing-source'
    | 'duplicate-title'
    | 'duplicate-page-id'
    | 'duplicate-source-hash'
    | 'missing-frontmatter'
    | 'ungradeable-evidence'
    | 'missing-evidence-path'
    | 'nonportable-evidence'
    | 'broken-contradiction'
    | 'invalid-invalidation'
    | 'cites-invalidated'
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

/**
 * The event vocabulary, as a value so the runtime schema is DERIVED from it
 * rather than restated. A restated copy in `schemas.ts` drifted: it omitted
 * `research.iteration`, which is the only event `runVerifiedResearchLoop`
 * produces, so every attempt to store one would have been rejected. Nothing
 * caught it because nothing ever stored an event. Add a type here and the
 * schema accepts it in the same edit.
 */
export const KNOWLEDGE_EVENT_TYPES = [
  'source.added',
  'proposal.applied',
  'index.built',
  'lint.run',
  'research.iteration',
  'optimization.run',
  'release.promoted',
  'release.rejected',
] as const

export type KnowledgeEventType = (typeof KNOWLEDGE_EVENT_TYPES)[number]

export interface KnowledgeEvent {
  id: string
  type: KnowledgeEventType
  createdAt: string
  actor?: string
  target?: string
  metadata?: Record<string, unknown>
}

/** The four deep sub-question kinds a research driver raises to drive depth. */
export type DeepQuestionKind = 'comparative' | 'mechanism' | 'gap' | 'contradiction'

/**
 * A deep sub-question the research driver folds into the worker's next prompt.
 *
 * Lives here, next to the other record types, because it is persisted state:
 * `addressed` is the half of the completion oracle that cannot be recomputed
 * from the claim ledger alone, so a run that loses it reports "complete" for
 * questions nobody ever answered.
 */
export interface DeepQuestion {
  kind: DeepQuestionKind
  text: string
  /** sha256-derived stable id, so "addressed" can be tracked across rounds. */
  id: string
  /** Claim id(s) this question interrogates (for contradiction/mechanism kinds). */
  claimIds: string[]
  /** True once a later round's evidence addressed it. */
  addressed: boolean
  /** The round this question was raised in. */
  raisedRound: number
}

/** One live tracked claim exposed by the research-driving API. */
export interface TrackedClaim {
  id: string
  /** The claim text as first extracted (kept for prompts/audit). */
  text: string
  /** Canonical hosts of the INDEPENDENT sources that assert this claim. */
  supportingHosts: Set<string>
  /** Source URIs that assert this claim (provenance; may share a host). */
  supportingUris: string[]
  /** Claim ids this claim was found to CONTRADICT (and vice versa). */
  contradicts: Set<string>
  /**
   * CONTESTED = a contradiction the loop surfaced but could not resolve to a
   * single supported claim. A contested claim counts as "settled enough to be
   * done" (we report the disagreement) even with < 2 independent sources.
   */
  contested: boolean
  firstSeenRound: number
}

/**
 * JSON-safe form of a tracked claim stored in a research claim ledger.
 *
 * The live `TrackedClaim` contract retains its published `Set` fields.
 * Durable records use sorted arrays because `JSON.stringify` turns a `Set`
 * into `{}`, which would erase every corroboration count and contradiction.
 */
export interface ResearchClaimRecord {
  id: string
  text: string
  supportingHosts: string[]
  supportingUris: string[]
  contradicts: string[]
  contested: boolean
  firstSeenRound: number
}

/** Immutable identity of one exact version of an original source URI. */
export interface ResearchSourceVersion {
  /** Canonical source-registry id for this URI and content hash. */
  sourceId: KnowledgeId
  /** The URI supplied before the source was copied into the raw-source store. */
  uri: string
  /** SHA-256 of the exact submitted source text. */
  contentHash: string
}

/**
 * One immutable claim extraction observed while a source is being verified.
 *
 * An observation is deliberately separate from `ResearchClaimRecord`: source
 * verification happens before source registration, and a process can die in
 * between. The observation is durable immediately, but it contributes support
 * to a claim only after its expected registry id, original URI, and content hash
 * appear together in the ledger's independently confirmed `registeredSources` set.
 */
export interface ResearchClaimEvidence {
  /** Stable identity of this claim/source/contradiction observation. */
  id: string
  claimId: string
  text: string
  /** Canonical source-registry id expected for this source version. */
  sourceId: KnowledgeId
  sourceUri: string
  /** SHA-256 of the exact source text from which this observation was extracted. */
  sourceContentHash: string
  /** Existing claim this observation directly contradicts, when reported. */
  contradictsClaimId?: string
  firstSeenRound: number
}

/**
 * The durable record of one research run's belief state: which claims were
 * extracted, how independently each is supported, which contradict which, and
 * which deep sub-questions are still open.
 *
 * `id` names the run — one knowledge base can host several, and they must not
 * overwrite each other, so the store addresses ledgers by this id.
 */
export interface ResearchClaimLedger {
  /** Persistent contract version; version 2 binds evidence to source content. */
  schemaVersion: 2
  id: string
  /** The research goal this ledger accumulated evidence for. */
  goal?: string
  /** ISO timestamp of the last write. */
  updatedAt: string
  /** How many rounds the driver has folded steer for. */
  rounds: number
  /**
   * Highest round durably announced before its synchronous question-generation
   * step began. Greater than `rounds` only while a round needs crash recovery.
   */
  preparedRounds?: number
  /**
   * Extracted evidence, including observations whose source registration has
   * not yet been confirmed. Pending observations never count toward claims.
   */
  claimEvidence: ResearchClaimEvidence[]
  /** Exact source-registry identities confirmed after their raw bytes were stored. */
  registeredSources: ResearchSourceVersion[]
  claims: ResearchClaimRecord[]
  questions: DeepQuestion[]
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
