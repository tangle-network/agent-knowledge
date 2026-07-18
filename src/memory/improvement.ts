import { join } from 'node:path'
import { canonicalJson } from '@tangle-network/agent-eval'
import {
  type CampaignStorage,
  type CostLedgerHandle,
  campaignLineageStore,
  createRunCostLedger,
  fsCampaignStorage,
  type Governor,
  type GovernorContext,
  type GovernorOp,
  type HeldoutSignificance,
  type HeldoutSignificanceOptions,
  heldoutSignificance,
  type Lineage,
  type LineageStore,
  type MutableSurface,
  memLineageStore,
  type PairedHoldout,
  resolveRunDir,
  runLineageLoop,
  type Scenario,
  type SurfaceProposer,
  surfaceHash,
} from '@tangle-network/agent-eval/campaign'
import {
  appendDurableJournalEvent,
  assertNoInterruptedPaidCalls,
  reconcileInterruptedRunPaidCalls,
} from './attempt-log'
import type {
  AgentMemoryExperimentCandidate,
  AgentMemorySequence,
  AgentMemorySequenceArtifact,
  AgentMemorySequenceProbe,
  RunAgentMemoryExperimentOptions,
  RunAgentMemoryExperimentResult,
} from './experiment'
import { runAgentMemoryExperiment } from './experiment'
import { runBoundedMemoryLifecycle } from './lifecycle'
import {
  type AgentMemoryAcquireRunLease,
  type AgentMemoryControllerMode,
  type AgentMemoryRunLease,
  acquireAgentMemoryRunLease,
  type OwnedAgentMemoryRunLease,
} from './run-control'

export interface AgentMemoryImprovementSeed<TConfig> {
  config: TConfig
  track: string
  vision?: string
  proposer: string
}

export interface AgentMemoryDimensionComparison {
  dimension: string
  n: number
  expectedN: number
  measured: boolean
  meanDelta: number
  low: number
  high: number
  tolerance: number
  regressed: boolean
}

export interface AgentMemoryPromotionDecision {
  status: 'promote' | 'hold' | 'no-change'
  reasons: readonly string[]
  baselineScore: number
  winnerScore: number
  lift: number
  significance?: HeldoutSignificance
  criticalDimensions: readonly AgentMemoryDimensionComparison[]
}

export interface AgentMemoryActivation {
  id: string
  status:
    | 'not-eligible'
    | 'not-configured'
    | 'pending'
    | 'activated'
    | 'recovered'
    | 'already-activated'
  journalPath: string
}

export interface AgentMemoryActivationDriver<TConfig> {
  /** Change whenever activation behavior or the external target changes. */
  ref: string
  /** Return the exact currently active configuration. */
  readCurrent(): Promise<TConfig>
  /** Atomically replace expectedConfig with config, or fail on a concurrent change. */
  compareAndSet(input: {
    activationId: string
    expectedConfig: TConfig
    expectedSurfaceHash: string
    config: TConfig
    surfaceHash: string
    decision: AgentMemoryPromotionDecision
    lineage: Lineage
    holdout: RunAgentMemoryExperimentResult
  }): Promise<void>
}

interface AgentMemoryActivationEvent {
  schema: 1
  status: 'prepared' | 'activated'
  activationId: string
  experimentId: string
  activationRef: string
  baselineSurfaceHash: string
  winnerSurfaceHash: string
  holdoutManifestHash: string
  recordedAt: string
  outcome?: 'applied' | 'recovered' | 'already-current'
}

interface AgentMemoryActivationJournalState {
  prepared: boolean
  activated?: AgentMemoryActivationEvent
}

export type AgentMemoryImprovementRunLease = AgentMemoryRunLease

export interface AgentMemoryGovernor {
  decide(
    context: GovernorContext & {
      costLedger: CostLedgerHandle
      costPhase: string
    },
  ): GovernorOp | Promise<GovernorOp>
}

