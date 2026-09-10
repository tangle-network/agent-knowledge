import {
  canonicalCandidateBytes,
  canonicalCandidateDigest,
  type Sha256Digest,
  sha256Bytes,
  sha256DigestSchema,
} from '@tangle-network/agent-interface'
import type {
  KnowledgeVisibilityArtifactRef,
  KnowledgeVisibilityRef,
  KnowledgeVisibilitySnapshot,
  KnowledgeVisibilitySnapshotEntry,
} from './knowledge-use-receipts'
import type { OriginatedPage, PageOrigin } from './run-scoped'
import type { KnowledgePage } from './types'

export const KNOWLEDGE_USE_RECEIPT_SCHEMA_VERSION = '2.0.0' as const

export const KNOWLEDGE_RECEIPT_DIGEST_ALGORITHM = 'rfc8785-sha256' as const

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
    const identity = visibilityIdentity(origin, entry.page.path)
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
  const snapshot: KnowledgeVisibilitySnapshot = Object.freeze({
    ...material,
    snapshotDigest: canonicalCandidateDigest(material),
    entries: Object.freeze(entries),
  })
  visibilityIndexes.set(snapshot, indexVisibility(snapshot))
  return snapshot
}

/**
 * Verify a snapshot's schema and canonical digest. The check runs once per
 * snapshot object; later calls with the same object are free.
 */
export function verifyKnowledgeVisibilitySnapshot(
  snapshot: KnowledgeVisibilitySnapshot,
): KnowledgeVisibilitySnapshot {
  return visibilityIndexOf(snapshot).snapshot
}

/** Canonical bytes of a verified snapshot, for durable storage. */
export function encodeKnowledgeVisibilitySnapshot(
  snapshot: KnowledgeVisibilitySnapshot,
): Uint8Array {
  const verified = verifyKnowledgeVisibilitySnapshot(snapshot)
  return canonicalCandidateBytes({
    schemaVersion: verified.schemaVersion,
    digestAlgorithm: verified.digestAlgorithm,
    snapshotDigest: verified.snapshotDigest,
    entries: visibilityMaterial(verified.entries).entries,
  })
}

