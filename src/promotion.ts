/**
 * Run-scope to shared-scope promotion.
 *
 * A run writes only its own store. Knowledge reaches the curated shared store
 * through this call and no other, and every promotion leaves a record naming
 * the source run, the promoted bytes, the support carried with them, the actor,
 * and the reason.
 *
 * A claim's cited support travels with it. Promoting a claim while leaving the
 * run-local pages it cites behind is what turns a resolved citation into a
 * dangling one, so the closure of cited pages is carried and the promotion is
 * refused when any citation would not resolve in the target.
 */
import { canonicalCandidateDigest, type Sha256Digest } from '@tangle-network/agent-interface'
import {
  assertKnowledgeCitationsResolved,
  parseKnowledgeCitationReference,
  resolveKnowledgeCitation,
} from './citation-resolution'
import { isMissingFile, readRegularFileWithinRoot, writeJsonDurableWithinRoot } from './durable-fs'
import { commitKnowledgeFileMutations } from './file-transaction'
import { knowledgePageDigest } from './knowledge-use-receipts'
import { withKnowledgeMutation } from './mutation-lock'
import { type KnowledgePagesOptions, normalizePagesDirectory } from './pages-directory'
import {
  type OriginatedPage,
  originatedPages,
  type PageOrigin,
  type RunScopedStores,
} from './run-scoped'
import { initKnowledgeBase, loadKnowledgePages } from './store'
import type { KnowledgeId, KnowledgePage } from './types'

export const KNOWLEDGE_PROMOTION_SCHEMA_VERSION = '1.0.0' as const
export const KNOWLEDGE_PROMOTION_DIGEST_ALGORITHM = 'rfc8785-sha256' as const

/** Root-relative directory holding one JSON record per promotion. */
export const KNOWLEDGE_PROMOTIONS_DIRECTORY = '.agent-knowledge/promotions'

export type KnowledgePromotionErrorCode =
  | 'unknown-page'
  | 'ambiguous-support'
  | 'id-conflict'
  | 'path-conflict'

/** A promotion that cannot be performed exactly as asked. */
export class KnowledgePromotionError extends Error {
  readonly code: KnowledgePromotionErrorCode

  constructor(code: KnowledgePromotionErrorCode, message: string) {
    super(message)
    this.name = 'KnowledgePromotionError'
    this.code = code
  }
}

export interface KnowledgePromotionEntry {
  readonly pageId: KnowledgeId
  readonly path: string
  /** Where the page was read from in the source run's chain. */
  readonly sourceOrigin: PageOrigin
  readonly pageDigest: Sha256Digest
  /** False when the page travelled only because a promoted page cites it. */
  readonly requested: boolean
}

/** Immutable record of one promotion into a shared store. */
export interface KnowledgePromotionRecord {
  readonly schemaVersion: typeof KNOWLEDGE_PROMOTION_SCHEMA_VERSION
  readonly kind: 'knowledge-promotion'
  readonly digestAlgorithm: typeof KNOWLEDGE_PROMOTION_DIGEST_ALGORITHM
  readonly recordDigest: Sha256Digest
  readonly createdAt: string
  readonly runId: string
  readonly actor: string
  readonly reason: string
  /** Promoted pages first, then carried support, each group in path order. */
  readonly entries: readonly KnowledgePromotionEntry[]
}

export interface PromoteRunScopedPagesOptions extends KnowledgePagesOptions {
  /** Stable ids of the pages this run authored and wants in shared scope. */
  readonly pageIds: readonly KnowledgeId[]
  /** The curated store every run reads and no run writes directly. */
  readonly sharedRoot: string
  /** Who decided to promote. */
  readonly actor: string
  /** Why this knowledge belongs in shared scope. */
  readonly reason: string
  readonly now?: () => Date
}

/**
 * Promote pages a run authored into the shared store, with their cited support.
 *
 * Support keeps its own evidence fields exactly as written, so a promoted claim
 * cannot inherit a confidence its support does not carry. Pages travel as the
 * bytes their store holds.
 *
 * Re-running the same promotion is safe: unchanged pages produce no file
 * mutation and the record is content-addressed, so it lands at the same path
 * with the same bytes.
 */
