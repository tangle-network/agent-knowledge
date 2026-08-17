import type { OriginatedPage, PageOrigin, RunScopedStores } from './run-scoped'
import type { KnowledgeId, KnowledgePage } from './types'

/**
 * A citation into the knowledge visible to one run.
 *
 * An unqualified reference is accepted only when exactly one visible page has
 * the requested id. Callers can qualify a reference by origin when a current,
 * inherited, or shared page intentionally reuses the same stable id.
 */
export interface KnowledgeCitationReference {
  readonly pageId: KnowledgeId
  readonly origin?: PageOrigin
}

export interface KnowledgeCitationCandidate {
  readonly pageId: KnowledgeId
  readonly origin: PageOrigin
  readonly page: KnowledgePage
}

export type KnowledgeCitationResolutionStatus = 'resolved' | 'missing' | 'ambiguous'

export interface KnowledgeCitationResolution {
  readonly reference: KnowledgeCitationReference
  readonly status: KnowledgeCitationResolutionStatus
  readonly candidates: readonly KnowledgeCitationCandidate[]
  readonly resolved?: KnowledgeCitationCandidate
}

/** A batch contains at least one citation that is missing or ambiguous. */
export class KnowledgeCitationResolutionError extends Error {
  readonly resolutions: readonly KnowledgeCitationResolution[]

  constructor(resolutions: readonly KnowledgeCitationResolution[]) {
    const unresolved = resolutions.filter((resolution) => resolution.status !== 'resolved')
    const missing = unresolved
      .filter((resolution) => resolution.status === 'missing')
      .map(renderReference)
    const ambiguous = unresolved
      .filter((resolution) => resolution.status === 'ambiguous')
      .map((resolution) => `${renderReference(resolution)} (${resolution.candidates.length} matches)`)
    const parts = [
      missing.length > 0 ? `missing: ${missing.join(', ')}` : '',
      ambiguous.length > 0 ? `ambiguous: ${ambiguous.join(', ')}` : '',
    ].filter(Boolean)
    super(`knowledge citation resolution failed: ${parts.join('; ')}`)
    this.name = 'KnowledgeCitationResolutionError'
    this.resolutions = Object.freeze([...unresolved])
  }
}

/** Resolve one reference against an already materialized visibility chain. */
export function resolveKnowledgeCitation(
  visiblePages: readonly OriginatedPage[],
  reference: KnowledgeCitationReference,
): KnowledgeCitationResolution {
  const normalized = normalizeReference(reference)
  const candidates = visiblePages
    .filter(
      (entry) =>
        entry.page.id === normalized.pageId &&
        (normalized.origin === undefined || entry.origin === normalized.origin),
    )
    .map((entry) =>
      Object.freeze({
        pageId: entry.page.id,
        origin: entry.origin,
        page: entry.page,
      }),
    )
  const status: KnowledgeCitationResolutionStatus =
    candidates.length === 0 ? 'missing' : candidates.length === 1 ? 'resolved' : 'ambiguous'
  return Object.freeze({
    reference: normalized,
    status,
    candidates: Object.freeze(candidates),
    ...(status === 'resolved' ? { resolved: candidates[0]! } : {}),
  })
}

/** Resolve a batch without discarding missing or ambiguous rows. */
export function resolveKnowledgeCitations(
  visiblePages: readonly OriginatedPage[],
  references: readonly KnowledgeCitationReference[],
): readonly KnowledgeCitationResolution[] {
  return Object.freeze(
    references.map((reference) => resolveKnowledgeCitation(visiblePages, reference)),
  )
}

/**
 * Resolve a batch and fail closed unless every reference names exactly one
 * visible page. Returned candidates preserve the caller's reference order.
 */
export function assertKnowledgeCitationsResolved(
  visiblePages: readonly OriginatedPage[],
  references: readonly KnowledgeCitationReference[],
): readonly KnowledgeCitationCandidate[] {
  const resolutions = resolveKnowledgeCitations(visiblePages, references)
  if (resolutions.some((resolution) => resolution.status !== 'resolved')) {
    throw new KnowledgeCitationResolutionError(resolutions)
  }
  return Object.freeze(resolutions.map((resolution) => resolution.resolved!))
}

/** Resolve one citation using a run-scoped store's declared visibility chain. */
export async function resolveRunScopedCitation(
  stores: RunScopedStores,
  runId: string,
  reference: KnowledgeCitationReference,
): Promise<KnowledgeCitationResolution> {
  return resolveKnowledgeCitation(await stores.loadChain(runId), reference)
}

/** Resolve citations using one chain read so every row sees the same snapshot. */
export async function resolveRunScopedCitations(
  stores: RunScopedStores,
  runId: string,
  references: readonly KnowledgeCitationReference[],
): Promise<readonly KnowledgeCitationResolution[]> {
  return resolveKnowledgeCitations(await stores.loadChain(runId), references)
}

/** Resolve a run-scoped batch and fail closed on any missing or ambiguous id. */
export async function assertRunScopedCitationsResolved(
  stores: RunScopedStores,
  runId: string,
  references: readonly KnowledgeCitationReference[],
): Promise<readonly KnowledgeCitationCandidate[]> {
  return assertKnowledgeCitationsResolved(await stores.loadChain(runId), references)
}

function normalizeReference(reference: KnowledgeCitationReference): KnowledgeCitationReference {
  if (!reference || typeof reference !== 'object') {
    throw new TypeError('knowledge citation reference must be an object')
  }
  if (typeof reference.pageId !== 'string' || reference.pageId.trim().length === 0) {
    throw new TypeError('knowledge citation pageId must be a non-empty string')
  }
  if (reference.origin !== undefined && !isPageOrigin(reference.origin)) {
    throw new TypeError(`knowledge citation origin is invalid: ${String(reference.origin)}`)
  }
  return Object.freeze({
    pageId: reference.pageId.trim(),
    ...(reference.origin === undefined ? {} : { origin: reference.origin }),
  })
}

function isPageOrigin(value: unknown): value is PageOrigin {
  if (value === 'here' || value === 'shared') return true
  return (
    typeof value === 'string' &&
    value.startsWith('inherited:') &&
    value.slice('inherited:'.length).trim().length > 0
  )
}

function renderReference(resolution: KnowledgeCitationResolution): string {
  return resolution.reference.origin === undefined
    ? resolution.reference.pageId
    : `${resolution.reference.origin}::${resolution.reference.pageId}`
}
