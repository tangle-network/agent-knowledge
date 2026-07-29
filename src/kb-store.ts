import { basename, dirname, resolve } from 'node:path'
import { z } from 'zod'
import {
  isMissingFile,
  listRegularFilesWithinRoot,
  readRegularFileWithinRoot,
  writeJsonDurableWithinRoot,
} from './durable-fs'
import type { KnowledgeEventQuery } from './events'
import { buildKnowledgeGraph } from './graph'
import { withKnowledgeMutation, withKnowledgeRead } from './mutation-lock'
import {
  KnowledgeEventSchema,
  KnowledgeIndexSchema,
  KnowledgePageSchema,
  ResearchClaimLedgerSchema,
  SourceRecordSchema,
} from './schemas'
import type {
  KnowledgeEvent,
  KnowledgeIndex,
  KnowledgePage,
  ResearchClaimLedger,
  SourceRecord,
} from './types'

/**
 * Where a filesystem knowledge base keeps its machine-written records, relative
 * to the knowledge-base root.
 *
 * This is the ONE location. `FileSystemKbStore` used to write `<dir>/index.json`
 * while `writeKnowledgeIndex` wrote `<root>/.agent-knowledge/index.json` — two
 * index writers, two files, and only the second one reachable, so a store that
 * had just been written to reported an empty knowledge base. Both now go through
 * `FileSystemKbStore`, anchored on the knowledge-base root, which is also the
 * directory `withKnowledgeMutation` locks: one file, one lock domain.
 */
export const KB_STORE_DIR = '.agent-knowledge'
export const KB_INDEX_PATH = `${KB_STORE_DIR}/index.json`
export const KB_EVENTS_PATH = `${KB_STORE_DIR}/events.json`
export const KB_CLAIM_LEDGER_DIR = `${KB_STORE_DIR}/claim-ledgers`

/**
 * A claim-ledger id is used as a filename, so it is restricted to one safe path
 * segment. Rejecting rather than sanitising is deliberate: a sanitised id maps
 * two different runs onto one file and silently merges their belief state.
 */
const LEDGER_ID_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/

export function assertClaimLedgerId(id: string): string {
  if (!LEDGER_ID_PATTERN.test(id) || id === '.' || id === '..') {
    throw new Error(
      `claim ledger id must match ${LEDGER_ID_PATTERN} and cannot be a path segment: ${id}`,
    )
  }
  return id
}

export interface KbStore {
  putSource(source: SourceRecord): Promise<void>
  getSource(id: string): Promise<SourceRecord | null>
  listSources(): Promise<SourceRecord[]>
  putPage(page: KnowledgePage): Promise<void>
  getPage(idOrPath: string): Promise<KnowledgePage | null>
  listPages(): Promise<KnowledgePage[]>
  putIndex(index: KnowledgeIndex): Promise<void>
  getIndex(): Promise<KnowledgeIndex | null>
  putEvent(event: KnowledgeEvent): Promise<void>
  listEvents(query?: KnowledgeEventQuery): Promise<KnowledgeEvent[]>
}

/** Optional durable capability for stores that retain per-run research belief. */
export interface ClaimLedgerStore {
  /**
   * Persist one research run's claim ledger — the corroboration counts,
   * contradiction edges, and open deep questions that make up its belief state.
   * Addressed by `ledger.id` so two runs against one knowledge base cannot
   * overwrite each other.
   */
  putClaimLedger(ledger: ResearchClaimLedger): Promise<void>
  getClaimLedger(id: string): Promise<ResearchClaimLedger | null>
  listClaimLedgers(): Promise<ResearchClaimLedger[]>
  /**
   * Read one ledger, hand it to `merge`, and write what comes back — with the
   * store's exclusive lock held across all three steps.
   *
   * This is the call a concurrent writer must use, and `putClaimLedger` is the
   * one it must not. `putClaimLedger` writes the whole record, so two writers
   * accumulating into one ledger each write a record built from what they read
   * before the other wrote, and the later write erases the earlier writer's
   * claims. Persisting a ledger that loses half its evidence is not compounding
   * knowledge; it is losing it more slowly.
   *
   * `merge` is SYNCHRONOUS on purpose: it runs inside the critical section, and
   * an `await` in there is a lock held across arbitrary I/O.
   */
  mergeClaimLedger(
    id: string,
    merge: (current: ResearchClaimLedger | null) => ResearchClaimLedger,
  ): Promise<ResearchClaimLedger>
}

