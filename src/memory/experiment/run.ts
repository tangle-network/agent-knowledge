import { join } from 'node:path'
import { canonicalJson } from '@tangle-network/agent-eval'
import {
  type CampaignResult,
  type CampaignStorage,
  createRunCostLedger,
  fsCampaignStorage,
  resolveRunDir,
  runCampaign,
} from '@tangle-network/agent-eval/campaign'
import { stableId } from '../../ids'
import { DEFAULT_MEMORY_RECOVERY_RETRIES_PER_ATTEMPT } from '../attempt-log'
import { createMemoryExecutionPool, resolveMemoryCleanupTimeoutMs } from '../lifecycle'
import { acquireAgentMemoryRunLease } from '../run-control'
import { agentMemorySequenceJudge, buildAgentMemorySequenceScenarios } from './cases'
import { runSequenceCell } from './cell'
import {
  memoryExperimentCostByCandidate,
  normalizeUsd,
  rankAgentMemoryExperiment,
  renderAgentMemoryExperimentRanking,
} from './metrics'
import { recoverAbandonedMemoryAttempts } from './recovery'
import { AgentMemoryCleanupError } from './runtime'
import type {
  AgentMemorySequenceArtifact,
  AgentMemorySequenceScenario,
  OwnedMemoryExperimentRunLease,
  RunAgentMemoryExperimentOptions,
  RunAgentMemoryExperimentResult,
} from './types'
import { assertMemorySequences, assertNonEmptyString, assertUnique } from './validation'

const MEMORY_EXPERIMENT_IMPLEMENTATION_REF = 'agent-knowledge:memory-experiment:v6'

/** Runs ordered, branch-isolated memory histories across candidate systems. */
export async function runAgentMemoryExperiment(
  options: RunAgentMemoryExperimentOptions,
): Promise<RunAgentMemoryExperimentResult> {
  assertNonEmptyString(options.experimentId, 'memory experiment experimentId')
  assertNonEmptyString(options.runDir, 'memory experiment runDir')
  if (options.experimentRunId !== undefined) {
    assertNonEmptyString(options.experimentRunId, 'memory experiment experimentRunId')
  }
  if (options.sequences.length === 0) throw new Error('memory experiment requires sequences')
  if (options.candidates.length === 0) throw new Error('memory experiment requires candidates')
  if (options.executeStep && !options.executeStepRef) {
    throw new Error('memory experiment executeStepRef is required when executeStep is configured')
  }
  assertUnique(
    options.sequences.map((sequence) => sequence.id),
    'sequence',
  )
  assertUnique(
    [...options.candidates, ...(options.recoveryCandidates ?? [])].map((candidate) => candidate.id),
    'candidate',
  )
  assertMemorySequences(options.sequences)
  for (const candidate of [...options.candidates, ...(options.recoveryCandidates ?? [])]) {
    if (options.cleanupBranches === false && !candidate.disposeAdapter) {
      throw new Error(
        `${candidate.id}: cleanupBranches=false requires disposeAdapter to delete isolated external state`,
      )
    }
    if (
      candidate.externalCostUsdPerSequence !== undefined &&
      (!Number.isFinite(candidate.externalCostUsdPerSequence) ||
        candidate.externalCostUsdPerSequence < 0)
    ) {
      throw new Error(
        `${candidate.id}: externalCostUsdPerSequence must be a non-negative finite number`,
      )
    }
    if (
      candidate.externalRecoveryCostUsdPerAttempt !== undefined &&
      (!Number.isFinite(candidate.externalRecoveryCostUsdPerAttempt) ||
        candidate.externalRecoveryCostUsdPerAttempt < 0)
    ) {
      throw new Error(
        `${candidate.id}: externalRecoveryCostUsdPerAttempt must be a non-negative finite number`,
      )
    }
    assertNonEmptyString(candidate.ref, `${candidate.id} ref`)
  }

  const storage = options.storage ?? fsCampaignStorage()
  const runDir = resolveRunDir(options.runDir, options.repo)
  if (!storage.append) {
    throw new Error('memory experiment requires CampaignStorage.append for durable attempt state')
  }
  resolveMemoryCleanupTimeoutMs(options.cleanupTimeoutMs, 'memory experiment')
  const maxRecoveryAttempts = options.maxRecoveryAttempts ?? 1_000
  if (!Number.isSafeInteger(maxRecoveryAttempts) || maxRecoveryAttempts <= 0) {
    throw new Error('memory experiment maxRecoveryAttempts must be a positive safe integer')
  }
  const maxRecoveryRetriesPerAttempt =
    options.maxRecoveryRetriesPerAttempt ?? DEFAULT_MEMORY_RECOVERY_RETRIES_PER_ATTEMPT
  if (!Number.isSafeInteger(maxRecoveryRetriesPerAttempt) || maxRecoveryRetriesPerAttempt <= 0) {
    throw new Error(
      'memory experiment maxRecoveryRetriesPerAttempt must be a positive safe integer',
    )
  }
  storage.ensureDir(runDir)
  const lease = await acquireAgentMemoryRunLease({
    experimentId: options.experimentId,
    runDir,
    storage,
    customStorage: options.storage !== undefined,
    lockFileName: 'memory-experiment.lock',
    label: 'memory experiment',
    controllerMode: options.controllerMode,
    acquireRunLease: options.acquireRunLease,
  })
  let result: RunAgentMemoryExperimentResult | undefined
  let primaryError: unknown
  try {
    await lease.assertOwned()
    result = await runOwnedAgentMemoryExperiment(options, storage, runDir, lease)
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
      'memory experiment failed and its controller lease could not be released',
    )
  }
  if (primaryError) throw primaryError
  if (releaseError) throw releaseError
  if (!result) throw new Error('memory experiment produced no result')
  return result
}

