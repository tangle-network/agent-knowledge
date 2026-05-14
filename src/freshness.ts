import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * Knowledge freshness store: tracks when each `(workspaceId, sourceId)` pair
 * was last successfully refreshed, and reports staleness against a TTL.
 *
 * The contract is intentionally minimal — just enough to drive a cron loop:
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
 * Per-tenant isolation is enforced by `workspaceId` keying — there is no
 * global mutable state across workspaces.
 *
 * Two adapters ship in-package:
 *
 *   - `createFileSystemFreshnessStore` — JSON file under the knowledge root,
 *     mirrors the layout convention already used by `sources.json`.
 *   - `createD1FreshnessStoreStub` — adapter scaffold for Cloudflare D1 /
 *     Postgres. Production consumers should implement the `D1Adapter`
 *     interface inside their own app; this stub exists to anchor the shape.
 *
 * @stable contract — interface is frozen at 0.x within this major.
 * @stable filesystem adapter
 * @experimental D1 stub — interface will evolve as real consumers wire it.
 */

/** Identity for one freshness record. */
export interface FreshnessKey {
  workspaceId: string
  sourceId: string
}

/** TTL bound for staleness checks. */
export interface FreshnessTtl extends FreshnessKey {
  /** Milliseconds — `Date.now() - last() > ttlMs` ⇒ stale. */
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
  /** All records for a workspace — useful for dashboards / debugging. */
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

/**
 * Filesystem-backed implementation. Single JSON file per knowledge root,
 * indexed by `${workspaceId}::${sourceId}`. Reads parse on every call —
 * cron tick rate is well below the cost of one JSON parse.
 *
 * Concurrent writes from a single process serialize through `writeQueue`.
 * Cross-process concurrency is undefined; the consuming app should run the
 * cron in a single worker.
 */
export function createFileSystemFreshnessStore(
  options: FileSystemFreshnessStoreOptions,
): KnowledgeFreshnessStore {
  const path = join(options.root, '.agent-knowledge', 'freshness.json')
  let writeQueue: Promise<unknown> = Promise.resolve()

  const read = async (): Promise<Record<string, FreshnessRecord>> => {
    try {
      const text = await readFile(path, 'utf8')
      const parsed = JSON.parse(text) as { records?: Record<string, FreshnessRecord> }
      return parsed.records ?? {}
    } catch {
      return {}
    }
  }

  const write = async (records: Record<string, FreshnessRecord>): Promise<void> => {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify({ records }, null, 2)}\n`, 'utf8')
  }

  return {
    async last(key) {
      const records = await read()
      const record = records[buildKey(key)]
      return record ? new Date(record.lastRefreshedAt) : null
    },
    async mark(input) {
      writeQueue = writeQueue.then(async () => {
        const records = await read()
        records[buildKey(input)] = {
          workspaceId: input.workspaceId,
          sourceId: input.sourceId,
          lastRefreshedAt: input.when.toISOString(),
          contentHash: input.contentHash,
        }
        await write(records)
      })
      await writeQueue
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
 * D1 / Postgres adapter scaffold. Production consumers implement
 * `D1Adapter` against their own driver (better-sqlite3, postgres,
 * Cloudflare D1 binding, ...). This factory wires the adapter to the
 * `KnowledgeFreshnessStore` interface.
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
