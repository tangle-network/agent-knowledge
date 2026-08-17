import type { EvidenceRef } from '@tangle-network/agent-eval/analyst'
import {
  canonicalCandidateDigest,
  type Sha256Digest,
  sha256DigestSchema,
} from '@tangle-network/agent-interface'
import type { OriginatedPage, PageOrigin } from './run-scoped'
import type { KnowledgePage, KnowledgeSearchResult } from './types'

export const KNOWLEDGE_USE_RECEIPT_SCHEMA_VERSION = '1.0.0' as const
export const KNOWLEDGE_RECEIPT_DIGEST_ALGORITHM = 'rfc8785-sha256' as const

export interface KnowledgeVisibilitySnapshotEntry {
  readonly position: number
  readonly pageId: string
  readonly origin: PageOrigin
  readonly path: string
  readonly pageDigest: Sha256Digest
  readonly sourceIds: readonly string[]
  readonly invalidated: boolean
}

/** Exact ordered page visibility presented to one retrieval operation. */
export interface KnowledgeVisibilitySnapshot {
  readonly schemaVersion: typeof KNOWLEDGE_USE_RECEIPT_SCHEMA_VERSION
  readonly digestAlgorithm: typeof KNOWLEDGE_RECEIPT_DIGEST_ALGORITHM
  readonly snapshotDigest: Sha256Digest
  readonly entries: readonly KnowledgeVisibilitySnapshotEntry[]
}

export interface KnowledgeRetrieverIdentity {
  /** Stable implementation name, for example `token-overlap-v1`. */
  readonly id: string
  /** Published or application-defined implementation version. */
  readonly version: string
  /** Exact identity of every retrieval setting not represented elsewhere. */
  readonly configDigest: Sha256Digest
}

export interface OriginatedKnowledgeSearchResult extends KnowledgeSearchResult {
  readonly origin: PageOrigin
}

export interface KnowledgeRetrievalResultReceipt {
  readonly rank: number
  readonly pageId: string
  readonly origin: PageOrigin
  readonly path: string
  readonly pageDigest: Sha256Digest
  readonly rrfScore: number
  readonly normalizedScore: number
  readonly snippet: string
  readonly reasons: readonly string[]
}

export type KnowledgeReceiptAttributeValue = string | number | boolean | null

/**
 * Immutable proof of what one actor could see and what its retriever returned.
 * Final prose is not evidence that retrieval happened; this receipt is.
 */
export interface KnowledgeRetrievalReceipt {
  readonly schemaVersion: typeof KNOWLEDGE_USE_RECEIPT_SCHEMA_VERSION
  readonly kind: 'knowledge-retrieval'
  readonly digestAlgorithm: typeof KNOWLEDGE_RECEIPT_DIGEST_ALGORITHM
  readonly receiptDigest: Sha256Digest
  readonly createdAt: string
  readonly runId: string
  readonly actorId?: string
  readonly profileDigest?: Sha256Digest
  readonly executionRef?: Sha256Digest
  readonly query: string
  readonly retriever: KnowledgeRetrieverIdentity
  readonly visibility: KnowledgeVisibilitySnapshot
  readonly results: readonly KnowledgeRetrievalResultReceipt[]
  readonly evidenceRefs: readonly EvidenceRef[]
  readonly attributes: Readonly<Record<string, KnowledgeReceiptAttributeValue>>
}

export interface CreateKnowledgeRetrievalReceiptInput {
  readonly runId: string
  readonly actorId?: string
  readonly profileDigest?: Sha256Digest
  readonly executionRef?: Sha256Digest
  readonly query: string
  readonly retriever: KnowledgeRetrieverIdentity
  readonly visiblePages: readonly OriginatedPage[]
  readonly results: readonly OriginatedKnowledgeSearchResult[]
  readonly evidenceRefs?: readonly EvidenceRef[]
  readonly attributes?: Readonly<Record<string, KnowledgeReceiptAttributeValue>>
  readonly createdAt?: Date | string
}

export type KnowledgeUseRelation =
  | 'supports'
  | 'contradicts'
  | 'extends'
  | 'rederives'
  | 'background'

export type KnowledgeConsumerKind =
  | 'decision'
  | 'artifact'
  | 'experiment'
  | 'candidate'
  | 'message'
  | 'other'