export class MemoryKbStore implements KbStore, ClaimLedgerStore {
  private readonly sources = new Map<string, SourceRecord>()
  private readonly pages = new Map<string, KnowledgePage>()
  private readonly events: KnowledgeEvent[] = []
  private readonly claimLedgers = new Map<string, ResearchClaimLedger>()
  private index: KnowledgeIndex | null = null

  async putSource(source: SourceRecord): Promise<void> {
    this.sources.set(source.id, clone(source))
  }

  async getSource(id: string): Promise<SourceRecord | null> {
    return clone(this.sources.get(id) ?? null)
  }

  async listSources(): Promise<SourceRecord[]> {
    return [...this.sources.values()].map(clone)
  }

  async putPage(page: KnowledgePage): Promise<void> {
    this.pages.set(page.id, clone(page))
  }

  async getPage(idOrPath: string): Promise<KnowledgePage | null> {
    return clone(
      this.pages.get(idOrPath) ??
        [...this.pages.values()].find((page) => page.path === idOrPath) ??
        null,
    )
  }

  async listPages(): Promise<KnowledgePage[]> {
    return [...this.pages.values()].map(clone)
  }

  async putIndex(index: KnowledgeIndex): Promise<void> {
    this.index = clone(index)
  }

  async getIndex(): Promise<KnowledgeIndex | null> {
    if (this.index) return clone(this.index)
    const pages = await this.listPages()
    const sources = await this.listSources()
    return {
      root: 'memory',
      generatedAt: new Date().toISOString(),
      sources,
      pages,
      graph: buildKnowledgeGraph(pages),
    }
  }

  async putEvent(event: KnowledgeEvent): Promise<void> {
    this.events.push(clone(event))
  }

  async listEvents(query: KnowledgeEventQuery = {}): Promise<KnowledgeEvent[]> {
    let out = this.events
    if (query.type) out = out.filter((event) => event.type === query.type)
    if (query.target) out = out.filter((event) => event.target === query.target)
    out = [...out].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    return out.slice(-(query.limit ?? out.length)).map(clone)
  }

  async putClaimLedger(ledger: ResearchClaimLedger): Promise<void> {
    const parsed = ResearchClaimLedgerSchema.parse(ledger) as ResearchClaimLedger
    this.claimLedgers.set(assertClaimLedgerId(parsed.id), clone(parsed))
  }

  async getClaimLedger(id: string): Promise<ResearchClaimLedger | null> {
    return clone(this.claimLedgers.get(assertClaimLedgerId(id)) ?? null)
  }

  async listClaimLedgers(): Promise<ResearchClaimLedger[]> {
    return [...this.claimLedgers.values()].map(clone).sort((a, b) => a.id.localeCompare(b.id))
  }

  async mergeClaimLedger(
    id: string,
    merge: (current: ResearchClaimLedger | null) => ResearchClaimLedger,
  ): Promise<ResearchClaimLedger> {
    // No lock: `merge` is synchronous and this is one process, so nothing can
    // interleave between the read and the write.
    const key = assertClaimLedgerId(id)
    const next = assertMergedLedgerId(key, merge(clone(this.claimLedgers.get(key) ?? null)))
    await this.putClaimLedger(next)
    return clone(next)
  }
}

const knowledgeEventsSchema = z.array(KnowledgeEventSchema)

/**
 * The durable record store for one knowledge base.
 *
 * The object constructor is anchored on the knowledge-base root and keeps its
 * records under `<root>/.agent-knowledge/`, which is the layout used by
 * `writeKnowledgeIndex`. The string constructor preserves the published direct
 * record-directory layout (`<directory>/index.json`).
 */
export interface FileSystemKbStoreOptions {
  /** Knowledge-base root; records are stored under `<root>/.agent-knowledge/`. */
  root: string
}

export class FileSystemKbStore implements KbStore, ClaimLedgerStore {
  private readonly root: string
  private readonly indexPath: string
  private readonly eventsPath: string
  private readonly claimLedgerDir: string

