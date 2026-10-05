/**
 * Run-scoped knowledge stores with lineage-chain reads.
 *
 * One store exists per run, physically isolated, with inheritance only through
 * declared ancestry. Reads expose the current store, every declared ancestor,
 * and an optional curated shared store with an explicit origin label.
 */
import { join } from 'node:path'
import {
  isMissingFile,
  listRegularFileMetadataWithinRoot,
  listRegularFilesWithinRoot,
  readRegularFileWithinRoot,
} from './durable-fs'
import { withKnowledgeMutation, withKnowledgeRead } from './mutation-lock'
import { type KnowledgePagesOptions, normalizePagesDirectory } from './pages-directory'
import type { KnowledgeLayout } from './store'
import {
  initKnowledgeBase,
  isKnowledgePagePath,
  knowledgePageFromMarkdown,
  loadKnowledgePages,
  writeJson,
} from './store'
import type { KnowledgePage } from './types'

/** Where a page in a chained read came from. */
export type PageOrigin = 'here' | `inherited:${string}` | 'shared'

export interface OriginatedPage {
  page: KnowledgePage
  origin: PageOrigin
}

/**
 * Present plain pages as a visibility chain of one origin.
 *
 * A store read directly is the `here` origin of a chain with no ancestry, so
 * the chain-shaped APIs — citation resolution, the write intake gate,
 * invalidation propagation — take one page shape whether or not the caller
 * runs run-scoped stores.
 */
export function originatedPages(
  pages: readonly KnowledgePage[],
  origin: PageOrigin = 'here',
): OriginatedPage[] {
  return pages.map((page) => ({ page, origin }))
}

export interface RunLineageRecord {
  runId: string
  parentRunId: string | null
  createdAt: string
}

/**
 * Durable authority for run ancestry.
 *
 * A product whose run manifest already owns lineage can supply an authority
 * backed by that manifest. `record` is optional for read-only authorities; in
 * that case `init` verifies that the existing authority agrees with the parent
 * requested by the caller before creating any store files.
 */
export interface RunLineageAuthority {
  parentOf(runId: string): Promise<string | null>
  record?(record: RunLineageRecord): Promise<void>
}

export const RUN_LINEAGE_BASENAME = 'lineage.json'

export interface RunScopedStoresOptions extends KnowledgePagesOptions {
  /** The root under which per-run stores live. */
  root: string
  /** Store path for a run; defaults to `<root>/<runId>/knowledge-base`. */
  runStorePath?: (runId: string) => string
  /**
   * The curated store every run may read but no run writes. Searched last and
   * labeled `shared`.
   */
  sharedRoot?: string
  /** External owner for run ancestry. Defaults to a record inside each run store. */
  lineageAuthority?: RunLineageAuthority
  /** Optional caller-owned bound on ancestor reads. Omit to read the complete finite chain.
   * Cycles and invalid identities are always refused; long valid history is not corruption. */
  maxAncestors?: number
}

export interface RunScopedStores {
  /** Create or open a run store and bind it to one exact parent identity. */
  init(runId: string, options?: { parentRunId?: string | null }): Promise<KnowledgeLayout>
  /**
   * Where one run's store lives. A caller that must read a run's bytes rather
   * than its parsed pages — promotion carries a page unchanged — needs the
   * root the chain read hides.
   */
  storePath(runId: string): string
  /** The ancestor chain of a run, nearest first. */
  lineage(runId: string): Promise<string[]>
  /**
   * Every page visible to a run: current, ancestors, then shared. A repeated
   * page id is retained at every origin so citation resolution can report the
   * ambiguity instead of silently shadowing one page.
   */
  loadChain(runId: string): Promise<OriginatedPage[]>
}

// Tool callers share immutable views; public loadChain continues to return detached mutable data.
const toolViewLoaders = new WeakMap<
  RunScopedStores,
  (runId: string) => Promise<readonly OriginatedPage[]>
>()
const toolViews = new WeakSet<readonly OriginatedPage[]>()

/** Only factory-owned immutable views are safe to reuse by object identity. */
export function isKnowledgeToolChain(chain: readonly OriginatedPage[]): boolean {
  return toolViews.has(chain)
}

const MAX_CACHED_ROOTS = 8
const MAX_CACHED_SOURCE_BYTES = 64 * 1024 * 1024

/** Internal tool path. Custom stores retain their existing loadChain contract. */
export function loadKnowledgeToolChain(stores: RunScopedStores, runId: string) {
  return toolViewLoaders.get(stores)?.(runId) ?? stores.loadChain(runId)
}

