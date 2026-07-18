import { createRunCostLedger, inMemoryCampaignStorage } from '@tangle-network/agent-eval/campaign'
import { describe, expect, it } from 'vitest'
import {
  buildFirstPartyMemoryLifecycleBenchmarkCases,
  createInMemoryBenchmarkAdapter,
} from '../../src/benchmarks/index'
import type { AgentMemoryAdapter, AgentMemoryHit } from '../../src/memory/types'
import { runMemoryAdapterBenchmark } from '../support/benchmarks'

describe('memory adapter benchmark recovery', () => {
  it('recovers an unfinished provider scope before retrying a direct benchmark cell', async () => {
    const storage = inMemoryCampaignStorage()
    const providerRows = new Map<string, AgentMemoryHit[]>()
    const operations: string[] = []
    const purposes: string[] = []
    let firstExecution = true
    const candidate = {
      id: 'recoverable',
      ref: 'recoverable:v1',
      adapterId: 'recoverable-provider',
      recoveryCostUsdPerAttempt: 0.1,
      createAdapter({ purpose }: { purpose: 'execute' | 'recovery' }) {
        purposes.push(purpose)
        const label = purpose === 'recovery' ? 'recovery' : firstExecution ? 'first' : 'retry'
        if (purpose === 'execute') firstExecution = false
        const adapter: AgentMemoryAdapter = {
          id: 'recoverable-provider',
          branchIsolation: { mode: 'scoped' },
          async search(_query, options) {
            return [...(providerRows.get(options?.scope?.namespace ?? '') ?? [])]
          },
          async getContext(query, options) {
            const hits = await adapter.search(query, options)
            return { query, text: hits.map((hit) => hit.text).join('\n'), hits, sourceRecords: [] }
          },
          async write(input) {
            operations.push(`write:${label}`)
            const namespace = input.scope?.namespace ?? ''
            const hit: AgentMemoryHit = {
              id: input.id ?? `${label}:memory`,
              uri: `memory://recoverable/${label}`,
              kind: input.kind,
              text: input.text,
              metadata: input.metadata,
            }
            providerRows.set(namespace, [...(providerRows.get(namespace) ?? []), hit])
            return { accepted: true, id: hit.id, uri: hit.uri, kind: hit.kind }
          },
          async clear(scope) {
            operations.push(`clear:${label}`)
            if (label === 'first') throw new Error('provider cleanup unavailable')
            providerRows.delete(scope?.namespace ?? '')
          },
          async close() {},
        }
        return adapter
      },
    }
    const run = () =>
      runMemoryAdapterBenchmark({
        cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
        runDir: '/runs/direct-benchmark-recovery',
        storage,
        candidates: [candidate],
        costCeiling: 1,
      })

    await expect(run()).rejects.toThrow('memory benchmark attempt cleanup failed')
    expect(providerRows.size).toBe(1)

    const result = await run()
    expect(result.rows[0]).toMatchObject({ candidateId: 'recoverable', cellsFailed: 0 })
    expect(result.rows[0]?.totalCostUsd).toBe(0.1)
    expect(result.totalCostUsd).toBe(0.1)
    expect(purposes).toEqual(['execute', 'recovery', 'execute'])
    expect(operations.indexOf('clear:recovery')).toBeLessThan(operations.indexOf('write:retry'))
    expect(providerRows.size).toBe(0)
    const events = storage
      .read(result.attemptLogPath)!
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { status: string; recovery: boolean })
    expect(events.map(({ status, recovery }) => ({ status, recovery }))).toEqual([
      { status: 'started', recovery: false },
      { status: 'cleaned', recovery: true },
      { status: 'started', recovery: false },
      { status: 'cleaned', recovery: false },
    ])
  })

  it('includes paid cleanup for a retired candidate in the benchmark total', async () => {
    const storage = inMemoryCampaignStorage()
    const runDir = '/runs/retired-candidate-recovery-cost'
    storage.write(
      `${runDir}/memory-adapter-attempts.jsonl`,
      `${JSON.stringify({
        schema: 3,
        status: 'started',
        attemptId: 'retired-attempt',
        candidateId: 'retired',
        candidateRef: 'retired:v1',
        adapterId: 'retired-provider',
        caseId: 'old-case',
        cellId: 'old-cell',
        scope: { namespace: 'retired-scope' },
        adapterCreationCostUsd: 0.05,
        costUsdPerCase: 0,
        recoveryCostUsdPerAttempt: 0.1,
        recordedAt: '2026-01-01T00:00:00.000Z',
        recovery: false,
      })}\n`,
    )
    let retiredClears = 0
    const result = await runMemoryAdapterBenchmark({
      cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
      runDir,
      storage,
      costCeiling: 1,
      candidates: [
        {
          id: 'active',
          ref: 'active:v1',
          adapterId: 'active-provider',
          createAdapter: () => createInMemoryBenchmarkAdapter({ id: 'active-provider' }),
        },
      ],
      recoveryCandidates: [
        {
          id: 'retired',
          ref: 'retired:v1',
          adapterId: 'retired-provider',
          adapterCreationCostUsd: 0.05,
          recoveryCostUsdPerAttempt: 0.1,
          createAdapter({ markExternalCall }) {
            markExternalCall()
            const adapter = createInMemoryBenchmarkAdapter({ id: 'retired-provider' })
            adapter.clear = async () => {
              retiredClears += 1
            }
            return adapter
          },
        },
      ],
    })

    expect(retiredClears).toBe(1)
    expect(result.rows[0]).toMatchObject({ candidateId: 'active', totalCostUsd: 0 })
    expect(result).toMatchObject({ totalCostUsd: 0.15, unrankedRecoveryCostUsd: 0.15 })
    expect(storage.read(result.rankingJsonPath)).toContain('"unrankedRecoveryCostUsd": 0.15')
  })

  it('refuses benchmark recovery when candidate cost settings changed', async () => {
    const storage = inMemoryCampaignStorage()
    const runDir = '/runs/benchmark-changed-recovery-costs'
    storage.write(
      `${runDir}/memory-adapter-attempts.jsonl`,
      `${JSON.stringify({
        schema: 3,
        status: 'started',
        attemptId: 'unfinished-attempt',
        candidateId: 'memory',
        candidateRef: 'memory:v1',
        adapterId: 'memory-provider',
        caseId: 'old-case',
        cellId: 'old-cell',
        scope: { namespace: 'unfinished-scope' },
        adapterCreationCostUsd: 0,
        costUsdPerCase: 0,
        recoveryCostUsdPerAttempt: 0,
        recordedAt: '2026-01-01T00:00:00.000Z',
        recovery: false,
      })}\n`,
    )
    let adapterCreates = 0

    await expect(
      runMemoryAdapterBenchmark({
        cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
        runDir,
        storage,
        costCeiling: 1,
        candidates: [
          {
            id: 'memory',
            ref: 'memory:v1',
            adapterId: 'memory-provider',
            costUsdPerCase: 0.1,
            createAdapter() {
              adapterCreates += 1
              return createInMemoryBenchmarkAdapter({ id: 'memory-provider' })
            },
          },
        ],
      }),
    ).rejects.toThrow('candidate cost settings changed')

    expect(adapterCreates).toBe(0)
    expect(
      storage.read(`${runDir}/memory-adapter-attempts.jsonl`)?.trim().split('\n'),
    ).toHaveLength(1)
  })

  it('bounds repeated direct benchmark recovery across process restarts', async () => {
    const storage = inMemoryCampaignStorage()
    const runDir = '/runs/benchmark-recovery-retry-limit'
    storage.write(
      `${runDir}/memory-adapter-attempts.jsonl`,
      `${JSON.stringify({
        schema: 3,
        status: 'started',
        attemptId: 'unfinished-attempt',
        candidateId: 'memory',
        candidateRef: 'memory:v1',
        adapterId: 'memory-provider',
        caseId: 'old-case',
        cellId: 'old-cell',
        scope: { namespace: 'unfinished-scope' },
        adapterCreationCostUsd: 0,
        costUsdPerCase: 0,
        recoveryCostUsdPerAttempt: 0,
        recordedAt: '2026-01-01T00:00:00.000Z',
        recovery: false,
      })}\n`,
    )
    let recoveryCreates = 0
    const run = () =>
      runMemoryAdapterBenchmark({
        cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
        runDir,
        storage,
        maxRecoveryRetriesPerAttempt: 2,
        candidates: [
          {
            id: 'memory',
            ref: 'memory:v1',
            adapterId: 'memory-provider',
            createAdapter({ purpose }) {
              if (purpose === 'recovery') recoveryCreates += 1
              throw new Error('provider recovery unavailable')
            },
          },
        ],
      })

    await expect(run()).rejects.toThrow('provider recovery unavailable')
    await expect(run()).rejects.toThrow('provider recovery unavailable')
    await expect(run()).rejects.toThrow('exhausted 2 recovery attempts')
    expect(recoveryCreates).toBe(2)
    expect(
      storage.read(`${runDir}/memory-adapter-recovery-attempts.jsonl`)?.trim().split('\n'),
    ).toHaveLength(2)
  })

  it('closes a recovery adapter that arrives after its factory timeout', async () => {
    const storage = inMemoryCampaignStorage()
    const runDir = '/runs/late-benchmark-recovery-adapter'
    storage.write(
      `${runDir}/memory-adapter-attempts.jsonl`,
      `${JSON.stringify({
        schema: 3,
        status: 'started',
        attemptId: 'unfinished-attempt',
        candidateId: 'memory',
        candidateRef: 'memory:v1',
        adapterId: 'memory-provider',
        caseId: 'old-case',
        cellId: 'old-cell',
        scope: { namespace: 'unfinished-scope' },
        adapterCreationCostUsd: 0,
        costUsdPerCase: 0,
        recoveryCostUsdPerAttempt: 0,
        recordedAt: '2026-01-01T00:00:00.000Z',
        recovery: false,
      })}\n`,
    )
    let resolveCreation!: (adapter: AgentMemoryAdapter) => void
    const creation = new Promise<AgentMemoryAdapter>((resolve) => {
      resolveCreation = resolve
    })
    let reportClosed!: () => void
    const closed = new Promise<void>((resolve) => {
      reportClosed = resolve
    })
    let closeCalls = 0
    const lateAdapter = createInMemoryBenchmarkAdapter({ id: 'memory-provider' })
    lateAdapter.close = async () => {
      closeCalls += 1
      reportClosed()
    }

    await expect(
      runMemoryAdapterBenchmark({
        cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
        runDir,
        storage,
        cleanupTimeoutMs: 10,
        candidates: [
          {
            id: 'memory',
            ref: 'memory:v1',
            adapterId: 'memory-provider',
            createAdapter: ({ purpose }) =>
              purpose === 'recovery' ? creation : createInMemoryBenchmarkAdapter(),
          },
        ],
      }),
    ).rejects.toThrow('benchmark recovery adapter creation did not finish within 10ms')

    resolveCreation(lateAdapter)
    await closed
    expect(closeCalls).toBe(1)
  })

  it('reconciles a crash after direct recovery but before its cost receipt', async () => {
    const storage = inMemoryCampaignStorage()
    const append = storage.append!.bind(storage)
    let failRecoveryReceipt = false
    storage.append = (path, value, expectedBytes) => {
      if (
        failRecoveryReceipt &&
        path.endsWith('/cost-ledger.jsonl') &&
        value.includes('"status":"settled"') &&
        value.includes('memory-adapter-recovery')
      ) {
        failRecoveryReceipt = false
        throw new Error('simulated process exit before benchmark recovery receipt')
      }
      return append(path, value, expectedBytes)
    }

    let firstExecution = true
    let recoveryClears = 0
    const candidate = {
      id: 'receipt-crash',
      ref: 'receipt-crash:v1',
      adapterId: 'receipt-crash-provider',
      costUsdPerCase: 0.1,
      recoveryCostUsdPerAttempt: 0.1,
      createAdapter({ purpose }: { purpose: 'execute' | 'recovery' }) {
        const adapter = createInMemoryBenchmarkAdapter({ id: 'receipt-crash-provider' })
        const clear = adapter.clear!
        const failThisExecution = purpose === 'execute' && firstExecution
        if (purpose === 'execute') firstExecution = false
        adapter.clear = async (scope) => {
          if (purpose === 'recovery') recoveryClears += 1
          if (failThisExecution) throw new Error('leave direct benchmark state active')
          await clear(scope)
        }
        return adapter
      },
    }
    const run = () =>
      runMemoryAdapterBenchmark({
        cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
        runDir: '/runs/direct-recovery-receipt-crash',
        storage,
        costCeiling: 1,
        candidates: [candidate],
      })

    await expect(run()).rejects.toThrow('memory benchmark attempt cleanup failed')
    failRecoveryReceipt = true
    await expect(run()).rejects.toThrow('failed to persist')
    expect(
      storage
        .read('/runs/direct-recovery-receipt-crash/memory-adapter-attempts.jsonl')
        ?.trim()
        .split('\n'),
    ).toHaveLength(2)

    const result = await run()
    const costLedger = createRunCostLedger({
      storage,
      runDir: '/runs/direct-recovery-receipt-crash',
      costCeilingUsd: 1,
    })

    expect(result.rows[0]).toMatchObject({
      candidateId: 'receipt-crash',
      cellsFailed: 0,
    })
    expect(result.rows[0]?.totalCostUsd).toBeCloseTo(0.3)
    expect(result.totalCostUsd).toBeCloseTo(0.3)
    expect(recoveryClears).toBe(1)
    expect(costLedger.summary()).toMatchObject({ unresolvedCalls: 0, accountingComplete: true })
    expect(costLedger.summary().totalCostUsd).toBeCloseTo(0.3)
  })

  it('bounds direct benchmark cleanup and preserves its recovery record', async () => {
    const storage = inMemoryCampaignStorage()
    const adapter = createInMemoryBenchmarkAdapter({ id: 'hung-cleanup' })
    let closeCalls = 0
    adapter.clear = () => new Promise<void>(() => {})
    adapter.close = async () => {
      closeCalls += 1
    }
    const startedAt = Date.now()

    await expect(
      runMemoryAdapterBenchmark({
        cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
        runDir: '/runs/direct-benchmark-cleanup-timeout',
        storage,
        cleanupTimeoutMs: 10,
        candidates: [
          {
            id: 'hung-cleanup',
            ref: 'hung-cleanup:v1',
            createAdapter: () => adapter,
          },
        ],
      }),
    ).rejects.toThrow('memory adapter benchmark cleanup failed')

    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(
      storage
        .read('/runs/direct-benchmark-cleanup-timeout/memory-adapter-attempts.jsonl')
        ?.trim()
        .split('\n'),
    ).toHaveLength(1)
    expect(closeCalls).toBe(0)
  })
})
