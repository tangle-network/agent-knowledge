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
import { createHash } from 'node:crypto'
import { canonicalCandidateDigest, type Sha256Digest } from '@tangle-network/agent-interface'
import {
  assertKnowledgeCitationsResolved,
  parseKnowledgeCitationReference,
  resolveKnowledgeCitation,
} from './citation-resolution'
import { isMissingFile, readRegularFileWithinRoot } from './durable-fs'
import { commitKnowledgeFileMutations, type KnowledgeFileMutation } from './file-transaction'
import { buildKnowledgeGraph } from './graph'
import { sha256 } from './ids'
import { hashKnowledgeBase } from './kb-improvement/workspace'
import { knowledgePageDigest } from './knowledge-use-receipts'
import { extractSourceRefs } from './lint'
import { withKnowledgeMutation, withKnowledgeRead } from './mutation-lock'
import { type KnowledgePagesOptions, normalizePagesDirectory } from './pages-directory'
import {
  type OriginatedPage,
  originatedPages,
  type PageOrigin,
  type RunScopedStores,
} from './run-scoped'
import { loadSourceRegistry } from './sources'
import { initKnowledgeBase, knowledgePageFromMarkdown, loadKnowledgePages } from './store'
import type { KnowledgeId, KnowledgePage, SourceRecord } from './types'
import { validateKnowledgeIndex } from './validate'

export const KNOWLEDGE_PROMOTION_SCHEMA_VERSION = '1.0.0' as const
export const KNOWLEDGE_PROMOTION_DIGEST_ALGORITHM = 'rfc8785-sha256' as const

/** Root-relative directory holding one JSON record per promotion. */
export const KNOWLEDGE_PROMOTIONS_DIRECTORY = '.agent-knowledge/promotions'

export type KnowledgePromotionErrorCode =
  | 'unknown-page'
  | 'ambiguous-support'
  | 'id-conflict'
  | 'path-conflict'
  | 'source-conflict'
  | 'baseline-conflict'
  | 'operation-conflict'

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
  readonly sources?: readonly { sourceId: string; contentHash: string }[]
  readonly operationId?: Sha256Digest
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
  /** Additional host-authorized frozen corpora containing cited raw sources. */
  readonly sourceRoots?: readonly string[]
  /** Refuse a stale publisher before any bytes change. */
  readonly expectedSharedHash?: string
  /** A host-stable retry identity; replays return the original atomic receipt. */
  readonly operationId?: Sha256Digest
  readonly now?: () => Date
}

/** The exact selected page closure, usable by filesystem and hosted owners. */
export interface PreparedKnowledgePromotion {
  readonly pages: readonly KnowledgePage[]
  readonly entries: readonly KnowledgePromotionEntry[]
  readonly sourceIds: readonly string[]
}

