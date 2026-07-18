import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { canonicalJson } from '@tangle-network/agent-eval'
import {
  type CampaignResult,
  type CampaignStorage,
  type CostLedgerHandle,
  createRunCostLedger,
  type DispatchContext,
  fsCampaignStorage,
  type JudgeConfig,
  resolveRunDir,
  runCampaign,
  type Scenario,
} from '@tangle-network/agent-eval/campaign'
import {
  type KnowledgeBenchmarkFamily,
  type KnowledgeBenchmarkSplit,
  type KnowledgeMemoryBenchmarkCase,
  type KnowledgeMemoryBenchmarkTaskKind,
  type KnowledgeMemoryEvent,
  type KnowledgeMemoryFactMatcher,
  scoreMemoryBenchmarkArtifact,
} from '../benchmarks/index'
import { stableId } from '../ids'
import { appendAttemptJournalEvent, readActiveAttemptJournal } from './attempt-log'
import {
  type AgentMemoryBranch,
  type AgentMemoryBranchSnapshot,
  type AgentMemorySharingPolicy,
  createAgentMemoryBranch,
} from './branch'
import {
  createMemoryExecutionPool,
  memoryRecoveryDelayMs,
  resolveMemoryCleanupTimeoutMs,
  runBoundedMemoryLifecycle,
  sleepForMemoryRecovery,
} from './lifecycle'
import {
  type AgentMemoryAcquireRunLease,
  type AgentMemoryControllerMode,
  type AgentMemoryRunLease,
  acquireAgentMemoryRunLease,
  type OwnedAgentMemoryRunLease,
} from './run-control'
import type { AgentMemoryAdapter, AgentMemoryScope, AgentMemoryWriteInput } from './types'

const MEMORY_EXPERIMENT_IMPLEMENTATION_REF = 'agent-knowledge:memory-experiment:v3'

export interface AgentMemorySequenceProbe {
  id: string
  query: string
  scope?: AgentMemoryScope
  limit?: number
  taskKind?: KnowledgeMemoryBenchmarkTaskKind
  requiredFacts?: readonly KnowledgeMemoryFactMatcher[]
  forbiddenFacts?: readonly KnowledgeMemoryFactMatcher[]
  expectedEventIds?: readonly string[]
  expectedActorIds?: readonly string[]
  referenceAnswer?: string
}

export interface AgentMemorySequenceStep {
  id: string
  instruction?: string
  scope?: AgentMemoryScope
  writes?: readonly AgentMemoryWriteInput[]
  parallelWrites?: boolean
  probes?: readonly AgentMemorySequenceProbe[]
  parallelProbes?: boolean
  metadata?: Record<string, unknown>
}

export interface AgentMemorySequence {
  id: string
  family: KnowledgeBenchmarkFamily | string
  split?: KnowledgeBenchmarkSplit
  steps: readonly AgentMemorySequenceStep[]
  /** Exact scopes a runtime callback may write beyond scopes declared by steps. */
  cleanupScopes?: readonly AgentMemoryScope[]
  tags?: readonly string[]
  metadata?: Record<string, unknown>
}

export interface BuildAgentMemorySequencesFromBenchmarkCasesOptions {
  memoryAgentId?: string
  eventScope?: (input: {
    event: KnowledgeMemoryEvent
    case: KnowledgeMemoryBenchmarkCase
    eventIndex: number
  }) => AgentMemoryScope
  probeScope?: (testCase: KnowledgeMemoryBenchmarkCase) => AgentMemoryScope
}

export interface AgentMemoryExperimentCandidate {
  id: string
  label?: string
  /** Change when provider configuration changes so cached cells cannot be reused. */
  ref: string
  createAdapter(input: {
    branchId: string
    sequence: AgentMemorySequence
    rep: number
    seed: number
    purpose: 'execute' | 'recovery'
  }): AgentMemoryAdapter | null | Promise<AgentMemoryAdapter | null>
  policy?: AgentMemorySharingPolicy
  baseScope?: AgentMemoryScope
  /** Conservative external provider charge for one complete history. */
  externalCostUsdPerSequence?: number
  /** Conservative extra provider charge when recovering one interrupted history. */
  externalRecoveryCostUsdPerAttempt?: number
  /** Release resources and, when cleanupBranches is false, delete the isolated state. */
  disposeAdapter?(adapter: AgentMemoryAdapter): Promise<void>
}

export interface AgentMemorySequenceProbeResult {
  id: string
  stepId: string
  query: string
  score: number
  passed: boolean
  dimensions: Record<string, number>
  applicableDimensions: readonly string[]
  notes: string
  hitIds: readonly string[]
}

export interface AgentMemorySequenceArtifact {
  candidateId: string
  sequenceId: string
  score: number
  passed: boolean
  dimensions: Record<string, number>
  dimensionSampleCounts: Record<string, number>
  probes: readonly AgentMemorySequenceProbeResult[]
  branchDigest: string
  journalEntries: number
  durationMs: number
}

export interface AgentMemorySequenceScenario extends Scenario {
  kind: 'agent-memory-sequence'
  candidateId: string
  sequenceId: string
  sequence: AgentMemorySequence
  seedGroup: string
}

export interface AgentMemoryExperimentRankingRow {
  rank: number
  candidateId: string
  label: string
  scoreMean: number
  passRate: number
  totalSequences: number
  totalCells: number
  totalProbes: number
  cellsFailed: number
  totalCostUsd: number
  durationMs: number
  dimensions: Record<string, number>
}