export interface KnowledgeConsumerRef {
  readonly kind: KnowledgeConsumerKind
  readonly uri: string
  readonly digest?: Sha256Digest
}

export interface KnowledgeUsedResult {
  readonly rank: number
  readonly pageId: string
  readonly origin: PageOrigin
  readonly path: string
  readonly pageDigest: Sha256Digest
}

/**
 * Immutable proof that one retrieved page was selected for a downstream
 * decision, artifact, experiment, candidate, or message.
 */
export interface KnowledgeUseReceipt {
  readonly schemaVersion: typeof KNOWLEDGE_USE_RECEIPT_SCHEMA_VERSION
  readonly kind: 'knowledge-use'
  readonly digestAlgorithm: typeof KNOWLEDGE_RECEIPT_DIGEST_ALGORITHM
  readonly receiptDigest: Sha256Digest
  readonly createdAt: string
  readonly runId: string
  readonly actorId?: string
  readonly profileDigest?: Sha256Digest
  readonly executionRef?: Sha256Digest
  readonly retrievalReceiptDigest: Sha256Digest
  readonly used: KnowledgeUsedResult
  readonly relation: KnowledgeUseRelation
  readonly consumer: KnowledgeConsumerRef
  readonly evidenceRefs: readonly EvidenceRef[]
  readonly attributes: Readonly<Record<string, KnowledgeReceiptAttributeValue>>
}

export interface CreateKnowledgeUseReceiptInput {
  readonly retrieval: KnowledgeRetrievalReceipt
  /** Exact one-based rank from the retrieval receipt. */
  readonly selectedRank: number
  readonly relation: KnowledgeUseRelation
  readonly consumer: KnowledgeConsumerRef
  readonly evidenceRefs?: readonly EvidenceRef[]
  readonly attributes?: Readonly<Record<string, KnowledgeReceiptAttributeValue>>
  readonly createdAt?: Date | string
}

/** Stable content identity for one exact knowledge page. */
export function knowledgePageDigest(page: KnowledgePage): Sha256Digest {
  validateKnowledgePage(page)
  return canonicalCandidateDigest({
    id: page.id,
    path: page.path,
    title: page.title,
    text: page.text,
    frontmatter: page.frontmatter,
    sourceIds: [...page.sourceIds],
    tags: [...page.tags],
    outLinks: [...page.outLinks],
    contradicts: [...(page.contradicts ?? [])],
    invalidation: page.invalidation ?? null,
  })
}

/** Snapshot the exact ordered current/ancestor/shared page view. */
export function createKnowledgeVisibilitySnapshot(
  visiblePages: readonly OriginatedPage[],
): KnowledgeVisibilitySnapshot {
  if (!Array.isArray(visiblePages)) {
    throw new TypeError('knowledge visibility must be an array')
  }
  const identities = new Set<string>()
  const entries = visiblePages.map((entry, position) => {
    if (!entry || typeof entry !== 'object') {
      throw new TypeError(`knowledge visibility[${position}] must be an originated page`)
    }
    const origin = validateOrigin(entry.origin, `knowledge visibility[${position}].origin`)
    validateKnowledgePage(entry.page)
    const identity = `${origin}\u0000${entry.page.path}`
    if (identities.has(identity)) {
      throw new Error(
        `knowledge visibility repeats path '${entry.page.path}' at origin '${origin}'`,
      )
    }
    identities.add(identity)
    return Object.freeze({
      position,
      pageId: entry.page.id,
      origin,
      path: entry.page.path,
      pageDigest: knowledgePageDigest(entry.page),
      sourceIds: Object.freeze([...entry.page.sourceIds]),
      invalidated: entry.page.invalidation !== undefined,
    })
  })
  const material = visibilityMaterial(entries)
  return Object.freeze({
    ...material,
    snapshotDigest: canonicalCandidateDigest(material),
    entries: Object.freeze(entries),
  })
}