export function prepareKnowledgePromotion(options: {
  visiblePages: readonly OriginatedPage[]
  sharedPages: readonly KnowledgePage[]
  pageIds: readonly KnowledgeId[]
  /** Hosted owners may carry exact shared support that is absent from their write target. */
  carrySharedSupport?: boolean
}): PreparedKnowledgePromotion {
  if (!Array.isArray(options.pageIds) || options.pageIds.length === 0) {
    throw new TypeError('promotion pageIds must name at least one page')
  }
  const travellers = collectTravellers(
    options.visiblePages,
    options.pageIds,
    options.carrySharedSupport ? options.sharedPages : undefined,
  )
  assertNoIdentityConflict(travellers, options.sharedPages)
  const paths = new Set(travellers.map((traveller) => traveller.entry.page.path))
  const pages = travellers.map((traveller) => traveller.entry.page)
  assertKnowledgeCitationsResolved(
    originatedPages(
      [...options.sharedPages.filter((page) => !paths.has(page.path)), ...pages],
      'shared',
    ),
    pages.flatMap((page) =>
      (page.cites ?? []).map((persisted) => parseKnowledgeCitationReference(persisted)),
    ),
  )
  return {
    pages,
    entries: travellers.map((traveller) => ({
      pageId: traveller.entry.page.id,
      path: traveller.entry.page.path,
      sourceOrigin: traveller.entry.origin,
      pageDigest: knowledgePageDigest(traveller.entry.page),
      requested: traveller.requested,
    })),
    sourceIds: [
      ...new Set(
        pages.flatMap((page) => [
          ...page.sourceIds,
          ...extractSourceRefs(page.text).map((ref) => ref.sourceId),
        ]),
      ),
    ].sort(),
  }
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
  if (options.operationId !== undefined && !/^sha256:[a-f0-9]{64}$/.test(options.operationId)) {
    throw new TypeError('promotion operationId must be a SHA-256 digest')
  }

  const chain = await stores.loadChain(runId)
  const travellers = collectTravellers(chain, options.pageIds)
  const pageMutations = await Promise.all(
    travellers.map(async (traveller) => ({
      path: traveller.entry.page.path,
      content: await readPageBytes(stores, runId, traveller.entry, pagesDirectory),
    })),
  )
  const sourceIds = new Set(
    travellers.flatMap(({ entry }) => [
      ...entry.page.sourceIds,
      ...extractSourceRefs(entry.page.text).map((ref) => ref.sourceId),
    ]),
  )
  const sourceRoots = [
    ...new Set([
      stores.storePath(runId),
      ...(await stores.lineage(runId)).map((ancestor) => stores.storePath(ancestor)),
      ...(options.sourceRoots ?? []),
    ]),
  ]
  const frozenSources = new Map<string, FrozenSource>()
  for (const root of sourceRoots) {
    for (const frozen of await freezeSources(root, sourceIds)) {
      const previous = frozenSources.get(frozen.record.id)
      if (previous) assertSameSource(previous.record, frozen.record)
      else frozenSources.set(frozen.record.id, frozen)
    }
  }

  await initKnowledgeBase(sharedRoot)
  return withKnowledgeMutation(sharedRoot, async (lock) => {
    const existing = await loadKnowledgePages(sharedRoot, { pagesDirectory })
    const prepared = prepareKnowledgePromotion({
      visiblePages: chain,
      sharedPages: existing,
      pageIds: options.pageIds,
    })
    const registry = await loadSourceRegistry(sharedRoot)
    const targetSources = new Map(registry.sources.map((source) => [source.id, source]))
    if (targetSources.size !== registry.sources.length) {
      throw new KnowledgePromotionError(
        'source-conflict',
        'shared source registry repeats a source identity',
      )
    }
    const newSources: FrozenSource[] = []
    for (const sourceId of prepared.sourceIds) {
      const frozen = frozenSources.get(sourceId)
      const present = targetSources.get(sourceId)
      if (present && frozen) assertSameSource(present, frozen.record)
      if (!present) {
        if (!frozen)
          throw new KnowledgePromotionError(
            'source-conflict',
            `promotion source "${sourceId}" has no captured evidence`,
          )
        newSources.push(frozen)
        targetSources.set(sourceId, frozen.record)
      }
    }
    const sources = prepared.sourceIds.map((sourceId) => ({
      sourceId,
      contentHash: targetSources.get(sourceId)!.contentHash,
    }))
    const operationPath =
      options.operationId === undefined
        ? undefined
        : `${KNOWLEDGE_PROMOTIONS_DIRECTORY}/operation-${options.operationId.slice('sha256:'.length)}.json`
    if (operationPath) {
      try {
        const previous = JSON.parse(
          (await readRegularFileWithinRoot(sharedRoot, operationPath)).bytes.toString('utf8'),
        ) as KnowledgePromotionRecord
        const replay = buildRecord({
          runId,
          actor,
          reason,
          entries: prepared.entries,
          sources,
          createdAt: previous.createdAt,
          operationId: options.operationId,
        })
        if (canonicalCandidateDigest(previous) !== canonicalCandidateDigest(replay)) {
          throw new KnowledgePromotionError(
            'operation-conflict',
            'promotion operationId was already used for different bytes or attribution',
          )
        }
        return previous
      } catch (error) {
        if (!isMissingFile(error)) throw error
      }
    }
    if (
      options.expectedSharedHash !== undefined &&
      (await hashKnowledgeBase(sharedRoot, { pagesDirectory })) !== options.expectedSharedHash
    ) {
      throw new KnowledgePromotionError(
        'baseline-conflict',
        'shared knowledge changed since this run was admitted',
      )
    }
    // A registry entry alone is not evidence: the target's cited raw bytes must
    // still agree with the content identity before new pages can rely on them.
    await freezeSources(sharedRoot, new Set(prepared.sourceIds))
    const paths = new Set(prepared.pages.map((page) => page.path))
    const pages = [...existing.filter((page) => !paths.has(page.path)), ...prepared.pages]
    const nextSources = [...targetSources.values()]
    const validation = validateKnowledgeIndex({
      root: sharedRoot,
      generatedAt: new Date(0).toISOString(),
      pages,
      sources: nextSources,
      graph: buildKnowledgeGraph(pages),
    })
    if (!validation.ok) {
      throw new KnowledgePromotionError(
        'source-conflict',
        `promotion validation failed: ${validation.findings
          .filter((finding) => finding.severity === 'error')
          .map((finding) => finding.message)
          .join('; ')}`,
      )
    }
    const record = buildRecord({
      runId,
      actor,
      reason,
      entries: prepared.entries,
      sources,
      operationId: options.operationId,
      createdAt: (options.now ?? (() => new Date()))().toISOString(),
    })
    const recordText = `${JSON.stringify(record, null, 2)}\n`
    const rawMutations = new Map<string, KnowledgeFileMutation>()
    for (const source of newSources) {
      const other = rawMutations.get(source.record.uri)
      if (other && !Buffer.from(other.content!).equals(source.bytes)) {
        throw new KnowledgePromotionError(
          'source-conflict',
          `promotion raw path "${source.record.uri}" contains different evidence`,
        )
      }
      try {
        const present = await readRegularFileWithinRoot(sharedRoot, source.record.uri)
        if (!present.bytes.equals(source.bytes))
          throw new KnowledgePromotionError(
            'source-conflict',
            `promotion would replace existing raw evidence "${source.record.uri}"`,
          )
      } catch (error) {
        if (!isMissingFile(error)) throw error
        rawMutations.set(source.record.uri, {
          path: source.record.uri,
          content: source.bytes,
          expectedBeforeHash: null,
        })
      }
    }
    const mutations: KnowledgeFileMutation[] = [
      ...pageMutations,
      ...rawMutations.values(),
      ...(newSources.length === 0
        ? []
        : [
            {
              path: '.agent-knowledge/sources.json',
              content: `${JSON.stringify({ generatedAt: record.createdAt, sources: nextSources }, null, 2)}\n`,
            },
          ]),
      {
        path: `${KNOWLEDGE_PROMOTIONS_DIRECTORY}/${record.recordDigest}.json`,
        content: recordText,
      },
      ...(operationPath ? [{ path: operationPath, content: recordText }] : []),
    ]
    await commitKnowledgeFileMutations({
      root: sharedRoot,
      transactionRoot: lock.transactionRoot,
      purpose: `knowledge-promotion:${options.operationId ?? record.recordDigest}`,
      mutations,
      pagesDirectory,
      actorId: actor,
      runId,
      retainHistory: true,
      assertOwned: lock.assertOwned,
    })
    return record
  })
}

