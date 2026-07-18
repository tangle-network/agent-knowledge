import { join } from 'node:path'
import { canonicalJson } from '@tangle-network/agent-eval'
import {
  type CampaignStorage,
  campaignLineageStore,
  createRunCostLedger,
  fsCampaignStorage,
  type MutableSurface,
  memLineageStore,
  resolveRunDir,
  runLineageLoop,
  surfaceHash,
} from '@tangle-network/agent-eval/campaign'
import { assertNoInterruptedPaidCalls, reconcileInterruptedRunPaidCalls } from '../attempt-log'
import { type RunAgentMemoryExperimentResult, runAgentMemoryExperiment } from '../experiment'
import { runBoundedMemoryLifecycle } from '../lifecycle'
import { acquireAgentMemoryRunLease } from '../run-control'
import { appendMemoryActivationEvent, readMemoryActivationJournal } from './activation'
import {
  buildCandidate,
  experimentOptions,
  withCostContext,
  withGovernorCostContext,
} from './candidate'
import {
  assertMemoryConfigRoundTrip,
  assertMemoryImprovementIdentity,
  memorySequenceFingerprint,
  parseMemoryConfig,
  requireStringSurface,
  serializeMemoryConfig,
} from './identity'
import { writeMemoryImprovementResult } from './output'
import { decidePromotion, normalizedPromotionPolicy, sequenceScores } from './promotion'
import type {
  AgentMemoryActivation,
  AgentMemoryActivationEvent,
  AgentMemoryPromotionDecision,
  MemoryConfigScenario,
  OwnedRunLease,
  RunAgentMemoryImprovementOptions,
  RunAgentMemoryImprovementResult,
} from './types'
import { assertMemoryImprovementOptions } from './validation'

/** Searches branchable memory configurations and activates only a fresh holdout win. */
export async function runAgentMemoryImprovement<TConfig>(
  options: RunAgentMemoryImprovementOptions<TConfig>,
): Promise<RunAgentMemoryImprovementResult<TConfig>> {
  if ('onPromote' in options) {
    throw new Error(
      'memory improvement onPromote was removed; use activation.readCurrent and activation.compareAndSet',
    )
  }
  if (options.seeds.length === 0) throw new Error('memory improvement requires seed configs')
  if (options.trainSequences.length === 0) {
    throw new Error('memory improvement requires training sequences')
  }
  if (options.holdoutSequences.length === 0) {
    throw new Error('memory improvement requires holdout sequences')
  }
  const trainIds = new Set(options.trainSequences.map((sequence) => sequence.id))
  const overlap = options.holdoutSequences
    .map((sequence) => sequence.id)
    .filter((id) => trainIds.has(id))
  if (overlap.length > 0) {
    throw new Error(`memory improvement train/holdout overlap: ${overlap.join(', ')}`)
  }
  const trainFingerprints = new Map(
    options.trainSequences.map((sequence) => [memorySequenceFingerprint(sequence), sequence.id]),
  )
  const duplicateHistories = options.holdoutSequences.flatMap((sequence) => {
    const trainId = trainFingerprints.get(memorySequenceFingerprint(sequence))
    return trainId ? [`${trainId}/${sequence.id}`] : []
  })
  if (duplicateHistories.length > 0) {
    throw new Error(
      `memory improvement train/holdout histories duplicate content: ${duplicateHistories.join(', ')}`,
    )
  }
  if (typeof options.improvementRef !== 'string' || !options.improvementRef.trim()) {
    throw new Error('memory improvement improvementRef must be a non-empty string')
  }
  assertMemoryImprovementOptions(options)
  const storage = options.storage ?? fsCampaignStorage()
  const runDir = resolveRunDir(options.runDir, options.repo)
  storage.ensureDir(runDir)
  const lease = await acquireAgentMemoryRunLease({
    experimentId: options.experimentId,
    runDir,
    storage,
    customStorage: options.storage !== undefined,
    lockFileName: 'memory-improvement.lock',
    label: 'memory improvement',
    controllerMode: options.controllerMode,
    acquireRunLease: options.acquireRunLease,
  })
  let result: RunAgentMemoryImprovementResult<TConfig> | undefined
  let primaryError: unknown
  try {
    result = await runAgentMemoryImprovementOwned(options, storage, runDir, lease)
  } catch (error) {
    primaryError = error
  }
  let releaseError: unknown
  try {
    await lease.release()
  } catch (error) {
    releaseError = error
  }
  if (primaryError && releaseError) {
    throw new AggregateError(
      [primaryError, releaseError],
      'memory improvement failed and its controller lease could not be released',
    )
  }
  if (primaryError) throw primaryError
  if (releaseError) throw releaseError
  if (!result) throw new Error('memory improvement produced no result')
  return result
}