/** Create a retrieval receipt and refuse results that were not in the view. */
export function createKnowledgeRetrievalReceipt(
  input: CreateKnowledgeRetrievalReceiptInput,
): KnowledgeRetrievalReceipt {
  if (!input || typeof input !== 'object') {
    throw new TypeError('knowledge retrieval receipt input is required')
  }
  const runId = nonEmpty(input.runId, 'knowledge retrieval runId')
  const actorId = optionalText(input.actorId, 'knowledge retrieval actorId')
  const profileDigest = optionalDigest(input.profileDigest, 'knowledge retrieval profileDigest')
  const executionRef = optionalDigest(input.executionRef, 'knowledge retrieval executionRef')
  const query = nonEmpty(input.query, 'knowledge retrieval query')
  const retriever = normalizeRetriever(input.retriever)
  const visibility = createKnowledgeVisibilitySnapshot(input.visiblePages)
  const results = normalizeRetrievalResults(input.results, visibility)
  const evidenceRefs = normalizeEvidenceRefs(input.evidenceRefs ?? [])
  const attributes = normalizeAttributes(input.attributes ?? {})
  const createdAt = isoTimestamp(input.createdAt, 'knowledge retrieval createdAt')
  const material = retrievalMaterial({
    createdAt,
    runId,
    actorId,
    profileDigest,
    executionRef,
    query,
    retriever,
    visibility,
    results,
    evidenceRefs,
    attributes,
  })
  return Object.freeze({
    ...material,
    receiptDigest: canonicalCandidateDigest(material),
  })
}

/** Verify the receipt's schema, internal joins, and canonical digest. */
export function verifyKnowledgeRetrievalReceipt(
  receipt: KnowledgeRetrievalReceipt,
): KnowledgeRetrievalReceipt {
  if (!receipt || typeof receipt !== 'object') {
    throw new TypeError('knowledge retrieval receipt is required')
  }
  if (receipt.schemaVersion !== KNOWLEDGE_USE_RECEIPT_SCHEMA_VERSION) {
    throw new Error(`unsupported knowledge retrieval schemaVersion '${receipt.schemaVersion}'`)
  }
  if (receipt.kind !== 'knowledge-retrieval') {
    throw new Error(`knowledge retrieval receipt kind must be 'knowledge-retrieval'`)
  }
  if (receipt.digestAlgorithm !== KNOWLEDGE_RECEIPT_DIGEST_ALGORITHM) {
    throw new Error(`unsupported knowledge retrieval digestAlgorithm '${receipt.digestAlgorithm}'`)
  }
  const expectedVisibility = canonicalCandidateDigest(
    visibilityMaterial(receipt.visibility.entries),
  )
  if (expectedVisibility !== receipt.visibility.snapshotDigest) {
    throw new Error('knowledge retrieval visibility snapshot digest mismatch')
  }
  validateReceiptResults(receipt.results, receipt.visibility)
  const material = retrievalMaterial({
    createdAt: isoTimestamp(receipt.createdAt, 'knowledge retrieval createdAt'),
    runId: nonEmpty(receipt.runId, 'knowledge retrieval runId'),
    actorId: optionalText(receipt.actorId, 'knowledge retrieval actorId'),
    profileDigest: optionalDigest(receipt.profileDigest, 'knowledge retrieval profileDigest'),
    executionRef: optionalDigest(receipt.executionRef, 'knowledge retrieval executionRef'),
    query: nonEmpty(receipt.query, 'knowledge retrieval query'),
    retriever: normalizeRetriever(receipt.retriever),
    visibility: receipt.visibility,
    results: receipt.results,
    evidenceRefs: normalizeEvidenceRefs(receipt.evidenceRefs),
    attributes: normalizeAttributes(receipt.attributes),
  })
  const expected = canonicalCandidateDigest(material)
  if (expected !== receipt.receiptDigest) {
    throw new Error('knowledge retrieval receipt digest mismatch')
  }
  return receipt
}

/** Prove that a receipt still describes the supplied visibility bytes. */
export function assertKnowledgeRetrievalMatchesVisibility(
  receipt: KnowledgeRetrievalReceipt,
  visiblePages: readonly OriginatedPage[],
): void {
  verifyKnowledgeRetrievalReceipt(receipt)
  const observed = createKnowledgeVisibilitySnapshot(visiblePages)
  if (observed.snapshotDigest !== receipt.visibility.snapshotDigest) {
    throw new Error('knowledge retrieval receipt does not match the supplied visibility snapshot')
  }
}

