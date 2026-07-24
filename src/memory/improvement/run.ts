import { join } from 'node:path'
import { canonicalJson } from '@tangle-network/agent-eval'
import {
  type CampaignStorage,
  fsCampaignStorage,
  resolveRunDir,
  surfaceHash,
} from '@tangle-network/agent-eval/campaign'
import type { AgentCandidateJsonValue as JsonValue } from '@tangle-network/agent-interface'
import { runSerializedKnowledgeOptimization } from '../../optimization'
import {
  type AgentMemoryExperimentCandidate,
  type AgentMemorySequenceArtifact,
  agentMemorySequenceJudge,
} from '../experiment'
import { acquireAgentMemoryRunLease } from '../run-control'
import {
  activateMemoryWinner,
  assertActivatedMemoryWinner,
  readMemoryActivationJournal,
} from './activation'
import { buildRegisteredCandidate } from './candidate'
import {
  evaluateMemoryCandidate,
  loadFinalEvaluation,
  memoryArtifactPath,
  memoryConfigCodec,
  memoryConfigScenarios,
} from './evaluation'
import {
  assertMemoryConfigRoundTrip,
  assertMemoryImprovementIdentity,
  memorySequenceFingerprint,
} from './identity'
import { writeMemoryImprovementResult } from './output'
import { decidePromotion, normalizedPromotionPolicy } from './promotion'
import type {
  AgentMemoryActivation,
  MemoryConfigScenario,
  OwnedRunLease,
  RunAgentMemoryImprovementOptions,
  RunAgentMemoryImprovementResult,
} from './types'
import { assertMemoryImprovementOptions } from './validation'