export interface RunAgentMemoryImprovementOptions<TConfig> {
  experimentId: string
  trainSequences: readonly AgentMemorySequence[]
  holdoutSequences: readonly AgentMemorySequence[]
  /** First entry is the current baseline; remaining entries seed independent search tracks. */
  seeds: readonly AgentMemoryImprovementSeed<TConfig>[]
  createCandidate(input: {
    config: TConfig
    candidateId: string
    surfaceHash: string
  }):
    | Omit<AgentMemoryExperimentCandidate, 'id'>
    | Promise<Omit<AgentMemoryExperimentCandidate, 'id'>>
  proposer: SurfaceProposer
  /** Optional proposer implementations keyed by seed and branch proposer labels. */
  proposers?: Readonly<Record<string, SurfaceProposer>>
  /** Stable version or commit for the candidate factory, proposer, and governor. */
  improvementRef: string
  governor?: AgentMemoryGovernor
  budget: { maxSteps: number }
  populationSize?: number
  candidateConcurrency?: number
  sequenceConcurrency?: number
  runDir: string
  repo?: string
  storage?: CampaignStorage
  lineageStore?: LineageStore
  /** Required with custom storage when all controllers are confined to one process. */
  controllerMode?: AgentMemoryControllerMode
  /** Required for distributed controllers using custom storage. Worker concurrency is independent. */
  acquireRunLease?: AgentMemoryAcquireRunLease
  seed?: number
  reps?: number
  resumable?: boolean
  dispatchTimeoutMs?: number
  cleanupTimeoutMs?: number
  maxRecoveryAttempts?: number
  maxTotalCostUsd?: number
  executeStep?: RunAgentMemoryExperimentOptions['executeStep']
  executeStepRef?: string
  onBranchSnapshot?: RunAgentMemoryExperimentOptions['onBranchSnapshot']
  cleanupBranches?: boolean
  serializeConfig?: (config: TConfig) => string
  parseConfig?: (surface: string) => TConfig
  significance?: HeldoutSignificanceOptions
  criticalDimensions?: readonly string[]
  criticalDimensionTolerance?: number
  minHoldoutScore?: number
  activation?: AgentMemoryActivationDriver<TConfig>
  activationTimeoutMs?: number
  now?: () => Date
}

export interface RunAgentMemoryImprovementResult<TConfig> {
  lineage: Lineage
  baselineConfig: TConfig
  winnerConfig: TConfig
  baselineSurface: string
  winnerSurface: string
  baselineSurfaceHash: string
  winnerSurfaceHash: string
  decision: AgentMemoryPromotionDecision
  activation: AgentMemoryActivation
  holdout?: RunAgentMemoryExperimentResult
  totalCostUsd: number
  resultJsonPath: string
}

interface MemoryConfigScenario extends Scenario {
  kind: 'agent-memory-config-search'
  sequenceId: string
}

const DEFAULT_CRITICAL_DIMENSIONS = [
  'memory_stale_safe',
  'memory_actor_recall',
  'memory_event_recall',
] as const

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

function withCostContext(
  proposer: SurfaceProposer,
  costLedger: CostLedgerHandle,
  lease: OwnedRunLease,
  label: string,
): SurfaceProposer {
  return {
    kind: proposer.kind,
    async propose(context) {
      await lease.assertOwned()
      const proposal = await proposer.propose({
        ...context,
        costLedger,
        costPhase: `memory.proposal.${context.track?.id ?? label}`,
      })
      await lease.assertOwned()
      return proposal
    },
    ...(proposer.decide ? { decide: (input) => proposer.decide!(input) } : {}),
  }
}

function withGovernorCostContext(
  governor: AgentMemoryGovernor,
  costLedger: CostLedgerHandle,
  lease: OwnedRunLease,
): Governor {
  return {
    async decide(context) {
      await lease.assertOwned()
      const decision = await governor.decide({
        ...context,
        costLedger,
        costPhase: 'memory.governor',
      })
      await lease.assertOwned()
      return decision
    },
  }
}

async function buildCandidate<TConfig>(
  options: RunAgentMemoryImprovementOptions<TConfig>,
  config: TConfig,
  hash: string,
  role: string,
): Promise<AgentMemoryExperimentCandidate> {
  const built = await options.createCandidate({
    config,
    candidateId: `${role}-${hash}`,
    surfaceHash: hash,
  })
  return {
    ...built,
    id: `${role}-${hash}`,
    ref: built.ref,
  }
}