async function runAgentMemoryImprovementOwned<TConfig>(
  options: RunAgentMemoryImprovementOptions<TConfig>,
  storage: CampaignStorage,
  runDir: string,
  lease: OwnedRunLease,
): Promise<RunAgentMemoryImprovementResult<TConfig>> {
  await lease.assertOwned()
  const serializeRaw = options.serializeConfig ?? ((config: TConfig) => canonicalJson(config))
  const parseRaw = options.parseConfig ?? ((surface: string) => JSON.parse(surface) as TConfig)
  const serialize = (config: TConfig): string => serializeMemoryConfig(serializeRaw, config)
  const parse = (surface: string): TConfig => parseMemoryConfig(parseRaw, surface)
  for (const seed of options.seeds) assertMemoryConfigRoundTrip(seed.config, serialize, parse)
  if (options.activation && !storage.append) {
    throw new Error('memory activation requires CampaignStorage.append')
  }
  if (options.resumable !== false && !options.lineageStore && !storage.append) {
    throw new Error('resumable memory improvement requires CampaignStorage.append')
  }
  assertMemoryImprovementIdentity(options, storage, runDir, serialize)
  const costLedger = createRunCostLedger({
    storage,
    runDir,
    costCeilingUsd: options.maxTotalCostUsd ?? 0,
  })
  reconcileInterruptedRunPaidCalls(costLedger, 'memory improvement run')
  assertNoInterruptedPaidCalls(costLedger, 'memory improvement recovery')
  const trainScenarios: MemoryConfigScenario[] = options.trainSequences.map((sequence) => ({
    id: sequence.id,
    kind: 'agent-memory-config-search',
    sequenceId: sequence.id,
  }))
  const evaluations = new Map<string, Promise<RunAgentMemoryExperimentResult>>()

  const evaluateSurface = async (
    surface: MutableSurface,
  ): Promise<{ score: number; scoreVector: number[] }> => {
    await lease.assertOwned()
    const text = requireStringSurface(surface)
    const config = parse(text)
    const canonicalSurface = serialize(config)
    const hash = surfaceHash(canonicalSurface)
    let pending = evaluations.get(hash)
    if (!pending) {
      pending = (async () => {
        const candidate = await buildCandidate(options, config, hash, `search-${hash}`)
        await lease.assertOwned()
        const experiment = await runAgentMemoryExperiment({
          ...experimentOptions(options, costLedger, storage, lease),
          experimentId: `${options.experimentId}:search:${hash}`,
          sequences: options.trainSequences,
          candidates: [candidate],
          runDir: join(runDir, 'search', hash),
          costPhase: `memory.search.${hash}`,
        })
        await lease.assertOwned()
        return experiment
      })()
      evaluations.set(hash, pending)
      void pending.catch(() => evaluations.delete(hash))
    }
    const result = await pending
    await lease.assertOwned()
    const row = result.rows[0]
    if (!row || row.cellsFailed > 0) {
      throw new Error(`${hash}: memory candidate did not complete every training cell`)
    }
    return {
      score: row.scoreMean,
      scoreVector: sequenceScores(result, options.trainSequences, row.candidateId),
    }
  }

  const lineageStore =
    options.lineageStore ??
    (options.resumable === false
      ? memLineageStore()
      : campaignLineageStore(storage, join(runDir, 'lineage.jsonl')))
  const lineageOptions = {
    seeds: options.seeds.map((seed) => ({
      surface: serialize(seed.config),
      track: seed.track,
      proposer: seed.proposer,
      ...(seed.vision !== undefined ? { vision: seed.vision } : {}),
    })),
    scenarios: trainScenarios,
    proposer: withCostContext(options.proposer, costLedger, lease, 'default'),
    proposers: options.proposers
      ? Object.fromEntries(
          Object.entries(options.proposers).map(([name, proposer]) => [
            name,
            withCostContext(proposer, costLedger, lease, name),
          ]),
        )
      : undefined,
    scoreSurface: evaluateSurface,
    governor: options.governor
      ? withGovernorCostContext(options.governor, costLedger, lease)
      : undefined,
    budget: {
      ...options.budget,
      maxNodes: options.seeds.length + options.budget.maxSteps,
    },
    store: lineageStore,
    populationSize: options.populationSize,
    candidateConcurrency: options.candidateConcurrency,
  }
  const search = await runLineageLoop<MemoryConfigScenario, unknown>(lineageOptions)
  await lease.assertOwned()
  const best = search.best
  if (!best) throw new Error('memory improvement produced no measured config')

  const baselineSurface = serialize(options.seeds[0]!.config)
  const baselineHash = surfaceHash(baselineSurface)
  const winnerConfig = parse(requireStringSurface(best.surface))
  const winnerSurface = serialize(winnerConfig)
  const winnerHash = surfaceHash(winnerSurface)
  const baselineConfig = parse(baselineSurface)

  let holdout: RunAgentMemoryExperimentResult | undefined
  let decision: AgentMemoryPromotionDecision
  if (winnerHash === baselineHash) {
    const baselineMeasurement = await evaluateSurface(baselineSurface)
    decision = {
      status: 'no-change',
      reasons: ['search did not find a config better than the baseline'],
      baselineScore: baselineMeasurement.score,
      winnerScore: baselineMeasurement.score,
      lift: 0,
      criticalDimensions: [],
    }
  } else {
    await lease.assertOwned()
    const [baselineCandidate, winnerCandidate] = await Promise.all([
      buildCandidate(options, baselineConfig, baselineHash, 'baseline'),
      buildCandidate(options, winnerConfig, winnerHash, 'winner'),
    ])
    await lease.assertOwned()
    holdout = await runAgentMemoryExperiment({
      ...experimentOptions(options, costLedger, storage, lease),
      experimentId: `${options.experimentId}:holdout`,
      sequences: options.holdoutSequences,
      candidates: [baselineCandidate, winnerCandidate],
      runDir: join(runDir, 'holdout'),
      costPhase: 'memory.holdout',
    })
    decision = decidePromotion({
      options,
      result: holdout,
      baselineId: baselineCandidate.id,
      winnerId: winnerCandidate.id,
    })
  }

  const resultJsonPath = join(runDir, 'memory-improvement-result.json')
  const activationRef = options.activation?.ref ?? 'not-configured'
  const activationId = `memory-activation-${surfaceHash(
    canonicalJson({
      experimentId: options.experimentId,
      improvementRef: options.improvementRef,
      activationRef,
      baselineSurfaceHash: baselineHash,
      winnerSurfaceHash: winnerHash,
      holdoutManifestHash: holdout?.campaign.manifestHash ?? null,
      promotionPolicy: normalizedPromotionPolicy(options),
    }),
  )}`
  const activationJournalDir = join(runDir, 'activations')
  const activationJournalPath = join(activationJournalDir, `${activationId}.jsonl`)
  const activationEligible = decision.status === 'promote' && holdout !== undefined
  const activationEventIdentity = holdout
    ? {
        schema: 1 as const,
        activationId,
        experimentId: options.experimentId,
        activationRef,
        baselineSurfaceHash: baselineHash,
        winnerSurfaceHash: winnerHash,
        holdoutManifestHash: holdout.campaign.manifestHash,
      }
    : undefined
  const activationJournal =
    activationEligible && activationEventIdentity
      ? readMemoryActivationJournal(storage, activationJournalPath, activationEventIdentity)
      : { prepared: false }
  const activation: AgentMemoryActivation = {
    id: activationId,
    status: !activationEligible
      ? 'not-eligible'
      : activationJournal.activated
        ? 'already-activated'
        : options.activation
          ? 'pending'
          : 'not-configured',
    journalPath: activationJournalPath,
  }
  const result = {
    lineage: search.lineage,
    baselineConfig,
    winnerConfig,
    baselineSurface,
    winnerSurface,
    baselineSurfaceHash: baselineHash,
    winnerSurfaceHash: winnerHash,
    decision,
    activation,
    ...(holdout ? { holdout } : {}),
    totalCostUsd: costLedger.summary().totalCostUsd,
    resultJsonPath,
  } satisfies RunAgentMemoryImprovementResult<TConfig>
  await lease.assertOwned()
  writeMemoryImprovementResult(storage, options.experimentId, result)
  if (
    activationEligible &&
    !activationJournal.activated &&
    activationEventIdentity &&
    holdout &&
    options.activation
  ) {
    const activationDriver = options.activation
    const activationTimeoutMs = options.activationTimeoutMs ?? 60_000
    const hadPreparedEvent = activationJournal.prepared
    if (!hadPreparedEvent) {
      await lease.assertOwned()
      storage.ensureDir(activationJournalDir)
      appendMemoryActivationEvent(storage, activationJournalPath, {
        ...activationEventIdentity,
        status: 'prepared',
        recordedAt: (options.now ?? (() => new Date()))().toISOString(),
      })
    }

    await lease.assertOwned()
    const currentConfig = await runBoundedMemoryLifecycle({
      operation: `${activationDriver.ref}: read current memory configuration`,
      timeoutMs: activationTimeoutMs,
      run: () => activationDriver.readCurrent(),
    })
    await lease.assertOwned()
    const currentHash = surfaceHash(serialize(currentConfig))
    if (currentHash !== baselineHash && currentHash !== winnerHash) {
      throw new Error(
        `memory activation target '${activationDriver.ref}' changed concurrently; expected '${baselineHash}' or '${winnerHash}', found '${currentHash}'`,
      )
    }

    let outcome: NonNullable<AgentMemoryActivationEvent['outcome']>
    if (currentHash === winnerHash) {
      outcome = hadPreparedEvent ? 'recovered' : 'already-current'
      activation.status = 'recovered'
    } else {
      let compareError: unknown
      try {
        await runBoundedMemoryLifecycle({
          operation: `${activationDriver.ref}: activate memory configuration`,
          timeoutMs: activationTimeoutMs,
          run: () =>
            activationDriver.compareAndSet({
              activationId,
              expectedConfig: baselineConfig,
              expectedSurfaceHash: baselineHash,
              config: winnerConfig,
              surfaceHash: winnerHash,
              decision,
              lineage: search.lineage,
              holdout,
            }),
        })
      } catch (error) {
        compareError = error
      }
      await lease.assertOwned()

      let observedConfig: TConfig
      try {
        observedConfig = await runBoundedMemoryLifecycle({
          operation: `${activationDriver.ref}: confirm memory configuration`,
          timeoutMs: activationTimeoutMs,
          run: () => activationDriver.readCurrent(),
        })
      } catch (error) {
        if (compareError) {
          throw new AggregateError(
            [compareError, error],
            `memory activation '${activationId}' failed and its live state could not be confirmed`,
          )
        }
        throw error
      }
      await lease.assertOwned()
      const observedHash = surfaceHash(serialize(observedConfig))
      if (observedHash !== winnerHash) {
        const mismatch = new Error(
          `memory activation '${activationId}' did not install the measured winner; found '${observedHash}'`,
        )
        if (compareError) {
          throw new AggregateError(
            [compareError, mismatch],
            `memory activation '${activationId}' failed without applying the measured winner`,
          )
        }
        throw mismatch
      }
      outcome = compareError ? 'recovered' : 'applied'
      activation.status = compareError ? 'recovered' : 'activated'
    }

    await lease.assertOwned()
    appendMemoryActivationEvent(storage, activationJournalPath, {
      ...activationEventIdentity,
      status: 'activated',
      outcome,
      recordedAt: (options.now ?? (() => new Date()))().toISOString(),
    })
    writeMemoryImprovementResult(storage, options.experimentId, result)
  }
  return result
}
