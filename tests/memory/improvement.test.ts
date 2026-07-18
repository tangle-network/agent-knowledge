import {
  createRunCostLedger,
  inMemoryCampaignStorage,
  type SurfaceProposer,
} from '@tangle-network/agent-eval/campaign'
import { describe, expect, it } from 'vitest'
import { runAgentMemoryImprovement as runAgentMemoryImprovementRaw } from '../../src/memory/index'
import { createScopedTestAdapter, runAgentMemoryImprovement } from '../support/memory'

describe('agent memory improvement', () => {
  it('fails fast when a JavaScript caller uses the removed onPromote option', async () => {
    await expect(
      runAgentMemoryImprovementRaw({
        onPromote() {},
      } as unknown as RunAgentMemoryImprovementOptions<unknown>),
    ).rejects.toThrow(
      'onPromote was removed; use activation.readCurrent and activation.compareAndSet',
    )
  })

  it('requires an explicit controller policy for custom improvement storage', async () => {
    await expect(
      runAgentMemoryImprovementRaw({
        experimentId: 'custom-improvement-storage',
        trainSequences: [improvementSequence('train', 'train')],
        holdoutSequences: [improvementSequence('holdout', 'holdout')],
        seeds: [
          {
            config: { mode: 'baseline' },
            track: 'baseline',
            proposer: 'default',
          },
        ],
        createCandidate: () => ({
          ref: 'memory:v1',
          createAdapter: () => createScopedTestAdapter('memory'),
        }),
        proposer: { kind: 'noop', propose: async () => [] },
        improvementRef: 'custom-improvement-storage:v1',
        budget: { maxSteps: 1 },
        runDir: '/runs/custom-improvement-storage',
        storage: inMemoryCampaignStorage(),
      }),
    ).rejects.toThrow("requires acquireRunLease or controllerMode='process-local'")
  })

  it('searches isolated configs and activates only a fresh holdout win', async () => {
    type Config = { visibility: 'private' | 'team' | 'shared' }
    const storage = inMemoryCampaignStorage()
    const promoted: Config[] = []
    let activeConfig: Config = { visibility: 'private' }
    const activationIds: string[] = []
    const contenderIds = new Set<string>()
    const activeContenderCalls = new Map<string, number>()
    let maxConcurrentConfigs = 0
    let reportContendersActive: (() => void) | undefined
    const contendersActive = new Promise<void>((resolve) => {
      reportContendersActive = resolve
    })
    let releaseContenders: (() => void) | undefined
    const continueContenders = new Promise<void>((resolve) => {
      releaseContenders = resolve
    })
    let proposalCalls = 0
    const proposer: SurfaceProposer = {
      kind: 'team-sharing-proposer',
      async propose() {
        proposalCalls += 1
        return [
          {
            surface: JSON.stringify({ visibility: 'team' }),
            label: 'share within the team',
            rationale: "the second agent needs the first agent's accepted fact",
          },
          {
            surface: JSON.stringify({ visibility: 'shared' }),
            label: 'share globally',
            rationale: 'compare a broader sharing policy under the same histories',
          },
        ]
      },
    }

    const options: RunAgentMemoryImprovementOptions<Config> = {
      experimentId: 'improve-team-memory',
      trainSequences: [
        improvementSequence('train-a', 'train'),
        improvementSequence('train-b', 'train'),
      ],
      holdoutSequences: [
        improvementSequence('holdout-a', 'holdout'),
        improvementSequence('holdout-b', 'holdout'),
      ],
      seeds: [
        {
          config: { visibility: 'private' },
          track: 'baseline',
          proposer: 'seed',
        },
      ],
      proposer,
      improvementRef: 'team-memory-policy/v1',
      budget: { maxSteps: 1 },
      populationSize: 2,
      candidateConcurrency: 2,
      sequenceConcurrency: 4,
      runDir: '/runs/improve-team-memory',
      storage,
      significance: { minProductiveRuns: 2, resamples: 200, seed: 7 },
      createCandidate: ({ config, candidateId }) => {
        if (config.visibility !== 'private') contenderIds.add(candidateId)
        return {
          ref: `visibility:${config.visibility}:v1`,
          label: config.visibility,
          policy: { read: [config.visibility], write: config.visibility },
          createAdapter: ({ branchId }) => createScopedTestAdapter(`${candidateId}:${branchId}`),
        }
      },
      executeStepRef: 'parallel-config-proof/v1',
      executeStep: async ({ candidateId, step }) => {
        if (step.id !== 'research' || !contenderIds.has(candidateId)) return
        activeContenderCalls.set(candidateId, (activeContenderCalls.get(candidateId) ?? 0) + 1)
        maxConcurrentConfigs = Math.max(maxConcurrentConfigs, activeContenderCalls.size)
        if (activeContenderCalls.size === 2) reportContendersActive?.()
        try {
          await continueContenders
        } finally {
          const remaining = (activeContenderCalls.get(candidateId) ?? 1) - 1
          if (remaining === 0) activeContenderCalls.delete(candidateId)
          else activeContenderCalls.set(candidateId, remaining)
        }
      },
      activation: {
        ref: 'memory-policy/live:v1',
        async readCurrent() {
          return structuredClone(activeConfig)
        },
        async compareAndSet({ activationId, expectedConfig, config }) {
          expect(activeConfig).toEqual(expectedConfig)
          activationIds.push(activationId)
          activeConfig = structuredClone(config)
          promoted.push(structuredClone(config))
        },
      },
    }
    const firstRun = runAgentMemoryImprovement(options)
    await contendersActive
    await expect(runAgentMemoryImprovement(options)).rejects.toThrow('active controller')
    releaseContenders?.()
    const result = await firstRun

    expect(result.decision).toMatchObject({
      status: 'promote',
      reasons: [],
      baselineScore: 0.25,
      winnerScore: 1,
      lift: 0.75,
    })
    expect(result.decision.significance).toMatchObject({ n: 2, significant: true })
    expect(result.winnerConfig).toEqual({ visibility: 'team' })
    expect(result.holdout?.campaign.cells).toHaveLength(4)
    expect(maxConcurrentConfigs).toBe(2)
    expect(promoted).toEqual([{ visibility: 'team' }])
    expect(result.activation).toMatchObject({ status: 'activated' })
    expect(storage.read(result.resultJsonPath)).toContain('"status": "promote"')
    expect(
      JSON.parse(storage.read('/runs/improve-team-memory/memory-improvement-manifest.json') ?? '{}')
        .identity?.schema,
    ).toBe(6)

    const resumed = await runAgentMemoryImprovement(options)
    expect(proposalCalls).toBe(1)
    expect(promoted).toEqual([{ visibility: 'team' }])
    expect(activationIds).toEqual([result.activation.id])
    expect(resumed.activation).toEqual({
      ...result.activation,
      status: 'already-activated',
    })
    expect(activeConfig).toEqual({ visibility: 'team' })
    await expect(
      runAgentMemoryImprovement({ ...options, budget: { maxSteps: 2 } }),
    ).rejects.toThrow('does not match its persisted inputs or implementationRef')
    await expect(runAgentMemoryImprovement({ ...options, minHoldoutScore: 0.99 })).rejects.toThrow(
      'does not match its persisted inputs or implementationRef',
    )
    await expect(
      runAgentMemoryImprovement({ ...options, improvementRef: 'team-memory-policy/v2' }),
    ).rejects.toThrow('does not match its persisted inputs or implementationRef')
  })

  it('recovers when the live config changes before the activation event is persisted', async () => {
    type Config = { visibility: 'private' | 'team' }
    const storage = inMemoryCampaignStorage()
    const append = storage.append!.bind(storage)
    let rejectActivatedEvent = true
    storage.append = (path, value, expectedBytes) => {
      if (
        rejectActivatedEvent &&
        path.includes('/activations/') &&
        value.includes('"status":"activated"')
      ) {
        rejectActivatedEvent = false
        throw new Error('activation journal unavailable')
      }
      return append(path, value, expectedBytes)
    }
    let activeConfig: Config = { visibility: 'private' }
    let compareAndSetCalls = 0
    const options: RunAgentMemoryImprovementOptions<Config> = {
      experimentId: 'recover-memory-activation',
      trainSequences: [
        improvementSequence('activation-train-a', 'train'),
        improvementSequence('activation-train-b', 'train'),
      ],
      holdoutSequences: [
        improvementSequence('activation-holdout-a', 'holdout'),
        improvementSequence('activation-holdout-b', 'holdout'),
      ],
      seeds: [
        {
          config: { visibility: 'private' },
          track: 'baseline',
          proposer: 'seed',
        },
      ],
      proposer: {
        kind: 'team-sharing-proposer',
        async propose() {
          return [
            {
              surface: JSON.stringify({ visibility: 'team' }),
              label: 'share with team',
              rationale: 'the second agent needs the accepted fact',
            },
          ]
        },
      },
      improvementRef: 'recover-memory-activation:v1',
      budget: { maxSteps: 1 },
      runDir: '/runs/recover-memory-activation',
      storage,
      significance: { minProductiveRuns: 2, resamples: 200, seed: 11 },
      createCandidate: ({ config, candidateId }) => ({
        ref: `visibility:${config.visibility}:v1`,
        policy: { read: [config.visibility], write: config.visibility },
        createAdapter: ({ branchId }) => createScopedTestAdapter(`${candidateId}:${branchId}`),
      }),
      activation: {
        ref: 'memory-policy/live:v1',
        async readCurrent() {
          return structuredClone(activeConfig)
        },
        async compareAndSet({ expectedConfig, config }) {
          expect(activeConfig).toEqual(expectedConfig)
          compareAndSetCalls += 1
          activeConfig = structuredClone(config)
        },
      },
    }

    await expect(runAgentMemoryImprovement(options)).rejects.toThrow(
      'activation journal unavailable',
    )
    expect(activeConfig).toEqual({ visibility: 'team' })
    expect(compareAndSetCalls).toBe(1)

    const recovered = await runAgentMemoryImprovement(options)
    expect(recovered.activation.status).toBe('recovered')
    expect(compareAndSetCalls).toBe(1)
    const resumed = await runAgentMemoryImprovement(options)
    expect(resumed.activation.status).toBe('already-activated')
    expect(compareAndSetCalls).toBe(1)
  })

  it('routes independent tracks to their named proposers with track context', async () => {
    type Config = { visibility: 'private' | 'team' }
    const trackContexts: Array<{
      id?: string
      operation?: string
      vision?: string
      generation: number
      costPhase?: string
      hasCostLedger: boolean
    }> = []
    let governorCostPhase: string | undefined
    let governorHasCostLedger = false
    const trackProposer: SurfaceProposer = {
      kind: 'team-memory-researcher',
      async propose(context) {
        trackContexts.push({
          id: context.track?.id,
          operation: context.track?.operation,
          vision: context.track?.vision,
          generation: context.generation,
          costPhase: context.costPhase,
          hasCostLedger: context.costLedger !== undefined,
        })
        return [JSON.stringify({ visibility: 'team' })]
      },
    }

    await runAgentMemoryImprovement<Config>({
      experimentId: 'named-track-proposers',
      trainSequences: [improvementSequence('track-train', 'train')],
      holdoutSequences: [improvementSequence('track-holdout', 'holdout')],
      seeds: [
        { config: { visibility: 'private' }, track: 'baseline', proposer: 'baseline' },
        {
          config: { visibility: 'private' },
          track: 'sharing-research',
          proposer: 'team-memory-researcher',
          vision: 'test whether team memory transfers accepted facts',
        },
      ],
      proposer: {
        kind: 'unexpected-fallback',
        async propose() {
          throw new Error('named track should not use the fallback proposer')
        },
      },
      proposers: { 'team-memory-researcher': trackProposer },
      governor: {
        decide(context) {
          governorCostPhase = context.costPhase
          governorHasCostLedger = context.costLedger !== undefined
          return { op: 'extend', track: 'sharing-research' }
        },
      },
      improvementRef: 'named-track-proposers/v1',
      budget: { maxSteps: 1 },
      populationSize: 1,
      runDir: '/runs/named-track-proposers',
      storage: inMemoryCampaignStorage(),
      createCandidate: ({ config, candidateId }) => ({
        ref: `visibility:${config.visibility}:v1`,
        policy: { read: [config.visibility], write: config.visibility },
        createAdapter: ({ branchId }) => createScopedTestAdapter(`${candidateId}:${branchId}`),
      }),
    })

    expect(trackContexts).toEqual([
      {
        id: 'sharing-research',
        operation: 'extend',
        vision: 'test whether team memory transfers accepted facts',
        generation: 1,
        costPhase: 'memory.proposal.sharing-research',
        hasCostLedger: true,
      },
    ])
    expect(governorCostPhase).toBe('memory.governor')
    expect(governorHasCostLedger).toBe(true)
  })

  it('holds a winner when holdout histories do not test a critical dimension', async () => {
    type Config = { visibility: 'private' | 'team' }
    const result = await runAgentMemoryImprovement<Config>({
      experimentId: 'missing-critical-dimension',
      trainSequences: [improvementSequence('critical-train', 'train')],
      holdoutSequences: [
        improvementSequence('critical-holdout-a', 'holdout', false),
        improvementSequence('critical-holdout-b', 'holdout', false),
        improvementSequence('critical-holdout-c', 'holdout', false),
      ],
      seeds: [{ config: { visibility: 'private' }, track: 'baseline', proposer: 'sharing' }],
      proposer: {
        kind: 'sharing',
        async propose() {
          return [JSON.stringify({ visibility: 'team' })]
        },
      },
      improvementRef: 'missing-critical-dimension/v1',
      budget: { maxSteps: 1 },
      populationSize: 1,
      runDir: '/runs/missing-critical-dimension',
      storage: inMemoryCampaignStorage(),
      significance: { minProductiveRuns: 1, resamples: 100, seed: 9 },
      criticalDimensions: ['memory_stale_safe'],
      createCandidate: ({ config, candidateId }) => ({
        ref: `visibility:${config.visibility}:v1`,
        policy: { read: [config.visibility], write: config.visibility },
        createAdapter: ({ branchId }) => createScopedTestAdapter(`${candidateId}:${branchId}`),
      }),
    })

    expect(result.decision.status).toBe('hold')
    expect(result.decision.criticalDimensions).toEqual([
      expect.objectContaining({
        dimension: 'memory_stale_safe',
        n: 0,
        expectedN: 0,
        measured: false,
      }),
    ])
    expect(result.decision.reasons).toContain(
      'critical dimension memory_stale_safe has no applicable holdout histories',
    )
  })

  it('stops before a proposer call would exceed the run-wide cost limit', async () => {
    let proposerExecuted = false

    await expect(
      runAgentMemoryImprovement({
        experimentId: 'proposer-cost-limit',
        trainSequences: [improvementSequence('cost-train', 'train')],
        holdoutSequences: [improvementSequence('cost-holdout', 'holdout')],
        seeds: [
          {
            config: { visibility: 'private' as const },
            track: 'baseline',
            proposer: 'costed',
          },
        ],
        proposer: {
          kind: 'costed',
          async propose(context) {
            if (!context.costLedger) throw new Error('missing run cost ledger')
            const paid = await context.costLedger.runPaidCall({
              actor: 'memory-config-proposer',
              channel: 'agent',
              phase: context.costPhase,
              model: 'fixture-model',
              maximumCharge: { externallyEnforcedMaximumUsd: 0.06 },
              execute: async () => {
                proposerExecuted = true
                return JSON.stringify({ visibility: 'team' })
              },
              receipt: () => ({
                model: 'fixture-model',
                inputTokens: 0,
                outputTokens: 0,
                usageUnknown: true,
                actualCostUsd: 0.06,
              }),
            })
            if (!paid.succeeded) throw paid.error
            return [paid.value]
          },
        },
        improvementRef: 'proposer-cost-limit/v1',
        budget: { maxSteps: 1 },
        maxTotalCostUsd: 0.05,
        runDir: '/runs/proposer-cost-limit',
        storage: inMemoryCampaignStorage(),
        createCandidate: ({ config, candidateId }) => ({
          ref: `visibility:${config.visibility}:v1`,
          policy: { read: [config.visibility], write: config.visibility },
          createAdapter: ({ branchId }) => createScopedTestAdapter(`${candidateId}:${branchId}`),
        }),
      }),
    ).rejects.toThrow('would exceed ceiling 0.05')
    expect(proposerExecuted).toBe(false)
  })

  it('charges an interrupted proposer reservation before resuming the search', async () => {
    type Config = { visibility: 'private' | 'team' }
    const storage = inMemoryCampaignStorage()
    const runDir = '/runs/interrupted-proposer-recovery'
    const append = storage.append!.bind(storage)
    let failFirstProposerReceipt = true
    storage.append = (path, value, expectedBytes) => {
      if (
        failFirstProposerReceipt &&
        path.endsWith('/cost-ledger.jsonl') &&
        value.includes('"status":"settled"') &&
        value.includes('memory-config-proposer')
      ) {
        failFirstProposerReceipt = false
        throw new Error('simulated process exit before proposer receipt')
      }
      return append(path, value, expectedBytes)
    }
    let proposerCalls = 0
    const options: RunAgentMemoryImprovementOptions<Config> = {
      experimentId: 'interrupted-proposer-recovery',
      trainSequences: [improvementSequence('proposer-train', 'train')],
      holdoutSequences: [improvementSequence('proposer-holdout', 'holdout')],
      seeds: [
        {
          config: { visibility: 'private' },
          track: 'baseline',
          proposer: 'costed',
        },
      ],
      proposer: {
        kind: 'costed',
        async propose(context) {
          proposerCalls += 1
          if (!context.costLedger) throw new Error('missing run cost ledger')
          const paid = await context.costLedger.runPaidCall({
            actor: 'memory-config-proposer',
            channel: 'agent',
            phase: context.costPhase,
            model: 'fixture-model',
            maximumCharge: { externallyEnforcedMaximumUsd: 0.1 },
            execute: async () => JSON.stringify({ visibility: 'team' }),
            receipt: () => ({
              model: 'fixture-model',
              inputTokens: 0,
              outputTokens: 0,
              actualCostUsd: 0.1,
            }),
          })
          if (!paid.succeeded) throw paid.error
          return [paid.value]
        },
      },
      improvementRef: 'interrupted-proposer-recovery/v1',
      budget: { maxSteps: 1 },
      maxTotalCostUsd: 0.2,
      runDir,
      storage,
      createCandidate: ({ config, candidateId }) => ({
        ref: `visibility:${config.visibility}:v1`,
        policy: { read: [config.visibility], write: config.visibility },
        createAdapter: ({ branchId }) => createScopedTestAdapter(`${candidateId}:${branchId}`),
      }),
    }

    await expect(runAgentMemoryImprovement(options)).rejects.toThrow('failed to persist')
    const interruptedLedger = createRunCostLedger({
      storage,
      runDir,
      costCeilingUsd: 0.2,
    })
    expect(interruptedLedger.listPending()).toEqual([
      expect.objectContaining({ actor: 'memory-config-proposer', state: 'interrupted' }),
    ])

    const result = await runAgentMemoryImprovement(options)
    const resumedLedger = createRunCostLedger({ storage, runDir, costCeilingUsd: 0.2 })

    expect(proposerCalls).toBe(2)
    expect(result.totalCostUsd).toBe(0.2)
    expect(resumedLedger.summary()).toMatchObject({
      totalCalls: 2,
      unresolvedCalls: 0,
      totalCostUsd: 0.2,
      accountingComplete: true,
    })
    expect(resumedLedger.list()[0]).toMatchObject({
      actor: 'memory-config-proposer',
      costUsd: 0.1,
      error: expect.stringContaining('charged the reserved maximum'),
    })
  })

  it('rejects train and holdout histories with the same id', async () => {
    const sequence = improvementSequence('duplicate', 'train')
    await expect(
      runAgentMemoryImprovement({
        experimentId: 'overlap',
        trainSequences: [sequence],
        holdoutSequences: [{ ...sequence, split: 'holdout' }],
        seeds: [{ config: {}, track: 'baseline', proposer: 'seed' }],
        proposer: {
          kind: 'unused',
          async propose() {
            return []
          },
        },
        improvementRef: 'overlap-test/v1',
        budget: { maxSteps: 1 },
        runDir: '/runs/overlap',
        storage: inMemoryCampaignStorage(),
        createCandidate: () => ({
          ref: 'unused:v1',
          createAdapter: () => createScopedTestAdapter('unused'),
        }),
      }),
    ).rejects.toThrow('train/holdout overlap: duplicate')
  })

  it('rejects a holdout history copied under a different id', async () => {
    const train = improvementSequence('train-original', 'train')
    await expect(
      runAgentMemoryImprovement({
        experimentId: 'renamed-overlap',
        trainSequences: [train],
        holdoutSequences: [{ ...train, id: 'renamed-holdout', split: 'holdout' }],
        seeds: [{ config: {}, track: 'baseline', proposer: 'seed' }],
        proposer: {
          kind: 'unused',
          async propose() {
            return []
          },
        },
        improvementRef: 'renamed-overlap/v1',
        budget: { maxSteps: 0 },
        runDir: '/runs/renamed-overlap',
        storage: inMemoryCampaignStorage(),
        createCandidate: () => ({
          ref: 'unused:v1',
          createAdapter: () => createScopedTestAdapter('unused'),
        }),
      }),
    ).rejects.toThrow('histories duplicate content')
  })
})

function improvementSequence(id: string, split: 'train' | 'holdout', includeStaleTarget = true) {
  return {
    id,
    family: 'first-party' as const,
    split,
    steps: [
      {
        id: 'research',
        scope: { agentId: 'researcher', teamId: 'team-1' },
        writes: [
          {
            id: `${id}-event`,
            kind: 'fact' as const,
            text: `${id} launch date is Friday`,
            metadata: { eventId: `${id}-event`, actorId: 'researcher' },
          },
        ],
      },
      {
        id: 'delivery',
        scope: { agentId: 'builder', teamId: 'team-1' },
        probes: [
          {
            id: 'launch-date',
            query: `${id} launch date`,
            requiredFacts: [{ id: 'current', anyOf: [`${id} launch date is Friday`] }],
            ...(includeStaleTarget
              ? {
                  forbiddenFacts: [
                    {
                      id: 'stale',
                      anyOf: [`${id} launch date is Thursday`],
                      obsolete: true,
                    },
                  ],
                }
              : {}),
            expectedEventIds: [`${id}-event`],
            expectedActorIds: ['researcher'],
          },
        ],
      },
    ],
  }
}
