import { createRunCostLedger, inMemoryCampaignStorage } from '@tangle-network/agent-eval/campaign'
import { describe, expect, it } from 'vitest'
import {
  type AgentMemoryAdapter,
  agentMemorySequenceJudge,
  buildAgentMemorySequenceScenarios,
  buildAgentMemorySequencesFromBenchmarkCases,
  runAgentMemoryExperiment as runAgentMemoryExperimentRaw,
} from '../../src/memory/index'
import { createScopedTestAdapter, runAgentMemoryExperiment } from '../support/memory'

describe('agent memory experiment cost and resume', () => {
  it('versions memory scoring for resumable cache safety', () => {
    expect(agentMemorySequenceJudge().judgeVersion).toBe('agent-knowledge:memory-sequence:v2')
  })

  it('requires an explicit controller policy for custom storage', async () => {
    await expect(
      runAgentMemoryExperimentRaw({
        experimentId: 'custom-storage-controller',
        sequences: [
          {
            id: 'history',
            family: 'first-party',
            steps: [{ id: 'probe', probes: [{ id: 'probe', query: 'x', referenceAnswer: 'x' }] }],
          },
        ],
        candidates: [
          {
            id: 'memory',
            ref: 'memory:v1',
            createAdapter: () => createScopedTestAdapter('memory'),
          },
        ],
        runDir: '/runs/custom-storage-controller',
        storage: inMemoryCampaignStorage(),
      }),
    ).rejects.toThrow("requires acquireRunLease or controllerMode='process-local'")
  })

  it('bounds provider cleanup and leaves the attempt available for recovery', async () => {
    const storage = inMemoryCampaignStorage()
    let clearCalls = 0
    const adapter = createScopedTestAdapter('bounded-cleanup')
    const clear = adapter.clear!
    adapter.clear = async (scope) => {
      clearCalls += 1
      if (clearCalls === 1) return new Promise<void>(() => {})
      await clear(scope)
    }
    const startedAt = Date.now()

    await expect(
      runAgentMemoryExperiment({
        experimentId: 'bounded-cleanup',
        sequences: [
          {
            id: 'history',
            family: 'first-party',
            steps: [
              {
                id: 'remember',
                scope: { agentId: 'worker' },
                writes: [{ kind: 'fact', text: 'bounded fact' }],
                probes: [{ id: 'probe', query: 'bounded', referenceAnswer: 'bounded fact' }],
              },
            ],
          },
        ],
        candidates: [{ id: 'memory', ref: 'memory:v1', createAdapter: () => adapter }],
        runDir: '/runs/bounded-cleanup',
        storage,
        cleanupTimeoutMs: 10,
      }),
    ).rejects.toThrow('memory experiment cleanup failed after dispatch')

    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(
      storage.read('/runs/bounded-cleanup/memory-attempts.jsonl')?.trim().split('\n'),
    ).toHaveLength(1)
  })

  it('does not charge provider cost when side-effect-free adapter construction fails', async () => {
    const storage = inMemoryCampaignStorage()
    const costLedger = createRunCostLedger({
      storage,
      runDir: '/runs/create-adapter-cost',
      costCeilingUsd: 1,
    })

    await expect(
      runAgentMemoryExperiment({
        experimentId: 'create-adapter-cost',
        sequences: [
          {
            id: 'history',
            family: 'first-party',
            steps: [{ id: 'probe', probes: [{ id: 'probe', query: 'x', referenceAnswer: 'x' }] }],
          },
        ],
        candidates: [
          {
            id: 'paid-memory',
            ref: 'paid-memory:v1',
            externalCostUsdPerSequence: 0.25,
            externalCostAccounting: 'exact',
            createAdapter() {
              throw new Error('provider setup rejected')
            },
          },
        ],
        runDir: '/runs/create-adapter-cost',
        storage,
        costLedger,
      }),
    ).rejects.toThrow('memory experiment cleanup failed after dispatch')

    expect(costLedger.summary().totalCostUsd).toBe(0)
  })

  it('charges a factory failure after dedicated provider provisioning starts', async () => {
    const storage = inMemoryCampaignStorage()
    const costLedger = createRunCostLedger({
      storage,
      runDir: '/runs/create-adapter-provider-cost',
      costCeilingUsd: 1,
    })

    await expect(
      runAgentMemoryExperiment({
        experimentId: 'create-adapter-provider-cost',
        sequences: [
          {
            id: 'history',
            family: 'first-party',
            steps: [{ id: 'probe', probes: [{ id: 'probe', query: 'x', referenceAnswer: 'x' }] }],
          },
        ],
        candidates: [
          {
            id: 'paid-memory',
            ref: 'paid-memory:v1',
            externalCostUsdPerSequence: 0.25,
            externalCostAccounting: 'exact',
            createAdapter({ markExternalCall, recordExternalCost }) {
              markExternalCall()
              recordExternalCost(0.25)
              throw new Error('provider provisioning failed')
            },
          },
        ],
        runDir: '/runs/create-adapter-provider-cost',
        storage,
        costLedger,
      }),
    ).rejects.toThrow('memory experiment cleanup failed after dispatch')

    expect(costLedger.summary()).toMatchObject({ totalCalls: 1, totalCostUsd: 0.25 })
  })

  it('marks positive external spend incomplete when the provider emits no receipt', async () => {
    const storage = inMemoryCampaignStorage()
    const costLedger = createRunCostLedger({
      storage,
      runDir: '/runs/missing-provider-receipt',
      costCeilingUsd: 1,
    })

    const result = await runAgentMemoryExperiment({
      experimentId: 'missing-provider-receipt',
      sequences: [
        {
          id: 'history',
          family: 'first-party',
          steps: [
            {
              id: 'remember',
              scope: { agentId: 'worker' },
              writes: [{ kind: 'fact', text: 'durable fact' }],
              probes: [
                {
                  id: 'recall',
                  query: 'durable',
                  scope: { agentId: 'worker' },
                  referenceAnswer: 'durable fact',
                },
              ],
            },
          ],
        },
      ],
      candidates: [
        {
          id: 'paid-memory',
          ref: 'paid-memory:v1',
          externalCostUsdPerSequence: 0.25,
          externalCostAccounting: 'exact',
          createAdapter({ maximumCostUsd, markExternalCall }) {
            expect(maximumCostUsd).toBe(0.25)
            markExternalCall()
            return createScopedTestAdapter('missing-provider-receipt')
          },
        },
      ],
      runDir: '/runs/missing-provider-receipt',
      storage,
      costLedger,
    })

    expect(result.campaign.aggregates.cost).toMatchObject({
      accountingComplete: false,
      totalCostUsd: 0,
    })
    expect(costLedger.summary()).toMatchObject({
      accountingComplete: false,
      totalCostUsd: 0,
    })
  })

  it('records provider cleanup before a paid-call receipt can be interrupted', async () => {
    const storage = inMemoryCampaignStorage()
    const append = storage.append!.bind(storage)
    let interruptReceipt = true
    storage.append = (path, value, expectedBytes) => {
      if (
        interruptReceipt &&
        path.endsWith('/cost-ledger.jsonl') &&
        value.includes('"status":"settled"') &&
        value.includes('agent-knowledge:memory-experiment')
      ) {
        interruptReceipt = false
        throw new Error('simulated process exit before execute receipt')
      }
      return append(path, value, expectedBytes)
    }
    const purposes: string[] = []
    const sequence = {
      id: 'history',
      family: 'first-party' as const,
      steps: [
        {
          id: 'remember',
          scope: { agentId: 'worker' },
          writes: [{ kind: 'fact' as const, text: 'durable fact' }],
          probes: [{ id: 'recall', query: 'durable', referenceAnswer: 'durable fact' }],
        },
      ],
    }
    const run = () =>
      runAgentMemoryExperiment({
        experimentId: 'execute-receipt-crash',
        sequences: [sequence],
        candidates: [
          {
            id: 'memory',
            ref: 'memory:v1',
            externalCostUsdPerSequence: 0.1,
            externalCostAccounting: 'exact',
            createAdapter({ purpose, recordExternalCost }) {
              purposes.push(purpose)
              recordExternalCost(0.1)
              return createScopedTestAdapter(`memory:${purpose}`)
            },
          },
        ],
        runDir: '/runs/execute-receipt-crash',
        storage,
        costCeiling: 1,
      })

    await expect(run()).rejects.toThrow(
      /paid calls for failed cell .* did not settle .* no complete failure receipt was produced/,
    )
    expect(
      storage.read('/runs/execute-receipt-crash/memory-attempts.jsonl')?.trim().split('\n'),
    ).toHaveLength(2)

    const result = await run()
    expect(purposes).toEqual(['execute', 'execute'])
    expect(result.rows[0]).toMatchObject({ cellsFailed: 0, totalCostUsd: 0.2 })
  })

  it('accounts for parallel candidates against one shared dollar limit', async () => {
    let releaseFirstCalls: (() => void) | undefined
    const firstCallsReady = new Promise<void>((resolve) => {
      releaseFirstCalls = resolve
    })
    let activeCalls = 0
    let firstCalls = 0
    let maxActiveCalls = 0
    const createAdapter = (id: string): AgentMemoryAdapter => {
      const adapter = createScopedTestAdapter(id)
      const clear = adapter.clear!
      let entered = false
      adapter.clear = async (scope) => {
        if (!entered) {
          entered = true
          firstCalls += 1
          activeCalls += 1
          maxActiveCalls = Math.max(maxActiveCalls, activeCalls)
          if (firstCalls === 2) releaseFirstCalls?.()
          await firstCallsReady
          activeCalls -= 1
        }
        await clear(scope)
      }
      return adapter
    }

    const result = await runAgentMemoryExperiment({
      experimentId: 'parallel-shared-cost',
      sequences: [
        {
          id: 'history',
          family: 'first-party',
          steps: [
            {
              id: 'remember',
              scope: { agentId: 'worker' },
              writes: [{ kind: 'fact', text: 'parallel fact' }],
              probes: [
                {
                  id: 'recall',
                  query: 'parallel',
                  scope: { agentId: 'worker' },
                  referenceAnswer: 'parallel fact',
                },
              ],
            },
          ],
        },
      ],
      candidates: ['first', 'second'].map((id) => ({
        id,
        ref: `${id}:v1`,
        externalCostUsdPerSequence: 0.1,
        externalCostAccounting: 'exact' as const,
        createAdapter: ({ recordExternalCost }) => {
          recordExternalCost(0.1)
          return createAdapter(id)
        },
      })),
      runDir: '/runs/parallel-shared-cost',
      storage: inMemoryCampaignStorage(),
      costCeiling: 0.2,
      maxConcurrency: 2,
    })

    expect(maxActiveCalls).toBe(2)
    expect(result.rows.map((row) => row.totalCostUsd).sort()).toEqual([0.1, 0.1])
    expect(result.campaign.aggregates.cost.totalCostUsd).toBe(0.2)
  })

  it('runs sequential paid histories after exact external-cost receipts', async () => {
    const storage = inMemoryCampaignStorage()
    const costLedger = createRunCostLedger({
      storage,
      runDir: '/runs/sequential-shared-cost',
      costCeilingUsd: 0.2,
    })
    const sequences = ['first', 'second'].map((id) => ({
      id,
      family: 'first-party',
      steps: [
        {
          id: 'remember',
          scope: { agentId: 'worker' },
          writes: [{ kind: 'fact' as const, text: `${id} fact` }],
          probes: [
            {
              id: 'recall',
              query: id,
              scope: { agentId: 'worker' },
              referenceAnswer: `${id} fact`,
            },
          ],
        },
      ],
    }))

    const result = await runAgentMemoryExperiment({
      experimentId: 'sequential-shared-cost',
      sequences,
      candidates: [
        {
          id: 'memory',
          ref: 'memory:v1',
          externalCostUsdPerSequence: 0.1,
          externalCostAccounting: 'exact',
          createAdapter: ({ branchId, recordExternalCost }) => {
            recordExternalCost(0.1)
            return createScopedTestAdapter(branchId)
          },
        },
      ],
      runDir: '/runs/sequential-shared-cost',
      storage,
      costLedger,
      maxConcurrency: 1,
    })

    expect(result.rows[0]).toMatchObject({ cellsFailed: 0, totalCostUsd: 0.2 })
    expect(costLedger.summary()).toMatchObject({
      totalCalls: 2,
      totalCostUsd: 0.2,
      accountingComplete: true,
    })
  })

  it('reports the reserved cost of an interrupted prior cell attempt', async () => {
    const storage = inMemoryCampaignStorage()
    const runDir = '/runs/interrupted-cell-cost-reporting'
    const sequence = {
      id: 'history',
      family: 'first-party' as const,
      steps: [
        {
          id: 'remember',
          scope: { agentId: 'worker' },
          writes: [{ kind: 'fact' as const, text: 'resumed fact' }],
          probes: [{ id: 'recall', query: 'resumed', referenceAnswer: 'resumed fact' }],
        },
      ],
    }
    const candidate = {
      id: 'memory',
      ref: 'memory:v1',
      externalCostUsdPerSequence: 0.1,
      externalCostAccounting: 'exact' as const,
      createAdapter: ({ recordExternalCost }) => {
        recordExternalCost(0.1)
        return createScopedTestAdapter('memory')
      },
    }
    const scenarioId = buildAgentMemorySequenceScenarios([sequence], [candidate])[0]!.id
    const abandonedLedger = createRunCostLedger({ storage, runDir, costCeilingUsd: 1 })
    const controller = new AbortController()
    let releaseProvider!: () => void
    let reportStarted!: () => void
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve
    })
    const abandoned = abandonedLedger.runPaidCall({
      callId: 'prior-cell-attempt',
      channel: 'agent',
      phase: 'memory.experiment',
      actor: 'agent-knowledge:memory-experiment:memory',
      model: 'memory',
      signal: controller.signal,
      tags: {
        runDir,
        scenarioId,
        cellId: 'prior-cell',
        rep: '0',
        runAttemptId: 'prior-attempt',
      },
      maximumCharge: { externallyEnforcedMaximumUsd: 0.1 },
      async execute() {
        reportStarted()
        return await new Promise<string>((resolve) => {
          releaseProvider = () => resolve('late result')
        })
      },
      receipt: () => ({
        model: 'memory',
        inputTokens: 0,
        outputTokens: 0,
        actualCostUsd: 0.05,
      }),
    })
    await started
    controller.abort(new Error('simulated process exit'))
    await abandoned

    const resumedLedger = createRunCostLedger({ storage, runDir, costCeilingUsd: 1 })
    const result = await runAgentMemoryExperiment({
      experimentId: 'interrupted-cell-cost-reporting',
      sequences: [sequence],
      candidates: [candidate],
      runDir,
      storage,
      costLedger: resumedLedger,
    })

    expect(result.rows[0]).toMatchObject({ candidateId: 'memory', totalCostUsd: 0.2 })
    expect(resumedLedger.summary()).toMatchObject({ totalCalls: 2, totalCostUsd: 0.2 })
    releaseProvider()
    await abandonedLedger.waitForIdle()
  })

  it('reconciles interrupted paid calls from every parallel memory branch before resuming', async () => {
    const storage = inMemoryCampaignStorage()
    const runDir = '/runs/parallel-interrupted-cost-recovery'
    const abandonedLedger = createRunCostLedger({ storage, runDir, costCeilingUsd: 1 })
    const controllers = [new AbortController(), new AbortController()]
    const releases: Array<() => void> = []
    let started = 0
    let reportStarted: (() => void) | undefined
    const bothStarted = new Promise<void>((resolve) => {
      reportStarted = resolve
    })
    const abandonedCalls = ['one', 'two'].map((branch, index) =>
      abandonedLedger.runPaidCall({
        callId: `abandoned-${branch}`,
        channel: 'agent',
        phase: 'memory.train',
        actor: `agent-knowledge:memory-experiment:${branch}`,
        model: `provider-${branch}`,
        signal: controllers[index]!.signal,
        maximumCharge: { externallyEnforcedMaximumUsd: 0.1 },
        async execute() {
          started += 1
          if (started === 2) reportStarted?.()
          return await new Promise<string>((resolve) => {
            releases[index] = () => resolve('late provider result')
          })
        },
        receipt: () => ({
          model: `provider-${branch}`,
          inputTokens: 0,
          outputTokens: 0,
          actualCostUsd: 0.05,
        }),
      }),
    )

    await bothStarted
    for (const controller of controllers) {
      controller.abort(new Error('simulated process exit'))
    }
    await Promise.all(abandonedCalls)
    expect(abandonedLedger.listPending().map((call) => call.state)).toEqual(['late', 'late'])

    const resumedLedger = createRunCostLedger({ storage, runDir, costCeilingUsd: 1 })
    expect(resumedLedger.listPending().map((call) => call.state)).toEqual([
      'interrupted',
      'interrupted',
    ])

    const result = await runAgentMemoryExperiment({
      experimentId: 'parallel-interrupted-cost-recovery',
      sequences: [
        {
          id: 'history',
          family: 'first-party',
          steps: [
            {
              id: 'remember',
              scope: { agentId: 'worker' },
              writes: [{ kind: 'fact', text: 'resumed fact' }],
              probes: [
                {
                  id: 'recall',
                  query: 'resumed',
                  referenceAnswer: 'resumed fact',
                },
              ],
            },
          ],
        },
      ],
      candidates: [
        {
          id: 'resumed',
          ref: 'resumed:v1',
          createAdapter: () => createScopedTestAdapter('resumed'),
        },
      ],
      runDir,
      storage,
      costLedger: resumedLedger,
    })

    expect(result.rows[0]).toMatchObject({ candidateId: 'resumed', cellsFailed: 0 })
    expect(resumedLedger.summary()).toMatchObject({
      totalCalls: 2,
      unresolvedCalls: 0,
      totalCostUsd: 0.2,
      accountingComplete: true,
    })
    expect(resumedLedger.list().map((receipt) => receipt.error)).toEqual([
      expect.stringContaining('charged the reserved maximum'),
      expect.stringContaining('charged the reserved maximum'),
    ])

    for (const release of releases) release()
    await abandonedLedger.waitForIdle()
  })

  it('does not reuse cells after the candidate implementation reference changes', async () => {
    const storage = inMemoryCampaignStorage()
    const sequence = {
      id: 'candidate-ref',
      family: 'first-party' as const,
      steps: [
        {
          id: 'remember',
          scope: { agentId: 'worker' },
          writes: [{ kind: 'fact' as const, text: 'remember me' }],
          probes: [
            {
              id: 'recall',
              query: 'remember',
              requiredFacts: [{ id: 'fact', anyOf: ['remember me'] }],
            },
          ],
        },
      ],
    }
    let creates = 0
    const run = (ref: string, visible: boolean) =>
      runAgentMemoryExperiment({
        experimentId: 'candidate-ref-cache',
        sequences: [sequence],
        candidates: [
          {
            id: 'memory',
            ref,
            createAdapter() {
              creates += 1
              const adapter = createScopedTestAdapter(`memory:${ref}`)
              if (visible) return adapter
              return {
                ...adapter,
                async search() {
                  return []
                },
              }
            },
          },
        ],
        runDir: '/runs/candidate-ref-cache',
        storage,
      })

    const first = await run('memory:v1', true)
    const cached = await run('memory:v1', false)
    const changed = await run('memory:v2', false)

    expect(first.rows[0]?.scoreMean).toBe(1)
    expect(cached.campaign.cells[0]?.cached).toBe(true)
    expect(cached.rows[0]?.scoreMean).toBe(1)
    expect(changed.campaign.cells[0]?.cached).toBe(false)
    expect(changed.rows[0]?.scoreMean).toBe(0)
    expect(creates).toBe(2)
  })

  it('runs existing ordered memory benchmark cases without reshaping the dataset', async () => {
    const sequences = buildAgentMemorySequencesFromBenchmarkCases([
      {
        id: 'launch-update',
        family: 'longmemeval',
        taskKind: 'memory-temporal',
        split: 'holdout',
        events: [
          { id: 'old', actorId: 'pm', text: 'Launch is April 3.' },
          { id: 'current', actorId: 'pm', text: 'Launch moved to April 17.' },
        ],
        prompt: 'When is launch?',
        requiredFacts: [{ id: 'current-date', anyOf: ['April 17'] }],
        forbiddenFacts: [{ id: 'old-date', anyOf: ['April 3'], obsolete: true }],
        expectedEventIds: ['current'],
        expectedActorIds: ['pm'],
      },
    ])
    const result = await runAgentMemoryExperiment({
      experimentId: 'benchmark-conversion',
      sequences,
      candidates: [
        {
          id: 'literal-memory',
          ref: 'literal-memory:v1',
          createAdapter: () => createScopedTestAdapter('literal-memory'),
        },
      ],
      runDir: '/runs/benchmark-conversion',
      storage: inMemoryCampaignStorage(),
    })

    expect(sequences[0]?.steps.map((step) => step.id)).toEqual([
      'event:old',
      'event:current',
      'probe',
    ])
    expect(result.rows[0]).toMatchObject({
      scoreMean: 0.75,
      totalSequences: 1,
      totalProbes: 1,
      cellsFailed: 0,
    })
    expect(result.rows[0]?.dimensions).toMatchObject({ memory_stale_safe: 0 })
  })
})