/** Create a downstream-use receipt for one exact ranked result. */
export function createKnowledgeUseReceipt(
  input: CreateKnowledgeUseReceiptInput,
): KnowledgeUseReceipt {
  if (!input || typeof input !== 'object') {
    throw new TypeError('knowledge use receipt input is required')
  }
  const retrieval = verifyKnowledgeRetrievalReceipt(input.retrieval)
  if (!Number.isSafeInteger(input.selectedRank) || input.selectedRank < 1) {
    throw new TypeError('knowledge use selectedRank must be a positive safe integer')
  }
  const selected = retrieval.results.find((result) => result.rank === input.selectedRank)
  if (!selected) {
    throw new Error(
      `knowledge use selectedRank ${input.selectedRank} was not returned by retrieval ${retrieval.receiptDigest}`,
    )
  }
  const relation = validateUseRelation(input.relation)
  const consumer = normalizeConsumer(input.consumer)
  const evidenceRefs = normalizeEvidenceRefs(input.evidenceRefs ?? [])
  const attributes = normalizeAttributes(input.attributes ?? {})
  const createdAt = isoTimestamp(input.createdAt, 'knowledge use createdAt')
  const used = Object.freeze({
    rank: selected.rank,
    pageId: selected.pageId,
    origin: selected.origin,
    path: selected.path,
    pageDigest: selected.pageDigest,
  })
  const material = useMaterial({
    createdAt,
    retrieval,
    used,
    relation,
    consumer,
    evidenceRefs,
    attributes,
  })
  return Object.freeze({
    ...material,
    receiptDigest: canonicalCandidateDigest(material),
  })
}

/** Verify one use receipt against the exact retrieval that authorized it. */
export function verifyKnowledgeUseReceipt(
  receipt: KnowledgeUseReceipt,
  retrieval: KnowledgeRetrievalReceipt,
): KnowledgeUseReceipt {
  if (!receipt || typeof receipt !== 'object') {
    throw new TypeError('knowledge use receipt is required')
  }
  const verifiedRetrieval = verifyKnowledgeRetrievalReceipt(retrieval)
  if (receipt.schemaVersion !== KNOWLEDGE_USE_RECEIPT_SCHEMA_VERSION) {
    throw new Error(`unsupported knowledge use schemaVersion '${receipt.schemaVersion}'`)
  }
  if (receipt.kind !== 'knowledge-use') {
    throw new Error(`knowledge use receipt kind must be 'knowledge-use'`)
  }
  if (receipt.digestAlgorithm !== KNOWLEDGE_RECEIPT_DIGEST_ALGORITHM) {
    throw new Error(`unsupported knowledge use digestAlgorithm '${receipt.digestAlgorithm}'`)
  }
  if (receipt.retrievalReceiptDigest !== verifiedRetrieval.receiptDigest) {
    throw new Error('knowledge use receipt references a different retrieval receipt')
  }
  const selected = verifiedRetrieval.results.find((result) => result.rank === receipt.used.rank)
  if (
    !selected ||
    selected.pageId !== receipt.used.pageId ||
    selected.origin !== receipt.used.origin ||
    selected.path !== receipt.used.path ||
    selected.pageDigest !== receipt.used.pageDigest
  ) {
    throw new Error('knowledge use receipt selected result does not match the retrieval receipt')
  }
  const material = useMaterial({
    createdAt: isoTimestamp(receipt.createdAt, 'knowledge use createdAt'),
    retrieval: verifiedRetrieval,
    used: receipt.used,
    relation: validateUseRelation(receipt.relation),
    consumer: normalizeConsumer(receipt.consumer),
    evidenceRefs: normalizeEvidenceRefs(receipt.evidenceRefs),
    attributes: normalizeAttributes(receipt.attributes),
  })
  const expected = canonicalCandidateDigest(material)
  if (expected !== receipt.receiptDigest) {
    throw new Error('knowledge use receipt digest mismatch')
  }
  return receipt
}

function visibilityMaterial(entries: readonly KnowledgeVisibilitySnapshotEntry[]) {
  return {
    schemaVersion: KNOWLEDGE_USE_RECEIPT_SCHEMA_VERSION,
    digestAlgorithm: KNOWLEDGE_RECEIPT_DIGEST_ALGORITHM,
    entries: entries.map((entry, position) => {
      if (entry.position !== position) {
        throw new Error(
          `knowledge visibility position mismatch: expected ${position}, observed ${entry.position}`,
        )
      }
      return {
        position,
        pageId: nonEmpty(entry.pageId, `knowledge visibility[${position}].pageId`),
        origin: validateOrigin(entry.origin, `knowledge visibility[${position}].origin`),
        path: nonEmpty(entry.path, `knowledge visibility[${position}].path`),
        pageDigest: digest(entry.pageDigest, `knowledge visibility[${position}].pageDigest`),
        sourceIds: entry.sourceIds.map((sourceId, sourceIndex) =>
          nonEmpty(sourceId, `knowledge visibility[${position}].sourceIds[${sourceIndex}]`),
        ),
        invalidated: Boolean(entry.invalidated),
      }
    }),
  } as const
}