export interface RunAgentMemoryExperimentOptions {
  experimentId: string
  /** Stable external branch namespace; distributed workers must use the same value. */
  experimentRunId?: string
  sequences: readonly AgentMemorySequence[]
  candidates: readonly AgentMemoryExperimentCandidate[]
  runDir: string
  executeStep?: (input: {
    memory: AgentMemoryBranch
    candidateId: string
    sequence: AgentMemorySequence
    step: AgentMemorySequenceStep
    context: DispatchContext
  }) => Promise<void>
  /** Required with executeStep; identify the runtime/profile behavior in cache keys. */
  executeStepRef?: string
  onBranchSnapshot?: (input: {
    candidateId: string
    sequenceId: string
    cellId: string
    snapshot: AgentMemoryBranchSnapshot
  }) => Promise<void> | void
  cleanupBranches?: boolean
  storage?: CampaignStorage
  repo?: string
  seed?: number
  reps?: number
  resumable?: boolean
  costCeiling?: number
  /** Shared across nested experiments when an outer improvement run owns spend. */
  costLedger?: CostLedgerHandle
  costPhase?: string
  maxConcurrency?: number
  dispatchTimeoutMs?: number
  /** Total deadline for each provider cleanup, close, or recovery operation. */
  cleanupTimeoutMs?: number
  now?: () => Date
  /** Required with custom storage when all controllers are confined to one process. */
  controllerMode?: AgentMemoryControllerMode
  /** Required for distributed controllers that share custom storage. */
  acquireRunLease?: AgentMemoryAcquireRunLease
}

export type AgentMemoryExperimentRunLease = AgentMemoryRunLease

export interface AgentMemoryAttemptEvent {
  schema: 1
  status: 'started' | 'cleaned'
  branchId: string
  candidateId: string
  candidateRef: string
  sequenceId: string
  rep: number
  seed: number
  cleanupBranches: boolean
  recordedAt: string
  recovery: boolean
}

export interface RunAgentMemoryExperimentResult {
  campaign: CampaignResult<AgentMemorySequenceArtifact, AgentMemorySequenceScenario>
  rows: readonly AgentMemoryExperimentRankingRow[]
  leaderCandidateId?: string
  rankingJsonPath: string
  rankingMarkdownPath: string
  attemptLogPath: string
}

class AgentMemoryCleanupError extends AggregateError {
  constructor(errors: Iterable<unknown>, message: string) {
    super(errors, message)
    this.name = 'AgentMemoryCleanupError'
  }
}

type OwnedMemoryExperimentRunLease = OwnedAgentMemoryRunLease