export function createRunScopedStores(options: RunScopedStoresOptions): RunScopedStores {
  if (!options || typeof options !== 'object') {
    throw new TypeError('createRunScopedStores options are required')
  }
  if (typeof options.root !== 'string' || options.root.trim().length === 0) {
    throw new TypeError('createRunScopedStores root must be a non-empty string')
  }
  if (options.runStorePath !== undefined && typeof options.runStorePath !== 'function') {
    throw new TypeError('createRunScopedStores runStorePath must be a function when present')
  }
  const maxAncestors = options.maxAncestors
  if (maxAncestors !== undefined && (!Number.isSafeInteger(maxAncestors) || maxAncestors < 0)) {
    throw new TypeError('createRunScopedStores maxAncestors must be a non-negative safe integer')
  }
  if (options.lineageAuthority !== undefined) validateLineageAuthority(options.lineageAuthority)
  const pagesDirectory = normalizePagesDirectory(options.pagesDirectory)

  const storePath =
    options.runStorePath ?? ((runId: string) => join(options.root, runId, 'knowledge-base'))
  const internalAuthority = createFileRunLineageAuthority(storePath)
  const authority = options.lineageAuthority ?? internalAuthority

  const resolveLineage = async (runId: string): Promise<string[]> => {
    assertRunId(runId)
    const chain: string[] = []
    const seen = new Set<string>([runId])
    let current = runId
    // The terminating null is read even at an explicit bound: an exactly-full chain is valid.
    for (;;) {
      const parent = await authority.parentOf(current)
      if (parent === null) return chain
      assertRunId(parent, `parent of '${current}'`)
      if (seen.has(parent)) {
        throw new Error(`run lineage cycle: ${parent} is its own ancestor (via ${runId})`)
      }
      if (maxAncestors !== undefined && chain.length >= maxAncestors) {
        throw new Error(`run lineage for '${runId}' exceeds caller maxAncestors=${maxAncestors}`)
      }
      seen.add(parent)
      chain.push(parent)
      current = parent
    }
  }

  const stores: RunScopedStores = {
    storePath(runId) {
      assertRunId(runId)
      return storePath(runId)
    },

    async init(runId, initOptions = {}) {
      assertRunId(runId)
      const parentRunId = initOptions.parentRunId ?? null
      if (parentRunId !== null) assertRunId(parentRunId, `parent of '${runId}'`)

      // A read-only product authority already owns the identity. Verify it
      // before `initKnowledgeBase` creates directories or scaffold files, so a
      // rejected lineage request leaves no partial knowledge store behind.
      if (!authority.record) {
        const existingParent = await authority.parentOf(runId)
        if (existingParent !== parentRunId) {
          throw new Error(
            `external lineage authority disagrees for '${runId}': expected ${renderParent(parentRunId)}, observed ${renderParent(existingParent)}`,
          )
        }
      }

      const layout = await initKnowledgeBase(storePath(runId))
      if (authority.record) {
        await authority.record(
          Object.freeze({
            runId,
            parentRunId,
            createdAt: new Date().toISOString(),
          }),
        )
      }
      return layout
    },

    lineage: resolveLineage,

    async loadChain(runId) {
      assertRunId(runId)
      const out: OriginatedPage[] = []
      const readInto = async (root: string, origin: PageOrigin) => {
        let pages: KnowledgePage[]
        try {
          pages = await loadKnowledgePages(root, { pagesDirectory })
        } catch (error) {
          if (isMissingFile(error)) return
          throw error
        }
        for (const page of pages) out.push({ page, origin })
      }
      await readInto(storePath(runId), 'here')
      for (const ancestor of await resolveLineage(runId)) {
        await readInto(storePath(ancestor), `inherited:${ancestor}`)
      }
      if (options.sharedRoot) await readInto(options.sharedRoot, 'shared')
      return out
    },
  }

  type CachedFile = { generation: string; page: KnowledgePage | undefined }
  type CachedRoot = {
    generation: string
    bytes: number
    files: ReadonlyMap<string, CachedFile>
    pages: readonly KnowledgePage[]
  }
  const roots = new Map<string, CachedRoot>()
  let current:
    | { identities: string[]; parts: CachedRoot[]; chain: readonly OriginatedPage[] }
    | undefined
  // Re-read and re-parse only files whose identity changed; an unchanged file keeps its frozen page.
  const loadRoot = (root: string, previous: CachedRoot | undefined): Promise<CachedRoot> =>
    withKnowledgeRead(root, async () => {
      let listed: Awaited<ReturnType<typeof listRegularFileMetadataWithinRoot>>
      try {
        listed = await listRegularFileMetadataWithinRoot(root, pagesDirectory)
      } catch (error) {
        if (!isMissingFile(error)) throw error
        listed = []
      }
      const generation = JSON.stringify(listed.map((file) => [file.path, file.generation]))
      if (previous?.generation === generation) return previous
      const files = new Map<string, CachedFile>()
      const changed: typeof listed = []
      for (const file of listed) {
        const known = previous?.files.get(file.path)
        if (known?.generation === file.generation) files.set(file.path, known)
        else if (!isKnowledgePagePath(file.path))
          files.set(file.path, { generation: file.generation, page: undefined })
        else changed.push(file)
      }
      const parse = (path: string, generation: string, bytes: Buffer) =>
        files.set(path, {
          generation,
          page: freezeView(knowledgePageFromMarkdown(path, bytes.toString('utf8'), pagesDirectory)),
        })
      if (changed.length > 64) {
        // A cold or wholesale change reads the tree through one anchored walk. A file replaced or
        // removed after the listing differs from its listed generation at the next refresh.
        const wanted = new Map(changed.map((file) => [file.path, file.generation]))
        for (const file of await listRegularFilesWithinRoot(root, pagesDirectory)) {
          const generation = wanted.get(file.path)
          if (generation !== undefined) parse(file.path, generation, file.bytes)
        }
      } else {
        await Promise.all(
          changed.map(async (file) => {
            try {
              parse(
                file.path,
                file.generation,
                (await readRegularFileWithinRoot(root, file.path)).bytes,
              )
            } catch (error) {
              if (!isMissingFile(error)) throw error
            }
          }),
        )
      }
      const pages = Object.freeze(
        [...files.values()]
          .flatMap((file) => (file.page ? [file.page] : []))
          .sort((a, b) => a.path.localeCompare(b.path)),
      )
      return {
        generation,
        bytes: listed.reduce((sum, file) => sum + file.bytes, 0),
        files,
        pages,
      }
    })
  // One refresh per root at a time. A caller joins only a refresh that starts after it arrived,
  // so every caller still observes every write that completed before its call.
  const refreshes = new Map<string, { running?: Promise<CachedRoot>; next?: Promise<CachedRoot> }>()
  const readRoot = (root: string): Promise<CachedRoot> => {
    let state = refreshes.get(root)
    if (!state) {
      state = {}
      refreshes.set(root, state)
    }
    const slot = state
    const start = (): Promise<CachedRoot> => {
      const running = loadRoot(root, roots.get(root))
        .then((loaded) => retain(root, loaded))
        .finally(() => {
          if (slot.running === running) slot.running = undefined
          if (!slot.running && !slot.next && refreshes.get(root) === slot) refreshes.delete(root)
        })
      slot.running = running
      return running
    }
    if (slot.next) return slot.next
    if (!slot.running) return start()
    const next = slot.running
      .catch(() => undefined)
      .then(() => {
        slot.next = undefined
        return start()
      })
    slot.next = next
    return next
  }
  // Retain the roots of the latest view without a byte bound, so a large store is never re-read
  // whole; other roots are evicted beyond the root and byte bounds, oldest first.
  const retain = (root: string, loaded: CachedRoot): CachedRoot => {
    const existing = roots.get(root)
    if (existing?.generation === loaded.generation) return existing
    roots.delete(root)
    roots.set(root, loaded)
    const live = new Set(current?.identities.map((identity) => JSON.parse(identity)[0] as string))
    live.add(root)
    let bytes = 0
    for (const part of roots.values()) bytes += part.bytes
    for (const [candidate, part] of roots) {
      if (roots.size <= MAX_CACHED_ROOTS && bytes <= MAX_CACHED_SOURCE_BYTES) break
      if (live.has(candidate)) continue
      roots.delete(candidate)
      bytes -= part.bytes
    }
    return loaded
  }
  toolViewLoaders.set(stores, async (runId) => {
    assertRunId(runId)
    const scopes: Array<{ root: string; origin: PageOrigin }> = [
      { root: storePath(runId), origin: 'here' },
    ]
    for (const ancestor of await resolveLineage(runId)) {
      scopes.push({ root: storePath(ancestor), origin: `inherited:${ancestor}` })
    }
    if (options.sharedRoot) scopes.push({ root: options.sharedRoot, origin: 'shared' })
    const identities = scopes.map(({ root, origin }) => JSON.stringify([root, origin]))
    const parts = await Promise.all(scopes.map((scope) => readRoot(scope.root)))
    const latest = current
    if (
      latest &&
      identities.length === latest.identities.length &&
      identities.every((id, i) => id === latest.identities[i] && parts[i] === latest.parts[i])
    ) {
      return latest.chain
    }
    const chain = Object.freeze(
      parts.flatMap((part, i) =>
        part.pages.map((page) => Object.freeze({ page, origin: scopes[i]!.origin })),
      ),
    )
    toolViews.add(chain)
    current = { identities, parts, chain }
    return chain
  })
  return stores
}