interface FrozenSource {
  record: SourceRecord
  bytes: Buffer
}

async function freezeSources(
  root: string,
  sourceIds: ReadonlySet<string>,
): Promise<FrozenSource[]> {
  return withKnowledgeRead(root, async () => {
    const registry = await loadSourceRegistry(root)
    const frozen: FrozenSource[] = []
    for (const record of registry.sources) {
      if (!sourceIds.has(record.id)) continue
      if (!record.uri.startsWith('raw/'))
        throw new KnowledgePromotionError(
          'source-conflict',
          `promotion source "${record.id}" has no captured raw file`,
        )
      const bytes = (await readRegularFileWithinRoot(root, record.uri)).bytes
      // Path imports hash their original bytes as base64; text imports hash UTF-8.
      if (
        createHash('sha256').update(bytes).digest('hex') !== record.contentHash &&
        sha256(bytes.toString('base64')) !== record.contentHash
      ) {
        throw new KnowledgePromotionError(
          'source-conflict',
          `promotion source "${record.id}" does not match its registered content hash`,
        )
      }
      frozen.push({ record, bytes: Buffer.from(bytes) })
    }
    return frozen
  })
}

function assertSameSource(left: SourceRecord, right: SourceRecord): void {
  if (canonicalCandidateDigest(left) !== canonicalCandidateDigest(right)) {
    throw new KnowledgePromotionError(
      'source-conflict',
      `promotion source "${left.id}" has conflicting registered evidence`,
    )
  }
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
  targetSharedPages?: readonly KnowledgePage[],
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
    byId.set(next.entry.page.id, {
      entry: next.entry,
      requested: next.requested,
    })
    for (const persisted of next.entry.page.cites ?? []) {
      const resolution = resolveKnowledgeCitation(chain, parseKnowledgeCitationReference(persisted))
      const target = resolution.resolved
      if (target === undefined) continue
      if (
        target.origin === 'shared' &&
        (targetSharedPages === undefined ||
          targetSharedPages.some(
            (page) => knowledgePageDigest(page) === knowledgePageDigest(target.page),
          ))
      )
        continue
      queue.push({
        entry: { page: target.page, origin: target.origin },
        requested: false,
      })
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
  pagesDirectory: string,
): Promise<string> {
  const sourceRunId = sourceRunOf(entry.origin, runId)
  const snapshot = await readRegularFileWithinRoot(stores.storePath(sourceRunId), entry.page.path)
  const content = snapshot.bytes.toString('utf8')
  const page = knowledgePageFromMarkdown(entry.page.path, content, pagesDirectory)
  if (knowledgePageDigest(page) !== knowledgePageDigest(entry.page)) {
    throw new KnowledgePromotionError(
      'path-conflict',
      `source page "${entry.page.path}" in run "${sourceRunId}" changed after the promotion snapshot`,
    )
  }
  return content
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
  entries: readonly KnowledgePromotionEntry[]
  sources: readonly { sourceId: string; contentHash: string }[]
  operationId?: Sha256Digest
  createdAt: string
}): KnowledgePromotionRecord {
  const material = {
    schemaVersion: KNOWLEDGE_PROMOTION_SCHEMA_VERSION,
    kind: 'knowledge-promotion' as const,
    digestAlgorithm: KNOWLEDGE_PROMOTION_DIGEST_ALGORITHM,
    createdAt: input.createdAt,
    runId: input.runId,
    actor: input.actor,
    reason: input.reason,
    entries: input.entries,
    sources: input.sources,
    ...(input.operationId === undefined ? {} : { operationId: input.operationId }),
  }
  return Object.freeze({
    ...material,
    recordDigest: canonicalCandidateDigest(material),
  })
}

function nonEmpty(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  return value.trim()
}