function retrievalMaterial(input: {
  createdAt: string
  runId: string
  actorId?: string
  profileDigest?: Sha256Digest
  executionRef?: Sha256Digest
  query: string
  retriever: KnowledgeRetrieverIdentity
  visibility: KnowledgeVisibilitySnapshot
  results: readonly KnowledgeRetrievalResultReceipt[]
  evidenceRefs: readonly EvidenceRef[]
  attributes: Readonly<Record<string, KnowledgeReceiptAttributeValue>>
}) {
  return {
    schemaVersion: KNOWLEDGE_USE_RECEIPT_SCHEMA_VERSION,
    kind: 'knowledge-retrieval' as const,
    digestAlgorithm: KNOWLEDGE_RECEIPT_DIGEST_ALGORITHM,
    createdAt: input.createdAt,
    runId: input.runId,
    ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
    ...(input.profileDigest === undefined ? {} : { profileDigest: input.profileDigest }),
    ...(input.executionRef === undefined ? {} : { executionRef: input.executionRef }),
    query: input.query,
    retriever: input.retriever,
    visibility: input.visibility,
    results: input.results,
    evidenceRefs: input.evidenceRefs,
    attributes: input.attributes,
  }
}

function useMaterial(input: {
  createdAt: string
  retrieval: KnowledgeRetrievalReceipt
  used: KnowledgeUsedResult
  relation: KnowledgeUseRelation
  consumer: KnowledgeConsumerRef
  evidenceRefs: readonly EvidenceRef[]
  attributes: Readonly<Record<string, KnowledgeReceiptAttributeValue>>
}) {
  return {
    schemaVersion: KNOWLEDGE_USE_RECEIPT_SCHEMA_VERSION,
    kind: 'knowledge-use' as const,
    digestAlgorithm: KNOWLEDGE_RECEIPT_DIGEST_ALGORITHM,
    createdAt: input.createdAt,
    runId: input.retrieval.runId,
    ...(input.retrieval.actorId === undefined ? {} : { actorId: input.retrieval.actorId }),
    ...(input.retrieval.profileDigest === undefined
      ? {}
      : { profileDigest: input.retrieval.profileDigest }),
    ...(input.retrieval.executionRef === undefined
      ? {}
      : { executionRef: input.retrieval.executionRef }),
    retrievalReceiptDigest: input.retrieval.receiptDigest,
    used: input.used,
    relation: input.relation,
    consumer: input.consumer,
    evidenceRefs: input.evidenceRefs,
    attributes: input.attributes,
  }
}

