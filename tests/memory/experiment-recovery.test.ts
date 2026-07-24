import { createRunCostLedger, inMemoryCampaignStorage } from '@tangle-network/agent-eval/campaign'
import { describe, expect, it } from 'vitest'
import type { AgentMemoryAdapter, AgentMemoryHit } from '../../src/memory/index'
import { createScopedTestAdapter, hitText, runAgentMemoryExperiment } from '../support/memory'

describe('agent memory experiment recovery', () => {
  it('recovers an unfinished provider branch before retrying the history', async () => {
    const storage = inMemoryCampaignStorage()
    const rows = new Map<string, AgentMemoryHit[]>()
    const operations: string[] = []
    const branchIds: Record<'first' | 'recovery' | 'retry', string | undefined> = {
      first: undefined,
      recovery: undefined,
      retry: undefined,
    }
    let firstExecution = true
    const sequence = {
      id: 'recover-history',
      family: 'first-party' as const,
      steps: [
        {
          id: 'remember',
          scope: { agentId: 'worker' },
          writes: [{ kind: 'fact' as const, text: 'sensitive provider fact' }],
          probes: [
            {
              id: 'recall',
              query: 'provider fact',
              referenceAnswer: 'sensitive provider fact',
            },
          ],
        },
      ],
    }
    const candidate = {
      id: 'recoverable',
      ref: 'recoverable:v1',
      externalRecoveryCostUsdPerAttempt: 0.1,
      externalCostAccounting: 'exact' as const,
      createAdapter({ branchId, purpose }: { branchId: string; purpose: 'execute' | 'recovery' }) {
        const executionLabel =
          purpose === 'recovery' ? 'recovery' : firstExecution ? 'first' : 'retry'
        branchIds[executionLabel] = branchId
        operations.push(`create:${executionLabel}`)
        let clearCalls = 0
        const adapter: AgentMemoryAdapter = {
          id: 'recoverable-provider',
          branchIsolation: { mode: 'scoped' },
          async search(_query, options) {
            return [...(rows.get(options.scope?.namespace ?? '') ?? [])]
          },
          async getContext(query, options) {
            const hits = await adapter.search(query, options)
            return { query, text: hits.map(hitText).join('\n'), hits, sourceRecords: [] }
          },
          async write(input) {
            operations.push(`write:${executionLabel}`)
            const namespace = input.scope?.namespace ?? ''
            const hit = {
              id: input.id ?? `${executionLabel}-fact`,
              uri: `memory://recoverable/${executionLabel}`,
              kind: input.kind,
              text: input.text,
            }
            rows.set(namespace, [...(rows.get(namespace) ?? []), hit])
            return { accepted: true, id: hit.id, uri: hit.uri, kind: hit.kind }
          },
          async clear(scope) {
            clearCalls += 1
            operations.push(`clear:${executionLabel}`)
            if (executionLabel === 'first' && clearCalls === 1) {
              throw new Error('provider cleanup unavailable')
            }
            rows.delete(scope?.namespace ?? '')
          },
        }
        if (purpose === 'execute') firstExecution = false
        return adapter
      },
    }
    const run = () =>
      runAgentMemoryExperiment({
        experimentId: 'restart-recovery',
        sequences: [sequence],
        candidates: [candidate],
        runDir: '/runs/restart-recovery',
        storage,
        costCeiling: 1,
      })

    await expect(run()).rejects.toThrow('memory experiment cleanup failed after dispatch')
    expect(rows.size).toBe(1)

    const result = await run()

    expect(result.rows[0]).toMatchObject({ candidateId: 'recoverable', cellsFailed: 0 })
    expect(result.rows[0]?.totalCostUsd).toBe(0.1)
    expect(result.campaign.aggregates.totalCostUsd).toBe(0.1)
    expect(branchIds.recovery).toBe(branchIds.first)
    expect(branchIds.retry).not.toBe(branchIds.first)
    expect(operations.indexOf('clear:recovery')).toBeLessThan(operations.indexOf('write:retry'))
    expect(rows.size).toBe(0)
    const attemptEvents = storage
      .read(result.attemptLogPath)!
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { status: string; recovery: boolean })
    expect(attemptEvents.map(({ status, recovery }) => ({ status, recovery }))).toEqual([
      { status: 'started', recovery: false },
      { status: 'cleaned', recovery: true },
      { status: 'started', recovery: false },
      { status: 'cleaned', recovery: false },
    ])
  })

  it('closes and disposes a recovery adapter that arrives after its factory timeout', async () => {
    const storage = inMemoryCampaignStorage()
    const runDir = '/runs/late-recovery-adapter'
    storage.write(
      `${runDir}/memory-attempts.jsonl`,
      `${JSON.stringify({
        status: 'started',
        branchId: 'unfinished-branch',
        candidateId: 'memory',
        candidateRef: 'memory:v1',
        sequenceId: 'history',
        rep: 0,
        seed: 42,
        cleanupBranches: true,
        externalCostUsdPerSequence: 0,
        externalRecoveryCostUsdPerAttempt: 0,
        recordedAt: '2026-01-01T00:00:00.000Z',
        recovery: false,
      })}\n`,
    )
    const sequence = {
      id: 'history',
      family: 'first-party' as const,
      steps: [
        {
          id: 'remember',
          scope: { agentId: 'worker' },
          writes: [{ kind: 'fact' as const, text: 'fact' }],
          probes: [{ id: 'recall', query: 'fact', referenceAnswer: 'fact' }],
        },
      ],
    }
    let resolveCreation!: (adapter: AgentMemoryAdapter) => void
    const creation = new Promise<AgentMemoryAdapter>((resolve) => {
      resolveCreation = resolve
    })
    let reportDisposed!: () => void
    const disposed = new Promise<void>((resolve) => {
      reportDisposed = resolve
    })
    let closeCalls = 0
    let disposeCalls = 0
    const lateAdapter = createScopedTestAdapter('memory-provider')
    lateAdapter.close = async () => {
      closeCalls += 1
    }

    await expect(
      runAgentMemoryExperiment({
        experimentId: 'late-recovery-adapter',
        sequences: [sequence],
        candidates: [
          {
            id: 'memory',
            ref: 'memory:v1',
            createAdapter: ({ purpose }) =>
              purpose === 'recovery' ? creation : createScopedTestAdapter('memory-provider'),
            async disposeAdapter(adapter) {
              expect(adapter).toBe(lateAdapter)
              disposeCalls += 1
              reportDisposed()
            },
          },
        ],
        runDir,
        storage,
        cleanupTimeoutMs: 10,
      }),
    ).rejects.toThrow("memory: abandoned memory branch 'unfinished-branch' recovery failed")

    resolveCreation(lateAdapter)
    await disposed
    expect({ closeCalls, disposeCalls }).toEqual({ closeCalls: 1, disposeCalls: 1 })
  })

  it('reconciles a crash after provider recovery but before its cost receipt', async () => {
    const storage = inMemoryCampaignStorage()
    const append = storage.append!.bind(storage)
    let failRecoveryReceipt = false
    storage.append = (path, value, expectedBytes) => {
      if (
        failRecoveryReceipt &&
        path.endsWith('/cost-ledger.jsonl') &&
        value.includes('"status":"settled"') &&
        value.includes('agent-knowledge:memory-recovery')
      ) {
        failRecoveryReceipt = false
        throw new Error('simulated process exit before recovery receipt')
      }
      return append(path, value, expectedBytes)
    }

    let firstExecution = true
    let recoveryClears = 0
    const candidate = {
      id: 'crash-recoverable',
      ref: 'crash-recoverable:v1',
      externalCostUsdPerSequence: 0.1,
      externalCostAccounting: 'exact' as const,
      externalRecoveryCostUsdPerAttempt: 0.1,
      createAdapter({ purpose }: { purpose: 'execute' | 'recovery' }) {
        const adapter = createScopedTestAdapter(`crash-recoverable:${purpose}`)
        const clear = adapter.clear!
        let clearCalls = 0
        const failThisExecution = purpose === 'execute' && firstExecution
        if (purpose === 'execute') firstExecution = false
        adapter.clear = async (scope) => {
          clearCalls += 1
          if (purpose === 'recovery') recoveryClears += 1
          if (failThisExecution && clearCalls === 1) {
            throw new Error('leave the first branch active')
          }
          await clear(scope)
        }
        return adapter
      },
    }
    const run = () =>
      runAgentMemoryExperiment({
        experimentId: 'recovery-receipt-crash',
        sequences: [
          {
            id: 'history',
            family: 'first-party',
            steps: [
              {
                id: 'remember',
                scope: { agentId: 'worker' },
                writes: [{ kind: 'fact', text: 'durable recovery fact' }],
                probes: [
                  {
                    id: 'recall',
                    query: 'durable',
                    referenceAnswer: 'durable recovery fact',
                  },
                ],
              },
            ],
          },
        ],
        candidates: [candidate],
        runDir: '/runs/recovery-receipt-crash',
        storage,
        costCeiling: 1,
      })

    await expect(run()).rejects.toThrow('memory experiment cleanup failed after dispatch')
    failRecoveryReceipt = true
    await expect(run()).rejects.toThrow('failed to persist')
    expect(
      storage.read('/runs/recovery-receipt-crash/memory-attempts.jsonl')?.trim().split('\n'),
    ).toHaveLength(2)

    const result = await run()
    const costLedger = createRunCostLedger({
      storage,
      runDir: '/runs/recovery-receipt-crash',
      costCeilingUsd: 1,
    })

    expect(result.rows[0]).toMatchObject({
      candidateId: 'crash-recoverable',
      cellsFailed: 0,
    })
    expect(result.rows[0]?.totalCostUsd).toBeCloseTo(0.3)
    expect(recoveryClears).toBe(1)
    expect(costLedger.summary()).toMatchObject({ unresolvedCalls: 0, accountingComplete: true })
    expect(costLedger.summary().totalCostUsd).toBeCloseTo(0.3)
  })

  it('recovers independent abandoned branches in parallel before retrying them', async () => {
    const storage = inMemoryCampaignStorage()
    let phase: 'leave-active' | 'recover' = 'leave-active'
    let activeRecoveries = 0
    let maxActiveRecoveries = 0
    let releaseRecoveries: (() => void) | undefined
    const recoveriesStarted = new Promise<void>((resolve) => {
      releaseRecoveries = resolve
    })
    const sequences = ['one', 'two'].map((id) => ({
      id,
      family: 'first-party' as const,
      steps: [
        {
          id: 'remember',
          scope: { agentId: 'worker' },
          writes: [{ kind: 'fact' as const, text: `${id} fact` }],
          probes: [{ id: 'recall', query: id, referenceAnswer: `${id} fact` }],
        },
      ],
    }))
    const run = () =>
      runAgentMemoryExperiment({
        experimentId: 'parallel-recovery',
        sequences,
        candidates: [
          {
            id: 'memory',
            ref: 'memory:v1',
            async createAdapter({ purpose }) {
              if (purpose === 'recovery') {
                activeRecoveries += 1
                maxActiveRecoveries = Math.max(maxActiveRecoveries, activeRecoveries)
                if (activeRecoveries === 2) releaseRecoveries?.()
                await recoveriesStarted
                activeRecoveries -= 1
                return null
              }
              if (phase === 'leave-active') return null
              return createScopedTestAdapter('parallel-recovery')
            },
          },
        ],
        runDir: '/runs/parallel-recovery',
        storage,
        maxConcurrency: 2,
      })

    await expect(run()).rejects.toThrow('memory experiment cleanup failed after dispatch')
    phase = 'recover'
    const result = await run()

    expect(maxActiveRecoveries).toBe(2)
    expect(result.rows[0]).toMatchObject({ candidateId: 'memory', cellsFailed: 0 })
    const recovered = storage
      .read(result.attemptLogPath)!
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { status: string; recovery: boolean })
      .filter((event) => event.status === 'cleaned' && event.recovery)
    expect(recovered).toHaveLength(2)
  })

  it('closes an attempt whose provider was never created before retrying it', async () => {
    const storage = inMemoryCampaignStorage()
    const purposes: Array<'execute' | 'recovery'> = []
    let executionCalls = 0
    const sequence = {
      id: 'provider-creation',
      family: 'first-party' as const,
      steps: [
        {
          id: 'remember',
          scope: { agentId: 'worker' },
          writes: [{ kind: 'fact' as const, text: 'created provider fact' }],
          probes: [
            {
              id: 'recall',
              query: 'provider fact',
              referenceAnswer: 'created provider fact',
            },
          ],
        },
      ],
    }
    const run = () =>
      runAgentMemoryExperiment({
        experimentId: 'provider-creation-recovery',
        sequences: [sequence],
        candidates: [
          {
            id: 'sometimes-created',
            ref: 'sometimes-created:v1',
            externalRecoveryCostUsdPerAttempt: 0.1,
            externalCostAccounting: 'exact',
            createAdapter({ purpose }) {
              purposes.push(purpose)
              if (purpose === 'recovery') return null
              executionCalls += 1
              if (executionCalls === 1) return null
              return createScopedTestAdapter('created-provider')
            },
          },
        ],
        runDir: '/runs/provider-creation-recovery',
        storage,
        costCeiling: 1,
      })

    await expect(run()).rejects.toThrow('memory experiment cleanup failed after dispatch')
    const result = await run()

    expect(result.rows[0]).toMatchObject({ candidateId: 'sometimes-created', cellsFailed: 0 })
    expect(result.rows[0]?.totalCostUsd).toBe(0)
    expect(purposes).toEqual(['execute', 'recovery', 'execute'])
    const attemptEvents = storage
      .read(result.attemptLogPath)!
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { status: string; recovery: boolean })
    expect(attemptEvents.map(({ status, recovery }) => ({ status, recovery }))).toEqual([
      { status: 'started', recovery: false },
      { status: 'cleaned', recovery: true },
      { status: 'started', recovery: false },
      { status: 'cleaned', recovery: false },
    ])
  })

  it('uses a retired candidate only to clean its unfinished branch', async () => {
    const storage = inMemoryCampaignStorage()
    const runDir = '/runs/retired-recovery-candidate'
    const sequence = {
      id: 'history',
      family: 'first-party' as const,
      steps: [
        {
          id: 'remember',
          scope: { agentId: 'worker' },
          writes: [{ kind: 'fact' as const, text: 'active fact' }],
          probes: [{ id: 'recall', query: 'active', referenceAnswer: 'active fact' }],
        },
      ],
    }
    storage.write(
      `${runDir}/memory-attempts.jsonl`,
      `${JSON.stringify({
        status: 'started',
        branchId: 'retired-branch',
        candidateId: 'retired',
        candidateRef: 'retired:v1',
        sequenceId: sequence.id,
        rep: 0,
        seed: 1,
        cleanupBranches: true,
        externalCostUsdPerSequence: 0,
        externalRecoveryCostUsdPerAttempt: 0.1,
        recordedAt: '2026-01-01T00:00:00.000Z',
        recovery: false,
      })}\n`,
    )
    const purposes: string[] = []
    let retiredClears = 0
    const result = await runAgentMemoryExperiment({
      experimentId: 'retired-recovery-candidate',
      sequences: [sequence],
      candidates: [
        {
          id: 'active',
          ref: 'active:v1',
          createAdapter({ purpose }) {
            purposes.push(`active:${purpose}`)
            return createScopedTestAdapter('active')
          },
        },
      ],
      recoveryCandidates: [
        {
          id: 'retired',
          ref: 'retired:v1',
          externalRecoveryCostUsdPerAttempt: 0.1,
          externalCostAccounting: 'exact',
          createAdapter({ purpose }) {
            purposes.push(`retired:${purpose}`)
            const adapter = createScopedTestAdapter('retired')
            adapter.clear = async () => {
              retiredClears += 1
            }
            return adapter
          },
        },
      ],
      runDir,
      storage,
      resumable: false,
      costCeiling: 1,
    })

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.candidateId).toBe('active')
    expect(result.rows[0]?.totalCostUsd).toBe(0)
    expect(result).toMatchObject({ totalCostUsd: 0.1, unrankedRecoveryCostUsd: 0.1 })
    expect(purposes).toEqual(['retired:recovery', 'active:execute'])
    expect(retiredClears).toBeGreaterThan(0)
  })

  it('refuses to hide an unfinished branch when candidate cost settings change', async () => {
    const storage = inMemoryCampaignStorage()
    const runDir = '/runs/changed-recovery-costs'
    const sequence = {
      id: 'history',
      family: 'first-party' as const,
      steps: [{ id: 'probe', probes: [{ id: 'recall', query: 'fact', referenceAnswer: 'fact' }] }],
    }
    storage.write(
      `${runDir}/memory-attempts.jsonl`,
      `${JSON.stringify({
        status: 'started',
        branchId: 'unfinished-branch',
        candidateId: 'memory',
        candidateRef: 'memory:v1',
        sequenceId: sequence.id,
        rep: 0,
        seed: 1,
        cleanupBranches: true,
        externalCostUsdPerSequence: 0,
        externalRecoveryCostUsdPerAttempt: 0,
        recordedAt: '2026-01-01T00:00:00.000Z',
        recovery: false,
      })}\n`,
    )
    let adapterCreates = 0

    await expect(
      runAgentMemoryExperiment({
        experimentId: 'changed-recovery-costs',
        sequences: [sequence],
        candidates: [
          {
            id: 'memory',
            ref: 'memory:v1',
            externalCostUsdPerSequence: 0.1,
            externalCostAccounting: 'exact',
            createAdapter() {
              adapterCreates += 1
              return createScopedTestAdapter('memory')
            },
          },
        ],
        runDir,
        storage,
        costCeiling: 1,
      }),
    ).rejects.toThrow('candidate cost settings changed')

    expect(adapterCreates).toBe(0)
    expect(storage.read(`${runDir}/memory-attempts.jsonl`)?.trim().split('\n')).toHaveLength(1)
  })

  it('refuses a recovery backlog larger than maxRecoveryAttempts', async () => {
    const storage = inMemoryCampaignStorage()
    const runDir = '/runs/recovery-backlog-limit'
    const sequence = {
      id: 'history',
      family: 'first-party' as const,
      steps: [
        {
          id: 'probe',
          scope: { agentId: 'worker' },
          probes: [{ id: 'recall', query: 'fact', referenceAnswer: 'fact' }],
        },
      ],
    }
    storage.write(
      `${runDir}/memory-attempts.jsonl`,
      `${[
        {
          status: 'started',
          branchId: 'branch-1',
          candidateId: 'memory',
          candidateRef: 'memory:v1',
          sequenceId: sequence.id,
          rep: 0,
          seed: 1,
          cleanupBranches: true,
          externalCostUsdPerSequence: 0,
          externalRecoveryCostUsdPerAttempt: 0,
          recordedAt: '2026-01-01T00:00:00.000Z',
          recovery: false,
        },
        {
          status: 'started',
          branchId: 'branch-2',
          candidateId: 'memory',
          candidateRef: 'memory:v1',
          sequenceId: sequence.id,
          rep: 0,
          seed: 2,
          cleanupBranches: true,
          externalCostUsdPerSequence: 0,
          externalRecoveryCostUsdPerAttempt: 0,
          recordedAt: '2026-01-01T00:00:00.000Z',
          recovery: false,
        },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n')}\n`,
    )
    let providerCreates = 0

    await expect(
      runAgentMemoryExperiment({
        experimentId: 'recovery-backlog-limit',
        sequences: [sequence],
        candidates: [
          {
            id: 'memory',
            ref: 'memory:v1',
            createAdapter() {
              providerCreates += 1
              return createScopedTestAdapter('memory')
            },
          },
        ],
        runDir,
        storage,
        maxRecoveryAttempts: 1,
      }),
    ).rejects.toThrow('2 unfinished attempts; maxRecoveryAttempts is 1')
    expect(providerCreates).toBe(0)
  })

  it('bounds repeated provider recovery across process restarts', async () => {
    const storage = inMemoryCampaignStorage()
    const runDir = '/runs/recovery-retry-limit'
    const sequence = {
      id: 'history',
      family: 'first-party' as const,
      steps: [{ id: 'probe', probes: [{ id: 'recall', query: 'fact', referenceAnswer: 'fact' }] }],
    }
    storage.write(
      `${runDir}/memory-attempts.jsonl`,
      `${JSON.stringify({
        status: 'started',
        branchId: 'unfinished-branch',
        candidateId: 'memory',
        candidateRef: 'memory:v1',
        sequenceId: sequence.id,
        rep: 0,
        seed: 1,
        cleanupBranches: true,
        externalCostUsdPerSequence: 0,
        externalRecoveryCostUsdPerAttempt: 0,
        recordedAt: '2026-01-01T00:00:00.000Z',
        recovery: false,
      })}\n`,
    )
    let recoveryCreates = 0
    const run = () =>
      runAgentMemoryExperiment({
        experimentId: 'recovery-retry-limit',
        sequences: [sequence],
        candidates: [
          {
            id: 'memory',
            ref: 'memory:v1',
            createAdapter({ purpose }) {
              if (purpose === 'recovery') recoveryCreates += 1
              throw new Error('provider recovery unavailable')
            },
          },
        ],
        runDir,
        storage,
        maxRecoveryRetriesPerAttempt: 2,
      })

    await expect(run()).rejects.toThrow(
      "abandoned memory branch 'unfinished-branch' recovery failed",
    )
    await expect(run()).rejects.toThrow(
      "abandoned memory branch 'unfinished-branch' recovery failed",
    )
    await expect(run()).rejects.toThrow('exhausted 2 recovery attempts')
    expect(recoveryCreates).toBe(2)
    expect(
      storage.read(`${runDir}/memory-recovery-attempts.jsonl`)?.trim().split('\n'),
    ).toHaveLength(2)
  })
})