/** Parse stored snapshot bytes and verify their schema and digest. */
export function decodeKnowledgeVisibilitySnapshot(bytes: Uint8Array): KnowledgeVisibilitySnapshot {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError('knowledge visibility snapshot bytes must be a Uint8Array')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch (error) {
    throw new Error(
      `knowledge visibility snapshot bytes are not JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('knowledge visibility snapshot must be an object')
  }
  const candidate = parsed as Record<string, unknown>
  if (!Array.isArray(candidate.entries)) {
    throw new TypeError('knowledge visibility snapshot entries must be an array')
  }
  const snapshot = Object.freeze({
    schemaVersion: candidate.schemaVersion as KnowledgeVisibilitySnapshot['schemaVersion'],
    digestAlgorithm: candidate.digestAlgorithm as KnowledgeVisibilitySnapshot['digestAlgorithm'],
    snapshotDigest: digest(candidate.snapshotDigest, 'knowledge visibility snapshotDigest'),
    entries: Object.freeze(
      candidate.entries.map((entry: unknown, position: number) => {
        if (!entry || typeof entry !== 'object') {
          throw new TypeError(`knowledge visibility[${position}] must be an object`)
        }
        const value = entry as Record<string, unknown>
        if (!Array.isArray(value.sourceIds)) {
          throw new TypeError(`knowledge visibility[${position}].sourceIds must be an array`)
        }
        return Object.freeze({
          position: value.position as number,
          pageId: value.pageId as string,
          origin: value.origin as PageOrigin,
          path: value.path as string,
          pageDigest: value.pageDigest as Sha256Digest,
          sourceIds: Object.freeze([...(value.sourceIds as string[])]),
          invalidated: value.invalidated as boolean,
        })
      }),
    ),
  })
  return verifyKnowledgeVisibilitySnapshot(snapshot)
}

/** Locator for snapshot bytes stored at `uri`. */
export function knowledgeVisibilityArtifactRef(input: {
  uri: string
  bytes: Uint8Array
}): KnowledgeVisibilityArtifactRef {
  if (!input || typeof input !== 'object' || !(input.bytes instanceof Uint8Array)) {
    throw new TypeError('knowledge visibility artifact bytes must be a Uint8Array')
  }
  if (input.bytes.byteLength === 0) {
    throw new TypeError('knowledge visibility artifact bytes must not be empty')
  }
  return Object.freeze({
    uri: nonEmpty(input.uri, 'knowledge visibility artifact uri'),
    digest: sha256Bytes(input.bytes),
    byteLength: input.bytes.byteLength,
  })
}

export interface VisibilityIndex {
  readonly snapshot: KnowledgeVisibilitySnapshot
  readonly byIdentity: ReadonlyMap<string, KnowledgeVisibilitySnapshotEntry>
}

// One verification and one join index per snapshot object, so N retrievals
// over one view cost O(results) each after the first. A snapshot is a value:
// a caller that needs a different view creates a new snapshot.
const visibilityIndexes = new WeakMap<KnowledgeVisibilitySnapshot, VisibilityIndex>()

export function visibilityIndexOf(snapshot: KnowledgeVisibilitySnapshot): VisibilityIndex {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new TypeError('knowledge visibility snapshot is required')
  }
  const cached = visibilityIndexes.get(snapshot)
  if (cached !== undefined) return cached
  assertSchemaVersion(snapshot.schemaVersion, 'knowledge visibility')
  if (snapshot.digestAlgorithm !== KNOWLEDGE_RECEIPT_DIGEST_ALGORITHM) {
    throw new Error(
      `unsupported knowledge visibility digestAlgorithm '${snapshot.digestAlgorithm}'`,
    )
  }
  if (!Array.isArray(snapshot.entries)) {
    throw new TypeError('knowledge visibility snapshot entries must be an array')
  }
  const expected = canonicalCandidateDigest(visibilityMaterial(snapshot.entries))
  if (expected !== digest(snapshot.snapshotDigest, 'knowledge visibility snapshotDigest')) {
    throw new Error('knowledge visibility snapshot digest mismatch')
  }
  const index = indexVisibility(snapshot)
  visibilityIndexes.set(snapshot, index)
  return index
}

function indexVisibility(snapshot: KnowledgeVisibilitySnapshot): VisibilityIndex {
  const byIdentity = new Map<string, KnowledgeVisibilitySnapshotEntry>()
  for (const entry of snapshot.entries) {
    const identity = visibilityIdentity(entry.origin, entry.path)
    if (byIdentity.has(identity)) {
      throw new Error(
        `knowledge visibility repeats path '${entry.path}' at origin '${entry.origin}'`,
      )
    }
    byIdentity.set(identity, entry)
  }
  return { snapshot, byIdentity }
}

export function visibilityIdentity(origin: PageOrigin, path: string): string {
  return `${origin}\u0000${path}`
}

export function assertSchemaVersion(value: unknown, label: string): void {
  if (value === KNOWLEDGE_USE_RECEIPT_SCHEMA_VERSION) return
  const hint =
    value === '1.0.0'
      ? '; 1.0.0 records embed the visibility snapshot and have no reader, create a 2.0.0 record from the snapshot'
      : ''
  throw new Error(`unsupported ${label} schemaVersion '${String(value)}'${hint}`)
}

function visibilityMaterial(entries: readonly KnowledgeVisibilitySnapshotEntry[]) {
  return {
    schemaVersion: KNOWLEDGE_USE_RECEIPT_SCHEMA_VERSION,
    digestAlgorithm: KNOWLEDGE_RECEIPT_DIGEST_ALGORITHM,
    entries: entries.map((entry, position) => {
      if (!entry || typeof entry !== 'object') {
        throw new TypeError(`knowledge visibility[${position}] must be an object`)
      }
      if (entry.position !== position) {
        throw new Error(
          `knowledge visibility position mismatch: expected ${position}, observed ${entry.position}`,
        )
      }
      if (!Array.isArray(entry.sourceIds)) {
        throw new TypeError(`knowledge visibility[${position}].sourceIds must be an array`)
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

export function normalizeVisibilityRef(input: KnowledgeVisibilityRef): KnowledgeVisibilityRef {
  if (!input || typeof input !== 'object') {
    throw new TypeError('knowledge retrieval visibility reference is required')
  }
  if (!Number.isSafeInteger(input.pageCount) || input.pageCount < 0) {
    throw new TypeError('knowledge retrieval visibility pageCount must be a non-negative integer')
  }
  return Object.freeze({
    snapshotDigest: digest(input.snapshotDigest, 'knowledge retrieval visibility snapshotDigest'),
    pageCount: input.pageCount,
    ...(input.artifact === undefined
      ? {}
      : {
          artifact: normalizeVisibilityArtifact(
            input.artifact,
            'knowledge retrieval visibility artifact',
          ),
        }),
  })
}

export function normalizeVisibilityArtifact(
  input: KnowledgeVisibilityArtifactRef,
  label: string,
): KnowledgeVisibilityArtifactRef {
  if (!input || typeof input !== 'object') throw new TypeError(`${label} must be an object`)
  if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 1) {
    throw new TypeError(`${label} byteLength must be a positive integer`)
  }
  return Object.freeze({
    uri: nonEmpty(input.uri, `${label} uri`),
    digest: digest(input.digest, `${label} digest`),
    byteLength: input.byteLength,
  })
}

export function validateKnowledgePage(page: KnowledgePage): void {
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

export function validateOrigin(value: unknown, label: string): PageOrigin {
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

export function digest(value: unknown, label: string): Sha256Digest {
  const parsed = sha256DigestSchema.safeParse(value)
  if (!parsed.success) throw new TypeError(`${label} must be a lowercase sha256 digest`)
  return parsed.data
}

export function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value.trim()
}