export async function promoteRunScopedPages(
  stores: RunScopedStores,
  runId: string,
  options: PromoteRunScopedPagesOptions,
): Promise<KnowledgePromotionRecord> {
  const pagesDirectory = normalizePagesDirectory(options.pagesDirectory)
  const sharedRoot = nonEmpty(options.sharedRoot, 'promotion sharedRoot')
  const actor = nonEmpty(options.actor, 'promotion actor')
  const reason = nonEmpty(options.reason, 'promotion reason')
  if (!Array.isArray(options.pageIds) || options.pageIds.length === 0) {
    throw new TypeError('promotion pageIds must name at least one page')
  }

  const chain = await stores.loadChain(runId)
  const travellers = collectTravellers(chain, options.pageIds)

  await initKnowledgeBase(sharedRoot)
  return withKnowledgeMutation(sharedRoot, async (lock) => {
    const existing = await loadKnowledgePages(sharedRoot, { pagesDirectory })
    assertNoIdentityConflict(travellers, existing)

    const promotedPaths = new Set(travellers.map((traveller) => traveller.entry.page.path))
    const promotedView = originatedPages(
      [
        ...existing.filter((page) => !promotedPaths.has(page.path)),
        ...travellers.map((traveller) => traveller.entry.page),
      ],
      'shared',
    )
    assertKnowledgeCitationsResolved(
      promotedView,
      travellers.flatMap((traveller) =>
        (traveller.entry.page.cites ?? []).map((persisted: string) =>
          parseKnowledgeCitationReference(persisted),
        ),
      ),
    )

    const mutations = await Promise.all(
      travellers.map(async (traveller) => ({
        path: traveller.entry.page.path,
        content: await readPageBytes(stores, runId, traveller.entry),
      })),
    )
    await commitKnowledgeFileMutations({
      root: sharedRoot,
      transactionRoot: lock.transactionRoot,
      purpose: `knowledge-promotion:${runId}`,
      mutations,
      pagesDirectory,
      assertOwned: lock.assertOwned,
    })

    const record = buildRecord({
      runId,
      actor,
      reason,
      travellers,
      createdAt: (options.now ?? (() => new Date()))().toISOString(),
    })
    await writeJsonDurableWithinRoot(
      sharedRoot,
      `${KNOWLEDGE_PROMOTIONS_DIRECTORY}/${record.recordDigest}.json`,
      record,
    )
    return record
  })
}

/** Read one promotion record written by `promoteRunScopedPages`. */
export async function loadKnowledgePromotionRecord(
  sharedRoot: string,
  recordDigest: Sha256Digest,
): Promise<KnowledgePromotionRecord | null> {
  try {
    const snapshot = await readRegularFileWithinRoot(
      sharedRoot,
      `${KNOWLEDGE_PROMOTIONS_DIRECTORY}/${recordDigest}.json`,
    )
    return JSON.parse(snapshot.bytes.toString('utf8')) as KnowledgePromotionRecord
  } catch (error) {
    if (isMissingFile(error)) return null
    throw error
  }
}

interface Traveller {
  readonly entry: OriginatedPage
  requested: boolean
}

/**
 * The requested pages plus the closure of the run-local pages they cite.
 *
 * A citation into the shared store needs no carrying, and an unresolved
 * citation is left to the target-side check, which reports every one of them
 * together rather than failing on the first.
 */