function normalizeRetrievalResults(
  results: readonly OriginatedKnowledgeSearchResult[],
  visibility: KnowledgeVisibilitySnapshot,
): readonly KnowledgeRetrievalResultReceipt[] {
  if (!Array.isArray(results)) throw new TypeError('knowledge retrieval results must be an array')
  const visible = new Map(
    visibility.entries.map((entry) => [`${entry.origin}\u0000${entry.path}`, entry]),
  )
  const seenRanks = new Set<number>()
  const seenPages = new Set<string>()
  const normalized = results.map((result, index) => {
    if (!result || typeof result !== 'object') {
      throw new TypeError(`knowledge retrieval results[${index}] must be an object`)
    }
    if (!Number.isSafeInteger(result.rank) || result.rank < 1) {
      throw new TypeError(`knowledge retrieval results[${index}].rank must be positive`)
    }
    if (seenRanks.has(result.rank)) {
      throw new Error(`knowledge retrieval repeats rank ${result.rank}`)
    }
    seenRanks.add(result.rank)
    const origin = validateOrigin(result.origin, `knowledge retrieval results[${index}].origin`)
    validateKnowledgePage(result.page)
    const key = `${origin}\u0000${result.page.path}`
    if (seenPages.has(key)) {
      throw new Error(
        `knowledge retrieval repeats page '${result.page.path}' at origin '${origin}'`,
      )
    }
    seenPages.add(key)
    const visibleEntry = visible.get(key)
    if (!visibleEntry) {
      throw new Error(
        `knowledge retrieval result '${result.page.path}' at origin '${origin}' was not visible`,
      )
    }
    const pageDigest = knowledgePageDigest(result.page)
    if (visibleEntry.pageId !== result.page.id || visibleEntry.pageDigest !== pageDigest) {
      throw new Error(
        `knowledge retrieval result '${result.page.path}' does not match its visibility snapshot`,
      )
    }
    finite(result.rrfScore, `knowledge retrieval results[${index}].rrfScore`)
    finite(result.normalizedScore, `knowledge retrieval results[${index}].normalizedScore`)
    if (result.normalizedScore < 0 || result.normalizedScore > 1) {
      throw new TypeError(`knowledge retrieval results[${index}].normalizedScore must be in [0,1]`)
    }
    return Object.freeze({
      rank: result.rank,
      pageId: result.page.id,
      origin,
      path: result.page.path,
      pageDigest,
      rrfScore: result.rrfScore,
      normalizedScore: result.normalizedScore,
      snippet: typeof result.snippet === 'string' ? result.snippet : '',
      reasons: Object.freeze(
        result.reasons.map((reason: string, reasonIndex: number) =>
          nonEmpty(reason, `knowledge retrieval results[${index}].reasons[${reasonIndex}]`),
        ),
      ),
    })
  })
  normalized.sort((left, right) => left.rank - right.rank)
  normalized.forEach((result, index) => {
    if (result.rank !== index + 1) {
      throw new Error(
        `knowledge retrieval ranks must be contiguous from 1; expected ${index + 1}, observed ${result.rank}`,
      )
    }
  })
  return Object.freeze(normalized)
}

function validateReceiptResults(
  results: readonly KnowledgeRetrievalResultReceipt[],
  visibility: KnowledgeVisibilitySnapshot,
): void {
  const visible = new Map(
    visibility.entries.map((entry) => [`${entry.origin}\u0000${entry.path}`, entry]),
  )
  const seen = new Set<string>()
  results.forEach((result, index) => {
    if (result.rank !== index + 1) {
      throw new Error(
        `knowledge retrieval ranks must be contiguous from 1; expected ${index + 1}, observed ${result.rank}`,
      )
    }
    const origin = validateOrigin(result.origin, `knowledge retrieval results[${index}].origin`)
    const key = `${origin}\u0000${nonEmpty(result.path, `knowledge retrieval results[${index}].path`)}`
    if (seen.has(key)) throw new Error(`knowledge retrieval repeats visible page '${result.path}'`)
    seen.add(key)
    const entry = visible.get(key)
    if (!entry || entry.pageId !== result.pageId || entry.pageDigest !== result.pageDigest) {
      throw new Error(
        `knowledge retrieval result rank ${result.rank} is not in the visibility snapshot`,
      )
    }
    finite(result.rrfScore, `knowledge retrieval results[${index}].rrfScore`)
    finite(result.normalizedScore, `knowledge retrieval results[${index}].normalizedScore`)
    if (result.normalizedScore < 0 || result.normalizedScore > 1) {
      throw new TypeError(`knowledge retrieval results[${index}].normalizedScore must be in [0,1]`)
    }
    if (!Array.isArray(result.reasons)) {
      throw new TypeError(`knowledge retrieval results[${index}].reasons must be an array`)
    }
  })
}

function normalizeRetriever(input: KnowledgeRetrieverIdentity): KnowledgeRetrieverIdentity {
  if (!input || typeof input !== 'object') {
    throw new TypeError('knowledge retriever identity is required')
  }
  return Object.freeze({
    id: nonEmpty(input.id, 'knowledge retriever id'),
    version: nonEmpty(input.version, 'knowledge retriever version'),
    configDigest: digest(input.configDigest, 'knowledge retriever configDigest'),
  })
}

