import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { isMissingFile, writeJsonDurableWithinRoot } from './durable-fs'
import { withKnowledgeMutation, withKnowledgeRead } from './mutation-lock'

/**
 * Knowledge freshness store: tracks when each `(workspaceId, sourceId)` pair
 * was last successfully refreshed, and reports staleness against a TTL.
 *
 * The contract is intentionally minimal and supports scheduled refresh loops:
 *
 *   ```ts
 *   const store = createFileSystemFreshnessStore({ root: '.agent-knowledge' })
 *   for (const source of sources) {
 *     if (await store.stale({ workspaceId, sourceId: source.id, ttlMs: DAY })) {
 *       const fragments = await source.fetch({ cacheDir })
 *       await persistFragments(fragments)
 *       await store.mark({ workspaceId, sourceId: source.id, when: new Date() })
 *     }
 *   }
 *   ```
 *
 * Per-tenant isolation is enforced by `workspaceId` keying. There is no
 * global mutable state across workspaces.
 *
 * Two adapters ship in-package:
 *
 *   - `createFileSystemFreshnessStore`: JSON file under the knowledge root,
 *     mirrors the layout convention already used by `sources.json`.
 *   - `createD1FreshnessStoreStub`: complete bridge from the `D1Adapter` port
 *     to this package's freshness interface. The port can be backed by D1,
 *     PostgreSQL, SQLite, or another application-owned store.
 */

/** Identity for one freshness record. */
export interface FreshnessKey {
  workspaceId: string
  sourceId: string
}

/** TTL bound for staleness checks. */
export interface FreshnessTtl extends FreshnessKey {
  /** Milliseconds; the record is stale when `Date.now() - last() > ttlMs`. */
  ttlMs: number
  /** Injected clock for deterministic tests; defaults to system time. */
  now?: Date
}

/** Mark argument. */
export interface FreshnessMark extends FreshnessKey {
  when: Date
  /** Optional content hash captured at refresh time; aids debugging. */
  contentHash?: string
}

export interface KnowledgeFreshnessStore {
  /** Last refresh time, or null if never refreshed. */
  last(key: FreshnessKey): Promise<Date | null>
  /** Record a successful refresh. */
  mark(input: FreshnessMark): Promise<void>
  /** True iff `last(key)` is null or older than `ttlMs`. */
  stale(input: FreshnessTtl): Promise<boolean>
  /** All records for a workspace. */
  list(workspaceId: string): Promise<FreshnessRecord[]>
}

export interface FreshnessRecord {
  workspaceId: string
  sourceId: string
  lastRefreshedAt: string
  contentHash?: string
}

export interface FileSystemFreshnessStoreOptions {
  /**
   * Knowledge root. The store writes to `<root>/.agent-knowledge/freshness.json`,
   * mirroring the convention used by `sources.json`.
   */
  root: string
}

const freshnessRecordSchema = z
  .object({
    workspaceId: z.string().min(1),
    sourceId: z.string().min(1),
    lastRefreshedAt: z.iso.datetime(),
    contentHash: z.string().min(1).optional(),
  })
  .strict()
const freshnessFileSchema = z
  .object({ records: z.record(z.string(), freshnessRecordSchema) })
  .strict()

/**
 * Filesystem-backed implementation. Single JSON file per knowledge root,
 * indexed by `${workspaceId}::${sourceId}`. Reads parse on every call;
 * cron tick rate is well below the cost of one JSON parse.
 *
 * Writes share the package-wide filesystem lock, so multiple workers cannot
 * overwrite one another or run through an interrupted knowledge promotion.
 */
export function createFileSystemFreshnessStore(
  options: FileSystemFreshnessStoreOptions,
): KnowledgeFreshnessStore {
  const path = join(options.root, '.agent-knowledge', 'freshness.json')

  const read = async (): Promise<Record<string, FreshnessRecord>> => {
    return withKnowledgeRead(options.root, async () => {
      try {
        return freshnessFileSchema.parse(JSON.parse(await readFile(path, 'utf8'))).records
      } catch (error) {
        if (isMissingFile(error)) return {}
        throw error
      }
    })
  }

  const write = async (records: Record<string, FreshnessRecord>): Promise<void> => {
    await writeJsonDurableWithinRoot(
      options.root,
      '.agent-knowledge/freshness.json',
      freshnessFileSchema.parse({ records }),
    )
  }

  return {
    async last(key) {
      const records = await read()
      const record = records[buildKey(key)]
      return record ? new Date(record.lastRefreshedAt) : null
    },
    async mark(input) {
      await withKnowledgeMutation(options.root, async () => {
        const records = await read()
        records[buildKey(input)] = {
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
          lastRefreshedAt: input.when.toISOString(),
          ...(input.contentHash === undefined ? {} : { contentHash: input.contentHash }),
        }
        await write(records)
      })
    },
    async stale(input) {
      const last = await this.last(input)
      if (!last) return true
      const now = input.now ?? new Date()
      return now.getTime() - last.getTime() > input.ttlMs
    },
    async list(workspaceId) {
      const records = await read()
      return Object.values(records).filter((r) => r.workspaceId === workspaceId)
    },
  }
}

/**
 * Bridge an application-owned database adapter to `KnowledgeFreshnessStore`.
 * The adapter may use D1, PostgreSQL, SQLite, or another durable store.
 *
 * The expected schema:
 *
 * ```sql
 * CREATE TABLE knowledge_freshness (
 *   workspace_id     TEXT NOT NULL,
 *   source_id        TEXT NOT NULL,
 *   last_refreshed_at TEXT NOT NULL,
 *   content_hash     TEXT,
 *   PRIMARY KEY (workspace_id, source_id)
 * );
 * ```
 */
export interface D1Adapter {
  get(workspaceId: string, sourceId: string): Promise<FreshnessRecord | null>
  upsert(record: FreshnessRecord): Promise<void>
  listByWorkspace(workspaceId: string): Promise<FreshnessRecord[]>
}

export function createD1FreshnessStoreStub(adapter: D1Adapter): KnowledgeFreshnessStore {
  return {
    async last(key) {
      const record = await adapter.get(key.workspaceId, key.sourceId)
      return record ? new Date(record.lastRefreshedAt) : null
    },
    async mark(input) {
      await adapter.upsert({
        workspaceId: input.workspaceId,
        sourceId: input.sourceId,
        lastRefreshedAt: input.when.toISOString(),
        contentHash: input.contentHash,
      })
    },
    async stale(input) {
      const last = await this.last(input)
      if (!last) return true
      const now = input.now ?? new Date()
      return now.getTime() - last.getTime() > input.ttlMs
    },
    async list(workspaceId) {
      return adapter.listByWorkspace(workspaceId)
    },
  }
}

function buildKey(key: FreshnessKey): string {
  return `${key.workspaceId}::${key.sourceId}`
}