/** Optimizes memory configuration with an external method and activates only a fresh final win. */
export async function runAgentMemoryImprovement<TConfig extends JsonValue>(
  options: RunAgentMemoryImprovementOptions<TConfig>,
): Promise<RunAgentMemoryImprovementResult<TConfig>> {
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

async function runAgentMemoryImprovementOwned<TConfig extends JsonValue>(
  options: RunAgentMemoryImprovementOptions<TConfig>,
  storage: CampaignStorage,
  runDir: string,
  lease: OwnedRunLease,
): Promise<RunAgentMemoryImprovementResult<TConfig>> {
  await lease.assertOwned()
  const codec = memoryConfigCodec(options)
  assertMemoryConfigRoundTrip(options.baselineConfig, codec.serialize, codec.parse)
  if (options.activation && !storage.append) {
    throw new Error('memory activation requires CampaignStorage.append')
  }
  assertMemoryImprovementIdentity(options, storage, runDir, codec.serialize)

  const trainScenarios = memoryConfigScenarios(options.trainSequences)
  const selectionScenarios = memoryConfigScenarios(options.selectionSequences)
  const finalScenarios = memoryConfigScenarios(options.finalSequences)
  const finalScenarioIds = new Set(finalScenarios.map((scenario) => scenario.id))
  const pending = new Map<string, Promise<AgentMemorySequenceArtifact>>()
  const candidates = new Map<string, Promise<AgentMemoryExperimentCandidate>>()
  const candidateFor = (config: TConfig, hash: string) => {
    let candidate = candidates.get(hash)
    if (!candidate) {
      candidate = buildRegisteredCandidate(options, storage, runDir, config, hash)
      candidates.set(hash, candidate)
      void candidate.catch(() => candidates.delete(hash))
    }
    return candidate
  }
  const optimizationRunOptions = {
    ...(options.optimizationRunOptions ?? {}),
    storage,
    ...(options.reps !== undefined ? { reps: options.reps } : {}),
    ...(options.resumable !== undefined ? { resumable: options.resumable } : {}),
    ...(options.sequenceConcurrency !== undefined
      ? { maxConcurrency: options.sequenceConcurrency }
      : {}),
    ...(options.dispatchTimeoutMs !== undefined
      ? { dispatchTimeoutMs: options.dispatchTimeoutMs }
      : {}),
    expectUsage: 'off' as const,
  }
  const optimization = await runSerializedKnowledgeOptimization({
    executionRef: options.implementationRef,
    baseline: options.baselineConfig,
    method: options.method,
    trainScenarios,
    selectionScenarios,
    finalScenarios,
    codec,
    scenarioFingerprint: (scenario) => memorySequenceFingerprint(scenario.sequence),
    dispatchCandidate: async ({ candidate, candidateSurfaceHash, scenario, context }) => {
      const key = memoryArtifactPath(
        runDir,
        candidateSurfaceHash,
        scenario,
        context.rep,
        context.seed,
      )
      let operation = pending.get(key)
      if (!operation) {
        operation = candidateFor(candidate, candidateSurfaceHash).then((builtCandidate) =>
          evaluateMemoryCandidate({
            options,
            storage,
            runDir,
            lease,
            candidate: builtCandidate,
            surfaceHash: candidateSurfaceHash,
            scenario,
            rep: context.rep,
            seed: context.seed,
            final: finalScenarioIds.has(scenario.id),
            cost: context.cost,
            signal: context.signal,
          }),
        )
        pending.set(key, operation)
        void operation.catch(() => pending.delete(key))
      }
      return operation
    },
    judges: [agentMemorySequenceJudge<MemoryConfigScenario>()],
    runDir,
    repo: options.repo,
    storage,
    seed: options.seed,
    reps: options.reps,
    resumable: options.resumable,
    costCeiling: options.maxTotalCostUsd ?? 0,
    maxConcurrency: options.sequenceConcurrency,
    dispatchTimeoutMs: options.dispatchTimeoutMs,
    expectUsage: 'off',
    optimizationRunOptions,
    now: options.now,
  })
  await lease.assertOwned()
  const [baselineCandidate, winnerCandidate] = await Promise.all([
    candidateFor(optimization.baseline.value, optimization.baseline.surfaceHash),
    candidateFor(optimization.winner.value, optimization.winner.surfaceHash),
  ])

  const finalEvaluation = loadFinalEvaluation({
    options,
    storage,
    runDir,
    baselineSurfaceHash: optimization.baseline.surfaceHash,
    baselineCandidateRef: baselineCandidate.ref,
    winnerSurfaceHash: optimization.winner.surfaceHash,
    winnerCandidateRef: winnerCandidate.ref,
  })
  const unchanged = optimization.baseline.surfaceHash === optimization.winner.surfaceHash
  const decision = decidePromotion({ options, optimization, finalEvaluation, unchanged })
  const resultJsonPath = join(runDir, 'memory-improvement-result.json')
  const activationRef = options.activation?.ref ?? 'not-configured'
  const activationId = `memory-activation-${surfaceHash(
    canonicalJson({
      experimentId: options.experimentId,
      implementationRef: options.implementationRef,
      method: optimization.methodName,
      activationRef,
      baselineSurfaceHash: optimization.baseline.surfaceHash,
      winnerSurfaceHash: optimization.winner.surfaceHash,
      finalEvaluationHash: finalEvaluation.manifestHash,
      promotionPolicy: normalizedPromotionPolicy(options),
    }),
  )}`
  const activationJournalDir = join(runDir, 'activations')
  const activationJournalPath = join(activationJournalDir, `${activationId}.jsonl`)
  const activationEligible = decision.status === 'promote'
  const activationEventIdentity = {
    activationId,
    experimentId: options.experimentId,
    activationRef,
    baselineSurfaceHash: optimization.baseline.surfaceHash,
    winnerSurfaceHash: optimization.winner.surfaceHash,
    finalEvaluationHash: finalEvaluation.manifestHash,
  }
  const activationJournal = activationEligible
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
    optimization,
    baselineConfig: optimization.baseline.value,
    winnerConfig: optimization.winner.value,
    baselineSurface: optimization.baseline.surface,
    winnerSurface: optimization.winner.surface,
    baselineSurfaceHash: optimization.baseline.surfaceHash,
    winnerSurfaceHash: optimization.winner.surfaceHash,
    decision,
    finalEvaluation,
    activation,
    totalCostUsd: optimization.comparison.totalCost.totalCostUsd,
    resultJsonPath,
  } satisfies RunAgentMemoryImprovementResult<TConfig>
  await lease.assertOwned()
  if (activationJournal.activated) {
    await assertActivatedMemoryWinner({ options, lease, result })
  }
  writeMemoryImprovementResult(storage, options.experimentId, result)

  if (activationEligible && !activationJournal.activated && options.activation) {
    await activateMemoryWinner({
      options,
      storage,
      lease,
      result,
      activationEventIdentity,
      activationJournalDir,
      activationJournalPath,
      hadPreparedEvent: activationJournal.prepared,
    })
    writeMemoryImprovementResult(storage, options.experimentId, result)
  }
  return result
}