async function runOwnedAgentMemoryExperiment(
  options: RunAgentMemoryExperimentOptions,
  storage: CampaignStorage,
  runDir: string,
  lease: OwnedMemoryExperimentRunLease,
): Promise<RunAgentMemoryExperimentResult> {
  const runIdentity = stableId(
    'memory_run',
    canonicalJson({
      experimentId: options.experimentId,
      experimentRunId: options.experimentRunId ?? runDir,
    }),
  )
  const maxConcurrency = options.maxConcurrency ?? 2
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency <= 0) {
    throw new Error('memory experiment maxConcurrency must be a positive safe integer')
  }
  const executionPool = createMemoryExecutionPool(maxConcurrency)
  const dispatchedExecutions: Promise<AgentMemorySequenceArtifact>[] = []
  const candidateById = new Map(options.candidates.map((candidate) => [candidate.id, candidate]))
  const recoveryCandidateById = new Map(
    [...options.candidates, ...(options.recoveryCandidates ?? [])].map((candidate) => [
      candidate.id,
      candidate,
    ]),
  )
  const sequenceById = new Map(options.sequences.map((sequence) => [sequence.id, sequence]))
  const scenarios = buildAgentMemorySequenceScenarios(options.sequences, options.candidates)
  const attemptLogPath = join(runDir, 'memory-attempts.jsonl')
  const recoveryLogPath = join(runDir, 'memory-recovery-attempts.jsonl')
  const costCeiling = options.costCeiling ?? options.costLedger?.costCeilingUsd ?? 0
  const costLedger =
    options.costLedger ??
    createRunCostLedger({
      storage,
      runDir,
      costCeilingUsd: costCeiling,
    })
  if (costLedger.costCeilingUsd !== costCeiling) {
    throw new Error('memory experiment costCeiling must match the shared cost ledger ceiling')
  }
  storage.ensureDir(runDir)
  await recoverAbandonedMemoryAttempts({
    options,
    storage,
    runDir,
    attemptLogPath,
    candidateById: recoveryCandidateById,
    sequenceById,
    lease,
    maxConcurrency,
    costLedger,
    maxRecoveryAttempts: options.maxRecoveryAttempts ?? 1_000,
    recoveryLogPath,
    maxRecoveryRetriesPerAttempt:
      options.maxRecoveryRetriesPerAttempt ?? DEFAULT_MEMORY_RECOVERY_RETRIES_PER_ATTEMPT,
  })
  await lease.assertOwned()
  let campaign: CampaignResult<AgentMemorySequenceArtifact, AgentMemorySequenceScenario> | undefined
  let campaignError: unknown
  let settledExecutions: PromiseSettledResult<AgentMemorySequenceArtifact>[] = []
  try {
    campaign = await runCampaign<AgentMemorySequenceScenario, AgentMemorySequenceArtifact>({
      scenarios,
      dispatch: (scenario, context) => {
        const candidate = candidateById.get(scenario.candidateId)
        if (!candidate) throw new Error(`unknown memory candidate ${scenario.candidateId}`)
        const operation = executionPool.run(() =>
          runSequenceCell({
            options,
            candidate,
            scenario,
            context,
            runIdentity,
            storage,
            attemptLogPath,
            lease,
          }),
        )
        dispatchedExecutions.push(operation)
        return operation
      },
      dispatchRef: memoryExperimentDispatchRef(options),
      judges: [agentMemorySequenceJudge()],
      runDir,
      storage,
      seed: options.seed,
      reps: options.reps,
      resumable: options.resumable,
      costCeiling,
      costLedger,
      costPhase: options.costPhase,
      maxConcurrency,
      dispatchTimeoutMs: options.dispatchTimeoutMs,
      expectUsage: 'off',
      now: options.now,
    })
  } catch (error) {
    campaignError = error
  } finally {
    settledExecutions = await Promise.allSettled(dispatchedExecutions)
  }
  const cleanupFailures = settledExecutions.flatMap((settled) =>
    settled.status === 'rejected' && settled.reason instanceof AgentMemoryCleanupError
      ? [settled.reason]
      : [],
  )
  if (campaignError && cleanupFailures.length > 0) {
    throw new AggregateError(
      [campaignError, ...cleanupFailures],
      'memory experiment failed and provider cleanup also failed',
    )
  }
  if (campaignError) throw campaignError
  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, 'memory experiment cleanup failed after dispatch')
  }
  if (!campaign) throw new Error('memory experiment produced no campaign result')
  await lease.assertOwned()
  const costByCandidate = memoryExperimentCostByCandidate(
    costLedger,
    campaign.runDir,
    scenarios,
    [...options.candidates, ...(options.recoveryCandidates ?? [])].map((candidate) => candidate.id),
  )
  const unrankedRecoveryCostUsd = normalizeUsd(
    (options.recoveryCandidates ?? []).reduce(
      (sum, candidate) => sum + (costByCandidate.get(candidate.id) ?? 0),
      0,
    ),
  )
  const totalCostUsd = normalizeUsd(
    [...costByCandidate.values()].reduce((sum, cost) => sum + cost, 0),
  )
  const rows = rankAgentMemoryExperiment(options.candidates, scenarios, campaign, costByCandidate)
  const rankingJsonPath = join(campaign.runDir, 'memory-experiment-ranking.json')
  const rankingMarkdownPath = join(campaign.runDir, 'memory-experiment-ranking.md')
  storage.write(
    rankingJsonPath,
    `${JSON.stringify(
      { experimentId: options.experimentId, totalCostUsd, unrankedRecoveryCostUsd, rows },
      null,
      2,
    )}\n`,
  )
  storage.write(
    rankingMarkdownPath,
    renderAgentMemoryExperimentRanking(rows, totalCostUsd, unrankedRecoveryCostUsd),
  )
  return {
    campaign,
    rows,
    totalCostUsd,
    unrankedRecoveryCostUsd,
    leaderCandidateId: rows.find((row) => row.cellsFailed === 0)?.candidateId,
    rankingJsonPath,
    rankingMarkdownPath,
    attemptLogPath,
    recoveryLogPath,
  }
}

function memoryExperimentDispatchRef(options: RunAgentMemoryExperimentOptions): string {
  return stableId(
    'memory_experiment',
    canonicalJson({
      implementationRef: MEMORY_EXPERIMENT_IMPLEMENTATION_REF,
      experimentId: options.experimentId,
      experimentRunId: options.experimentRunId ?? null,
      executeStepRef: options.executeStepRef ?? 'fixtures',
      cleanupBranches: options.cleanupBranches ?? true,
      candidates: options.candidates
        .map((candidate) => ({
          id: candidate.id,
          ref: candidate.ref,
          policy: candidate.policy ?? null,
          baseScope: candidate.baseScope ?? null,
          externalCostUsdPerSequence: candidate.externalCostUsdPerSequence ?? 0,
          externalRecoveryCostUsdPerAttempt: candidate.externalRecoveryCostUsdPerAttempt ?? 0,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    }),
  )
}