  /**
   * A string retains the published direct-directory contract.
   * The object form explicitly selects a knowledge-base root and the canonical
   * `.agent-knowledge/` layout. A string naming that exact canonical directory
   * keeps its file paths but shares the root form's lock domain.
   */
  constructor(input: string | FileSystemKbStoreOptions) {
    const directDirectory = typeof input === 'string' ? resolve(input) : undefined
    const aliasesCanonicalDirectory =
      directDirectory !== undefined && basename(directDirectory) === KB_STORE_DIR
    this.root = aliasesCanonicalDirectory
      ? dirname(directDirectory)
      : typeof input === 'string'
        ? input
        : input.root
    const canonicalLayout = typeof input !== 'string' || aliasesCanonicalDirectory
    this.indexPath = canonicalLayout ? KB_INDEX_PATH : 'index.json'
    this.eventsPath = canonicalLayout ? KB_EVENTS_PATH : 'events.json'
    this.claimLedgerDir = canonicalLayout ? KB_CLAIM_LEDGER_DIR : 'claim-ledgers'
  }

  async putSource(source: SourceRecord): Promise<void> {
    const parsed = SourceRecordSchema.parse(source) as SourceRecord
    await this.updateIndex((index) => ({
      ...index,
      generatedAt: new Date().toISOString(),
      sources: [parsed, ...index.sources.filter((entry) => entry.id !== parsed.id)],
    }))
  }

  async getSource(id: string): Promise<SourceRecord | null> {
    return withKnowledgeRead(this.root, async () => {
      const index = await this.readIndex()
      return clone(index?.sources.find((source) => source.id === id) ?? null)
    })
  }

  async listSources(): Promise<SourceRecord[]> {
    return withKnowledgeRead(this.root, async () => clone((await this.readIndex())?.sources ?? []))
  }

  async putPage(page: KnowledgePage): Promise<void> {
    const parsed = KnowledgePageSchema.parse(page) as KnowledgePage
    await this.updateIndex((index) => {
      const pages = [parsed, ...index.pages.filter((entry) => entry.id !== parsed.id)]
      return {
        ...index,
        generatedAt: new Date().toISOString(),
        pages,
        graph: buildKnowledgeGraph(pages),
      }
    })
  }

  async getPage(idOrPath: string): Promise<KnowledgePage | null> {
    return withKnowledgeRead(this.root, async () => {
      const index = await this.readIndex()
      return clone(
        index?.pages.find((page) => page.id === idOrPath || page.path === idOrPath) ?? null,
      )
    })
  }

  async listPages(): Promise<KnowledgePage[]> {
    return withKnowledgeRead(this.root, async () => clone((await this.readIndex())?.pages ?? []))
  }

  async putIndex(index: KnowledgeIndex): Promise<void> {
    const parsed = KnowledgeIndexSchema.parse(index) as KnowledgeIndex
    await withKnowledgeMutation(this.root, () =>
      writeJsonDurableWithinRoot(this.root, this.indexPath, parsed),
    )
  }

  async getIndex(): Promise<KnowledgeIndex | null> {
    return withKnowledgeRead(this.root, () => this.readIndex())
  }

