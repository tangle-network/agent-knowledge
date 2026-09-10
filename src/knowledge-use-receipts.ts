import type { EvidenceRef } from '@tangle-network/agent-eval/analyst'
import {
  canonicalCandidateDigest,
  type Sha256Digest,
  sha256Bytes,
} from '@tangle-network/agent-interface'
import {
  assertSchemaVersion,
  createKnowledgeVisibilitySnapshot,
  decodeKnowledgeVisibilitySnapshot,
  digest,
  KNOWLEDGE_RECEIPT_DIGEST_ALGORITHM,
  KNOWLEDGE_USE_RECEIPT_SCHEMA_VERSION,
  type KnowledgeVisibilityArtifactRef,
  type KnowledgeVisibilityRef,
  type KnowledgeVisibilitySnapshot,
  knowledgePageDigest,
  nonEmpty,
  normalizeVisibilityArtifact,
  normalizeVisibilityRef,
  type VisibilityIndex,
  validateKnowledgePage,
  validateOrigin,
  visibilityIdentity,
  visibilityIndexOf,
} from './knowledge-visibility'
import type { OriginatedPage, PageOrigin } from './run-scoped'
import type { KnowledgeSearchResult } from './types'

export {
  createKnowledgeVisibilitySnapshot,
  decodeKnowledgeVisibilitySnapshot,
  encodeKnowledgeVisibilitySnapshot,
  KNOWLEDGE_RECEIPT_DIGEST_ALGORITHM,
  KNOWLEDGE_USE_RECEIPT_SCHEMA_VERSION,
  type KnowledgeVisibilityArtifactRef,
  type KnowledgeVisibilityRef,
  type KnowledgeVisibilitySnapshot,
  type KnowledgeVisibilitySnapshotEntry,
  knowledgePageDigest,
  knowledgeVisibilityArtifactRef,
  verifyKnowledgeVisibilitySnapshot,
} from './knowledge-visibility'

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
  readonly visibility: KnowledgeVisibilityRef
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
  /**
   * The snapshot the retriever searched, created once with
   * `createKnowledgeVisibilitySnapshot` and reused for every retrieval over the
   * same view. Results join against its entries; the receipt stores only its
   * reference.
   */
  readonly visibility: KnowledgeVisibilitySnapshot
  /** Where the snapshot bytes are stored, when the caller has persisted them. */
  readonly visibilityArtifact?: KnowledgeVisibilityArtifactRef
  readonly results: readonly OriginatedKnowledgeSearchResult[]
  readonly evidenceRefs?: readonly EvidenceRef[]
  readonly attributes?: Readonly<Record<string, KnowledgeReceiptAttributeValue>>
  readonly createdAt?: Date | string
}

/**
 * Returns the stored bytes of the artifact, or `undefined` when nothing is
 * stored at its uri. A thrown error is reported as a load failure.
 */
export type KnowledgeVisibilityArtifactLoader = (
  artifact: KnowledgeVisibilityArtifactRef,
) => Promise<Uint8Array | undefined> | Uint8Array | undefined

export type KnowledgeVisibilityUnavailableReason =
  | 'no-artifact-reference'
  | 'missing'
  | 'load-failed'

/**
 * The visibility snapshot a receipt references could not be obtained, so the
 * result-to-visibility join cannot be proven. This is distinct from a snapshot
 * that loads and fails to match.
 */
export class KnowledgeVisibilityUnavailableError extends Error {
  readonly reason: KnowledgeVisibilityUnavailableReason
  readonly snapshotDigest: Sha256Digest
  readonly uri?: string

