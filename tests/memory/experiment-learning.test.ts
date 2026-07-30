import {
  canonicalDigest,
  createRunCostLedger,
  inMemoryCampaignStorage,
} from '@tangle-network/agent-eval/campaign'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  compareAgentMemoryLearning,
  type RunAgentMemoryLearningExperimentResult,
  runAgentMemoryExperiment,
  runAgentMemoryLearningExperiment,
} from '../../src/memory/index'
import {
  continualSequences,
  immutableRef,
  memoryCandidate,
  memoryCandidateWithoutClear,
  runDirectArm,
  twoStepControlSequence,
} from '../support/memory-learning'

describe('agent memory controlled learning experiment', () => {
  let result: RunAgentMemoryLearningExperimentResult
  let sharedCostUsd = 0
  let executorCalls = 0
  let comparisonJson = ''
  let storage: ReturnType<typeof inMemoryCampaignStorage>
  const observedBranchScopes = new Set<string>()
  const observedProviderTags: Record<string, string>[] = []

  beforeAll(async () => {
    storage = inMemoryCampaignStorage()
    const costLedger = createRunCostLedger({
      storage,
      runDir: '/runs/controlled-memory-learning',
      costCeilingUsd: 0.1,
    })
    const candidate = memoryCandidate('memory:v1', 0.01, (scope) => {
      const branchId = scope.tags?.memoryBranchId
      if (branchId) observedBranchScopes.add(branchId)
      observedProviderTags.push({ ...(scope.tags ?? {}) })
    })
    result = await runAgentMemoryLearningExperiment({
      experimentId: 'controlled-memory-learning',
      sequences: continualSequences(),
      candidates: [candidate],
      runDir: '/runs/controlled-memory-learning',
      storage,
      controllerMode: 'process-local',
      costCeiling: 0.1,
      costLedger,
      seed: 17,
      reps: 2,
      executeStepRef: immutableRef('test:shared-executor'),
      async executeStep() {
        executorCalls += 1
      },
    })
    sharedCostUsd = costLedger.summary().totalCostUsd
    comparisonJson = storage.read(result.comparisonPath) ?? ''
  })

  it('changes only memory persistence and shares identity, execution, and spend', () => {
    expect(result.stateful.memoryMode).toBe('stateful')
    expect(result.stateless.memoryMode).toBe('stateless')
    expect(result.armOrder).toBe('stateful-first')
    expect(result.stateful.comparisonRef).toBe(result.stateless.comparisonRef)
    expect(result.stateful.campaign.manifestHash).not.toBe(result.stateless.campaign.manifestHash)
    expect(
      result.stateful.campaign.cells.every((cell) => cell.artifact.memoryMode === 'stateful'),
    ).toBe(true)
    expect(
      result.stateless.campaign.cells.every((cell) => cell.artifact.memoryMode === 'stateless'),
    ).toBe(true)
    expect(sharedCostUsd).toBeCloseTo(0.08, 12)
    expect(result.stateful.totalCostUsd + result.stateless.totalCostUsd).toBeCloseTo(0.08, 12)
    expect(executorCalls).toBe(16)
    expect(observedBranchScopes.size).toBe(8)
    for (const tags of observedProviderTags) {
      expect(tags).not.toHaveProperty('memoryExperimentId')
      expect(tags).not.toHaveProperty('memoryCandidateId')
      expect(tags).not.toHaveProperty('memorySequenceId')
    }
  })

  it('defaults a single-arm memory experiment to stateful mode', async () => {
    const single = await runAgentMemoryExperiment({
      experimentId: 'default-stateful-memory',
      sequences: [twoStepControlSequence()],
      candidates: [memoryCandidate('memory:default-stateful')],
      runDir: '/runs/default-stateful-memory',
      storage: inMemoryCampaignStorage(),
      controllerMode: 'process-local',
    })

    expect(single.memoryMode).toBe('stateful')
    expect(single.campaign.cells[0]!.artifact.memoryMode).toBe('stateful')
  })

  it('records and executes a counterbalanced stateless-first arm order', async () => {
    const storage = inMemoryCampaignStorage()
    const append = storage.append!.bind(storage)
    const startedPaths: string[] = []
    storage.append = (path, value, expectedBytes) => {
      if (path.endsWith('/memory-attempts.jsonl') && value.includes('"status":"started"')) {
        startedPaths.push(path)
      }
      return append(path, value, expectedBytes)
    }

    const counterbalanced = await runAgentMemoryLearningExperiment({
      experimentId: 'counterbalanced-memory-learning',
      runDir: '/runs/counterbalanced-memory-learning',
      armOrder: 'stateless-first',
      sequences: [twoStepControlSequence()],
      candidates: [memoryCandidate('memory:counterbalanced')],
      storage,
      controllerMode: 'process-local',
    })

    expect(counterbalanced.armOrder).toBe('stateless-first')
    expect(startedPaths[0]).toContain('/stateless/')
    expect(startedPaths.at(-1)).toContain('/stateful/')
    expect(JSON.parse(storage.read(counterbalanced.comparisonPath)!)).toMatchObject({
      armOrder: 'stateless-first',
    })
  })

  it('reports paired gain, explicit transfer, and explicit forgetting', () => {
    const { comparison } = result

    expect(comparison.comparisonRef).toBe(result.stateful.comparisonRef)
    expect(comparison.cells).toHaveLength(4)
    expect(comparison.gain).toMatchObject({
      n: 2,
      mean: 0.375,
      median: 0.375,
      confidence: 0.95,
      resamples: 2_000,
      gateEligible: false,
    })
    expect(comparison.gainByCandidate).toHaveLength(1)
    expect(comparison.gainByCandidate[0]).toMatchObject({
      candidateId: 'memory',
      cells: 4,
      gain: { n: 2, mean: 0.375, gateEligible: false },
    })
    expect(comparison.preTreatment).toMatchObject({
      definition: 'first-step-probes',
      cells: 4,
      n: 2,
      exactMatchRate: 1,
      difference: { n: 2, mean: 0 },
    })
    expect(comparison.cells.find((cell) => cell.sequenceId === 'retention')).toMatchObject({
      candidateId: 'memory',
      statefulReward: 1,
      statelessReward: 0.25,
      gain: 0.75,
    })

    expect(comparison.transfer.definition).toBe('explicit-transfer-probes')
    expect(comparison.transfer.cells).toHaveLength(2)
    expect(comparison.transfer.cells.every((cell) => cell.probeCount === 1)).toBe(true)
    expect(comparison.transfer.byStep).toMatchObject([
      {
        candidateId: 'memory',
        transferKey: 'cross-capital-recall',
        stepOrdinal: 1,
        gain: { n: 1, mean: 0.5, gateEligible: false },
      },
    ])

    expect(comparison.forgetting.probes).toHaveLength(2)
    expect(comparison.forgetting.probes[0]).toMatchObject({
      retentionKey: 'capital-of-france',
      observations: 2,
      firstStepOrdinal: 0,
      finalStepOrdinal: 1,
      statefulPriorPeakReward: 1,
      statefulFinalReward: 1,
      statefulForgetting: 0,
      statelessPriorPeakReward: 1,
      statelessFinalReward: 0,
      statelessForgetting: 1,
      excessForgetting: -1,
    })
    expect(comparison.forgetting).toMatchObject({
      n: 1,
      meanStatefulForgetting: 0,
      meanStatelessForgetting: 1,
      meanExcessForgetting: -1,
      excess: { n: 1, mean: -1, gateEligible: false },
    })
  })

  it('binds the report to exact tasks, manifests, candidates, and artifacts', () => {
    expect(result.evidenceRef).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(result.comparisonPath).toContain(result.evidenceRef.slice(7))
    expect(result.cost).toEqual({
      experimentUsd: 0.08,
      ledgerUsd: 0.08,
      ceilingUsd: 0.1,
      accountingComplete: true,
    })
    expect(result.comparison.evidence).toMatchObject({
      splitRef: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      statefulManifestRef: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      statelessManifestRef: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      candidateRefs: [{ id: 'memory', ref: immutableRef('memory:v1') }],
      executionRef: immutableRef('test:shared-executor'),
    })
    expect(result.comparison.evidence.statefulManifestRef).not.toBe(
      result.comparison.evidence.statelessManifestRef,
    )
    expect(
      result.comparison.cells.every(
        (cell) =>
          /^sha256:[a-f0-9]{64}$/.test(cell.statefulArtifactRef) &&
          /^sha256:[a-f0-9]{64}$/.test(cell.statelessArtifactRef) &&
          cell.statefulArtifactRef !== cell.statelessArtifactRef,
      ),
    ).toBe(true)
    for (const arm of [result.stateful, result.stateless]) {
      for (const cell of arm.campaign.cells) {
        for (const probe of cell.artifact.probes) {
          expect(Object.values(arm.campaign.artifactsByPath)).toContain(probe.evidencePath)
          const raw = storage.read(probe.evidencePath)
          expect(raw).toBeTruthy()
          expect(canonicalDigest(JSON.parse(raw!))).toBe(probe.evidenceRef)
        }
      }
    }

    const stored = JSON.parse(comparisonJson)
    expect(stored).toEqual({
      evidenceRef: result.evidenceRef,
      armOrder: 'stateful-first',
      comparison: result.comparison,
      cost: result.cost,
    })
    expect(
      canonicalDigest({
        armOrder: stored.armOrder,
        comparison: stored.comparison,
        cost: stored.cost,
      }),
    ).toBe(stored.evidenceRef)
  })

  it('does not infer forgetting from repeated probe ids or prompt text', () => {
    expect(
      result.comparison.forgetting.probes.some((probe) => probe.sequenceId === 'control'),
    ).toBe(false)
  })

  it('reports first-step arm drift instead of hiding it in post-step gain', () => {
    const drifted = structuredClone(result.stateless)
    const artifact = drifted.campaign.cells.find(
      (cell) => cell.artifact.sequenceId === 'retention',
    )!.artifact
    const firstProbe = artifact.probes.find((probe) => probe.stepOrdinal === 0)!
    firstProbe.score = 0
    artifact.score =
      artifact.probes.reduce((sum, probe) => sum + probe.score, 0) / artifact.probes.length

    const comparison = compareAgentMemoryLearning({
      stateful: result.stateful,
      stateless: drifted,
    })
    expect(comparison.preTreatment).toMatchObject({
      n: 2,
      exactMatchRate: 0.5,
      difference: { mean: 0.25 },
    })
  })

  it('rejects swapped labels, incomplete runs, and mismatched probes', () => {
    expect(() =>
      compareAgentMemoryLearning({ stateful: result.stateless, stateless: result.stateful }),
    ).toThrow('stateful arm is labeled stateless')

    const missingCell = structuredClone(result.stateless)
    missingCell.campaign.cells.pop()
    expect(() =>
      compareAgentMemoryLearning({ stateful: result.stateful, stateless: missingCell }),
    ).toThrow('stateless run is missing cells')

    const mismatchedProbe = structuredClone(result.stateless)
    const artifact = mismatchedProbe.campaign.cells[0]!.artifact
    artifact.probes = artifact.probes.map((probe, index) =>
      index === 0 ? { ...probe, id: 'different-probe' } : probe,
    )
    expect(() =>
      compareAgentMemoryLearning({ stateful: result.stateful, stateless: mismatchedProbe }),
    ).toThrow('unmatched probe in cell')
  })

  it('rejects damaged task identity and failed cells before reporting gain', () => {
    const damagedIdentity = structuredClone(result.stateless)
    damagedIdentity.campaign.splitDigest = `sha256:${'0'.repeat(64)}`
    expect(() =>
      compareAgentMemoryLearning({ stateful: result.stateful, stateless: damagedIdentity }),
    ).toThrow('stateless run has invalid task identity')

    const failed = structuredClone(result.stateless)
    failed.campaign.cells[0]!.error = 'provider failed'
    expect(() =>
      compareAgentMemoryLearning({ stateful: result.stateful, stateless: failed }),
    ).toThrow('stateless cell')

    const damagedEvidence = structuredClone(result.stateless)
    damagedEvidence.campaign.cells[0]!.artifact.branchDigest = 'sha256:not-evidence'
    expect(() =>
      compareAgentMemoryLearning({ stateful: result.stateful, stateless: damagedEvidence }),
    ).toThrow('invalid branch evidence')
  })

  it('requires scoped clear support for the stateless arm', async () => {
    await expect(
      runAgentMemoryExperiment({
        experimentId: 'missing-stateless-clear',
        memoryMode: 'stateless',
        sequences: [twoStepControlSequence()],
        candidates: [memoryCandidateWithoutClear()],
        runDir: '/runs/missing-stateless-clear',
        storage: inMemoryCampaignStorage(),
        controllerMode: 'process-local',
        cleanupBranches: false,
      }),
    ).rejects.toThrow('stateless memoryMode requires scoped clear support')
  })

  it('rejects arms whose candidate implementation references differ', async () => {
    const experimentRunId = 'unequal-memory-arms'
    const [stateful, stateless] = await Promise.all([
      runDirectArm('stateful', 'memory:a', experimentRunId),
      runDirectArm('stateless', 'memory:b', experimentRunId),
    ])

    expect(() => compareAgentMemoryLearning({ stateful, stateless })).toThrow(
      'experimental conditions differ',
    )
  })

  it('rejects a mutable executor reference in separately run arms', async () => {
    const storage = inMemoryCampaignStorage()
    const common = {
      experimentId: 'mutable-executor-arms',
      experimentRunId: 'mutable-executor-arms',
      sequences: [twoStepControlSequence()],
      candidates: [memoryCandidate('memory:mutable-executor')],
      storage,
      controllerMode: 'process-local' as const,
      executeStepRef: 'executor:v1',
      async executeStep() {},
    }
    const [stateful, stateless] = await Promise.all([
      runAgentMemoryExperiment({
        ...common,
        memoryMode: 'stateful',
        runDir: '/runs/mutable-executor-arms/stateful',
      }),
      runAgentMemoryExperiment({
        ...common,
        memoryMode: 'stateless',
        runDir: '/runs/mutable-executor-arms/stateless',
      }),
    ])

    expect(() => compareAgentMemoryLearning({ stateful, stateless })).toThrow(
      'executor reference must be lowercase sha256',
    )
  })

  it('aborts active work and resumes without replaying completed cells', async () => {
    const storage = inMemoryCampaignStorage()
    const runDir = '/runs/resumable-memory-learning'
    const costLedger = createRunCostLedger({ storage, runDir, costCeilingUsd: 1 })
    const abortController = new AbortController()
    let executeCalls = 0
    const base = {
      experimentId: 'resumable-memory-learning',
      experimentRunId: 'resumable-memory-learning-run',
      sequences: continualSequences(),
      candidates: [memoryCandidate('memory:resumable', 0.01)],
      runDir,
      storage,
      controllerMode: 'process-local' as const,
      costCeiling: 1,
      costLedger,
      seed: 31,
      reps: 1,
      maxConcurrency: 1,
      executeStepRef: immutableRef('test:resumable-executor'),
      async executeStep() {
        executeCalls += 1
        if (executeCalls === 5) abortController.abort(new Error('stop after stateful arm'))
      },
    }

    await expect(
      runAgentMemoryLearningExperiment({ ...base, signal: abortController.signal }),
    ).rejects.toThrow()

    const resumed = await runAgentMemoryLearningExperiment({
      ...base,
      signal: new AbortController().signal,
    })

    expect(resumed.stateful.campaign.cells.every((cell) => cell.cached)).toBe(true)
    expect(resumed.stateless.campaign.cells.every((cell) => !cell.error)).toBe(true)
    expect(resumed.comparison.cells).toHaveLength(2)
    expect(executeCalls).toBe(9)
    expect(costLedger.summary()).toMatchObject({
      totalCalls: 5,
      totalCostUsd: 0.05,
      accountingComplete: true,
      unresolvedCalls: 0,
    })
    expect(resumed.cost).toEqual({
      experimentUsd: 0.05,
      ledgerUsd: 0.05,
      ceilingUsd: 1,
      accountingComplete: true,
    })

    const evidencePath = resumed.stateful.campaign.cells[0]!.artifact.probes[0]!.evidencePath
    storage.write(evidencePath, '{}\n')
    await expect(
      runAgentMemoryLearningExperiment({
        ...base,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow('probe evidence hash does not match')
  })

  it('checks cached stateful evidence before starting the stateless arm', async () => {
    const storage = inMemoryCampaignStorage()
    const runDir = '/runs/corrupt-stateful-memory-learning'
    let executeCalls = 0
    const base = {
      experimentId: 'corrupt-stateful-memory-learning',
      experimentRunId: runDir,
      sequences: continualSequences(),
      candidates: [memoryCandidate('memory:corrupt-stateful')],
      storage,
      controllerMode: 'process-local' as const,
      seed: 41,
      reps: 1,
      executeStepRef: immutableRef('test:corrupt-stateful-executor'),
      async executeStep() {
        executeCalls += 1
      },
    }
    const stateful = await runAgentMemoryExperiment({
      ...base,
      memoryMode: 'stateful',
      runDir: `${runDir}/stateful`,
    })
    expect(executeCalls).toBe(4)
    const evidencePath = stateful.campaign.cells[0]!.artifact.probes[0]!.evidencePath
    storage.write(evidencePath, '{}\n')

    await expect(
      runAgentMemoryLearningExperiment({
        ...base,
        runDir,
      }),
    ).rejects.toThrow('probe evidence hash does not match')
    expect(executeCalls).toBe(4)
  })

  it('recomputes cached probe scores from their saved retrieval evidence', async () => {
    const storage = inMemoryCampaignStorage()
    const runDir = '/runs/tampered-memory-learning-score'
    const base = {
      experimentId: 'tampered-memory-learning-score',
      experimentRunId: runDir,
      sequences: [twoStepControlSequence()],
      candidates: [memoryCandidate('memory:tampered-score')],
      runDir,
      storage,
      controllerMode: 'process-local' as const,
    }
    const first = await runAgentMemoryLearningExperiment(base)
    const cell = first.stateful.campaign.cells[0]!
    const cachePath = `${first.stateful.campaign.runDir}/${cell.cellId.replace(
      /[^a-zA-Z0-9_-]/g,
      '_',
    )}/cached-result.json`
    const cached = JSON.parse(storage.read(cachePath)!)
    cached.artifact.probes[1].score = 0
    cached.artifact.score =
      cached.artifact.probes.reduce(
        (sum: number, probe: { score: number }) => sum + probe.score,
        0,
      ) / cached.artifact.probes.length
    cached.artifact.passed = false
    storage.write(cachePath, JSON.stringify(cached))

    await expect(runAgentMemoryLearningExperiment(base)).rejects.toThrow(
      'probe score does not match saved evidence',
    )
  })
})
