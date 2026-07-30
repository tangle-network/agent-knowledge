import { canonicalJson } from '@tangle-network/agent-eval'
import {
  type CampaignStorage,
  type CostLedgerHandle,
  canonicalDigest,
} from '@tangle-network/agent-eval/campaign'
import { stableId } from '../../ids'
import {
  appendAttemptJournalEvent,
  assertNoInterruptedPaidCalls,
  hasSettledPaidCall,
  readActiveAttemptJournal,
  reconcileInterruptedMemoryPaidCalls,
  reserveRecoveryAttempts,
} from '../attempt-log'
import { type AgentMemoryBranch, createAgentMemoryBranch } from '../branch'
import {
  createBoundedMemoryAdapter,
  createMemoryExecutionPool,
  memoryRecoveryDelayMs,
  resolveMemoryCleanupTimeoutMs,
  runBoundedMemoryLifecycle,
  sleepForMemoryRecovery,
} from '../lifecycle'
import type { AgentMemoryAdapter } from '../types'
import { createAgentMemoryCostRecorder } from './cost'
import {
  AgentMemoryCleanupError,
  clearSequenceScopes,
  memoryExperimentBaseScope,
  sequenceCleanupScopes,
  trackExternalMemoryCalls,
} from './runtime'
import type {
  AgentMemoryAttemptEvent,
  AgentMemoryExperimentCandidate,
  AgentMemorySequence,
  OwnedMemoryExperimentRunLease,
  RunAgentMemoryExperimentOptions,
} from './types'

