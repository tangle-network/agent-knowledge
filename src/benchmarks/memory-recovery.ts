import { join } from 'node:path'

import { canonicalJson } from '@tangle-network/agent-eval'

import type { CampaignStorage, CostLedgerHandle } from '@tangle-network/agent-eval/campaign'

import { stableId } from '../ids'

import {
  appendAttemptJournalEvent,
  assertNoInterruptedPaidCalls,
  hasSettledPaidCall,
  readActiveAttemptJournal,
  reconcileInterruptedMemoryPaidCalls,
  reserveRecoveryAttempts,
} from '../memory/attempt-log'

import {
  createMemoryExecutionPool,
  memoryRecoveryDelayMs,
  releaseMemoryAdapterCreatedAfterAbort,
  runBoundedMemoryLifecycle,
  sleepForMemoryRecovery,
} from '../memory/lifecycle'

import type { OwnedAgentMemoryRunLease } from '../memory/run-control'

import type { AgentMemoryAdapter, AgentMemoryScope } from '../memory/types'

import type { MemoryAdapterBenchmarkCandidate } from './types'

export function memoryAdapterBenchmarkExpectedId(
  candidate: MemoryAdapterBenchmarkCandidate,
): string {
  return candidate.adapterId ?? candidate.id
}

export async function recoverMemoryAdapterBenchmarkAttempts(input: {
  candidates: readonly MemoryAdapterBenchmarkCandidate[]
  storage: CampaignStorage
  attemptLogPath: string
  lease: OwnedAgentMemoryRunLease
  cleanupTimeoutMs: number
  maxConcurrency: number
  now?: () => Date
  runDir: string
  costLedger: CostLedgerHandle
  costPhase: string
  maxRecoveryAttempts: number
  recoveryLogPath: string
  maxRecoveryRetriesPerAttempt: number
}): Promise<void> {
  let attempts = readActiveMemoryBenchmarkAttempts(input.storage, input.attemptLogPath)
  if (attempts.length > input.maxRecoveryAttempts) {
    throw new Error(
      `memory adapter benchmark has ${attempts.length} unfinished attempts; maxRecoveryAttempts is ${input.maxRecoveryAttempts}`,
    )
  }
  const candidateById = new Map(input.candidates.map((candidate) => [candidate.id, candidate]))
  for (const attempt of attempts) {
    const candidate = candidateById.get(attempt.candidateId)
    if (!candidate) {
      throw new Error(
        `cannot recover memory benchmark attempts: candidate '${attempt.candidateId}' is missing; pass it in recoveryCandidates`,
      )
    }
    assertMemoryBenchmarkAttemptCandidateMatches(attempt, candidate)
  }

  reconcileInterruptedMemoryPaidCalls(input.costLedger)
  assertNoInterruptedPaidCalls(input.costLedger, 'memory adapter benchmark recovery')

  for (const attempt of attempts) {
    const candidate = candidateById.get(attempt.candidateId)!
    const costUsd = candidate.costUsdPerCase ?? 0
    if (
      costUsd > 0 &&
      !hasSettledPaidCall(input.costLedger, memoryBenchmarkCostCallId(attempt, 'execute', 0))
    ) {
      appendMemoryBenchmarkAttemptEvent(input.storage, input.attemptLogPath, {
        ...attempt,
        status: 'cleaned',
        recovery: true,
        recordedAt: (input.now ?? (() => new Date()))().toISOString(),
      })
    }
  }
  attempts = readActiveMemoryBenchmarkAttempts(input.storage, input.attemptLogPath)
  const recoveryGenerations = reserveRecoveryAttempts({
    storage: input.storage,
    path: input.recoveryLogPath,
    attemptIds: attempts.map((attempt) => attempt.attemptId),
    maxRetriesPerAttempt: input.maxRecoveryRetriesPerAttempt,
    label: 'memory benchmark recovery attempt log',
    now: input.now,
  })
  const grouped = groupMemoryBenchmarkAttempts(attempts)
  const pool = createMemoryExecutionPool(input.maxConcurrency)
  const settled = await Promise.allSettled(
    [...grouped]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([candidateId, candidateAttempts]) =>
        pool.run(async () => {
          await input.lease.assertOwned()
          const candidate = candidateById.get(candidateId)
          if (!candidate) {
            throw new Error(
              `cannot recover memory benchmark attempts: candidate '${candidateId}' is missing; pass it in recoveryCandidates`,
            )
          }
          for (const attempt of candidateAttempts) {
            assertMemoryBenchmarkAttemptCandidateMatches(attempt, candidate)
            if (recoveryGenerations.get(attempt.attemptId) === undefined) {
              throw new Error(
                `missing recovery generation for memory benchmark attempt '${attempt.attemptId}'`,
              )
            }
          }

          let recoveryAttemptsStarted = 0
          let adapterCreationExternalCallAttempted = false
          const cleared: MemoryAdapterBenchmarkAttemptEvent[] = []
          const recover = async (): Promise<void> => {
            let adapter: AgentMemoryAdapter | undefined
            let primaryError: unknown
            try {
              const abortController = new AbortController()
              const creation = Promise.resolve().then(() =>
                candidate.createAdapter({
                  purpose: 'recovery',
                  signal: abortController.signal,
                  markExternalCall: () => {
                    adapterCreationExternalCallAttempted = true
                  },
                }),
              )
              releaseMemoryAdapterCreatedAfterAbort({
                creation,
                signal: abortController.signal,
              })
              adapter = await runBoundedMemoryLifecycle({
                operation: `${candidate.id}: benchmark recovery adapter creation`,
                timeoutMs: input.cleanupTimeoutMs,
                abortController,
                run: () => creation,
              })
              assertScopedMemoryBenchmarkAdapter(adapter)
              for (const attempt of candidateAttempts) {
                if (adapter.id !== attempt.adapterId) {
                  throw new Error(
                    `cannot recover memory benchmark attempt '${attempt.attemptId}': adapter changed from '${attempt.adapterId}' to '${adapter.id}'`,
                  )
                }
              }
              await sleepForMemoryRecovery(
                memoryRecoveryDelayMs(adapter),
                () => input.lease.assertOwned(),
                input.cleanupTimeoutMs,
                `${candidate.id}: benchmark recovery visibility wait`,
              )
              for (const attempt of candidateAttempts.sort((left, right) =>
                left.attemptId.localeCompare(right.attemptId),
              )) {
                await input.lease.assertOwned()
                try {
                  recoveryAttemptsStarted += 1
                  await runBoundedMemoryLifecycle({
                    operation: `${candidate.id}: abandoned benchmark attempt cleanup`,
                    timeoutMs: input.cleanupTimeoutMs,
                    resource: adapter,
                    run: () => adapter!.clear!(attempt.scope),
                  })
                  await input.lease.assertOwned()
                  cleared.push(attempt)
                } catch (error) {
                  primaryError = primaryError
                    ? new AggregateError(
                        [primaryError, error],
                        `${candidate.id}: multiple benchmark attempts failed recovery`,
                      )
                    : error
                }
              }
            } catch (error) {
              primaryError = primaryError
                ? new AggregateError(
                    [primaryError, error],
                    `${candidate.id}: benchmark recovery failed in multiple operations`,
                  )
                : error
            }

            let closeError: unknown
            if (adapter) {
              try {
                await runBoundedMemoryLifecycle({
                  operation: `${candidate.id}: benchmark recovery adapter close`,
                  timeoutMs: input.cleanupTimeoutMs,
                  resource: adapter,
                  run: () => adapter!.close?.(),
                })
              } catch (error) {
                closeError = error
              }
            }
            let journalError: unknown
            if (!closeError) {
              try {
                for (const attempt of cleared) {
                  await input.lease.assertOwned()
                  appendMemoryBenchmarkAttemptEvent(input.storage, input.attemptLogPath, {
                    ...attempt,
                    status: 'cleaned',
                    recovery: true,
                    recordedAt: (input.now ?? (() => new Date()))().toISOString(),
                  })
                }
              } catch (error) {
                journalError = error
              }
            }
            const failures = [primaryError, closeError, journalError].filter(
              (error) => error !== undefined,
            )
            if (failures.length > 1) {
              throw new AggregateError(
                failures,
                `${candidate.id}: benchmark attempt recovery, adapter close, or cleanup journal failed`,
              )
            }
            if (primaryError) throw primaryError
            if (closeError) throw closeError
            if (journalError) throw journalError
          }

          const recoveryCostUsd = candidate.recoveryCostUsdPerAttempt ?? 0
          const adapterCreationCostUsd = candidate.adapterCreationCostUsd ?? 0
          const maximumCostUsd = adapterCreationCostUsd + recoveryCostUsd * candidateAttempts.length
          const actualCostUsd = (): number =>
            (adapterCreationExternalCallAttempted ? adapterCreationCostUsd : 0) +
            recoveryCostUsd * recoveryAttemptsStarted
          let recoveryError: unknown
          if (maximumCostUsd === 0) {
            try {
              await recover()
            } catch (error) {
              recoveryError = error
            }
          } else {
            const receipt = {
              model: candidate.id,
              inputTokens: 0,
              outputTokens: 0,
            } as const
            const tags = memoryBenchmarkRecoveryCostTags(input.runDir, candidate.id)
            const paid = await input.costLedger.runPaidCall({
              callId: memoryBenchmarkRecoveryCostCallId(
                candidate,
                candidateAttempts,
                recoveryGenerations,
              ),
              channel: 'driver',
              phase: `${input.costPhase}.${candidate.id}.recovery`,
              actor: `agent-knowledge:memory-adapter-recovery:${candidate.id}`,
              model: candidate.id,
              tags,
              maximumCharge: { externallyEnforcedMaximumUsd: maximumCostUsd },
              execute: recover,
              receipt: () => ({ ...receipt, actualCostUsd: actualCostUsd() }),
              receiptFromError: () => ({
                ...receipt,
                actualCostUsd: actualCostUsd(),
              }),
            })
            if (!paid.succeeded) recoveryError = paid.error
          }
          if (recoveryError) throw recoveryError
        }),
      ),
  )
  const failures = settled.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  )
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(failures, 'multiple memory benchmark candidates failed recovery')
  }
}

