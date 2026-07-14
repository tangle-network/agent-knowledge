import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createD1FreshnessStoreStub,
  createFileSystemFreshnessStore,
  type D1Adapter,
  type FreshnessRecord,
} from '../src/freshness'

/**
 * Bug class each test defends against:
 *
 *   - filesystem store reading stale in-memory state ⇒ cron re-fetches
 *     even after a successful mark.
 *   - tenants leaking across workspaces ⇒ multi-tenant data-isolation bug.
 *   - TTL miscompare (e.g. `>=` vs `>`) ⇒ off-by-one in cron scheduling.
 *   - D1 stub interface drift breaking production callers.
 */
async function withTempRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'agent-knowledge-freshness-'))
  try {
    return await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('createFileSystemFreshnessStore', () => {
  it('starts empty — every source is stale', async () => {
    await withTempRoot(async (root) => {
      const store = createFileSystemFreshnessStore({ root })
      expect(await store.last({ workspaceId: 'w1', sourceId: 'cornell-lii' })).toBeNull()
      expect(await store.stale({ workspaceId: 'w1', sourceId: 'cornell-lii', ttlMs: 60_000 })).toBe(
        true,
      )
    })
  })

  it('round-trips mark → last → stale=false within TTL', async () => {
    await withTempRoot(async (root) => {
      const store = createFileSystemFreshnessStore({ root })
      const when = new Date('2026-05-14T12:00:00.000Z')
      await store.mark({ workspaceId: 'w1', sourceId: 'cornell-lii', when, contentHash: 'abc' })

      expect(await store.last({ workspaceId: 'w1', sourceId: 'cornell-lii' })).toEqual(when)
      expect(
        await store.stale({
          workspaceId: 'w1',
          sourceId: 'cornell-lii',
          ttlMs: 60_000,
          now: new Date('2026-05-14T12:00:30.000Z'),
        }),
      ).toBe(false)
    })
  })

  it('reports stale once TTL elapses', async () => {
    await withTempRoot(async (root) => {
      const store = createFileSystemFreshnessStore({ root })
      const when = new Date('2026-05-14T12:00:00.000Z')
      await store.mark({ workspaceId: 'w1', sourceId: 'cornell-lii', when })
      expect(
        await store.stale({
          workspaceId: 'w1',
          sourceId: 'cornell-lii',
          ttlMs: 60_000,
          now: new Date('2026-05-14T12:02:00.000Z'),
        }),
      ).toBe(true)
    })
  })

  it('isolates workspaces — w2 cannot read w1 freshness', async () => {
    await withTempRoot(async (root) => {
      const store = createFileSystemFreshnessStore({ root })
      await store.mark({
        workspaceId: 'w1',
        sourceId: 'cornell-lii',
        when: new Date('2026-05-14T12:00:00.000Z'),
      })
      expect(await store.last({ workspaceId: 'w2', sourceId: 'cornell-lii' })).toBeNull()
      expect(await store.stale({ workspaceId: 'w2', sourceId: 'cornell-lii', ttlMs: 60_000 })).toBe(
        true,
      )
    })
  })

  it('list returns only that workspace', async () => {
    await withTempRoot(async (root) => {
      const store = createFileSystemFreshnessStore({ root })
      const t = new Date('2026-05-14T12:00:00.000Z')
      await store.mark({ workspaceId: 'w1', sourceId: 'cornell-lii', when: t })
      await store.mark({ workspaceId: 'w1', sourceId: 'irs-publications', when: t })
      await store.mark({ workspaceId: 'w2', sourceId: 'cornell-lii', when: t })

      const w1 = await store.list('w1')
      expect(w1.map((r) => r.sourceId).sort()).toEqual(['cornell-lii', 'irs-publications'])

      const w2 = await store.list('w2')
      expect(w2.map((r) => r.sourceId)).toEqual(['cornell-lii'])
    })
  })

  it('serializes concurrent marks without losing writes', async () => {
    await withTempRoot(async (root) => {
      const stores = [
        createFileSystemFreshnessStore({ root }),
        createFileSystemFreshnessStore({ root }),
        createFileSystemFreshnessStore({ root }),
      ]
      const t = new Date('2026-05-14T12:00:00.000Z')
      await Promise.all([
        stores[0]!.mark({ workspaceId: 'w1', sourceId: 'a', when: t }),
        stores[1]!.mark({ workspaceId: 'w1', sourceId: 'b', when: t }),
        stores[2]!.mark({ workspaceId: 'w1', sourceId: 'c', when: t }),
      ])
      const list = await stores[0]!.list('w1')
      expect(list.map((r) => r.sourceId).sort()).toEqual(['a', 'b', 'c'])
    })
  })

  it('does not replace malformed freshness data', async () => {
    await withTempRoot(async (root) => {
      const store = createFileSystemFreshnessStore({ root })
      await store.mark({
        workspaceId: 'w1',
        sourceId: 'first',
        when: new Date('2026-05-14T12:00:00.000Z'),
      })
      const path = join(root, '.agent-knowledge', 'freshness.json')
      await writeFile(path, '{broken')

      await expect(
        store.mark({
          workspaceId: 'w1',
          sourceId: 'second',
          when: new Date('2026-05-14T12:01:00.000Z'),
        }),
      ).rejects.toThrow()
      await expect(readFile(path, 'utf8')).resolves.toBe('{broken')
    })
  })
})

describe('createD1FreshnessStoreStub', () => {
  it('delegates last/mark/stale to the adapter', async () => {
    const records: Record<string, FreshnessRecord> = {}
    const adapter: D1Adapter = {
      async get(workspaceId, sourceId) {
        return records[`${workspaceId}::${sourceId}`] ?? null
      },
      async upsert(record) {
        records[`${record.workspaceId}::${record.sourceId}`] = record
      },
      async listByWorkspace(workspaceId) {
        return Object.values(records).filter((r) => r.workspaceId === workspaceId)
      },
    }
    const store = createD1FreshnessStoreStub(adapter)
    expect(await store.last({ workspaceId: 'w1', sourceId: 'irs-publications' })).toBeNull()
    const when = new Date('2026-05-14T12:00:00.000Z')
    await store.mark({ workspaceId: 'w1', sourceId: 'irs-publications', when })
    expect(await store.last({ workspaceId: 'w1', sourceId: 'irs-publications' })).toEqual(when)
    expect(records['w1::irs-publications']?.lastRefreshedAt).toBe(when.toISOString())
  })
})
