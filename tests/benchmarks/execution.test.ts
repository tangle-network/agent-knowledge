import { inMemoryCampaignStorage } from '@tangle-network/agent-eval/campaign'
import { describe, expect, it } from 'vitest'
import {
  buildFirstPartyMemoryLifecycleBenchmarkCases,
  createInMemoryBenchmarkAdapter,
  createNoopMemoryBenchmarkAdapter,
  runMemoryAdapterBenchmark as runMemoryAdapterBenchmarkRaw,
} from '../../src/benchmarks/index'
import type { AgentMemoryAdapter, AgentMemoryScope } from '../../src/memory/types'
import { runMemoryAdapterBenchmark } from '../support/benchmarks'

describe('memory adapter benchmark execution', () => {
  it('ranks actual memory adapters on the first-party lifecycle benchmark', async () => {
    const storage = inMemoryCampaignStorage()
    const cases = buildFirstPartyMemoryLifecycleBenchmarkCases()
    const result = await runMemoryAdapterBenchmark({
      cases,
      runDir: '/runs/memory-adapter-ranking',
      storage,
      candidates: [
        {
          id: 'no-memory',
          ref: 'no-memory:v1',
          createAdapter: () => createNoopMemoryBenchmarkAdapter(),
        },
        {
          id: 'in-memory',
          ref: 'in-memory:v1',
          createAdapter: () => createInMemoryBenchmarkAdapter(),
          searchLimit: 1,
        },
      ],
    })

    expect(cases).toHaveLength(12)
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0]?.candidateId).toBe('in-memory')
    expect(result.rows[0]?.scoreMean).toBeGreaterThan(0.9)
    expect(result.rows[0]?.totalCells).toBe(12)
    expect(result.rows[0]?.cellsFailed).toBe(0)
    expect(result.rows[1]?.candidateId).toBe('no-memory')
    expect(result.rows[1]?.scoreMean).toBeLessThan(0.3)
    expect(storage.read(result.rankingJsonPath)).toContain('"candidateId": "in-memory"')
    expect(storage.read(result.rankingMarkdownPath)).toContain('| 1 | in-memory |')
    expect(storage.read(result.rows[0]!.reportJsonPath)).toContain('"memory_stale_safe"')
  })

  it('requires an explicit controller policy for custom benchmark storage', async () => {
    await expect(
      runMemoryAdapterBenchmarkRaw({
        cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
        runDir: '/runs/custom-benchmark-storage',
        storage: inMemoryCampaignStorage(),
        candidates: [
          {
            id: 'in-memory',
            ref: 'in-memory:v1',
            createAdapter: () => createInMemoryBenchmarkAdapter(),
          },
        ],
      }),
    ).rejects.toThrow("requires acquireRunLease or controllerMode='process-local'")
  })

  it('isolates and clears every concurrent adapter repetition', async () => {
    const adapter = createInMemoryBenchmarkAdapter()
    const clearedScopes: AgentMemoryScope[] = []
    const clear = adapter.clear!
    adapter.clear = async (scope) => {
      clearedScopes.push(scope ?? {})
      await clear(scope)
    }

    const result = await runMemoryAdapterBenchmark({
      cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
      runDir: '/runs/isolated-memory-repetitions',
      storage: inMemoryCampaignStorage(),
      reps: 3,
      maxConcurrency: 3,
      candidates: [
        {
          id: 'in-memory',
          ref: 'in-memory:v1',
          createAdapter: () => adapter,
        },
      ],
    })

    expect(result.rows[0]?.totalCells).toBe(3)
    expect(result.rows[0]?.cellsFailed).toBe(0)
    expect(clearedScopes).toHaveLength(3)
    expect(new Set(clearedScopes.map((scope) => scope.namespace)).size).toBe(3)
    expect(new Set(clearedScopes.map((scope) => scope.tags?.benchmarkAttemptId)).size).toBe(3)
  })

  it('settles timed-out provider work before clearing and closing the adapter', async () => {
    let closed = false
    let writes = 0
    let writesAfterClose = 0
    let clears = 0
    let clearsAfterClose = 0
    let contextReads = 0
    const adapter: AgentMemoryAdapter = {
      id: 'delayed-provider',
      branchIsolation: { mode: 'scoped' },
      async search() {
        return []
      },
      async getContext(query) {
        contextReads += 1
        return { query, text: '', hits: [], sourceRecords: [] }
      },
      async write(input) {
        await new Promise((resolve) => setTimeout(resolve, 25))
        writes += 1
        if (closed) writesAfterClose += 1
        return {
          accepted: true,
          id: input.id ?? String(writes),
          uri: `memory://delayed-provider/${writes}`,
          kind: input.kind,
        }
      },
      async clear() {
        await new Promise((resolve) => setTimeout(resolve, 1))
        clears += 1
        if (closed) clearsAfterClose += 1
      },
      async close() {
        closed = true
      },
    }

    const result = await runMemoryAdapterBenchmark({
      cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
      runDir: '/runs/timed-out-memory-provider',
      storage: inMemoryCampaignStorage(),
      dispatchTimeoutMs: 5,
      candidates: [
        {
          id: 'delayed-provider',
          ref: 'delayed-provider:v1',
          createAdapter: () => adapter,
        },
        {
          id: 'no-memory',
          ref: 'no-memory:v1',
          createAdapter: () => createNoopMemoryBenchmarkAdapter(),
        },
      ],
    })

    expect(result.rows[0]).toMatchObject({ candidateId: 'no-memory', cellsFailed: 0 })
    expect(result.rows[1]).toMatchObject({ candidateId: 'delayed-provider', cellsFailed: 1 })
    expect({ closed, writes, writesAfterClose, clears, clearsAfterClose, contextReads }).toEqual({
      closed: true,
      writes: 1,
      writesAfterClose: 0,
      clears: 1,
      clearsAfterClose: 0,
      contextReads: 0,
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect({ writes, writesAfterClose, clears, clearsAfterClose }).toEqual({
      writes: 1,
      writesAfterClose: 0,
      clears: 1,
      clearsAfterClose: 0,
    })
  })

  it('rejects every unsafe candidate id before creating any adapter', async () => {
    let creates = 0
    await expect(
      runMemoryAdapterBenchmark({
        cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
        runDir: '/runs/invalid-memory-candidate',
        storage: inMemoryCampaignStorage(),
        candidates: [
          {
            id: 'valid',
            ref: 'valid:v1',
            createAdapter() {
              creates += 1
              return createInMemoryBenchmarkAdapter()
            },
          },
          {
            id: '../invalid',
            ref: 'invalid:v1',
            createAdapter() {
              creates += 1
              return createInMemoryBenchmarkAdapter()
            },
          },
        ],
      }),
    ).rejects.toThrow('must be a safe directory segment')
    expect(creates).toBe(0)
  })
})