function groupMemoryBenchmarkAttempts(
  attempts: readonly MemoryAdapterBenchmarkAttemptEvent[],
): Map<string, MemoryAdapterBenchmarkAttemptEvent[]> {
  const grouped = new Map<string, MemoryAdapterBenchmarkAttemptEvent[]>()
  for (const attempt of attempts) {
    const group = grouped.get(attempt.candidateId) ?? []
    group.push(attempt)
    grouped.set(attempt.candidateId, group)
  }
  return grouped
}

export function memoryBenchmarkCostCallId(
  attempt: MemoryAdapterBenchmarkAttemptEvent,
  purpose: 'execute' | 'recovery',
  generation: number,
): string {
  return stableId(
    'memory_benchmark_cost_call',
    canonicalJson({
      purpose,
      generation,
      attemptId: attempt.attemptId,
      candidateId: attempt.candidateId,
      candidateRef: attempt.candidateRef,
      adapterId: attempt.adapterId,
      adapterCreationCostUsd: attempt.adapterCreationCostUsd,
      costUsdPerCase: attempt.costUsdPerCase,
      recoveryCostUsdPerAttempt: attempt.recoveryCostUsdPerAttempt,
      caseId: attempt.caseId,
      cellId: attempt.cellId,
    }),
  )
}

