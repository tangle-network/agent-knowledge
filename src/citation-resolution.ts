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

export type KnowledgeCitationAuditIssueKind = 'self' | 'missing' | 'ambiguous'

export interface KnowledgeCitationAuditIssue {
  readonly kind: KnowledgeCitationAuditIssueKind
  readonly sourcePageId: KnowledgeId
  readonly sourcePath: string
  readonly sourceOrigin: PageOrigin
  readonly persistedCitation: string
  readonly reference: KnowledgeCitationReference
  readonly candidates: readonly KnowledgeCitationCandidate[]
}

export interface KnowledgeCitationAuditReport {
  readonly ok: boolean
  readonly checkedPages: number
  readonly checkedCitations: number
  readonly issues: readonly KnowledgeCitationAuditIssue[]
}

export interface AuditKnowledgeCitationsOptions {
  /** Limit audited source pages to these origins. All visible origins are checked by default. */
  readonly sourceOrigins?: readonly PageOrigin[]
}

/** A batch contains at least one citation that is missing or ambiguous. */
export class KnowledgeCitationResolutionError extends Error {
  readonly resolutions: readonly KnowledgeCitationResolution[]

  constructor(resolutions: readonly KnowledgeCitationResolution[]) {
    const unresolved = resolutions.filter((resolution) => resolution.status !== 'resolved')
    const missing = unresolved
      .filter((resolution) => resolution.status === 'missing')
      .map((resolution) => formatKnowledgeCitationReference(resolution.reference))
    const ambiguous = unresolved
      .filter((resolution) => resolution.status === 'ambiguous')
      .map(
        (resolution) =>
          `${formatKnowledgeCitationReference(resolution.reference)} (${resolution.candidates.length} matches)`,
      )
    const parts = [
      missing.length > 0 ? `missing: ${missing.join(', ')}` : '',
      ambiguous.length > 0 ? `ambiguous: ${ambiguous.join(', ')}` : '',
    ].filter(Boolean)
    super(`knowledge citation resolution failed: ${parts.join('; ')}`)
    this.name = 'KnowledgeCitationResolutionError'
    this.resolutions = Object.freeze([...unresolved])
  }
}

/** A persisted page contains a self, missing, or ambiguous citation. */
export class KnowledgeCitationAuditError extends Error {
  readonly report: KnowledgeCitationAuditReport

  constructor(report: KnowledgeCitationAuditReport) {
    const counts = new Map<KnowledgeCitationAuditIssueKind, number>()
    for (const issue of report.issues) counts.set(issue.kind, (counts.get(issue.kind) ?? 0) + 1)
    const summary = [...counts.entries()].map(([kind, count]) => `${kind}=${count}`).join(', ')
    super(`knowledge citation audit failed: ${summary}`)
    this.name = 'KnowledgeCitationAuditError'
    this.report = report
  }
}

/**
 * Parse the persisted citation form.
 *
 * `page-id` is unqualified. `here::page-id`, `shared::page-id`, and
 * `inherited:<runId>::page-id` bind an intentional duplicate to one origin.
 */
export function parseKnowledgeCitationReference(value: string): KnowledgeCitationReference {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError('persisted knowledge citation must be a non-empty string')
  }
  const normalized = value.trim()
  const separator = normalized.indexOf('::')
  if (separator < 0) return Object.freeze({ pageId: normalized })
  const possibleOrigin = normalized.slice(0, separator)
  const pageId = normalized.slice(separator + 2)
  if (!isPageOrigin(possibleOrigin)) {
    return Object.freeze({ pageId: normalized })
  }
  return normalizeReference({ pageId, origin: possibleOrigin })
}

/** Serialize one reference into the canonical frontmatter representation. */
export function formatKnowledgeCitationReference(reference: KnowledgeCitationReference): string {
  const normalized = normalizeReference(reference)
  return normalized.origin === undefined
    ? normalized.pageId
    : `${normalized.origin}::${normalized.pageId}`
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

/** Audit persisted `cites` relations against one immutable visibility snapshot. */
export function auditKnowledgeCitations(
  visiblePages: readonly OriginatedPage[],
  options: AuditKnowledgeCitationsOptions = {},
): KnowledgeCitationAuditReport {
  const origins = options.sourceOrigins
    ? new Set(options.sourceOrigins.map((origin) => validatePageOrigin(origin)))
    : null
  const sources = visiblePages.filter((entry) => origins === null || origins.has(entry.origin))
  const issues: KnowledgeCitationAuditIssue[] = []
  let checkedCitations = 0

  for (const source of sources) {
    for (const persistedCitation of new Set(source.page.cites ?? [])) {
      checkedCitations += 1
      const reference = parseKnowledgeCitationReference(persistedCitation)
      const resolution = resolveKnowledgeCitation(visiblePages, reference)
      const self = resolution.candidates.some(
        (candidate) =>
          candidate.page === source.page ||
          (candidate.origin === source.origin && candidate.page.path === source.page.path),
      )
      const kind: KnowledgeCitationAuditIssueKind | null = self
        ? 'self'
        : resolution.status === 'missing'
          ? 'missing'
          : resolution.status === 'ambiguous'
            ? 'ambiguous'
            : null
      if (kind === null) continue
      issues.push(
        Object.freeze({
          kind,
          sourcePageId: source.page.id,
          sourcePath: source.page.path,
          sourceOrigin: source.origin,
          persistedCitation,
          reference,
          candidates: resolution.candidates,
        }),
      )
    }
  }

  return Object.freeze({
    ok: issues.length === 0,
    checkedPages: sources.length,
    checkedCitations,
    issues: Object.freeze(issues),
  })
}

/** Audit and fail closed when any persisted citation is unresolved. */
export function assertKnowledgeCitationAudit(report: KnowledgeCitationAuditReport): void {
  if (!report.ok) throw new KnowledgeCitationAuditError(report)
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

/** Audit only pages authored in the current run against the full visible chain. */
export async function auditCurrentRunCitations(
  stores: RunScopedStores,
  runId: string,
): Promise<KnowledgeCitationAuditReport> {
  return auditKnowledgeCitations(await stores.loadChain(runId), { sourceOrigins: ['here'] })
}

/** Audit current-run citations and fail closed on every unresolved relation. */
export async function assertCurrentRunCitationsResolved(
  stores: RunScopedStores,
  runId: string,
): Promise<KnowledgeCitationAuditReport> {
  const report = await auditCurrentRunCitations(stores, runId)
  assertKnowledgeCitationAudit(report)
  return report
}

function normalizeReference(reference: KnowledgeCitationReference): KnowledgeCitationReference {
  if (!reference || typeof reference !== 'object') {
    throw new TypeError('knowledge citation reference must be an object')
  }
  if (typeof reference.pageId !== 'string' || reference.pageId.trim().length === 0) {
    throw new TypeError('knowledge citation pageId must be a non-empty string')
  }
  if (reference.origin !== undefined) validatePageOrigin(reference.origin)
  return Object.freeze({
    pageId: reference.pageId.trim(),
    ...(reference.origin === undefined ? {} : { origin: reference.origin }),
  })
}

function validatePageOrigin(value: PageOrigin): PageOrigin {
  if (!isPageOrigin(value)) {
    throw new TypeError(`knowledge citation origin is invalid: ${String(value)}`)
  }
  return value
}

function isPageOrigin(value: unknown): value is PageOrigin {
  if (value === 'here' || value === 'shared') return true
  return (
    typeof value === 'string' &&
    value.startsWith('inherited:') &&
    value.slice('inherited:'.length).trim().length > 0
  )
}
