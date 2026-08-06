/**
 * Run-scoped knowledge stores with lineage-chain reads.
 *
 * One store per run, physically isolated, with inheritance only by declared ancestry. The design
 * answers a failure mode a discovery campaign paid for twice: when every run writes one shared
 * store, a false "measured" claim from one arm becomes the next arm's settled provenance — twice
 * in that campaign a wrong claim crossed run boundaries and became standing instruction before
 * anyone re-derived it. Isolation makes "what did THIS run learn" a directory listing, and the
 * knowledge delta between two runs a diff of two directories.
 *
 * A branch still inherits: reads walk the run's own store, then each ancestor up a recorded
 * parent chain, then an optional shared store — every page labeled with where it came from,
 * because "I established this", "an earlier attempt believed this", and "the lab curates this"
 * are three different provenance claims and a reader must be able to weigh them differently.
 */
import { join } from 'node:path'
import { isMissingFile, readRegularFileWithinRoot } from './durable-fs'
import type { KnowledgeLayout } from './store'
import { initKnowledgeBase, loadKnowledgePages, writeJson } from './store'
import type { KnowledgePage } from './types'

/** Where a page in a chained read came from. */
export type PageOrigin = 'here' | `inherited:${string}` | 'shared'

export interface OriginatedPage {
  page: KnowledgePage
  origin: PageOrigin
}

export interface RunLineageRecord {
  runId: string
  parentRunId: string | null
  createdAt: string
}

export const RUN_LINEAGE_BASENAME = 'lineage.json'

export interface RunScopedStoresOptions {
  /** The root under which per-run stores live. */
  root: string
  /** Store path for a run; defaults to `<root>/<runId>/knowledge-base`. */
  runStorePath?: (runId: string) => string
  /**
   * The curated store every run may read but no run writes — promotion into it is a deliberate
   * act outside this module. Searched last, labeled `shared`.
   */
  sharedRoot?: string
}

/** Ancestry chains longer than this indicate a cycle or a runaway, not a real lineage. */
const MAX_LINEAGE_HOPS = 64

export interface RunScopedStores {
  /** Create (or open) a run's store, recording its parent at creation time. */
  init(runId: string, options?: { parentRunId?: string | null }): Promise<KnowledgeLayout>
  /** The ancestor chain of a run, nearest first, resolved from records written at init. */
  lineage(runId: string): Promise<string[]>
  /**
   * Every page visible to a run: its own, then each ancestor's, then the shared store's, each
   * labeled with its origin. Later stores never shadow earlier ones — a reader sees both copies
   * of a twice-recorded claim and the labels that distinguish them.
   */
  loadChain(runId: string): Promise<OriginatedPage[]>
}

export function createRunScopedStores(options: RunScopedStoresOptions): RunScopedStores {
  const storePath =
    options.runStorePath ?? ((runId: string) => join(options.root, runId, 'knowledge-base'))

  async function parentOf(runId: string): Promise<string | null> {
    try {
      const snapshot = await readRegularFileWithinRoot(storePath(runId), RUN_LINEAGE_BASENAME)
      return (JSON.parse(snapshot.bytes.toString('utf8')) as RunLineageRecord).parentRunId
    } catch (error) {
      // A run created before lineage recording (or outside it) simply ends the chain: absent
      // ancestry is absent, not an error — the chain is only as deep as what was declared.
      if (isMissingFile(error)) return null
      throw error
    }
  }

  return {
    async init(runId, initOptions = {}) {
      const layout = await initKnowledgeBase(storePath(runId))
      const record: RunLineageRecord = {
        runId,
        parentRunId: initOptions.parentRunId ?? null,
        createdAt: new Date().toISOString(),
      }
      await writeJson(join(storePath(runId), RUN_LINEAGE_BASENAME), record)
      return layout
    },

    async lineage(runId) {
      const chain: string[] = []
      const seen = new Set<string>([runId])
      let current: string | null = runId
      for (let hop = 0; hop < MAX_LINEAGE_HOPS && current !== null; hop += 1) {
        current = await parentOf(current)
        if (current === null) break
        if (seen.has(current)) {
          throw new Error(`run lineage cycle: ${current} is its own ancestor (via ${runId})`)
        }
        seen.add(current)
        chain.push(current)
      }
      return chain
    },

    async loadChain(runId) {
      const out: OriginatedPage[] = []
      const readInto = async (root: string, origin: PageOrigin) => {
        let pages: KnowledgePage[]
        try {
          pages = await loadKnowledgePages(root)
        } catch (error) {
          if (isMissingFile(error)) return
          throw error
        }
        for (const page of pages) out.push({ page, origin })
      }
      await readInto(storePath(runId), 'here')
      for (const ancestor of await this.lineage(runId)) {
        await readInto(storePath(ancestor), `inherited:${ancestor}`)
      }
      if (options.sharedRoot) await readInto(options.sharedRoot, 'shared')
      return out
    },
  }
}
