/**
 * Run-scoped knowledge stores with lineage-chain reads.
 *
 * One store exists per run, physically isolated, with inheritance only through
 * declared ancestry. Reads expose the current store, every declared ancestor,
 * and an optional curated shared store with an explicit origin label.
 */
import { join } from 'node:path'
import { isMissingFile, readRegularFileWithinRoot } from './durable-fs'
import { withKnowledgeMutation } from './mutation-lock'
import { type KnowledgePagesOptions, normalizePagesDirectory } from './pages-directory'
import type { KnowledgeLayout } from './store'
import { initKnowledgeBase, loadKnowledgePages, writeJson } from './store'
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
}

/** Ancestry beyond this bound is invalid durable state. */
const MAX_LINEAGE_HOPS = 64

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
    // One query more than the bound: a chain of exactly MAX_LINEAGE_HOPS
    // ancestors needs the terminating null query to prove it ends.
    for (let hop = 0; hop <= MAX_LINEAGE_HOPS; hop += 1) {
      const parent = await authority.parentOf(current)
      if (parent === null) return chain
      assertRunId(parent, `parent of '${current}'`)
      if (seen.has(parent)) {
        throw new Error(`run lineage cycle: ${parent} is its own ancestor (via ${runId})`)
      }
      seen.add(parent)
      chain.push(parent)
      current = parent
    }
    throw new Error(`run lineage for '${runId}' exceeds ${MAX_LINEAGE_HOPS} ancestors`)
  }

  return {
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