function collectTravellers(
  chain: readonly OriginatedPage[],
  pageIds: readonly KnowledgeId[],
): Traveller[] {
  const byId = new Map<KnowledgeId, Traveller>()
  const queue: Array<{ entry: OriginatedPage; requested: boolean }> = []

  for (const pageId of pageIds) {
    const authored = chain.filter((entry) => entry.origin === 'here' && entry.page.id === pageId)
    if (authored.length === 0) {
      throw new KnowledgePromotionError(
        'unknown-page',
        `promotion page "${pageId}" was not authored by this run`,
      )
    }
    if (authored.length > 1) {
      throw new KnowledgePromotionError(
        'ambiguous-support',
        `promotion page "${pageId}" names ${authored.length} pages in this run`,
      )
    }
    queue.push({ entry: authored[0]!, requested: true })
  }

  while (queue.length > 0) {
    const next = queue.shift()!
    const seen = byId.get(next.entry.page.id)
    if (seen) {
      if (next.requested) seen.requested = true
      if (seen.entry.page.path !== next.entry.page.path) {
        throw new KnowledgePromotionError(
          'ambiguous-support',
          `promotion support "${next.entry.page.id}" names more than one visible page`,
        )
      }
      continue
    }
    byId.set(next.entry.page.id, { entry: next.entry, requested: next.requested })
    for (const persisted of next.entry.page.cites ?? []) {
      const resolution = resolveKnowledgeCitation(chain, parseKnowledgeCitationReference(persisted))
      const target = resolution.resolved
      if (target === undefined || target.origin === 'shared') continue
      queue.push({ entry: { page: target.page, origin: target.origin }, requested: false })
    }
  }

  return [...byId.values()].sort(
    (left, right) =>
      Number(right.requested) - Number(left.requested) ||
      left.entry.page.path.localeCompare(right.entry.page.path),
  )
}

function assertNoIdentityConflict(
  travellers: readonly Traveller[],
  existing: readonly KnowledgePage[],
): void {
  for (const traveller of travellers) {
    const page = traveller.entry.page
    const idClash = existing.find((other) => other.id === page.id && other.path !== page.path)
    if (idClash) {
      throw new KnowledgePromotionError(
        'id-conflict',
        `shared page "${idClash.path}" already holds id "${page.id}"; promoting "${page.path}" would create two`,
      )
    }
    const pathClash = existing.find((other) => other.path === page.path && other.id !== page.id)
    if (pathClash) {
      throw new KnowledgePromotionError(
        'path-conflict',
        `shared page "${page.path}" holds id "${pathClash.id}", not "${page.id}"`,
      )
    }
  }
}

/**
 * The page as its own store holds it. A promoted page must be the same bytes
 * in both scopes, so the record's digest describes what a reader will load.
 */
async function readPageBytes(
  stores: RunScopedStores,
  runId: string,
  entry: OriginatedPage,
): Promise<string> {
  const sourceRunId = sourceRunOf(entry.origin, runId)
  const snapshot = await readRegularFileWithinRoot(stores.storePath(sourceRunId), entry.page.path)
  return snapshot.bytes.toString('utf8')
}

function sourceRunOf(origin: PageOrigin, runId: string): string {
  if (origin === 'here') return runId
  if (origin.startsWith('inherited:')) return origin.slice('inherited:'.length)
  throw new Error(`promotion cannot read the bytes of a ${origin} page`)
}

function buildRecord(input: {
  runId: string
  actor: string
  reason: string
  travellers: readonly Traveller[]
  createdAt: string
}): KnowledgePromotionRecord {
  const entries: KnowledgePromotionEntry[] = input.travellers.map((traveller) =>
    Object.freeze({
      pageId: traveller.entry.page.id,
      path: traveller.entry.page.path,
      sourceOrigin: traveller.entry.origin,
      pageDigest: knowledgePageDigest(traveller.entry.page),
      requested: traveller.requested,
    }),
  )
  const material = {
    schemaVersion: KNOWLEDGE_PROMOTION_SCHEMA_VERSION,
    kind: 'knowledge-promotion' as const,
    digestAlgorithm: KNOWLEDGE_PROMOTION_DIGEST_ALGORITHM,
    createdAt: input.createdAt,
    runId: input.runId,
    actor: input.actor,
    reason: input.reason,
    entries,
  }
  return Object.freeze({ ...material, recordDigest: canonicalCandidateDigest(material) })
}

function nonEmpty(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value.trim()
}