function memoryBenchmarkRecoveryCostCallId(
  candidate: MemoryAdapterBenchmarkCandidate,
  attempts: readonly MemoryAdapterBenchmarkAttemptEvent[],
  generations: ReadonlyMap<string, number>,
): string {
  return stableId(
    'memory_benchmark_recovery_cost_call',
    canonicalJson({
      candidateId: candidate.id,
      candidateRef: candidate.ref,
      adapterCreationCostUsd: candidate.adapterCreationCostUsd ?? 0,
      recoveryCostUsdPerAttempt: candidate.recoveryCostUsdPerAttempt ?? 0,
      attempts: attempts
        .map((attempt) => ({
          attemptId: attempt.attemptId,
          generation: generations.get(attempt.attemptId),
        }))
        .sort((left, right) => left.attemptId.localeCompare(right.attemptId)),
    }),
  )
}

function memoryBenchmarkRecoveryCostTags(
  runDir: string,
  candidateId: string,
): Record<string, string> {
  return {
    runDir: join(runDir, candidateId),
    candidateId,
    memoryRecovery: 'benchmark',
  }
}

export function appendMemoryBenchmarkAttemptEvent(
  storage: CampaignStorage,
  path: string,
  event: MemoryAdapterBenchmarkAttemptEvent,
): void {
  appendAttemptJournalEvent({
    storage,
    path,
    event,
    label: 'memory benchmark attempt log',
  })
}

function readActiveMemoryBenchmarkAttempts(
  storage: CampaignStorage,
  path: string,
): MemoryAdapterBenchmarkAttemptEvent[] {
  return readActiveAttemptJournal({
    storage,
    path,
    label: 'memory benchmark attempt log',
    parse: parseMemoryBenchmarkAttemptEvent,
    id: (event) => event.attemptId,
    sameAttempt: sameMemoryBenchmarkAttempt,
  })
}

