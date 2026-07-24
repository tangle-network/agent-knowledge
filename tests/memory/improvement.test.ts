import { canonicalJson } from '@tangle-network/agent-eval'
import {
  campaignMeanComposite,
  inMemoryCampaignStorage,
  type JsonValue,
  type OptimizationMethod,
  runCampaign,
  surfaceHash,
} from '@tangle-network/agent-eval/campaign'
import { describe, expect, it } from 'vitest'
import { stableId } from '../../src/ids'
import { buildCandidate } from '../../src/memory/improvement/candidate'
import {
  type AgentMemorySequence,
  type AgentMemorySequenceArtifact,
  type MemoryConfigScenario,
  type RunAgentMemoryImprovementOptions,
  runAgentMemoryImprovement as runAgentMemoryImprovementRaw,
} from '../../src/memory/index'
import { createScopedTestAdapter, runAgentMemoryImprovement } from '../support/memory'

type Config = { visibility: 'private' | 'team' }

describe('agent memory improvement', () => {
  it('runs a complete method, keeps final data private, resumes, and activates once', async () => {
    const storage = inMemoryCampaignStorage()
    const methodInputs: string[][] = []
    let candidateConstructions = 0
    let activeConfig: Config = { visibility: 'private' }
    const activationIds: string[] = []
    const method = selectingMethod<Config>(
      [{ visibility: 'private' }, { visibility: 'team' }],
      methodInputs,
    )
    const options: RunAgentMemoryImprovementOptions<Config> = {
      experimentId: 'complete-method-memory',
      baselineConfig: { visibility: 'private' },
      method,
      trainSequences: [improvementSequence('train-a', 'train')],
      selectionSequences: [improvementSequence('selection-a', 'validation')],
      finalSequences: [
        improvementSequence('final-a', 'test'),
        improvementSequence('final-b', 'test'),
      ],
      improvementRef: 'deployment:test/team-memory-policy',
      runDir: '/runs/complete-method-memory',
      storage,
      controllerMode: 'process-local',
      sequenceConcurrency: 4,
      significance: { minProductiveRuns: 2, resamples: 200, seed: 7 },
      createCandidate: ({ config, candidateId }) => {
        candidateConstructions += 1
        return {
          ref: `deployment:test/visibility/${config.visibility}`,
          policy: { read: [config.visibility], write: config.visibility },
          externalCostUsdPerSequence: 0,
          externalRecoveryCostUsdPerAttempt: 0,
          externalCostAccounting: 'exact',
          createAdapter: ({ branchId }) => createScopedTestAdapter(`${candidateId}:${branchId}`),
        }
      },
      activation: {
        ref: 'deployment:test/memory-policy',
        async readCurrent() {
          return structuredClone(activeConfig)
        },
        async compareAndSet({ activationId, expectedConfig, config, optimization }) {
          expect(activeConfig).toEqual(expectedConfig)
          expect(optimization.winner.surfaceHash).toBe(surfaceHash(canonicalJson(config)))
          activationIds.push(activationId)
          activeConfig = structuredClone(config)
        },
      },
    }

    const result = await runAgentMemoryImprovement(options)

    expect(methodInputs).toEqual([['train-a', 'selection-a']])
    expect(result.winnerConfig).toEqual({ visibility: 'team' })
    expect(result.winnerSurface).toBe('{"visibility":"team"}')
    expect(result.finalEvaluation.pairs).toHaveLength(2)
    expect(result.finalEvaluation.pairs.map((pair) => pair.sequenceId)).toEqual([
      'final-a',
      'final-b',
    ])
    expect(result.decision).toMatchObject({
      status: 'promote',
      baselineScore: 0.25,
      winnerScore: 1,
      lift: 0.75,
    })
    expect(result.activation.status).toBe('activated')
    expect(activeConfig).toEqual({ visibility: 'team' })
    expect(activationIds).toEqual([result.activation.id])
    const identity = JSON.parse(
      storage.read('/runs/complete-method-memory/memory-improvement-manifest.json') ?? '{}',
    ).identity
    expect(identity).toMatchObject({
      experimentId: 'complete-method-memory',
      improvementRef: 'deployment:test/team-memory-policy',
      method: 'fixture-selection',
    })
    expect(identity).not.toHaveProperty('schema')
    expect(identity).not.toHaveProperty('implementationRef')
    expect(
      storage.read(
        `/runs/complete-method-memory/memory-config-artifacts/${result.winnerSurfaceHash}/${stableId('sequence', 'final-a')}/rep-0-${stableId('seed', '42')}.json`,
      ),
    ).toContain('"sequenceId": "final-a"')
    expect(
      storage.read(
        `/runs/complete-method-memory/memory-final-artifacts/${result.winnerSurfaceHash}/${stableId('sequence', 'final-a')}/rep-0.json`,
      ),
    ).toContain('"seed": 42')

    const constructionsAfterFirstRun = candidateConstructions
    const resumed = await runAgentMemoryImprovement(options)

    expect(candidateConstructions).toBe(constructionsAfterFirstRun)
    expect(activationIds).toEqual([result.activation.id])
    expect(resumed.activation.status).toBe('already-activated')
    expect(resumed.winnerSurfaceHash).toBe(result.winnerSurfaceHash)
    expect(resumed.finalEvaluation.manifestHash).toBe(result.finalEvaluation.manifestHash)
  })

  it('recovers an applied activation whose final journal write was interrupted', async () => {
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
    const options = baseOptions({
      experimentId: 'recover-memory-activation',
      runDir: '/runs/recover-memory-activation',
      storage,
      method: selectingMethod([{ visibility: 'private' }, { visibility: 'team' }]),
      activation: {
        ref: 'deployment:test/memory-policy',
        async readCurrent() {
          return structuredClone(activeConfig)
        },
        async compareAndSet({ expectedConfig, config }) {
          expect(activeConfig).toEqual(expectedConfig)
          compareAndSetCalls += 1
          activeConfig = structuredClone(config)
        },
      },
    })

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

  it('rejects a resumed final artifact whose embedded candidate identity changed', async () => {
    const storage = inMemoryCampaignStorage()
    const options = baseOptions({
      experimentId: 'corrupt-memory-artifact',
      runDir: '/runs/corrupt-memory-artifact',
      storage,
    })
    const first = await runAgentMemoryImprovement(options)
    const artifactPath =
      `/runs/corrupt-memory-artifact/memory-final-artifacts/${first.winnerSurfaceHash}` +
      `/${stableId('sequence', 'final-a')}/rep-0.json`
    const record = JSON.parse(storage.read(artifactPath)!)
    record.artifact.candidateId = 'memory-config-from-another-surface'
    storage.write(artifactPath, `${JSON.stringify(record, null, 2)}\n`)

    await expect(runAgentMemoryImprovement(options)).rejects.toThrow(
      `memory config artifact '${artifactPath}' is malformed`,
    )
  })

  it('rejects copied data across train, selection, and final partitions', async () => {
    const train = improvementSequence('train-original', 'train')
    const options = baseOptions({
      experimentId: 'copied-memory-data',
      runDir: '/runs/copied-memory-data',
      trainSequences: [train],
      finalSequences: [
        { ...train, id: 'renamed-final', split: 'test' },
        improvementSequence('final-b', 'test'),
      ],
    })

    await expect(runAgentMemoryImprovement(options)).rejects.toThrow(
      "train/final histories duplicate content at 'train-original'/'renamed-final'",
    )
  })

  it('requires an explicit controller policy for custom storage', async () => {
    const options = baseOptions({
      experimentId: 'custom-memory-storage',
      runDir: '/runs/custom-memory-storage',
      storage: inMemoryCampaignStorage(),
    })
    delete (options as { controllerMode?: string }).controllerMode

    await expect(runAgentMemoryImprovementRaw(options)).rejects.toThrow(
      "requires acquireRunLease or controllerMode='process-local'",
    )
  })

  it('requires a per-evaluation maximum before enabling paid work', async () => {
    await expect(
      runAgentMemoryImprovement(
        baseOptions({
          experimentId: 'missing-evaluation-maximum',
          runDir: '/runs/missing-evaluation-maximum',
          maxOptimizationCostUsd: 1,
        }),
      ),
    ).rejects.toThrow('maximumEvaluationCostUsd is required when a spend limit is configured')
  })

  it('rejects memory candidates without explicit provider cost declarations', async () => {
    const options = baseOptions({
      experimentId: 'missing-provider-costs',
      runDir: '/runs/missing-provider-costs',
    })
    options.createCandidate = (({
      config,
      candidateId,
    }: Parameters<typeof options.createCandidate>[0]) => ({
      ref: `deployment:test/visibility/${config.visibility}`,
      policy: { read: [config.visibility], write: config.visibility },
      createAdapter: ({ branchId }: { branchId: string }) =>
        createScopedTestAdapter(`${candidateId}:${branchId}`),
    })) as typeof options.createCandidate

    await expect(buildCandidate(options, options.baselineConfig, 'missing-costs')).rejects.toThrow(
      'externalCostUsdPerSequence must be a declared non-negative finite number',
    )
  })

  it('holds activation when the method cannot fully account for optimization cost', async () => {
    let activationCalls = 0
    const result = await runAgentMemoryImprovement(
      baseOptions({
        experimentId: 'incomplete-method-cost',
        runDir: '/runs/incomplete-method-cost',
        method: selectingMethod([{ visibility: 'private' }, { visibility: 'team' }], undefined, {
          totalCostUsd: 0,
          accountingComplete: false,
          incompleteReasons: ['external optimizer usage unavailable'],
        }),
        activation: {
          ref: 'deployment:test/memory-policy',
          async readCurrent() {
            return { visibility: 'private' }
          },
          async compareAndSet() {
            activationCalls += 1
          },
        },
      }),
    )

    expect(result.winnerConfig).toEqual({ visibility: 'team' })
    expect(result.decision.status).toBe('hold')
    expect(result.decision.reasons).toContain('optimization or final cost accounting is incomplete')
    expect(result.activation.status).toBe('not-eligible')
    expect(activationCalls).toBe(0)
  })
})

function baseOptions(
  overrides: Partial<RunAgentMemoryImprovementOptions<Config>> = {},
): RunAgentMemoryImprovementOptions<Config> {
  return {
    experimentId: 'memory-improvement',
    baselineConfig: { visibility: 'private' },
    method: selectingMethod([{ visibility: 'private' }, { visibility: 'team' }]),
    trainSequences: [improvementSequence('train-a', 'train')],
    selectionSequences: [improvementSequence('selection-a', 'validation')],
    finalSequences: [
      improvementSequence('final-a', 'test'),
      improvementSequence('final-b', 'test'),
    ],
    createCandidate: ({ config, candidateId }) => ({
      ref: `deployment:test/visibility/${config.visibility}`,
      policy: { read: [config.visibility], write: config.visibility },
      externalCostUsdPerSequence: 0,
      externalRecoveryCostUsdPerAttempt: 0,
      externalCostAccounting: 'exact',
      createAdapter: ({ branchId }) => createScopedTestAdapter(`${candidateId}:${branchId}`),
    }),
    improvementRef: 'deployment:test/memory-improvement',
    runDir: '/runs/memory-improvement',
    storage: inMemoryCampaignStorage(),
    controllerMode: 'process-local',
    significance: { minProductiveRuns: 2, resamples: 200, seed: 7 },
    ...overrides,
  }
}

function selectingMethod<TConfig extends JsonValue>(
  configs: readonly TConfig[],
  inputs?: string[][],
  cost = { totalCostUsd: 0, accountingComplete: true, incompleteReasons: [] },
): OptimizationMethod<MemoryConfigScenario, AgentMemorySequenceArtifact> {
  return {
    name: 'fixture-selection',
    async optimize(input) {
      inputs?.push([
        ...input.trainScenarios.map((scenario) => scenario.id),
        ...input.selectionScenarios.map((scenario) => scenario.id),
      ])
      expect('testScenarios' in input).toBe(false)
      const scored = await Promise.all(
        configs.map(async (config) => {
          const surface = canonicalJson(config)
          await runCampaign({
            ...input.runOptions,
            scenarios: [...input.trainScenarios],
            dispatch: (scenario, context) => input.dispatchWithSurface(surface, scenario, context),
            judges: [...input.judges],
            runDir: `${input.runDir}/fixture/${surfaceHash(surface)}/train`,
            seed: input.seed,
          })
          const selection = await runCampaign({
            ...input.runOptions,
            scenarios: [...input.selectionScenarios],
            dispatch: (scenario, context) => input.dispatchWithSurface(surface, scenario, context),
            judges: [...input.judges],
            runDir: `${input.runDir}/fixture/${surfaceHash(surface)}/selection`,
            seed: input.seed,
          })
          return { surface, score: campaignMeanComposite(selection) }
        }),
      )
      scored.sort((left, right) => right.score - left.score)
      return {
        winnerSurface: scored[0]!.surface,
        cost,
      }
    },
  }
}

function improvementSequence(
  id: string,
  split: 'train' | 'validation' | 'test',
): AgentMemorySequence {
  return {
    id,
    family: 'first-party',
    split,
    steps: [
      {
        id: 'research',
        scope: { agentId: 'researcher', teamId: 'team-1' },
        writes: [
          {
            id: `${id}-event`,
            kind: 'fact',
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
            forbiddenFacts: [
              {
                id: 'stale',
                anyOf: [`${id} launch date is Thursday`],
                obsolete: true,
              },
            ],
            expectedEventIds: [`${id}-event`],
            expectedActorIds: ['researcher'],
          },
        ],
      },
    ],
  }
}