function freezeView<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeView(child)
    Object.freeze(value)
  }
  return value
}

/** File-backed authority used when the product has no separate run manifest. */
export function createFileRunLineageAuthority(
  runStorePath: (runId: string) => string,
): RunLineageAuthority {
  if (typeof runStorePath !== 'function') {
    throw new TypeError('createFileRunLineageAuthority requires a runStorePath function')
  }

  const readRecord = async (runId: string): Promise<RunLineageRecord | null> => {
    assertRunId(runId)
    const root = runStorePath(runId)
    try {
      const snapshot = await readRegularFileWithinRoot(root, RUN_LINEAGE_BASENAME)
      return parseLineageRecord(snapshot.bytes.toString('utf8'), runId)
    } catch (error) {
      if (isMissingFile(error)) return null
      throw error
    }
  }

  return {
    async parentOf(runId) {
      return (await readRecord(runId))?.parentRunId ?? null
    },

    async record(record) {
      const validated = validateLineageRecord(record)
      const root = runStorePath(validated.runId)
      await withKnowledgeMutation(root, async () => {
        const existing = await readRecord(validated.runId)
        if (existing) {
          if (existing.parentRunId !== validated.parentRunId) {
            throw new Error(
              `run lineage conflict for '${validated.runId}': existing parent ${renderParent(existing.parentRunId)}, requested ${renderParent(validated.parentRunId)}`,
            )
          }
          return
        }
        await writeJson(join(root, RUN_LINEAGE_BASENAME), validated)
      })
    },
  }
}