  async putEvent(event: KnowledgeEvent): Promise<void> {
    const parsed = KnowledgeEventSchema.parse(event) as KnowledgeEvent
    await withKnowledgeMutation(this.root, async () => {
      const current = await this.readEvents()
      const next = [...current.filter((entry) => entry.id !== parsed.id), parsed].sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      )
      await writeJsonDurableWithinRoot(this.root, this.eventsPath, next)
    })
  }

  async listEvents(query: KnowledgeEventQuery = {}): Promise<KnowledgeEvent[]> {
    return withKnowledgeRead(this.root, async () => {
      let events = await this.readEvents()
      if (query.type) events = events.filter((event) => event.type === query.type)
      if (query.target) events = events.filter((event) => event.target === query.target)
      return clone(events.slice(-(query.limit ?? events.length)))
    })
  }

  async putClaimLedger(ledger: ResearchClaimLedger): Promise<void> {
    const parsed = ResearchClaimLedgerSchema.parse(ledger) as ResearchClaimLedger
    const path = this.claimLedgerPath(parsed.id)
    await withKnowledgeMutation(this.root, () =>
      writeJsonDurableWithinRoot(this.root, path, parsed),
    )
  }

  async getClaimLedger(id: string): Promise<ResearchClaimLedger | null> {
    const path = this.claimLedgerPath(id)
    return withKnowledgeRead(
      this.root,
      () =>
        readJsonFile(
          this.root,
          path,
          ResearchClaimLedgerSchema,
        ) as Promise<ResearchClaimLedger | null>,
    )
  }

  async listClaimLedgers(): Promise<ResearchClaimLedger[]> {
    return withKnowledgeRead(this.root, async () => {
      let files: Awaited<ReturnType<typeof listRegularFilesWithinRoot>>
      try {
        files = await listRegularFilesWithinRoot(this.root, this.claimLedgerDir)
      } catch (error) {
        if (isMissingFile(error)) return []
        throw error
      }
      const ledgers: ResearchClaimLedger[] = []
      for (const file of files) {
        if (!file.path.endsWith('.json')) continue
        ledgers.push(
          ResearchClaimLedgerSchema.parse(
            JSON.parse(file.bytes.toString('utf8')),
          ) as ResearchClaimLedger,
        )
      }
      return ledgers.sort((a, b) => a.id.localeCompare(b.id))
    })
  }

  async mergeClaimLedger(
    id: string,
    merge: (current: ResearchClaimLedger | null) => ResearchClaimLedger,
  ): Promise<ResearchClaimLedger> {
    const key = assertClaimLedgerId(id)
    // One mutation scope spans the read AND the write, so a second process
    // cannot read the same `current` this one did. `withKnowledgeMutation` is
    // reentrant, so the nested lock inside `putClaimLedger` joins this scope
    // rather than deadlocking against it.
    return withKnowledgeMutation(this.root, async () => {
      const current = (await readJsonFile(
        this.root,
        this.claimLedgerPath(key),
        ResearchClaimLedgerSchema,
      )) as ResearchClaimLedger | null
      const next = assertMergedLedgerId(key, merge(current))
      await this.putClaimLedger(next)
      return next
    })
  }

  private async updateIndex(change: (index: KnowledgeIndex) => KnowledgeIndex): Promise<void> {
    await withKnowledgeMutation(this.root, async () => {
      const current = (await this.readIndex()) ?? emptyIndex(this.root)
      const next = KnowledgeIndexSchema.parse(change(current)) as KnowledgeIndex
      await writeJsonDurableWithinRoot(this.root, this.indexPath, next)
    })
  }

  private async readIndex(): Promise<KnowledgeIndex | null> {
    return readJsonFile(
      this.root,
      this.indexPath,
      KnowledgeIndexSchema,
    ) as Promise<KnowledgeIndex | null>
  }

  private async readEvents(): Promise<KnowledgeEvent[]> {
    return ((await readJsonFile(this.root, this.eventsPath, knowledgeEventsSchema)) ??
      []) as KnowledgeEvent[]
  }

  private claimLedgerPath(id: string): string {
    return `${this.claimLedgerDir}/${assertClaimLedgerId(id)}.json`
  }
}

/**
 * A merge that returns a ledger under a different id would write that ledger to
 * the file the caller asked to merge, giving one file two identities. Refuse
 * rather than trust the merge function to be well behaved.
 */
function assertMergedLedgerId(id: string, merged: ResearchClaimLedger): ResearchClaimLedger {
  if (merged.id !== id) {
    throw new Error(`merge of claim ledger '${id}' returned a ledger with id '${merged.id}'`)
  }
  return merged
}

function emptyIndex(root: string): KnowledgeIndex {
  return {
    root,
    generatedAt: new Date(0).toISOString(),
    sources: [],
    pages: [],
    graph: { nodes: [], edges: [] },
  }
}

async function readJsonFile<T>(
  root: string,
  relativePath: string,
  schema: z.ZodType<T>,
): Promise<T | null> {
  try {
    const file = await readRegularFileWithinRoot(root, relativePath)
    return schema.parse(JSON.parse(file.bytes.toString('utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return null
    throw error
  }
}

function clone<T>(value: T): T {
  return value == null ? value : (JSON.parse(JSON.stringify(value)) as T)
}