function normalizeConsumer(input: KnowledgeConsumerRef): KnowledgeConsumerRef {
  if (!input || typeof input !== 'object') {
    throw new TypeError('knowledge consumer reference is required')
  }
  const kinds: readonly KnowledgeConsumerKind[] = [
    'decision',
    'artifact',
    'experiment',
    'candidate',
    'message',
    'other',
  ]
  if (!kinds.includes(input.kind)) {
    throw new TypeError(`knowledge consumer kind is invalid: ${String(input.kind)}`)
  }
  return Object.freeze({
    kind: input.kind,
    uri: nonEmpty(input.uri, 'knowledge consumer uri'),
    ...(input.digest === undefined
      ? {}
      : { digest: digest(input.digest, 'knowledge consumer digest') }),
  })
}

function normalizeEvidenceRefs(values: readonly EvidenceRef[]): readonly EvidenceRef[] {
  if (!Array.isArray(values)) throw new TypeError('knowledge evidenceRefs must be an array')
  const allowed: readonly EvidenceRef['kind'][] = ['span', 'event', 'artifact', 'finding', 'metric']
  return Object.freeze(
    values.map((value, index) => {
      if (!value || typeof value !== 'object' || !allowed.includes(value.kind)) {
        throw new TypeError(`knowledge evidenceRefs[${index}].kind is invalid`)
      }
      return Object.freeze({
        kind: value.kind,
        uri: nonEmpty(value.uri, `knowledge evidenceRefs[${index}].uri`),
        ...(value.excerpt === undefined
          ? {}
          : { excerpt: nonEmpty(value.excerpt, `knowledge evidenceRefs[${index}].excerpt`) }),
      })
    }),
  )
}

function normalizeAttributes(
  input: Readonly<Record<string, KnowledgeReceiptAttributeValue>>,
): Readonly<Record<string, KnowledgeReceiptAttributeValue>> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('knowledge receipt attributes must be an object')
  }
  const normalized: Record<string, KnowledgeReceiptAttributeValue> = {}
  for (const [key, value] of Object.entries(input)) {
    const name = nonEmpty(key, 'knowledge receipt attribute key')
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      throw new TypeError(`knowledge receipt attribute '${name}' has an unsupported value`)
    }
    if (typeof value === 'number') finite(value, `knowledge receipt attribute '${name}'`)
    normalized[name] = value
  }
  return Object.freeze(normalized)
}

function validateUseRelation(value: KnowledgeUseRelation): KnowledgeUseRelation {
  const allowed: readonly KnowledgeUseRelation[] = [
    'supports',
    'contradicts',
    'extends',
    'rederives',
    'background',
  ]
  if (!allowed.includes(value)) {
    throw new TypeError(`knowledge use relation is invalid: ${String(value)}`)
  }
  return value
}

function validateKnowledgePage(page: KnowledgePage): void {
  if (!page || typeof page !== 'object') throw new TypeError('knowledge page must be an object')
  nonEmpty(page.id, 'knowledge page id')
  nonEmpty(page.path, 'knowledge page path')
  nonEmpty(page.title, 'knowledge page title')
  if (typeof page.text !== 'string') throw new TypeError('knowledge page text must be a string')
  if (
    !page.frontmatter ||
    typeof page.frontmatter !== 'object' ||
    Array.isArray(page.frontmatter)
  ) {
    throw new TypeError('knowledge page frontmatter must be an object')
  }
  for (const [name, values] of [
    ['sourceIds', page.sourceIds],
    ['tags', page.tags],
    ['outLinks', page.outLinks],
  ] as const) {
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
      throw new TypeError(`knowledge page ${name} must be a string array`)
    }
  }
}

function validateOrigin(value: unknown, label: string): PageOrigin {
  if (value === 'here' || value === 'shared') return value
  if (
    typeof value === 'string' &&
    value.startsWith('inherited:') &&
    value.slice('inherited:'.length).trim().length > 0
  ) {
    return value as PageOrigin
  }
  throw new TypeError(`${label} is invalid: ${String(value)}`)
}

function digest(value: unknown, label: string): Sha256Digest {
  const parsed = sha256DigestSchema.safeParse(value)
  if (!parsed.success) throw new TypeError(`${label} must be a lowercase sha256 digest`)
  return parsed.data
}

function optionalDigest(value: unknown, label: string): Sha256Digest | undefined {
  return value === undefined ? undefined : digest(value, label)
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value.trim()
}

function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : nonEmpty(value, label)
}

function finite(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number`)
  }
}

function isoTimestamp(value: Date | string | undefined, label: string): string {
  const date = value === undefined ? new Date() : value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} must be a valid timestamp`)
  return date.toISOString()
}