function experimentOptions<TConfig>(
  options: RunAgentMemoryImprovementOptions<TConfig>,
  costLedger: ReturnType<typeof createRunCostLedger>,
  storage: CampaignStorage,
  lease: OwnedRunLease,
): Pick<
  RunAgentMemoryExperimentOptions,
  | 'storage'
  | 'seed'
  | 'reps'
  | 'resumable'
  | 'maxConcurrency'
  | 'dispatchTimeoutMs'
  | 'cleanupTimeoutMs'
  | 'maxRecoveryAttempts'
  | 'executeStep'
  | 'executeStepRef'
  | 'onBranchSnapshot'
  | 'cleanupBranches'
  | 'costLedger'
  | 'acquireRunLease'
  | 'now'
> {
  return {
    storage,
    seed: options.seed,
    reps: options.reps,
    resumable: options.resumable,
    maxConcurrency: options.sequenceConcurrency,
    dispatchTimeoutMs: options.dispatchTimeoutMs,
    cleanupTimeoutMs: options.cleanupTimeoutMs,
    maxRecoveryAttempts: options.maxRecoveryAttempts,
    executeStep: options.executeStep,
    executeStepRef: options.executeStepRef,
    onBranchSnapshot: options.onBranchSnapshot,
    cleanupBranches: options.cleanupBranches ?? true,
    costLedger,
    acquireRunLease: async () => ({
      assertOwned: () => lease.assertOwned(),
      release() {},
    }),
    now: options.now,
  }
}

type OwnedRunLease = OwnedAgentMemoryRunLease

function assertMemoryImprovementIdentity<TConfig>(
  options: RunAgentMemoryImprovementOptions<TConfig>,
  storage: CampaignStorage,
  runDir: string,
  serialize: (config: TConfig) => string,
): void {
  const path = join(runDir, 'memory-improvement-manifest.json')
  const identity = {
    schema: 5,
    experimentId: options.experimentId,
    improvementRef: options.improvementRef,
    activationRef: options.activation?.ref ?? null,
    proposerKind: options.proposer.kind,
    proposerKinds: Object.fromEntries(
      Object.entries(options.proposers ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, proposer]) => [name, proposer.kind]),
    ),
    populationSize: options.populationSize ?? 4,
    budget: { maxSteps: options.budget.maxSteps },
    executeStepRef: options.executeStepRef ?? null,
    cleanupBranches: options.cleanupBranches ?? true,
    promotionPolicy: normalizedPromotionPolicy(options),
    seed: options.seed ?? null,
    reps: options.reps ?? 1,
    seeds: options.seeds.map((entry) => ({
      config: serialize(entry.config),
      track: entry.track,
      vision: entry.vision ?? null,
      proposer: entry.proposer,
    })),
    trainSequences: options.trainSequences,
    holdoutSequences: options.holdoutSequences,
  }
  const identityHash = surfaceHash(canonicalJson(identity))
  const stored = storage.read(path)
  if (stored === undefined) {
    if (storage.exists(path)) throw new Error(`cannot read memory improvement manifest '${path}'`)
    if (
      storage.exists(join(runDir, 'lineage.jsonl')) ||
      storage.exists(join(runDir, 'memory-improvement-result.json'))
    ) {
      throw new Error(`memory improvement run '${runDir}' has state without an identity manifest`)
    }
    storage.write(path, `${JSON.stringify({ identityHash, identity }, null, 2)}\n`)
    return
  }
  let manifest: unknown
  try {
    manifest = JSON.parse(stored)
  } catch (error) {
    throw new Error(`invalid memory improvement manifest '${path}'`, { cause: error })
  }
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    (manifest as Record<string, unknown>).identityHash !== identityHash ||
    canonicalJson((manifest as Record<string, unknown>).identity) !== canonicalJson(identity)
  ) {
    throw new Error(
      `memory improvement run '${runDir}' does not match its persisted inputs or implementationRef`,
    )
  }
}

function appendMemoryActivationEvent(
  storage: CampaignStorage,
  path: string,
  event: AgentMemoryActivationEvent,
): void {
  appendDurableJournalEvent({
    storage,
    path,
    event,
    label: 'memory activation journal',
  })
}