  constructor(input: {
    reason: KnowledgeVisibilityUnavailableReason
    snapshotDigest: Sha256Digest
    uri?: string
    cause?: unknown
  }) {
    const where = input.uri === undefined ? '' : ` at '${input.uri}'`
    const detail = {
      'no-artifact-reference': 'the receipt carries no artifact reference',
      missing: `no artifact is stored${where}`,
      'load-failed': `the artifact${where} could not be loaded`,
    }[input.reason]
    super(
      `knowledge visibility snapshot ${input.snapshotDigest} is unavailable: ${detail}`,
      input.cause === undefined ? undefined : { cause: input.cause },
    )
    this.name = 'KnowledgeVisibilityUnavailableError'
    this.reason = input.reason
    this.snapshotDigest = input.snapshotDigest
    if (input.uri !== undefined) this.uri = input.uri
  }
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

/**
 * Why a retrieval influenced nothing.
 *
 * `irrelevant` means the returned pages did not bear on the question.
 * `no-use` means they did bear on it and the consumer still used none of them.
 */
export type KnowledgeRetrievalDispositionRelation = 'irrelevant' | 'no-use'

/**
 * Immutable proof that one retrieval led to no use.
 *
 * A use receipt requires a selected rank, so a retrieval that influenced
 * nothing would otherwise leave no record at all, and "no evidence of use" and
 * "evidence of no use" would look identical in the ledger.
 */
export interface KnowledgeRetrievalDisposition {
  readonly schemaVersion: typeof KNOWLEDGE_USE_RECEIPT_SCHEMA_VERSION
  readonly kind: 'knowledge-retrieval-disposition'
  readonly digestAlgorithm: typeof KNOWLEDGE_RECEIPT_DIGEST_ALGORITHM
  readonly receiptDigest: Sha256Digest
  readonly createdAt: string
  readonly runId: string
  readonly actorId?: string
  readonly profileDigest?: Sha256Digest
  readonly executionRef?: Sha256Digest
  readonly retrievalReceiptDigest: Sha256Digest
  readonly relation: KnowledgeRetrievalDispositionRelation
  readonly consumer: KnowledgeConsumerRef
  readonly evidenceRefs: readonly EvidenceRef[]
  readonly attributes: Readonly<Record<string, KnowledgeReceiptAttributeValue>>
}

export interface CreateKnowledgeRetrievalDispositionInput {
  readonly retrieval: KnowledgeRetrievalReceipt
  readonly relation: KnowledgeRetrievalDispositionRelation
  readonly consumer: KnowledgeConsumerRef
  readonly evidenceRefs?: readonly EvidenceRef[]
  readonly attributes?: Readonly<Record<string, KnowledgeReceiptAttributeValue>>
  readonly createdAt?: Date | string
}

/**
 * Create a retrieval receipt over a precomputed snapshot. Every result must
 * occur in the snapshot with the same page id and bytes; the receipt stores the
 * snapshot's reference, not its entries.
 */
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
  const index = visibilityIndexOf(input.visibility)
  const artifact =
    input.visibilityArtifact === undefined
      ? undefined
      : normalizeVisibilityArtifact(
          input.visibilityArtifact,
          'knowledge retrieval visibilityArtifact',
        )
  const visibility: KnowledgeVisibilityRef = Object.freeze({
    snapshotDigest: index.snapshot.snapshotDigest,
    pageCount: index.snapshot.entries.length,
    ...(artifact === undefined ? {} : { artifact }),
  })
  const results = normalizeRetrievalResults(input.results, index)
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

/**
 * Verify the receipt's schema, canonical digest, rank continuity, finite
 * scores, and well-formed visibility reference. This proves what the receipt
 * says; it does not prove that the results occur in the referenced snapshot.
 * Use `assertKnowledgeRetrievalMatchesVisibility` or
 * `assertKnowledgeRetrievalMatchesVisibilityArtifact` for that join.
 */
export function verifyKnowledgeRetrievalReceipt(
  receipt: KnowledgeRetrievalReceipt,
): KnowledgeRetrievalReceipt {
  if (!receipt || typeof receipt !== 'object') {
    throw new TypeError('knowledge retrieval receipt is required')
  }
  assertSchemaVersion(receipt.schemaVersion, 'knowledge retrieval')
  if (receipt.kind !== 'knowledge-retrieval') {
    throw new Error(`knowledge retrieval receipt kind must be 'knowledge-retrieval'`)
  }
  if (receipt.digestAlgorithm !== KNOWLEDGE_RECEIPT_DIGEST_ALGORITHM) {
    throw new Error(`unsupported knowledge retrieval digestAlgorithm '${receipt.digestAlgorithm}'`)
  }
  const visibility = normalizeVisibilityRef(receipt.visibility)
  validateReceiptResultShape(receipt.results, visibility.pageCount)
  const material = retrievalMaterial({
    createdAt: isoTimestamp(receipt.createdAt, 'knowledge retrieval createdAt'),
    runId: nonEmpty(receipt.runId, 'knowledge retrieval runId'),
    actorId: optionalText(receipt.actorId, 'knowledge retrieval actorId'),
    profileDigest: optionalDigest(receipt.profileDigest, 'knowledge retrieval profileDigest'),
    executionRef: optionalDigest(receipt.executionRef, 'knowledge retrieval executionRef'),
    query: nonEmpty(receipt.query, 'knowledge retrieval query'),
    retriever: normalizeRetriever(receipt.retriever),
    visibility,
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

/**
 * Prove that the receipt references exactly this snapshot and that every
 * returned result occurs in it with the same page id and bytes. Pass the
 * snapshot itself, or the originated pages to snapshot them first.
 */
export function assertKnowledgeRetrievalMatchesVisibility(
  receipt: KnowledgeRetrievalReceipt,
  visibility: KnowledgeVisibilitySnapshot | readonly OriginatedPage[],
): void {
  verifyKnowledgeRetrievalReceipt(receipt)
  const index = visibilityIndexOf(
    Array.isArray(visibility)
      ? createKnowledgeVisibilitySnapshot(visibility)
      : (visibility as KnowledgeVisibilitySnapshot),
  )
  assertReceiptJoinsVisibility(receipt, index)
}

/**
 * Load the snapshot artifact the receipt references, prove the stored bytes
 * match the reference, and prove every returned result occurs in the decoded
 * snapshot. A snapshot that cannot be obtained raises
 * `KnowledgeVisibilityUnavailableError`; it is never treated as empty.
 */
export async function assertKnowledgeRetrievalMatchesVisibilityArtifact(
  receipt: KnowledgeRetrievalReceipt,
  loadArtifact: KnowledgeVisibilityArtifactLoader,
): Promise<KnowledgeVisibilitySnapshot> {
  verifyKnowledgeRetrievalReceipt(receipt)
  if (typeof loadArtifact !== 'function') {
    throw new TypeError('knowledge visibility artifact loader must be a function')
  }
  const reference = receipt.visibility
  if (reference.artifact === undefined) {
    throw new KnowledgeVisibilityUnavailableError({
      reason: 'no-artifact-reference',
      snapshotDigest: reference.snapshotDigest,
    })
  }
  const artifact = reference.artifact
  let bytes: Uint8Array | undefined
  try {
    bytes = await loadArtifact(artifact)
  } catch (error) {
    throw new KnowledgeVisibilityUnavailableError({
      reason: 'load-failed',
      snapshotDigest: reference.snapshotDigest,
      uri: artifact.uri,
      cause: error,
    })
  }
  if (bytes === undefined) {
    throw new KnowledgeVisibilityUnavailableError({
      reason: 'missing',
      snapshotDigest: reference.snapshotDigest,
      uri: artifact.uri,
    })
  }
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError(`knowledge visibility artifact '${artifact.uri}' loaded a non-byte value`)
  }
  if (bytes.byteLength !== artifact.byteLength) {
    throw new Error(
      `knowledge visibility artifact '${artifact.uri}' byteLength mismatch: expected ${artifact.byteLength}, observed ${bytes.byteLength}`,
    )
  }
  if (sha256Bytes(bytes) !== artifact.digest) {
    throw new Error(`knowledge visibility artifact '${artifact.uri}' digest mismatch`)
  }
  const snapshot = decodeKnowledgeVisibilitySnapshot(bytes)
  if (snapshot.snapshotDigest !== reference.snapshotDigest) {
    throw new Error(
      `knowledge visibility artifact '${artifact.uri}' holds snapshot ${snapshot.snapshotDigest}, not ${reference.snapshotDigest}`,
    )
  }
  assertReceiptJoinsVisibility(receipt, visibilityIndexOf(snapshot))
  return snapshot
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
  assertSchemaVersion(receipt.schemaVersion, 'knowledge use')
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

/** Record that one retrieval led to no use, with no rank to select. */
export function createKnowledgeRetrievalDisposition(
  input: CreateKnowledgeRetrievalDispositionInput,
): KnowledgeRetrievalDisposition {
  if (!input || typeof input !== 'object') {
    throw new TypeError('knowledge retrieval disposition input is required')
  }
  const material = dispositionMaterial({
    createdAt: isoTimestamp(input.createdAt, 'knowledge retrieval disposition createdAt'),
    retrieval: verifyKnowledgeRetrievalReceipt(input.retrieval),
    relation: validateDispositionRelation(input.relation),
    consumer: normalizeConsumer(input.consumer),
    evidenceRefs: normalizeEvidenceRefs(input.evidenceRefs ?? []),
    attributes: normalizeAttributes(input.attributes ?? {}),
  })
  return Object.freeze({ ...material, receiptDigest: canonicalCandidateDigest(material) })
}

/** Verify one disposition against the exact retrieval that authorized it. */
export function verifyKnowledgeRetrievalDisposition(
  disposition: KnowledgeRetrievalDisposition,
  retrieval: KnowledgeRetrievalReceipt,
): KnowledgeRetrievalDisposition {
  if (!disposition || typeof disposition !== 'object') {
    throw new TypeError('knowledge retrieval disposition is required')
  }
  const verifiedRetrieval = verifyKnowledgeRetrievalReceipt(retrieval)
  assertSchemaVersion(disposition.schemaVersion, 'knowledge retrieval disposition')
  if (disposition.kind !== 'knowledge-retrieval-disposition') {
    throw new Error(
      `knowledge retrieval disposition kind must be 'knowledge-retrieval-disposition'`,
    )
  }
  if (disposition.digestAlgorithm !== KNOWLEDGE_RECEIPT_DIGEST_ALGORITHM) {
    throw new Error(
      `unsupported knowledge retrieval disposition digestAlgorithm '${disposition.digestAlgorithm}'`,
    )
  }
  if (disposition.retrievalReceiptDigest !== verifiedRetrieval.receiptDigest) {
    throw new Error('knowledge retrieval disposition references a different retrieval receipt')
  }
  const material = dispositionMaterial({
    createdAt: isoTimestamp(disposition.createdAt, 'knowledge retrieval disposition createdAt'),
    retrieval: verifiedRetrieval,
    relation: validateDispositionRelation(disposition.relation),
    consumer: normalizeConsumer(disposition.consumer),
    evidenceRefs: normalizeEvidenceRefs(disposition.evidenceRefs),
    attributes: normalizeAttributes(disposition.attributes),
  })
  if (canonicalCandidateDigest(material) !== disposition.receiptDigest) {
    throw new Error('knowledge retrieval disposition digest mismatch')
  }
  return disposition
}

function assertReceiptJoinsVisibility(
  receipt: KnowledgeRetrievalReceipt,
  index: VisibilityIndex,
): void {
  if (
    index.snapshot.snapshotDigest !== receipt.visibility.snapshotDigest ||
    index.snapshot.entries.length !== receipt.visibility.pageCount
  ) {
    throw new Error('knowledge retrieval receipt does not match the supplied visibility snapshot')
  }
  for (const result of receipt.results) {
    const entry = index.byIdentity.get(visibilityIdentity(result.origin, result.path))
    if (!entry || entry.pageId !== result.pageId || entry.pageDigest !== result.pageDigest) {
      throw new Error(
        `knowledge retrieval result rank ${result.rank} is not in the visibility snapshot`,
      )
    }
  }
}

function retrievalMaterial(input: {
  createdAt: string
  runId: string
  actorId?: string
  profileDigest?: Sha256Digest
  executionRef?: Sha256Digest
  query: string
  retriever: KnowledgeRetrieverIdentity
  visibility: KnowledgeVisibilityRef
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

/**
 * The actor identity a downstream record inherits from the retrieval that
 * authorized it. A record that re-declared these could disagree with the
 * receipt it references.
 */
function retrievalIdentity(retrieval: KnowledgeRetrievalReceipt) {
  return {
    runId: retrieval.runId,
    ...(retrieval.actorId === undefined ? {} : { actorId: retrieval.actorId }),
    ...(retrieval.profileDigest === undefined ? {} : { profileDigest: retrieval.profileDigest }),
    ...(retrieval.executionRef === undefined ? {} : { executionRef: retrieval.executionRef }),
    retrievalReceiptDigest: retrieval.receiptDigest,
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
    ...retrievalIdentity(input.retrieval),
    used: input.used,
    relation: input.relation,
    consumer: input.consumer,
    evidenceRefs: input.evidenceRefs,
    attributes: input.attributes,
  }
}

function dispositionMaterial(input: {
  createdAt: string
  retrieval: KnowledgeRetrievalReceipt
  relation: KnowledgeRetrievalDispositionRelation
  consumer: KnowledgeConsumerRef
  evidenceRefs: readonly EvidenceRef[]
  attributes: Readonly<Record<string, KnowledgeReceiptAttributeValue>>
}) {
  return {
    schemaVersion: KNOWLEDGE_USE_RECEIPT_SCHEMA_VERSION,
    kind: 'knowledge-retrieval-disposition' as const,
    digestAlgorithm: KNOWLEDGE_RECEIPT_DIGEST_ALGORITHM,
    createdAt: input.createdAt,
    ...retrievalIdentity(input.retrieval),
    relation: input.relation,
    consumer: input.consumer,
    evidenceRefs: input.evidenceRefs,
    attributes: input.attributes,
  }
}

function validateDispositionRelation(
  value: KnowledgeRetrievalDispositionRelation,
): KnowledgeRetrievalDispositionRelation {
  if (value !== 'irrelevant' && value !== 'no-use') {
    throw new TypeError(`knowledge retrieval disposition relation is invalid: ${String(value)}`)
  }
  return value
}

function normalizeRetrievalResults(
  results: readonly OriginatedKnowledgeSearchResult[],
  index: VisibilityIndex,
): readonly KnowledgeRetrievalResultReceipt[] {
  if (!Array.isArray(results)) throw new TypeError('knowledge retrieval results must be an array')
  const seenRanks = new Set<number>()
  const seenPages = new Set<string>()
  const normalized = results.map((result, position) => {
    if (!result || typeof result !== 'object') {
      throw new TypeError(`knowledge retrieval results[${position}] must be an object`)
    }
    if (!Number.isSafeInteger(result.rank) || result.rank < 1) {
      throw new TypeError(`knowledge retrieval results[${position}].rank must be positive`)
    }
    if (seenRanks.has(result.rank)) {
      throw new Error(`knowledge retrieval repeats rank ${result.rank}`)
    }
    seenRanks.add(result.rank)
    const origin = validateOrigin(result.origin, `knowledge retrieval results[${position}].origin`)
    validateKnowledgePage(result.page)
    const identity = visibilityIdentity(origin, result.page.path)
    if (seenPages.has(identity)) {
      throw new Error(
        `knowledge retrieval repeats page '${result.page.path}' at origin '${origin}'`,
      )
    }
    seenPages.add(identity)
    const visibleEntry = index.byIdentity.get(identity)
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
    assertResultScores(result, position)
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
          nonEmpty(reason, `knowledge retrieval results[${position}].reasons[${reasonIndex}]`),
        ),
      ),
    })
  })
  normalized.sort((left, right) => left.rank - right.rank)
  assertContiguousRanks(normalized)
  return Object.freeze(normalized)
}

function validateReceiptResultShape(
  results: readonly KnowledgeRetrievalResultReceipt[],
  pageCount: number,
): void {
  if (!Array.isArray(results)) throw new TypeError('knowledge retrieval results must be an array')
  if (results.length > pageCount) {
    throw new Error(
      `knowledge retrieval returns ${results.length} results from ${pageCount} visible pages`,
    )
  }
  assertContiguousRanks(results)
  const seen = new Set<string>()
  results.forEach((result, position) => {
    if (!result || typeof result !== 'object') {
      throw new TypeError(`knowledge retrieval results[${position}] must be an object`)
    }
    const origin = validateOrigin(result.origin, `knowledge retrieval results[${position}].origin`)
    const identity = visibilityIdentity(
      origin,
      nonEmpty(result.path, `knowledge retrieval results[${position}].path`),
    )
    if (seen.has(identity)) {
      throw new Error(`knowledge retrieval repeats visible page '${result.path}'`)
    }
    seen.add(identity)
    nonEmpty(result.pageId, `knowledge retrieval results[${position}].pageId`)
    digest(result.pageDigest, `knowledge retrieval results[${position}].pageDigest`)
    assertResultScores(result, position)
    if (typeof result.snippet !== 'string') {
      throw new TypeError(`knowledge retrieval results[${position}].snippet must be a string`)
    }
    if (!Array.isArray(result.reasons)) {
      throw new TypeError(`knowledge retrieval results[${position}].reasons must be an array`)
    }
  })
}

/**
 * Ranks a retriever returned: one-based, unique, and contiguous, so a receipt
 * cannot hide a result by omitting its rank.
 */
function assertContiguousRanks(results: readonly { readonly rank: number }[]): void {
  results.forEach((result, position) => {
    if (result.rank !== position + 1) {
      throw new Error(
        `knowledge retrieval ranks must be contiguous from 1; expected ${position + 1}, observed ${result.rank}`,
      )
    }
  })
}

/** Scores a receipt may carry: finite, with the normalized score inside [0,1]. */
function assertResultScores(
  result: { readonly rrfScore: number; readonly normalizedScore: number },
  position: number,
): void {
  finite(result.rrfScore, `knowledge retrieval results[${position}].rrfScore`)
  finite(result.normalizedScore, `knowledge retrieval results[${position}].normalizedScore`)
  if (result.normalizedScore < 0 || result.normalizedScore > 1) {
    throw new TypeError(`knowledge retrieval results[${position}].normalizedScore must be in [0,1]`)
  }
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

function optionalDigest(value: unknown, label: string): Sha256Digest | undefined {
  return value === undefined ? undefined : digest(value, label)
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