/** Converts existing ordered memory benchmark cases into executable histories. */
export function buildAgentMemorySequencesFromBenchmarkCases(
  cases: readonly KnowledgeMemoryBenchmarkCase[],
  options: BuildAgentMemorySequencesFromBenchmarkCasesOptions = {},
): AgentMemorySequence[] {
  const memoryAgentId = options.memoryAgentId ?? 'benchmark-agent'
  return cases.map((testCase) => ({
    id: testCase.id,
    family: testCase.family,
    ...(testCase.split !== undefined ? { split: testCase.split } : {}),
    ...(testCase.tags !== undefined ? { tags: testCase.tags } : {}),
    metadata: compactRecord({
      ...(testCase.metadata ?? {}),
      taskKind: testCase.taskKind,
      source: testCase.source,
    }),
    steps: [
      ...testCase.events.map((event, eventIndex) => ({
        id: `event:${event.id}`,
        scope: compactScope(
          options.eventScope?.({ event, case: testCase, eventIndex }) ?? {
            agentId: memoryAgentId,
            sessionId: testCase.id,
          },
        ),
        writes: [
          {
            id: event.id,
            kind: 'observation' as const,
            text: event.text,
            metadata: compactRecord({
              ...(event.metadata ?? {}),
              eventId: event.id,
              actorId: event.actorId,
              sessionId: event.sessionId,
              timestamp: event.timestamp,
            }),
          },
        ],
        metadata: { eventIndex },
      })),
      {
        id: 'probe',
        scope: compactScope(
          options.probeScope?.(testCase) ?? {
            agentId: memoryAgentId,
            sessionId: testCase.id,
          },
        ),
        probes: [
          {
            id: 'answer',
            query: testCase.prompt,
            taskKind: testCase.taskKind,
            ...(testCase.requiredFacts !== undefined
              ? { requiredFacts: testCase.requiredFacts }
              : {}),
            ...(testCase.forbiddenFacts !== undefined
              ? { forbiddenFacts: testCase.forbiddenFacts }
              : {}),
            ...(testCase.expectedEventIds !== undefined
              ? { expectedEventIds: testCase.expectedEventIds }
              : {}),
            ...(testCase.expectedActorIds !== undefined
              ? { expectedActorIds: testCase.expectedActorIds }
              : {}),
            ...(testCase.referenceAnswer !== undefined
              ? { referenceAnswer: testCase.referenceAnswer }
              : {}),
          },
        ],
      },
    ],
  }))
}

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
    options.candidates.map((candidate) => candidate.id),
    'candidate',
  )
  assertMemorySequences(options.sequences)
  for (const candidate of options.candidates) {
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
  const sequenceById = new Map(options.sequences.map((sequence) => [sequence.id, sequence]))
  const scenarios = buildAgentMemorySequenceScenarios(options.sequences, options.candidates)
  const attemptLogPath = join(runDir, 'memory-attempts.jsonl')
  const costLedger =
    options.costLedger ??
    createRunCostLedger({
      storage,
      runDir,
      costCeilingUsd: options.costCeiling,
    })
  if (options.costCeiling !== undefined && costLedger.costCeilingUsd !== options.costCeiling) {
    throw new Error('memory experiment costCeiling must match the shared cost ledger ceiling')
  }
  storage.ensureDir(runDir)
  const recoveryCostByCandidate = await recoverAbandonedMemoryAttempts({
    options,
    storage,
    runDir,
    attemptLogPath,
    candidateById,
    sequenceById,
    lease,
    maxConcurrency,
    costLedger,
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
      costCeiling: options.costCeiling,
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
  const rows = rankAgentMemoryExperiment(
    options.candidates,
    scenarios,
    campaign,
    recoveryCostByCandidate,
  )
  const rankingJsonPath = join(campaign.runDir, 'memory-experiment-ranking.json')
  const rankingMarkdownPath = join(campaign.runDir, 'memory-experiment-ranking.md')
  storage.write(
    rankingJsonPath,
    `${JSON.stringify({ experimentId: options.experimentId, rows }, null, 2)}\n`,
  )
  storage.write(rankingMarkdownPath, renderAgentMemoryExperimentRanking(rows))
  return {
    campaign,
    rows,
    leaderCandidateId: rows.find((row) => row.cellsFailed === 0)?.candidateId,
    rankingJsonPath,
    rankingMarkdownPath,
    attemptLogPath,
  }
}

export function buildAgentMemorySequenceScenarios(
  sequences: readonly AgentMemorySequence[],
  candidates: readonly Pick<AgentMemoryExperimentCandidate, 'id'>[],
): AgentMemorySequenceScenario[] {
  return candidates.flatMap((candidate) =>
    sequences.map((sequence) => ({
      id: `${stableId('candidate', candidate.id)}:${sequence.id}`,
      kind: 'agent-memory-sequence' as const,
      candidateId: candidate.id,
      sequenceId: sequence.id,
      sequence,
      seedGroup: sequence.id,
      tags: [...new Set([sequence.split ?? 'dev', ...(sequence.tags ?? []), candidate.id])],
    })),
  )
}

export function agentMemorySequenceJudge(): JudgeConfig<
  AgentMemorySequenceArtifact,
  AgentMemorySequenceScenario
> {
  return {
    name: 'agent-memory-sequence',
    judgeVersion: 'agent-knowledge:memory-sequence:v2',
    dimensions: [
      { key: 'score', description: 'mean memory probe score' },
      { key: 'passed', description: '1 when every memory probe passes' },
      { key: 'memory_fact_recall', description: 'current memory fact coverage' },
      { key: 'memory_event_recall', description: 'memory source event coverage' },
      { key: 'memory_actor_recall', description: 'memory actor attribution coverage' },
      { key: 'memory_stale_safe', description: '1 when obsolete memory is not reused' },
    ],
    score({ artifact }) {
      return {
        composite: artifact.score,
        dimensions: {
          score: artifact.score,
          passed: artifact.passed ? 1 : 0,
          ...artifact.dimensions,
        },
        notes: `${artifact.probes.filter((probe) => probe.passed).length}/${artifact.probes.length} probes passed`,
      }
    },
  }
}

async function runSequenceCell(input: {
  options: RunAgentMemoryExperimentOptions
  candidate: AgentMemoryExperimentCandidate
  scenario: AgentMemorySequenceScenario
  context: DispatchContext
  runIdentity: string
  storage: CampaignStorage
  attemptLogPath: string
  lease: OwnedMemoryExperimentRunLease
}): Promise<AgentMemorySequenceArtifact> {
  const { options, candidate, scenario, context, runIdentity, storage, attemptLogPath, lease } =
    input
  const cleanupBranches = options.cleanupBranches ?? true
  const costUsd = candidate.externalCostUsdPerSequence ?? 0
  if (!Number.isFinite(costUsd) || costUsd < 0) {
    throw new Error(
      `${candidate.id}: externalCostUsdPerSequence must be a non-negative finite number`,
    )
  }
  if (!cleanupBranches && !candidate.disposeAdapter) {
    throw new Error(
      `${candidate.id}: cleanupBranches=false requires disposeAdapter to delete isolated external state`,
    )
  }
  const cleanupTimeoutMs = resolveMemoryCleanupTimeoutMs(
    options.cleanupTimeoutMs,
    `${candidate.id}: memory sequence`,
  )

  let externalCallAttempted = false
  const execute = async (): Promise<AgentMemorySequenceArtifact> => {
    context.signal.throwIfAborted()
    await lease.assertOwned()
    const startedAt = Date.now()
    const branchId = stableId(
      'memory_branch',
      `${runIdentity}:${context.cellId}:${context.seed}:${randomUUID()}`,
    )
    const attempt = memoryAttemptEvent({
      status: 'started',
      branchId,
      candidate,
      sequence: scenario.sequence,
      rep: context.rep,
      seed: context.seed,
      recovery: false,
      cleanupBranches,
      now: options.now,
    })
    appendMemoryAttemptEvent(storage, attemptLogPath, attempt)
    let adapter: AgentMemoryAdapter | undefined
    let memory: AgentMemoryBranch | undefined
    let primaryError: unknown
    let completedArtifact: AgentMemorySequenceArtifact | undefined
    let finalClearStarted = false
    let finalClearCompleted = false
    try {
      // A factory can contact a provider before it rejects, so charge conservatively once invoked.
      externalCallAttempted = true
      const created = await candidate.createAdapter({
        branchId,
        sequence: scenario.sequence,
        rep: context.rep,
        seed: context.seed,
        purpose: 'execute',
      })
      if (!created) throw new Error(`${candidate.id}: createAdapter returned no execution adapter`)
      adapter = created
      await lease.assertOwned()
      context.signal.throwIfAborted()
      if (cleanupBranches && !adapter.clear) {
        throw new Error(
          `${candidate.id}: cleanupBranches requires an adapter with scoped clear support`,
        )
      }
      memory = createAgentMemoryBranch({
        adapter,
        branchId,
        lifetime: 'attempt',
        policy: candidate.policy,
        allowedWriteScopes: sequenceCleanupScopes(scenario.sequence),
        baseScope: memoryExperimentBaseScope(options, candidate, scenario.sequenceId),
      })
      if (cleanupBranches) {
        await runBoundedMemoryLifecycle({
          operation: `${candidate.id}: initial branch cleanup`,
          timeoutMs: cleanupTimeoutMs,
          run: () => clearSequenceScopes(memory!, scenario.sequence),
        })
        await lease.assertOwned()
      }
      const probes: AgentMemorySequenceProbeResult[] = []
      for (const step of scenario.sequence.steps) {
        context.signal.throwIfAborted()
        await lease.assertOwned()
        await writeStep(memory, step)
        await lease.assertOwned()
        await options.executeStep?.({
          memory,
          candidateId: candidate.id,
          sequence: scenario.sequence,
          step,
          context,
        })
        context.signal.throwIfAborted()
        await lease.assertOwned()
        const stepProbes = await probeStep(memory, scenario.sequence, step)
        await lease.assertOwned()
        probes.push(...stepProbes)
      }
      const snapshot = await memory.snapshot()
      await lease.assertOwned()
      await options.onBranchSnapshot?.({
        candidateId: candidate.id,
        sequenceId: scenario.sequenceId,
        cellId: context.cellId,
        snapshot,
      })
      await lease.assertOwned()
      const dimensions = meanDimensions(probes.map((probe) => probe.dimensions))
      const dimensionSampleCounts = countDimensions(
        probes.map((probe) => probe.applicableDimensions),
      )
      const artifact: AgentMemorySequenceArtifact = {
        candidateId: candidate.id,
        sequenceId: scenario.sequenceId,
        score: mean(probes.map((probe) => probe.score)),
        passed: probes.length > 0 && probes.every((probe) => probe.passed),
        dimensions,
        dimensionSampleCounts,
        probes,
        branchDigest: snapshot.digest,
        journalEntries: snapshot.journal.length,
        durationMs: Math.max(0, Date.now() - startedAt),
      }
      if (cleanupBranches) {
        finalClearStarted = true
        await runBoundedMemoryLifecycle({
          operation: `${candidate.id}: final branch cleanup`,
          timeoutMs: cleanupTimeoutMs,
          run: () => clearSequenceScopes(memory!, scenario.sequence),
        })
        finalClearCompleted = true
        await lease.assertOwned()
      }
      completedArtifact = artifact
    } catch (error) {
      primaryError = error
    }
    const cleanupErrors: unknown[] = []
    let cleanupOwned = true
    let ownershipError: unknown
    try {
      await lease.assertOwned()
    } catch (error) {
      cleanupOwned = false
      ownershipError = error
    }
    if (finalClearStarted && !finalClearCompleted && primaryError) {
      cleanupErrors.push(primaryError)
    }
    if (
      primaryError &&
      cleanupOwned &&
      !finalClearStarted &&
      memory &&
      cleanupBranches &&
      adapter?.clear
    ) {
      try {
        await runBoundedMemoryLifecycle({
          operation: `${candidate.id}: failed branch cleanup`,
          timeoutMs: cleanupTimeoutMs,
          run: () => clearSequenceScopes(memory!, scenario.sequence),
        })
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (adapter) {
      try {
        await runBoundedMemoryLifecycle({
          operation: `${candidate.id}: adapter close`,
          timeoutMs: cleanupTimeoutMs,
          run: async () => {
            if (memory && cleanupOwned) await memory.close?.()
            else {
              if (cleanupOwned) await adapter!.flush?.()
              await adapter!.close?.()
            }
          },
        })
      } catch (error) {
        cleanupErrors.push(error)
      }
      if (cleanupOwned) {
        try {
          await runBoundedMemoryLifecycle({
            operation: `${candidate.id}: adapter disposal`,
            timeoutMs: cleanupTimeoutMs,
            run: () => candidate.disposeAdapter?.(adapter!),
          })
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
    } else {
      cleanupErrors.push(
        new Error(`${candidate.id}: adapter creation failed before cleanup could be confirmed`),
      )
    }
    if (cleanupOwned && cleanupErrors.length === 0) {
      try {
        appendMemoryAttemptEvent(storage, attemptLogPath, {
          ...attempt,
          status: 'cleaned',
          recordedAt: (options.now ?? (() => new Date()))().toISOString(),
        })
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
    if (!cleanupOwned && cleanupErrors.length === 0) {
      if (primaryError) throw primaryError
      throw ownershipError
    }
    if (cleanupErrors.length > 0) {
      const primaryMessage =
        primaryError instanceof Error ? primaryError.message : String(primaryError ?? '')
      throw new AgentMemoryCleanupError(
        [
          ...(primaryError && !cleanupErrors.includes(primaryError) ? [primaryError] : []),
          ...(ownershipError ? [ownershipError] : []),
          ...cleanupErrors,
        ],
        `${candidate.id}: memory branch cleanup failed${primaryMessage ? ` after: ${primaryMessage}` : ''}`,
      )
    }
    if (primaryError) throw primaryError
    if (!completedArtifact) throw new Error(`${candidate.id}: memory sequence produced no result`)
    return completedArtifact
  }

  if (costUsd === 0) return execute()
  const receipt = {
    model: candidate.id,
    inputTokens: 0,
    outputTokens: 0,
    usageUnknown: true,
    actualCostUsd: costUsd,
  } as const
  const paid = await context.cost.runPaidCall({
    actor: `agent-knowledge:memory-experiment:${candidate.id}`,
    model: candidate.id,
    maximumCharge: { externallyEnforcedMaximumUsd: costUsd },
    execute,
    receipt: () => receipt,
    receiptFromError: () => ({
      ...receipt,
      actualCostUsd: externalCallAttempted ? costUsd : 0,
    }),
  })
  if (!paid.succeeded) throw paid.error
  return paid.value
}

async function recoverAbandonedMemoryAttempts(input: {
  options: RunAgentMemoryExperimentOptions
  storage: CampaignStorage
  runDir: string
  attemptLogPath: string
  candidateById: ReadonlyMap<string, AgentMemoryExperimentCandidate>
  sequenceById: ReadonlyMap<string, AgentMemorySequence>
  lease: OwnedMemoryExperimentRunLease
  maxConcurrency: number
  costLedger: CostLedgerHandle
}): Promise<ReadonlyMap<string, number>> {
  const attempts = readActiveMemoryAttempts(input.storage, input.attemptLogPath)
  const pool = createMemoryExecutionPool(input.maxConcurrency)
  const settled = await Promise.allSettled(
    attempts
      .sort((left, right) => left.branchId.localeCompare(right.branchId))
      .map((attempt) =>
        pool.run(async () => {
          await input.lease.assertOwned()
          const candidate = input.candidateById.get(attempt.candidateId)
          if (!candidate) {
            throw new Error(
              `cannot recover memory branch '${attempt.branchId}': candidate '${attempt.candidateId}' is missing`,
            )
          }
          if (candidate.ref !== attempt.candidateRef) {
            throw new Error(
              `cannot recover memory branch '${attempt.branchId}': candidate ref changed from '${attempt.candidateRef}' to '${candidate.ref}'`,
            )
          }
          const sequence = input.sequenceById.get(attempt.sequenceId)
          if (!sequence) {
            throw new Error(
              `cannot recover memory branch '${attempt.branchId}': sequence '${attempt.sequenceId}' is missing`,
            )
          }
          if ((input.options.cleanupBranches ?? true) !== attempt.cleanupBranches) {
            throw new Error(
              `cannot recover memory branch '${attempt.branchId}': cleanupBranches changed`,
            )
          }
          const recoveryCostUsd = candidate.externalRecoveryCostUsdPerAttempt ?? 0
          const recover = () =>
            recoverMemoryAttempt({
              options: input.options,
              candidate,
              sequence,
              attempt,
              lease: input.lease,
            })
          if (recoveryCostUsd === 0) {
            await recover()
          } else {
            const receipt = {
              model: candidate.id,
              inputTokens: 0,
              outputTokens: 0,
              usageUnknown: true,
              actualCostUsd: recoveryCostUsd,
            } as const
            const paid = await input.costLedger.runPaidCall({
              channel: 'driver',
              phase: `${input.options.costPhase ?? 'memory.experiment'}.recovery`,
              actor: `agent-knowledge:memory-recovery:${candidate.id}`,
              model: candidate.id,
              tags: {
                runDir: input.runDir,
                candidateId: candidate.id,
                branchId: attempt.branchId,
              },
              maximumCharge: { externallyEnforcedMaximumUsd: recoveryCostUsd },
              execute: recover,
              receipt: () => receipt,
              receiptFromError: () => receipt,
            })
            if (!paid.succeeded) throw paid.error
          }
          appendMemoryAttemptEvent(input.storage, input.attemptLogPath, {
            ...attempt,
            status: 'cleaned',
            recovery: true,
            recordedAt: (input.options.now ?? (() => new Date()))().toISOString(),
          })
        }),
      ),
  )
  const failures = settled.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  )
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(failures, 'multiple abandoned memory branches failed recovery')
  }
  return new Map(
    [...input.candidateById.keys()].map((candidateId) => [
      candidateId,
      input.costLedger.summary({ tags: { runDir: input.runDir, candidateId } }).totalCostUsd,
    ]),
  )
}

async function recoverMemoryAttempt(input: {
  options: RunAgentMemoryExperimentOptions
  candidate: AgentMemoryExperimentCandidate
  sequence: AgentMemorySequence
  attempt: AgentMemoryAttemptEvent
  lease: OwnedMemoryExperimentRunLease
}): Promise<void> {
  const { options, candidate, sequence, attempt, lease } = input
  const cleanupBranches = attempt.cleanupBranches
  const cleanupTimeoutMs = resolveMemoryCleanupTimeoutMs(
    options.cleanupTimeoutMs,
    `${candidate.id}: abandoned branch recovery`,
  )
  let adapter: AgentMemoryAdapter | undefined
  let memory: AgentMemoryBranch | undefined
  let primaryError: unknown
  try {
    const recovered = await runBoundedMemoryLifecycle({
      operation: `${candidate.id}: recovery adapter creation`,
      timeoutMs: cleanupTimeoutMs,
      run: () =>
        candidate.createAdapter({
          branchId: attempt.branchId,
          sequence,
          rep: attempt.rep,
          seed: attempt.seed,
          purpose: 'recovery',
        }),
    })
    await lease.assertOwned()
    if (recovered === null) return
    adapter = recovered
    const recoveryDelayMs = memoryRecoveryDelayMs(adapter)
    await sleepForMemoryRecovery(recoveryDelayMs, () => lease.assertOwned())
    if (cleanupBranches) {
      if (!adapter.clear) {
        throw new Error(
          `${candidate.id}: abandoned branch recovery requires an adapter with scoped clear support`,
        )
      }
      memory = createAgentMemoryBranch({
        adapter,
        branchId: attempt.branchId,
        lifetime: 'attempt',
        policy: candidate.policy,
        allowedWriteScopes: sequenceCleanupScopes(sequence),
        baseScope: memoryExperimentBaseScope(options, candidate, sequence.id),
      })
      await runBoundedMemoryLifecycle({
        operation: `${candidate.id}: abandoned branch cleanup`,
        timeoutMs: cleanupTimeoutMs,
        run: () => clearSequenceScopes(memory!, sequence),
      })
      await lease.assertOwned()
    }
  } catch (error) {
    primaryError = error
  }

  const cleanupErrors: unknown[] = []
  let cleanupOwned = true
  try {
    await lease.assertOwned()
  } catch (error) {
    cleanupOwned = false
    cleanupErrors.push(error)
  }
  if (adapter) {
    try {
      await runBoundedMemoryLifecycle({
        operation: `${candidate.id}: recovery adapter close`,
        timeoutMs: cleanupTimeoutMs,
        run: async () => {
          if (memory && cleanupOwned) await memory.close?.()
          else {
            if (cleanupOwned) await adapter!.flush?.()
            await adapter!.close?.()
          }
        },
      })
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (cleanupOwned) {
      try {
        await runBoundedMemoryLifecycle({
          operation: `${candidate.id}: recovery adapter disposal`,
          timeoutMs: cleanupTimeoutMs,
          run: () => candidate.disposeAdapter?.(adapter!),
        })
      } catch (error) {
        cleanupErrors.push(error)
      }
    }
  } else {
    cleanupErrors.push(
      new Error(
        `${candidate.id}: recovery adapter creation failed before cleanup could be confirmed`,
      ),
    )
  }
  if (!cleanupOwned || primaryError || cleanupErrors.length > 0) {
    throw new AgentMemoryCleanupError(
      [...(primaryError ? [primaryError] : []), ...cleanupErrors],
      `${candidate.id}: abandoned memory branch '${attempt.branchId}' recovery failed`,
    )
  }
}

function memoryAttemptEvent(input: {
  status: AgentMemoryAttemptEvent['status']
  branchId: string
  candidate: AgentMemoryExperimentCandidate
  sequence: AgentMemorySequence
  rep: number
  seed: number
  recovery: boolean
  cleanupBranches?: boolean
  now?: () => Date
}): AgentMemoryAttemptEvent {
  return {
    schema: 1,
    status: input.status,
    branchId: input.branchId,
    candidateId: input.candidate.id,
    candidateRef: input.candidate.ref,
    sequenceId: input.sequence.id,
    rep: input.rep,
    seed: input.seed,
    cleanupBranches: input.cleanupBranches ?? true,
    recordedAt: (input.now ?? (() => new Date()))().toISOString(),
    recovery: input.recovery,
  }
}

function appendMemoryAttemptEvent(
  storage: CampaignStorage,
  path: string,
  event: AgentMemoryAttemptEvent,
): void {
  appendAttemptJournalEvent({
    storage,
    path,
    event,
    label: 'memory attempt log',
  })
}

function readActiveMemoryAttempts(
  storage: CampaignStorage,
  path: string,
): AgentMemoryAttemptEvent[] {
  return readActiveAttemptJournal({
    storage,
    path,
    label: 'memory attempt log',
    parse: parseMemoryAttemptEvent,
    id: (event) => event.branchId,
    sameAttempt: sameMemoryAttempt,
  })
}

function parseMemoryAttemptEvent(
  value: unknown,
  path: string,
  line: number,
): AgentMemoryAttemptEvent {
  const event = value as Partial<AgentMemoryAttemptEvent> | null
  const valid =
    typeof event === 'object' &&
    event !== null &&
    event.schema === 1 &&
    (event.status === 'started' || event.status === 'cleaned') &&
    typeof event.branchId === 'string' &&
    event.branchId.length > 0 &&
    typeof event.candidateId === 'string' &&
    event.candidateId.length > 0 &&
    typeof event.candidateRef === 'string' &&
    event.candidateRef.length > 0 &&
    typeof event.sequenceId === 'string' &&
    event.sequenceId.length > 0 &&
    Number.isSafeInteger(event.rep) &&
    Number.isSafeInteger(event.seed) &&
    typeof event.cleanupBranches === 'boolean' &&
    typeof event.recordedAt === 'string' &&
    !Number.isNaN(Date.parse(event.recordedAt)) &&
    typeof event.recovery === 'boolean'
  if (!valid) throw new Error(`invalid memory attempt event in '${path}' line ${line}`)
  return value as AgentMemoryAttemptEvent
}

function sameMemoryAttempt(left: AgentMemoryAttemptEvent, right: AgentMemoryAttemptEvent): boolean {
  return (
    left.branchId === right.branchId &&
    left.candidateId === right.candidateId &&
    left.candidateRef === right.candidateRef &&
    left.sequenceId === right.sequenceId &&
    left.rep === right.rep &&
    left.seed === right.seed &&
    left.cleanupBranches === right.cleanupBranches
  )
}

async function writeStep(memory: AgentMemoryBranch, step: AgentMemorySequenceStep): Promise<void> {
  const writes = (step.writes ?? []).map((write) => ({
    ...write,
    scope: mergeScopes(step.scope, write.scope),
  }))
  if (step.parallelWrites) {
    await Promise.all(writes.map((write) => memory.write(write)))
    return
  }
  for (const write of writes) await memory.write(write)
}

async function probeStep(
  memory: AgentMemoryBranch,
  sequence: AgentMemorySequence,
  step: AgentMemorySequenceStep,
): Promise<AgentMemorySequenceProbeResult[]> {
  const run = async (probe: AgentMemorySequenceProbe): Promise<AgentMemorySequenceProbeResult> => {
    const scope = mergeScopes(step.scope, probe.scope)
    const context = await memory.getContext(probe.query, { scope, limit: probe.limit })
    const artifact = {
      answer: context.text,
      rememberedFacts: context.hits.map((hit) => hit.text),
      citedEventIds: uniqueStrings([
        ...context.hits.map((hit) => hit.metadata?.eventId),
        ...context.hits.flatMap((hit) => stringArray(hit.metadata?.eventIds)),
      ]),
      usedMemoryIds: context.hits.map((hit) => hit.id),
      actorIds: uniqueStrings([
        ...context.hits.map((hit) => hit.metadata?.actorId),
        ...context.hits.flatMap((hit) => stringArray(hit.metadata?.actorIds)),
      ]),
    }
    const evaluation = scoreMemoryBenchmarkArtifact(
      {
        id: `${sequence.id}:${step.id}:${probe.id}`,
        family: sequence.family,
        taskKind: probe.taskKind ?? 'memory-recall',
        split: sequence.split,
        events: [],
        prompt: probe.query,
        requiredFacts:
          probe.requiredFacts && probe.requiredFacts.length > 0
            ? probe.requiredFacts
            : probe.referenceAnswer
              ? [{ id: `${probe.id}:reference`, anyOf: [probe.referenceAnswer] }]
              : undefined,
        forbiddenFacts: probe.forbiddenFacts,
        expectedEventIds: probe.expectedEventIds,
        expectedActorIds: probe.expectedActorIds,
        referenceAnswer: probe.referenceAnswer,
      },
      artifact,
    )
    return {
      id: probe.id,
      stepId: step.id,
      query: probe.query,
      score: evaluation.score,
      passed: evaluation.passed,
      dimensions: evaluation.dimensions,
      applicableDimensions: evaluation.applicableDimensions ?? Object.keys(evaluation.dimensions),
      notes: evaluation.notes,
      hitIds: context.hits.map((hit) => hit.id),
    }
  }
  if (step.parallelProbes === false) {
    const results: AgentMemorySequenceProbeResult[] = []
    for (const probe of step.probes ?? []) results.push(await run(probe))
    return results
  }
  return Promise.all((step.probes ?? []).map(run))
}

function rankAgentMemoryExperiment(
  candidates: readonly AgentMemoryExperimentCandidate[],
  scenarios: readonly AgentMemorySequenceScenario[],
  campaign: CampaignResult<AgentMemorySequenceArtifact, AgentMemorySequenceScenario>,
  recoveryCostByCandidate: ReadonlyMap<string, number>,
): AgentMemoryExperimentRankingRow[] {
  const scenarioById = new Map(scenarios.map((scenario) => [scenario.id, scenario]))
  const rows = candidates.map((candidate): AgentMemoryExperimentRankingRow => {
    const candidateScenarios = scenarios.filter((scenario) => scenario.candidateId === candidate.id)
    const cells = campaign.cells.filter(
      (cell) => scenarioById.get(cell.scenarioId)?.candidateId === candidate.id,
    )
    const successful = cells.filter((cell) => !cell.error && cell.artifact)
    const dimensionRows = successful.map((cell) => cell.artifact.dimensions)
    return {
      rank: 0,
      candidateId: candidate.id,
      label: candidate.label ?? candidate.id,
      scoreMean: mean(
        cells.map((cell) => (!cell.error && cell.artifact ? cell.artifact.score : 0)),
      ),
      passRate: mean(cells.map((cell) => (!cell.error && cell.artifact?.passed ? 1 : 0))),
      totalSequences: candidateScenarios.length,
      totalCells: cells.length,
      totalProbes: successful.reduce((sum, cell) => sum + cell.artifact.probes.length, 0),
      cellsFailed: cells.filter((cell) => Boolean(cell.error)).length,
      totalCostUsd:
        cells.reduce((sum, cell) => sum + cell.costUsd, 0) +
        (recoveryCostByCandidate.get(candidate.id) ?? 0),
      durationMs: cells.reduce((sum, cell) => sum + cell.durationMs, 0),
      dimensions: meanDimensions(dimensionRows),
    }
  })
  return rows
    .sort(
      (a, b) =>
        Number(a.cellsFailed > 0) - Number(b.cellsFailed > 0) ||
        b.scoreMean - a.scoreMean ||
        b.passRate - a.passRate ||
        a.totalCostUsd - b.totalCostUsd ||
        a.candidateId.localeCompare(b.candidateId),
    )
    .map((row, index) => ({ ...row, rank: index + 1 }))
}

function renderAgentMemoryExperimentRanking(
  rows: readonly AgentMemoryExperimentRankingRow[],
): string {
  return [
    '# Agent Memory Experiment',
    '',
    '| rank | candidate | sequences | cells | probes | failed | score | pass rate | cost | duration ms |',
    '| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(
      (row) =>
        `| ${row.rank} | ${row.label} | ${row.totalSequences} | ${row.totalCells} | ${row.totalProbes} | ${row.cellsFailed} | ${format(row.scoreMean)} | ${format(row.passRate)} | $${format(row.totalCostUsd)} | ${format(row.durationMs)} |`,
    ),
    '',
  ].join('\n')
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

function meanDimensions(rows: readonly Record<string, number>[]): Record<string, number> {
  const values = new Map<string, number[]>()
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (!Number.isFinite(value)) continue
      const bucket = values.get(key) ?? []
      bucket.push(value)
      values.set(key, bucket)
    }
  }
  return Object.fromEntries([...values].map(([key, bucket]) => [key, mean(bucket)]))
}

function countDimensions(rows: readonly (readonly string[])[]): Record<string, number> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    for (const key of new Set(row)) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return Object.fromEntries(counts)
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function mergeScopes(base?: AgentMemoryScope, extra?: AgentMemoryScope): AgentMemoryScope {
  return {
    ...(base ?? {}),
    ...(extra ?? {}),
    tags: { ...(base?.tags ?? {}), ...(extra?.tags ?? {}) },
  }
}

function memoryExperimentBaseScope(
  options: Pick<RunAgentMemoryExperimentOptions, 'experimentId'>,
  candidate: Pick<AgentMemoryExperimentCandidate, 'id' | 'baseScope'>,
  sequenceId: string,
): AgentMemoryScope {
  return mergeScopes(candidate.baseScope, {
    tags: {
      memoryExperimentId: options.experimentId,
      memoryCandidateId: candidate.id,
      memorySequenceId: sequenceId,
    },
  })
}

function sequenceCleanupScopes(sequence: AgentMemorySequence): AgentMemoryScope[] {
  const scopes = new Map<string, AgentMemoryScope>()
  for (const scope of sequence.cleanupScopes ?? []) {
    const normalized = normalizeCleanupScope(scope)
    scopes.set(JSON.stringify(normalized), normalized)
  }
  for (const step of sequence.steps) {
    const candidates = [
      ...(step.scope ? [step.scope] : []),
      ...(step.writes ?? []).map((write) => mergeScopes(step.scope, write.scope)),
      ...(step.probes ?? []).map((probe) => mergeScopes(step.scope, probe.scope)),
    ]
    for (const scope of candidates) {
      const normalized = normalizeCleanupScope(scope)
      scopes.set(JSON.stringify(normalized), normalized)
    }
  }
  return [...scopes.values()]
}

async function clearSequenceScopes(
  memory: AgentMemoryBranch,
  sequence: AgentMemorySequence,
): Promise<void> {
  for (const scope of sequenceCleanupScopes(sequence)) await memory.clear?.(scope)
}

function assertMemorySequences(sequences: readonly AgentMemorySequence[]): void {
  for (const sequence of sequences) {
    assertNonEmptyString(sequence.family, `memory experiment sequence ${sequence.id} family`)
    if (sequence.steps.length === 0) {
      throw new Error(`memory experiment sequence ${sequence.id} has no steps`)
    }
    assertUnique(
      sequence.steps.map((step) => step.id),
      `step in sequence ${sequence.id}`,
    )
    let probeCount = 0
    for (const step of sequence.steps) {
      for (const write of step.writes ?? []) {
        assertNonEmptyString(write.text, `memory experiment write in ${sequence.id}/${step.id}`)
        if (write.id !== undefined) {
          assertNonEmptyString(write.id, `memory experiment write id in ${sequence.id}/${step.id}`)
        }
      }
      assertUnique(
        (step.probes ?? []).map((probe) => probe.id),
        `probe in sequence ${sequence.id} step ${step.id}`,
      )
      for (const probe of step.probes ?? []) {
        probeCount += 1
        assertNonEmptyString(
          probe.query,
          `memory experiment probe query ${sequence.id}/${step.id}/${probe.id}`,
        )
        if (probe.limit !== undefined && (!Number.isSafeInteger(probe.limit) || probe.limit <= 0)) {
          throw new Error(
            `memory experiment probe limit ${sequence.id}/${step.id}/${probe.id} must be a positive safe integer`,
          )
        }
        assertMemoryFactMatchers(
          probe.requiredFacts ?? [],
          `${sequence.id}/${step.id}/${probe.id} requiredFacts`,
        )
        assertMemoryFactMatchers(
          probe.forbiddenFacts ?? [],
          `${sequence.id}/${step.id}/${probe.id} forbiddenFacts`,
        )
        assertStringList(probe.expectedEventIds, `${sequence.id}/${step.id}/${probe.id} event ids`)
        assertStringList(probe.expectedActorIds, `${sequence.id}/${step.id}/${probe.id} actor ids`)
        if (probe.referenceAnswer !== undefined) {
          assertNonEmptyString(
            probe.referenceAnswer,
            `memory experiment reference answer ${sequence.id}/${step.id}/${probe.id}`,
          )
        }
        const hasTarget =
          (probe.requiredFacts?.length ?? 0) > 0 ||
          (probe.forbiddenFacts?.length ?? 0) > 0 ||
          (probe.expectedEventIds?.length ?? 0) > 0 ||
          (probe.expectedActorIds?.length ?? 0) > 0 ||
          Boolean(probe.referenceAnswer?.trim())
        if (!hasTarget) {
          throw new Error(
            `memory experiment probe ${sequence.id}/${step.id}/${probe.id} has no measurable target`,
          )
        }
      }
    }
    if (probeCount === 0) {
      throw new Error(`memory experiment sequence ${sequence.id} has no probes`)
    }
  }
}

function normalizeCleanupScope(scope: AgentMemoryScope): AgentMemoryScope {
  const normalized = compactScope(scope)
  if (normalized.tags && Object.keys(normalized.tags).length === 0) {
    delete normalized.tags
  }
  return normalized
}

function compactScope(scope: AgentMemoryScope): AgentMemoryScope {
  return Object.fromEntries(
    Object.entries(scope).filter(([, value]) => value !== undefined),
  ) as AgentMemoryScope
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined))
}

function uniqueStrings(values: readonly unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string'))]
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

function assertUnique(values: readonly string[], label: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    assertNonEmptyString(value, `memory experiment ${label} id`)
    if (seen.has(value)) throw new Error(`duplicate memory experiment ${label} id: ${value}`)
    seen.add(value)
  }
}

function assertMemoryFactMatchers(
  matchers: readonly KnowledgeMemoryFactMatcher[],
  label: string,
): void {
  assertUnique(
    matchers.map((matcher) => matcher.id),
    `${label} matcher`,
  )
  for (const matcher of matchers) {
    if (matcher.anyOf.length === 0) {
      throw new Error(`memory experiment ${label} matcher ${matcher.id} requires anyOf`)
    }
    assertStringList(matcher.anyOf, `${label} matcher ${matcher.id} anyOf`)
    assertStringList(matcher.sourceEventIds, `${label} matcher ${matcher.id} source event ids`)
    if (matcher.weight !== undefined && (!Number.isFinite(matcher.weight) || matcher.weight <= 0)) {
      throw new Error(
        `memory experiment ${label} matcher ${matcher.id} weight must be a positive finite number`,
      )
    }
  }
}

function assertStringList(values: readonly string[] | undefined, label: string): void {
  if (values === undefined) return
  assertUnique(values, label)
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`)
  }
}

function format(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4) : '0.0000'
}