function readMemoryActivationJournal(
  storage: CampaignStorage,
  path: string,
  expected: Omit<AgentMemoryActivationEvent, 'status' | 'recordedAt' | 'outcome'>,
): AgentMemoryActivationJournalState {
  const stored = storage.read(path)
  if (stored === undefined) {
    if (storage.exists(path)) throw new Error(`cannot read memory activation journal '${path}'`)
    return { prepared: false }
  }
  let prepared = false
  let activated: AgentMemoryActivationEvent | undefined
  for (const [index, line] of stored.split('\n').entries()) {
    if (!line) continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch (error) {
      throw new Error(`invalid memory activation journal '${path}' line ${index + 1}`, {
        cause: error,
      })
    }
    const event = parseMemoryActivationEvent(raw, path, index + 1, expected)
    if (event.status === 'prepared') {
      if (prepared || activated) {
        throw new Error(`memory activation journal '${path}' repeats its prepared event`)
      }
      prepared = true
      continue
    }
    if (!prepared || activated) {
      throw new Error(`memory activation journal '${path}' has an out-of-order activated event`)
    }
    activated = event
  }
  return { prepared, ...(activated ? { activated } : {}) }
}

function parseMemoryActivationEvent(
  value: unknown,
  path: string,
  line: number,
  expected: Omit<AgentMemoryActivationEvent, 'status' | 'recordedAt' | 'outcome'>,
): AgentMemoryActivationEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid memory activation journal '${path}' line ${line}`)
  }
  const event = value as Record<string, unknown>
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (event[key] !== expectedValue) {
      throw new Error(
        `memory activation journal '${path}' line ${line} does not match the measured winner`,
      )
    }
  }
  if (event.status !== 'prepared' && event.status !== 'activated') {
    throw new Error(`invalid memory activation journal '${path}' line ${line} status`)
  }
  if (typeof event.recordedAt !== 'string' || !Number.isFinite(Date.parse(event.recordedAt))) {
    throw new Error(`invalid memory activation journal '${path}' line ${line} recordedAt`)
  }
  if (
    event.status === 'activated' &&
    event.outcome !== 'applied' &&
    event.outcome !== 'recovered' &&
    event.outcome !== 'already-current'
  ) {
    throw new Error(`invalid memory activation journal '${path}' line ${line} outcome`)
  }
  if (event.status === 'prepared' && event.outcome !== undefined) {
    throw new Error(`invalid memory activation journal '${path}' line ${line} prepared outcome`)
  }
  return value as AgentMemoryActivationEvent
}

function writeMemoryImprovementResult<TConfig>(
  storage: CampaignStorage,
  experimentId: string,
  result: RunAgentMemoryImprovementResult<TConfig>,
): void {
  storage.write(
    result.resultJsonPath,
    `${JSON.stringify(
      {
        experimentId,
        baselineSurfaceHash: result.baselineSurfaceHash,
        winnerSurfaceHash: result.winnerSurfaceHash,
        baselineSurface: result.baselineSurface,
        winnerSurface: result.winnerSurface,
        decision: result.decision,
        activation: result.activation,
        totalCostUsd: result.totalCostUsd,
        lineage: result.lineage.toGraph(),
      },
      null,
      2,
    )}\n`,
  )
}

function decidePromotion<TConfig>(input: {
  options: RunAgentMemoryImprovementOptions<TConfig>
  result: RunAgentMemoryExperimentResult
  baselineId: string
  winnerId: string
}): AgentMemoryPromotionDecision {
  const { options, result, baselineId, winnerId } = input
  const baselineRow = result.rows.find((row) => row.candidateId === baselineId)
  const winnerRow = result.rows.find((row) => row.candidateId === winnerId)
  if (!baselineRow || !winnerRow) throw new Error('holdout result is missing a comparison arm')
  const paired = pairedArtifacts(result, baselineId, winnerId, (artifact) => artifact.score)
  const significance = heldoutSignificance(paired, options.significance)
  const tolerance = options.criticalDimensionTolerance ?? 0.05
  const criticalDimensions = (options.criticalDimensions ?? DEFAULT_CRITICAL_DIMENSIONS).map(
    (dimension) => {
      const expectedN =
        applicableSequenceCount(options.holdoutSequences, dimension) * (options.reps ?? 1)
      const dimensionPairs = pairedArtifacts(result, baselineId, winnerId, (artifact) =>
        (artifact.dimensionSampleCounts?.[dimension] ?? 0) > 0
          ? artifact.dimensions[dimension]
          : undefined,
      )
      const comparison = heldoutSignificance(dimensionPairs, {
        ...options.significance,
        deltaThreshold: 0,
      })
      return {
        dimension,
        n: comparison.n,
        expectedN,
        measured: expectedN > 0 && comparison.n === expectedN,
        meanDelta: comparison.bootstrap.mean,
        low: comparison.bootstrap.low,
        high: comparison.bootstrap.high,
        tolerance,
        regressed:
          expectedN > 0 && comparison.n === expectedN && comparison.bootstrap.low < -tolerance,
      }
    },
  )
  const reasons: string[] = []
  if (baselineRow.cellsFailed > 0 || winnerRow.cellsFailed > 0) {
    reasons.push('at least one holdout cell failed')
  }
  if (!significance.significant) {
    reasons.push(
      significance.fewRuns
        ? `only ${significance.n} paired holdout cells; more are required`
        : 'holdout lift is not confidently above the promotion threshold',
    )
  }
  if (winnerRow.scoreMean < (options.minHoldoutScore ?? 0)) {
    reasons.push(`winner holdout score ${winnerRow.scoreMean} is below the required minimum`)
  }
  for (const dimension of criticalDimensions) {
    if (!dimension.measured) {
      reasons.push(
        dimension.expectedN === 0
          ? `critical dimension ${dimension.dimension} has no applicable holdout histories`
          : `critical dimension ${dimension.dimension} was measured on ${dimension.n}/${dimension.expectedN} applicable paired holdout cells`,
      )
    } else if (dimension.regressed) {
      reasons.push(`${dimension.dimension} may regress beyond ${tolerance}`)
    }
  }
  return {
    status: reasons.length === 0 ? 'promote' : 'hold',
    reasons,
    baselineScore: baselineRow.scoreMean,
    winnerScore: winnerRow.scoreMean,
    lift: winnerRow.scoreMean - baselineRow.scoreMean,
    significance,
    criticalDimensions,
  }
}

function applicableSequenceCount(
  sequences: readonly AgentMemorySequence[],
  dimension: string,
): number {
  return sequences.filter((sequence) =>
    sequence.steps.some((step) =>
      (step.probes ?? []).some((probe) => probeAppliesToDimension(probe, dimension)),
    ),
  ).length
}

function probeAppliesToDimension(probe: AgentMemorySequenceProbe, dimension: string): boolean {
  switch (dimension) {
    case 'memory_fact_recall':
    case 'memory_required_fact_count':
    case 'memory_matched_fact_count':
      return Boolean(
        (probe.requiredFacts && probe.requiredFacts.length > 0) || probe.referenceAnswer,
      )
    case 'memory_event_recall':
      return Boolean(probe.expectedEventIds && probe.expectedEventIds.length > 0)
    case 'memory_actor_recall':
      return Boolean(probe.expectedActorIds && probe.expectedActorIds.length > 0)
    case 'memory_stale_safe':
    case 'memory_stale_rate':
    case 'memory_forbidden_fact_count':
    case 'memory_matched_forbidden_fact_count':
      return Boolean(probe.forbiddenFacts && probe.forbiddenFacts.length > 0)
    default:
      return true
  }
}

function normalizedPromotionPolicy<TConfig>(
  options: RunAgentMemoryImprovementOptions<TConfig>,
): Record<string, unknown> {
  return {
    significance: {
      deltaThreshold: options.significance?.deltaThreshold ?? 0,
      minProductiveRuns: options.significance?.minProductiveRuns ?? 3,
      confidence: options.significance?.confidence ?? 0.95,
      resamples: options.significance?.resamples ?? 2000,
      seed: options.significance?.seed ?? 1337,
      statistic: options.significance?.statistic ?? 'mean',
    },
    criticalDimensions: [...(options.criticalDimensions ?? DEFAULT_CRITICAL_DIMENSIONS)],
    criticalDimensionTolerance: options.criticalDimensionTolerance ?? 0.05,
    minHoldoutScore: options.minHoldoutScore ?? 0,
  }
}

function pairedArtifacts(
  result: RunAgentMemoryExperimentResult,
  baselineId: string,
  winnerId: string,
  select: (artifact: AgentMemorySequenceArtifact) => number | undefined,
): PairedHoldout {
  const baseline = artifactValues(result, baselineId, select)
  const winner = artifactValues(result, winnerId, select)
  const keys = [...baseline.keys()].filter((key) => winner.has(key)).sort()
  return {
    before: keys.map((key) => baseline.get(key)!),
    after: keys.map((key) => winner.get(key)!),
    cellIds: keys,
  }
}

function artifactValues(
  result: RunAgentMemoryExperimentResult,
  candidateId: string,
  select: (artifact: AgentMemorySequenceArtifact) => number | undefined,
): Map<string, number> {
  const values = new Map<string, number>()
  for (const cell of result.campaign.cells) {
    if (cell.error || cell.artifact.candidateId !== candidateId) continue
    const value = select(cell.artifact)
    if (value === undefined || !Number.isFinite(value)) continue
    values.set(`${cell.artifact.sequenceId}:${cell.rep}`, value)
  }
  return values
}

function sequenceScores(
  result: RunAgentMemoryExperimentResult,
  sequences: readonly AgentMemorySequence[],
  candidateId: string,
): number[] {
  const bySequence = new Map<string, number[]>()
  for (const cell of result.campaign.cells) {
    if (cell.error || cell.artifact.candidateId !== candidateId) continue
    const bucket = bySequence.get(cell.artifact.sequenceId) ?? []
    bucket.push(cell.artifact.score)
    bySequence.set(cell.artifact.sequenceId, bucket)
  }
  return sequences.map((sequence) => mean(bySequence.get(sequence.id) ?? []))
}

function requireStringSurface(surface: MutableSurface): string {
  if (typeof surface !== 'string' || surface.trim().length === 0) {
    throw new Error('memory config proposer must return a JSON string surface')
  }
  return surface
}

function serializeMemoryConfig<TConfig>(
  serialize: (config: TConfig) => string,
  config: TConfig,
): string {
  let surface: unknown
  try {
    surface = serialize(config)
  } catch (error) {
    throw new Error('memory config serializer failed', { cause: error })
  }
  if (typeof surface !== 'string' || surface.trim().length === 0) {
    throw new Error('memory config serializer must return a non-empty string')
  }
  return surface
}

function parseMemoryConfig<TConfig>(parse: (surface: string) => TConfig, surface: string): TConfig {
  try {
    const config = parse(surface)
    if (config === undefined) throw new Error('parser returned undefined')
    return config
  } catch (error) {
    throw new Error('memory config surface could not be parsed', { cause: error })
  }
}

function assertMemoryConfigRoundTrip<TConfig>(
  config: TConfig,
  serialize: (config: TConfig) => string,
  parse: (surface: string) => TConfig,
): void {
  const first = serialize(config)
  const second = serialize(parse(first))
  if (first !== second) {
    throw new Error('memory config serializer and parser must round-trip seed configs exactly')
  }
}

function memorySequenceFingerprint(sequence: AgentMemorySequence): string {
  const { id: _id, split: _split, tags: _tags, ...content } = sequence
  return surfaceHash(canonicalJson(content))
}

function assertMemoryImprovementOptions<TConfig>(
  options: RunAgentMemoryImprovementOptions<TConfig>,
): void {
  for (const [name, value] of [
    ['experimentId', options.experimentId],
    ['runDir', options.runDir],
  ] as const) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`memory improvement ${name} must be a non-empty string`)
    }
  }
  if (typeof options.proposer?.kind !== 'string' || !options.proposer.kind.trim()) {
    throw new Error('memory improvement proposer.kind must be a non-empty string')
  }
  if (typeof options.proposer?.propose !== 'function') {
    throw new Error('memory improvement proposer.propose must be a function')
  }
  if (options.governor !== undefined && typeof options.governor.decide !== 'function') {
    throw new Error('memory improvement governor.decide must be a function')
  }
  if (options.activation !== undefined) {
    if (typeof options.activation.ref !== 'string' || !options.activation.ref.trim()) {
      throw new Error('memory improvement activation.ref must be a non-empty string')
    }
    if (typeof options.activation.readCurrent !== 'function') {
      throw new Error('memory improvement activation.readCurrent must be a function')
    }
    if (typeof options.activation.compareAndSet !== 'function') {
      throw new Error('memory improvement activation.compareAndSet must be a function')
    }
  }
  for (const [name, proposer] of Object.entries(options.proposers ?? {})) {
    if (!name.trim()) throw new Error('memory improvement proposer labels must be non-empty')
    if (
      !proposer ||
      typeof proposer.kind !== 'string' ||
      !proposer.kind.trim() ||
      typeof proposer.propose !== 'function'
    ) {
      throw new Error(`memory improvement proposer '${name}' is invalid`)
    }
  }
  if (options.serializeConfig !== undefined && typeof options.serializeConfig !== 'function') {
    throw new Error('memory improvement serializeConfig must be a function')
  }
  if (options.parseConfig !== undefined && typeof options.parseConfig !== 'function') {
    throw new Error('memory improvement parseConfig must be a function')
  }
  if (!Number.isSafeInteger(options.budget.maxSteps) || options.budget.maxSteps < 0) {
    throw new Error('memory improvement budget.maxSteps must be a non-negative safe integer')
  }
  for (const [name, value] of [
    ['populationSize', options.populationSize],
    ['candidateConcurrency', options.candidateConcurrency],
    ['sequenceConcurrency', options.sequenceConcurrency],
    ['reps', options.reps],
    ['maxRecoveryAttempts', options.maxRecoveryAttempts],
  ] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new Error(`memory improvement ${name} must be a positive safe integer`)
    }
  }
  if (
    options.maxTotalCostUsd !== undefined &&
    (!Number.isFinite(options.maxTotalCostUsd) || options.maxTotalCostUsd < 0)
  ) {
    throw new Error('memory improvement maxTotalCostUsd must be a non-negative finite number')
  }
  if (
    options.activationTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.activationTimeoutMs) || options.activationTimeoutMs <= 0)
  ) {
    throw new Error('memory improvement activationTimeoutMs must be a positive safe integer')
  }
  const tolerance = options.criticalDimensionTolerance
  if (tolerance !== undefined && (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1)) {
    throw new Error('memory improvement criticalDimensionTolerance must be between 0 and 1')
  }
  const minimum = options.minHoldoutScore
  if (minimum !== undefined && (!Number.isFinite(minimum) || minimum < 0 || minimum > 1)) {
    throw new Error('memory improvement minHoldoutScore must be between 0 and 1')
  }
  for (const seed of options.seeds) {
    if (
      typeof seed.track !== 'string' ||
      !seed.track.trim() ||
      typeof seed.proposer !== 'string' ||
      !seed.proposer.trim()
    ) {
      throw new Error('memory improvement seeds require non-empty track and proposer values')
    }
    if (seed.vision !== undefined && (typeof seed.vision !== 'string' || !seed.vision.trim())) {
      throw new Error('memory improvement seed vision must be a non-empty string when provided')
    }
  }
  const dimensions = options.criticalDimensions ?? DEFAULT_CRITICAL_DIMENSIONS
  if (dimensions.some((dimension) => typeof dimension !== 'string' || !dimension.trim())) {
    throw new Error('memory improvement criticalDimensions must contain non-empty names')
  }
  if (new Set(dimensions).size !== dimensions.length) {
    throw new Error('memory improvement criticalDimensions must be unique')
  }
  assertDistinctSequenceContent(options.trainSequences, 'train')
  assertDistinctSequenceContent(options.holdoutSequences, 'holdout')
}

function assertDistinctSequenceContent(
  sequences: readonly AgentMemorySequence[],
  split: string,
): void {
  const idsByFingerprint = new Map<string, string>()
  for (const sequence of sequences) {
    const fingerprint = memorySequenceFingerprint(sequence)
    const prior = idsByFingerprint.get(fingerprint)
    if (prior) {
      throw new Error(
        `memory improvement ${split} histories duplicate content: ${prior}/${sequence.id}`,
      )
    }
    idsByFingerprint.set(fingerprint, sequence.id)
  }
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}