function parseMemoryBenchmarkAttemptEvent(
  value: unknown,
  path: string,
  line: number,
): MemoryAdapterBenchmarkAttemptEvent {
  const event = value as Partial<MemoryAdapterBenchmarkAttemptEvent> | null
  const valid =
    typeof event === 'object' &&
    event !== null &&
    event.schema === 3 &&
    (event.status === 'started' || event.status === 'cleaned') &&
    isNonEmptyString(event.attemptId) &&
    isNonEmptyString(event.candidateId) &&
    isNonEmptyString(event.candidateRef) &&
    isNonEmptyString(event.adapterId) &&
    isNonEmptyString(event.caseId) &&
    isNonEmptyString(event.cellId) &&
    isAgentMemoryScope(event.scope) &&
    typeof event.adapterCreationCostUsd === 'number' &&
    Number.isFinite(event.adapterCreationCostUsd) &&
    event.adapterCreationCostUsd >= 0 &&
    typeof event.costUsdPerCase === 'number' &&
    Number.isFinite(event.costUsdPerCase) &&
    event.costUsdPerCase >= 0 &&
    typeof event.recoveryCostUsdPerAttempt === 'number' &&
    Number.isFinite(event.recoveryCostUsdPerAttempt) &&
    event.recoveryCostUsdPerAttempt >= 0 &&
    typeof event.recordedAt === 'string' &&
    !Number.isNaN(Date.parse(event.recordedAt)) &&
    typeof event.recovery === 'boolean'
  if (!valid) {
    throw new Error(`invalid memory benchmark attempt event in '${path}' line ${line}`)
  }
  return value as MemoryAdapterBenchmarkAttemptEvent
}

function sameMemoryBenchmarkAttempt(
  left: MemoryAdapterBenchmarkAttemptEvent,
  right: MemoryAdapterBenchmarkAttemptEvent,
): boolean {
  return (
    left.attemptId === right.attemptId &&
    left.candidateId === right.candidateId &&
    left.candidateRef === right.candidateRef &&
    left.adapterId === right.adapterId &&
    left.caseId === right.caseId &&
    left.cellId === right.cellId &&
    canonicalJson(left.scope) === canonicalJson(right.scope) &&
    left.adapterCreationCostUsd === right.adapterCreationCostUsd &&
    left.costUsdPerCase === right.costUsdPerCase &&
    left.recoveryCostUsdPerAttempt === right.recoveryCostUsdPerAttempt
  )
}

function assertMemoryBenchmarkAttemptCandidateMatches(
  attempt: MemoryAdapterBenchmarkAttemptEvent,
  candidate: MemoryAdapterBenchmarkCandidate,
): void {
  if (attempt.candidateRef !== candidate.ref) {
    throw new Error(
      `cannot recover memory benchmark attempt '${attempt.attemptId}': candidate ref changed from '${attempt.candidateRef}' to '${candidate.ref}'`,
    )
  }
  const expectedAdapterId = memoryAdapterBenchmarkExpectedId(candidate)
  if (attempt.adapterId !== expectedAdapterId) {
    throw new Error(
      `cannot recover memory benchmark attempt '${attempt.attemptId}': adapter id changed from '${attempt.adapterId}' to '${expectedAdapterId}'`,
    )
  }
  const executionCost = candidate.costUsdPerCase ?? 0
  const adapterCreationCost = candidate.adapterCreationCostUsd ?? 0
  const recoveryCost = candidate.recoveryCostUsdPerAttempt ?? 0
  if (
    adapterCreationCost !== attempt.adapterCreationCostUsd ||
    executionCost !== attempt.costUsdPerCase ||
    recoveryCost !== attempt.recoveryCostUsdPerAttempt
  ) {
    throw new Error(
      `cannot recover memory benchmark attempt '${attempt.attemptId}': candidate cost settings changed; start a new run or restore the recorded costs`,
    )
  }
}

export function assertScopedMemoryBenchmarkAdapter(adapter: AgentMemoryAdapter): void {
  if (adapter.branchIsolation?.mode !== 'scoped') {
    throw new Error(
      `${adapter.id}: direct memory benchmark requires branchIsolation mode scoped; use runAgentMemoryExperiment for dedicated instances`,
    )
  }
  if (!adapter.clear) {
    throw new Error(`${adapter.id}: direct memory benchmark requires exact scoped clear`)
  }
}

function isAgentMemoryScope(value: unknown): value is AgentMemoryScope {
  if (!isRecordValue(value)) return false
  const allowed = new Set([
    'tenantId',
    'userId',
    'agentId',
    'teamId',
    'runId',
    'sessionId',
    'namespace',
    'tags',
  ])
  if (Object.keys(value).some((key) => !allowed.has(key))) return false
  for (const key of [
    'tenantId',
    'userId',
    'agentId',
    'teamId',
    'runId',
    'sessionId',
    'namespace',
  ]) {
    if (value[key] !== undefined && typeof value[key] !== 'string') return false
  }
  if (value.tags === undefined) return true
  return (
    isRecordValue(value.tags) &&
    Object.values(value.tags).every((entry) => typeof entry === 'string')
  )
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface MemoryAdapterBenchmarkAttemptEvent {
  schema: 3
  status: 'started' | 'cleaned'
  attemptId: string
  candidateId: string
  candidateRef: string
  adapterId: string
  caseId: string
  cellId: string
  scope: AgentMemoryScope
  adapterCreationCostUsd: number
  costUsdPerCase: number
  recoveryCostUsdPerAttempt: number
  recordedAt: string
  recovery: boolean
}