function validateLineageAuthority(authority: RunLineageAuthority): void {
  if (!authority || typeof authority !== 'object') {
    throw new TypeError('lineageAuthority must be an object')
  }
  if (typeof authority.parentOf !== 'function') {
    throw new TypeError('lineageAuthority.parentOf must be a function')
  }
  if (authority.record !== undefined && typeof authority.record !== 'function') {
    throw new TypeError('lineageAuthority.record must be a function when present')
  }
}

function parseLineageRecord(text: string, expectedRunId: string): RunLineageRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    throw new Error(`invalid lineage JSON for '${expectedRunId}'`, { cause })
  }
  const record = validateLineageRecord(parsed)
  if (record.runId !== expectedRunId) {
    throw new Error(
      `lineage record identity mismatch: expected '${expectedRunId}', found '${record.runId}'`,
    )
  }
  return record
}

function validateLineageRecord(value: unknown): RunLineageRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('run lineage record must be an object')
  }
  const record = value as Record<string, unknown>
  assertRunId(record.runId, 'lineage record runId')
  if (record.parentRunId !== null) {
    assertRunId(record.parentRunId, `parent of '${record.runId}'`)
  }
  if (
    typeof record.createdAt !== 'string' ||
    record.createdAt.trim().length === 0 ||
    !Number.isFinite(Date.parse(record.createdAt))
  ) {
    throw new TypeError('run lineage record createdAt must be an ISO timestamp')
  }
  return {
    runId: record.runId,
    parentRunId: record.parentRunId,
    createdAt: record.createdAt,
  }
}

function assertRunId(value: unknown, label = 'runId'): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
  // A run id becomes a path segment under the store root. A separator or dot
  // segment would escape the root and break the physical-isolation promise.
  const trimmed = value.trim()
  if (trimmed === '.' || trimmed === '..' || /[/\\\0]/.test(value)) {
    throw new TypeError(`${label} must not contain path separators or dot segments`)
  }
}

function renderParent(parentRunId: string | null): string {
  return parentRunId === null ? 'none' : `'${parentRunId}'`
}
