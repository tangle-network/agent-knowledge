import { createRunCostLedger, inMemoryCampaignStorage } from '@tangle-network/agent-eval/campaign'
import { describe, expect, it } from 'vitest'
import {
  buildFirstPartyMemoryLifecycleBenchmarkCases,
  createInMemoryBenchmarkAdapter,
} from '../../src/benchmarks/index'
import { runMemoryAdapterBenchmark } from '../support/benchmarks'

describe('memory adapter benchmark cost and resume', () => {
  it('counts billable adapter creation in the shared benchmark budget', async () => {
    const storage = inMemoryCampaignStorage()
    let creates = 0
    const result = await runMemoryAdapterBenchmark({
      cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
      runDir: '/runs/paid-adapter-creation',
      storage,
      costCeiling: 0.5,
      candidates: [
        {
          id: 'paid-creation',
          ref: 'paid-creation:v1',
          adapterId: 'paid-creation-provider',
          adapterCreationCostUsd: 0.2,
          createAdapter({ markExternalCall }) {
            markExternalCall()
            creates += 1
            return createInMemoryBenchmarkAdapter({ id: 'paid-creation-provider' })
          },
        },
      ],
    })

    const ledger = createRunCostLedger({
      storage,
      runDir: '/runs/paid-adapter-creation',
      costCeilingUsd: 0.5,
    })
    expect(creates).toBe(1)
    expect(result.rows[0]).toMatchObject({ candidateId: 'paid-creation', totalCostUsd: 0.2 })
    expect(result.totalCostUsd).toBe(0.2)
    expect(ledger.list()).toMatchObject([
      {
        actor: 'agent-knowledge:memory-adapter:paid-creation',
        costUsd: 0.2,
        tags: {
          candidateId: 'paid-creation',
          memoryAdapterCreation: 'execute',
          runDir: '/runs/paid-adapter-creation/paid-creation',
        },
      },
    ])
  })

  it('does not recreate or recharge a billable adapter when every cell resumes', async () => {
    const storage = inMemoryCampaignStorage()
    let creates = 0
    const run = () =>
      runMemoryAdapterBenchmark({
        cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
        runDir: '/runs/resumed-paid-adapter-creation',
        storage,
        costCeiling: 0.5,
        candidates: [
          {
            id: 'paid-resume',
            ref: 'paid-resume:v1',
            adapterId: 'paid-resume-provider',
            adapterCreationCostUsd: 0.2,
            createAdapter({ markExternalCall }) {
              markExternalCall()
              creates += 1
              return createInMemoryBenchmarkAdapter({ id: 'paid-resume-provider' })
            },
          },
        ],
      })

    const initial = await run()
    const resumed = await run()

    expect(creates).toBe(1)
    expect(initial).toMatchObject({ totalCostUsd: 0.2 })
    expect(resumed).toMatchObject({ totalCostUsd: 0.2 })
    expect(resumed.rows[0]).toMatchObject({ adapterId: 'paid-resume-provider' })
    expect(resumed.rows[0]?.report.cellsCached).toBe(1)
  })

  it('closes a mismatched lazy adapter before any benchmark case writes', async () => {
    const storage = inMemoryCampaignStorage()
    let closes = 0
    let writes = 0
    const adapter = createInMemoryBenchmarkAdapter({ id: 'actual-provider' })
    const write = adapter.write.bind(adapter)
    adapter.write = async (input) => {
      writes += 1
      return write(input)
    }
    adapter.close = async () => {
      closes += 1
    }

    await expect(
      runMemoryAdapterBenchmark({
        cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
        runDir: '/runs/mismatched-lazy-adapter',
        storage,
        candidates: [
          {
            id: 'candidate',
            ref: 'candidate:v1',
            adapterId: 'expected-provider',
            createAdapter: () => adapter,
          },
        ],
      }),
    ).rejects.toThrow("returned id 'actual-provider', expected 'expected-provider'")
    expect({ closes, writes }).toEqual({ closes: 1, writes: 0 })
    expect(
      storage.read('/runs/mismatched-lazy-adapter/memory-adapter-attempts.jsonl'),
    ).toBeUndefined()
  })

  it('aborts execute adapter creation at the configured timeout', async () => {
    const storage = inMemoryCampaignStorage()
    let aborted = false
    const startedAt = Date.now()

    await expect(
      runMemoryAdapterBenchmark({
        cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
        runDir: '/runs/timed-out-adapter-creation',
        storage,
        cleanupTimeoutMs: 10,
        candidates: [
          {
            id: 'hung-factory',
            ref: 'hung-factory:v1',
            createAdapter: ({ signal }) =>
              new Promise((_resolve, reject) => {
                signal.addEventListener(
                  'abort',
                  () => {
                    aborted = true
                    reject(signal.reason)
                  },
                  { once: true },
                )
              }),
          },
        ],
      }),
    ).rejects.toThrow('benchmark execute adapter creation did not finish within 10ms')
    expect(aborted).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(
      storage.read('/runs/timed-out-adapter-creation/memory-adapter-attempts.jsonl'),
    ).toBeUndefined()
  })

  it('does not charge a local adapter factory failure', async () => {
    const storage = inMemoryCampaignStorage()
    await expect(
      runMemoryAdapterBenchmark({
        cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
        runDir: '/runs/local-adapter-creation-failure',
        storage,
        costCeiling: 0.5,
        candidates: [
          {
            id: 'local-failure',
            ref: 'local-failure:v1',
            adapterCreationCostUsd: 0.2,
            createAdapter() {
              throw new Error('invalid local configuration')
            },
          },
        ],
      }),
    ).rejects.toThrow('invalid local configuration')

    const ledger = createRunCostLedger({
      storage,
      runDir: '/runs/local-adapter-creation-failure',
      costCeilingUsd: 0.5,
    })
    expect(ledger.summary()).toMatchObject({ totalCostUsd: 0, unresolvedCalls: 0 })
  })

  it('enforces one cost ceiling across every compared adapter', async () => {
    const result = await runMemoryAdapterBenchmark({
      cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
      runDir: '/runs/shared-adapter-cost-ceiling',
      storage: inMemoryCampaignStorage(),
      costCeiling: 0.75,
      candidates: ['first', 'second'].map((id) => ({
        id,
        ref: `${id}:v1`,
        costUsdPerCase: 0.5,
        createAdapter: () => createInMemoryBenchmarkAdapter({ id }),
      })),
    })

    expect(result.totalCostUsd).toBe(0.5)
    expect(result.rows).toHaveLength(2)
    expect(result.rows.find((row) => row.candidateId === 'first')).toMatchObject({
      cellsFailed: 0,
      totalCostUsd: 0.5,
    })
    expect(result.rows.find((row) => row.candidateId === 'second')).toMatchObject({
      cellsFailed: 1,
      totalCostUsd: 0,
    })
  })

  it('runs sequential paid adapter cases after exact external-cost receipts', async () => {
    const result = await runMemoryAdapterBenchmark({
      cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 2),
      runDir: '/runs/sequential-adapter-cost-accounting',
      storage: inMemoryCampaignStorage(),
      costCeiling: 0.2,
      maxConcurrency: 1,
      candidates: [
        {
          id: 'sequential-paid',
          ref: 'sequential-paid:v1',
          costUsdPerCase: 0.1,
          createAdapter: () => createInMemoryBenchmarkAdapter({ id: 'sequential-paid' }),
        },
      ],
    })

    expect(result.rows[0]).toMatchObject({ cellsFailed: 0, totalCostUsd: 0.2 })
    expect(result.totalCostUsd).toBe(0.2)
  })

  it('refuses paid adapter calls when no dollar limit is configured', async () => {
    let providerCalls = 0
    const adapter = createInMemoryBenchmarkAdapter({ id: 'paid-by-default' })
    const write = adapter.write.bind(adapter)
    adapter.write = async (input) => {
      providerCalls += 1
      return write(input)
    }

    const result = await runMemoryAdapterBenchmark({
      cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
      runDir: '/runs/default-zero-cost-ceiling',
      storage: inMemoryCampaignStorage(),
      candidates: [
        {
          id: 'paid-by-default',
          ref: 'paid-by-default:v1',
          costUsdPerCase: 0.01,
          createAdapter: () => adapter,
        },
      ],
    })

    expect(result.rows[0]).toMatchObject({ cellsFailed: 1, totalCostUsd: 0 })
    expect(providerCalls).toBe(0)
  })

  it('does not reuse resumable rows when adapter benchmark options change', async () => {
    const storage = inMemoryCampaignStorage()
    const run = (searchLimit: number) =>
      runMemoryAdapterBenchmark({
        cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
        runDir: '/runs/memory-adapter-cache-identity',
        storage,
        candidates: [
          {
            id: 'in-memory',
            ref: 'in-memory:v1',
            createAdapter: () => createInMemoryBenchmarkAdapter(),
            searchLimit,
          },
        ],
      })

    const initial = await run(1)
    const changed = await run(2)
    const repeated = await run(2)

    expect(initial.rows[0]?.report.cellsCached).toBe(0)
    expect(changed.rows[0]?.report.cellsCached).toBe(0)
    expect(repeated.rows[0]?.report.cellsCached).toBe(1)
  })
})