export async function recoverAbandonedMemoryAttempts(input: {
  options: RunAgentMemoryExperimentOptions
  storage: CampaignStorage
  runDir: string
  attemptLogPath: string
  candidateById: ReadonlyMap<string, AgentMemoryExperimentCandidate>
  sequenceById: ReadonlyMap<string, AgentMemorySequence>
  lease: OwnedMemoryExperimentRunLease
  maxConcurrency: number
  costLedger: CostLedgerHandle
  maxRecoveryAttempts: number
  recoveryLogPath: string
  maxRecoveryRetriesPerAttempt: number
}): Promise<void> {
  input.options.signal?.throwIfAborted()
  let attempts = readActiveMemoryAttempts(input.storage, input.attemptLogPath)
  if (attempts.length > input.maxRecoveryAttempts) {
    throw new Error(
      `memory experiment has ${attempts.length} unfinished attempts; maxRecoveryAttempts is ${input.maxRecoveryAttempts}`,
    )
  }
  for (const attempt of attempts) {
    const candidate = input.candidateById.get(attempt.candidateId)
    if (!candidate) {
      throw new Error(
        `cannot recover memory branch '${attempt.branchId}': candidate '${attempt.candidateId}' is missing; pass it in recoveryCandidates`,
      )
    }
    assertMemoryAttemptCandidateMatches(attempt, candidate)
    const sequence = input.sequenceById.get(attempt.sequenceId)
    if (!sequence) {
      throw new Error(
        `cannot recover memory branch '${attempt.branchId}': sequence '${attempt.sequenceId}' is missing`,
      )
    }
    assertMemoryAttemptSequenceMatches(attempt, sequence)
    if ((input.options.cleanupBranches ?? true) !== attempt.cleanupBranches) {
      throw new Error(`cannot recover memory branch '${attempt.branchId}': cleanupBranches changed`)
    }
  }

  reconcileInterruptedMemoryPaidCalls(input.costLedger)
  assertNoInterruptedPaidCalls(input.costLedger, 'memory experiment recovery')

  for (const attempt of attempts) {
    const candidate = input.candidateById.get(attempt.candidateId)!
    const executionCostUsd = candidate.externalCostUsdPerSequence ?? 0
    if (
      executionCostUsd > 0 &&
      !hasSettledPaidCall(input.costLedger, memoryAttemptCostCallId(attempt, 'execute', 0))
    ) {
      await input.lease.assertOwned()
      appendMemoryAttemptEvent(input.storage, input.attemptLogPath, {
        ...attempt,
        status: 'cleaned',
        recovery: true,
        recordedAt: (input.options.now ?? (() => new Date()))().toISOString(),
      })
    }
  }
  attempts = readActiveMemoryAttempts(input.storage, input.attemptLogPath)
  const recoveryGenerations = new Map<string, number>()
  for (const attempt of attempts.sort((left, right) =>
    left.branchId.localeCompare(right.branchId),
  )) {
    await input.lease.assertOwned()
    const reserved = reserveRecoveryAttempts({
      storage: input.storage,
      path: input.recoveryLogPath,
      attemptIds: [attempt.branchId],
      maxRetriesPerAttempt: input.maxRecoveryRetriesPerAttempt,
      label: 'memory recovery attempt log',
      now: input.options.now,
    })
    recoveryGenerations.set(attempt.branchId, reserved.get(attempt.branchId)!)
  }
  const pool = createMemoryExecutionPool(input.maxConcurrency)
  const settled = await Promise.allSettled(
    attempts.map((attempt) =>
      pool.run(async () => {
        input.options.signal?.throwIfAborted()
        await input.lease.assertOwned()
        const candidate = input.candidateById.get(attempt.candidateId)
        if (!candidate) {
          throw new Error(
            `cannot recover memory branch '${attempt.branchId}': candidate '${attempt.candidateId}' is missing; pass it in recoveryCandidates`,
          )
        }
        assertMemoryAttemptCandidateMatches(attempt, candidate)
        const sequence = input.sequenceById.get(attempt.sequenceId)
        if (!sequence) {
          throw new Error(
            `cannot recover memory branch '${attempt.branchId}': sequence '${attempt.sequenceId}' is missing`,
          )
        }
        assertMemoryAttemptSequenceMatches(attempt, sequence)
        if ((input.options.cleanupBranches ?? true) !== attempt.cleanupBranches) {
          throw new Error(
            `cannot recover memory branch '${attempt.branchId}': cleanupBranches changed`,
          )
        }
        const recoveryCostUsd = candidate.externalRecoveryCostUsdPerAttempt ?? 0
        const recoveryGeneration = recoveryGenerations.get(attempt.branchId)
        if (recoveryGeneration === undefined) {
          throw new Error(`missing recovery generation for memory branch '${attempt.branchId}'`)
        }
        let externalRecoveryAttempted = false
        const costRecorder = createAgentMemoryCostRecorder({
          candidateRef: candidate.ref,
          maximumCostUsd: recoveryCostUsd,
          operation: `${candidate.id}: memory recovery`,
        })
        const recover = async (): Promise<void> => {
          await recoverMemoryAttempt({
            options: input.options,
            candidate,
            sequence,
            attempt,
            lease: input.lease,
            onExternalCall: () => {
              externalRecoveryAttempted = true
            },
            recordExternalCost: (actualCostUsd) => {
              externalRecoveryAttempted = true
              costRecorder.record(actualCostUsd)
            },
          })
          await input.lease.assertOwned()
          appendMemoryAttemptEvent(input.storage, input.attemptLogPath, {
            ...attempt,
            status: 'cleaned',
            recovery: true,
            recordedAt: (input.options.now ?? (() => new Date()))().toISOString(),
          })
        }
        if (recoveryCostUsd === 0) {
          await recover()
        } else {
          const tags = memoryRecoveryCostTags(input.runDir, candidate.id, attempt.branchId)
          const paid = await input.costLedger.runPaidCall({
            callId: memoryAttemptCostCallId(attempt, 'recovery', recoveryGeneration),
            channel: 'driver',
            phase: `${input.options.costPhase ?? 'memory.experiment'}.recovery`,
            actor: `agent-knowledge:memory-recovery:${candidate.id}`,
            model: candidate.ref,
            tags,
            maximumCharge: { externallyEnforcedMaximumUsd: recoveryCostUsd },
            execute: recover,
            receipt: () => costRecorder.receipt(externalRecoveryAttempted),
            receiptFromError: () => costRecorder.receipt(externalRecoveryAttempted),
          })
          if (!paid.succeeded) throw paid.error
        }
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
}

async function recoverMemoryAttempt(input: {
  options: RunAgentMemoryExperimentOptions
  candidate: AgentMemoryExperimentCandidate
  sequence: AgentMemorySequence
  attempt: AgentMemoryAttemptEvent
  lease: OwnedMemoryExperimentRunLease
  onExternalCall(): void
  recordExternalCost(actualCostUsd: number): void
}): Promise<void> {
  const { options, candidate, sequence, attempt, lease, onExternalCall, recordExternalCost } = input
  const cleanupBranches = attempt.cleanupBranches
  const cleanupTimeoutMs = resolveMemoryCleanupTimeoutMs(
    options.cleanupTimeoutMs,
    `${candidate.id}: abandoned branch recovery`,
  )
  let rawAdapter: AgentMemoryAdapter | undefined
  let adapter: AgentMemoryAdapter | undefined
  let memory: AgentMemoryBranch | undefined
  let primaryError: unknown
  try {
    options.signal?.throwIfAborted()
    const recovered = await createBoundedMemoryAdapter({
      operation: `${candidate.id}: recovery adapter creation`,
      timeoutMs: cleanupTimeoutMs,
      signal: options.signal,
      create: (signal) =>
        candidate.createAdapter({
          branchId: attempt.branchId,
          purpose: 'recovery',
          signal,
          maximumCostUsd: candidate.externalRecoveryCostUsdPerAttempt ?? 0,
          markExternalCall: onExternalCall,
          recordExternalCost,
        }),
      dispose: candidate.disposeAdapter
        ? async (created) => {
            onExternalCall()
            await candidate.disposeAdapter?.(created)
          }
        : undefined,
    })
    options.signal?.throwIfAborted()
    await lease.assertOwned()
    if (recovered === null) return
    rawAdapter = recovered
    adapter = trackExternalMemoryCalls(recovered, onExternalCall)
    const recoveryDelayMs = memoryRecoveryDelayMs(adapter)
    await sleepForMemoryRecovery(
      recoveryDelayMs,
      () => lease.assertOwned(),
      cleanupTimeoutMs,
      `${candidate.id}: abandoned branch recovery visibility wait`,
      options.signal,
    )
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
        baseScope: memoryExperimentBaseScope(candidate),
      })
      await runBoundedMemoryLifecycle({
        operation: `${candidate.id}: abandoned branch cleanup`,
        timeoutMs: cleanupTimeoutMs,
        resource: adapter,
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
        resource: adapter,
        run: async () => {
          if (memory && cleanupOwned) {
            await memory.close?.()
          } else {
            if (cleanupOwned && adapter!.flush) {
              await adapter!.flush()
            }
            await adapter!.close?.()
          }
        },
      })
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (cleanupOwned) {
      try {
        if (candidate.disposeAdapter) onExternalCall()
        await runBoundedMemoryLifecycle({
          operation: `${candidate.id}: recovery adapter disposal`,
          timeoutMs: cleanupTimeoutMs,
          resource: adapter,
          run: () => candidate.disposeAdapter?.(rawAdapter!),
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

export function memoryAttemptCostCallId(
  attempt: AgentMemoryAttemptEvent,
  purpose: 'execute' | 'recovery',
  generation: number,
): string {
  return stableId(
    'memory_cost_call',
    canonicalJson({
      purpose,
      generation,
      branchId: attempt.branchId,
      candidateId: attempt.candidateId,
      candidateRef: attempt.candidateRef,
      externalCostUsdPerSequence: attempt.externalCostUsdPerSequence,
      externalRecoveryCostUsdPerAttempt: attempt.externalRecoveryCostUsdPerAttempt,
      sequenceId: attempt.sequenceId,
      sequenceRef: attempt.sequenceRef,
      rep: attempt.rep,
      seed: attempt.seed,
    }),
  )
}

function memoryRecoveryCostTags(
  runDir: string,
  candidateId: string,
  branchId: string,
): Record<string, string> {
  return {
    runDir,
    candidateId,
    branchId,
    memoryRecovery: 'attempt',
  }
}

export function memoryAttemptEvent(input: {
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
    status: input.status,
    branchId: input.branchId,
    candidateId: input.candidate.id,
    candidateRef: input.candidate.ref,
    sequenceId: input.sequence.id,
    sequenceRef: canonicalDigest(input.sequence),
    rep: input.rep,
    seed: input.seed,
    cleanupBranches: input.cleanupBranches ?? true,
    externalCostUsdPerSequence: input.candidate.externalCostUsdPerSequence ?? 0,
    externalRecoveryCostUsdPerAttempt: input.candidate.externalRecoveryCostUsdPerAttempt ?? 0,
    recordedAt: (input.now ?? (() => new Date()))().toISOString(),
    recovery: input.recovery,
  }
}

export function appendMemoryAttemptEvent(
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
    (event.status === 'started' || event.status === 'cleaned') &&
    typeof event.branchId === 'string' &&
    event.branchId.length > 0 &&
    typeof event.candidateId === 'string' &&
    event.candidateId.length > 0 &&
    typeof event.candidateRef === 'string' &&
    event.candidateRef.length > 0 &&
    typeof event.sequenceId === 'string' &&
    event.sequenceId.length > 0 &&
    typeof event.sequenceRef === 'string' &&
    /^sha256:[a-f0-9]{64}$/.test(event.sequenceRef) &&
    Number.isSafeInteger(event.rep) &&
    Number.isSafeInteger(event.seed) &&
    typeof event.cleanupBranches === 'boolean' &&
    typeof event.externalCostUsdPerSequence === 'number' &&
    Number.isFinite(event.externalCostUsdPerSequence) &&
    event.externalCostUsdPerSequence >= 0 &&
    typeof event.externalRecoveryCostUsdPerAttempt === 'number' &&
    Number.isFinite(event.externalRecoveryCostUsdPerAttempt) &&
    event.externalRecoveryCostUsdPerAttempt >= 0 &&
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
    left.sequenceRef === right.sequenceRef &&
    left.rep === right.rep &&
    left.seed === right.seed &&
    left.cleanupBranches === right.cleanupBranches &&
    left.externalCostUsdPerSequence === right.externalCostUsdPerSequence &&
    left.externalRecoveryCostUsdPerAttempt === right.externalRecoveryCostUsdPerAttempt
  )
}

function assertMemoryAttemptSequenceMatches(
  attempt: AgentMemoryAttemptEvent,
  sequence: AgentMemorySequence,
): void {
  if (canonicalDigest(sequence) !== attempt.sequenceRef) {
    throw new Error(
      `cannot recover memory branch '${attempt.branchId}': sequence '${attempt.sequenceId}' changed; restore the recorded sequence before cleanup`,
    )
  }
}

function assertMemoryAttemptCandidateMatches(
  attempt: AgentMemoryAttemptEvent,
  candidate: AgentMemoryExperimentCandidate,
): void {
  if (candidate.ref !== attempt.candidateRef) {
    throw new Error(
      `cannot recover memory branch '${attempt.branchId}': candidate ref changed from '${attempt.candidateRef}' to '${candidate.ref}'`,
    )
  }
  const executionCost = candidate.externalCostUsdPerSequence ?? 0
  const recoveryCost = candidate.externalRecoveryCostUsdPerAttempt ?? 0
  if (
    executionCost !== attempt.externalCostUsdPerSequence ||
    recoveryCost !== attempt.externalRecoveryCostUsdPerAttempt
  ) {
    throw new Error(
      `cannot recover memory branch '${attempt.branchId}': candidate cost settings changed; start a new run or restore the recorded costs`,
    )
  }
}
