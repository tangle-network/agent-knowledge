import { randomUUID } from 'node:crypto'
import type { CampaignStorage, DispatchContext } from '@tangle-network/agent-eval/campaign'
import { scoreMemoryBenchmarkArtifact } from '../../benchmarks/index'
import { stableId } from '../../ids'
import { type AgentMemoryBranch, createAgentMemoryBranch } from '../branch'
import { resolveMemoryCleanupTimeoutMs, runBoundedMemoryLifecycle } from '../lifecycle'
import type { AgentMemoryAdapter } from '../types'
import { createAgentMemoryCostRecorder } from './cost'
import { createAgentMemoryExecutionContext } from './execution-context'
import { countDimensions, mean, meanDimensions } from './metrics'
import { appendMemoryAttemptEvent, memoryAttemptCostCallId, memoryAttemptEvent } from './recovery'
import {
  AgentMemoryCleanupError,
  clearSequenceScopes,
  memoryExperimentBaseScope,
  mergeScopes,
  sequenceCleanupScopes,
  trackExternalMemoryCalls,
} from './runtime'
import type {
  AgentMemoryExecutionStep,
  AgentMemoryExperimentCandidate,
  AgentMemorySequence,
  AgentMemorySequenceArtifact,
  AgentMemorySequenceProbe,
  AgentMemorySequenceProbeResult,
  AgentMemorySequenceScenario,
  AgentMemorySequenceStep,
  OwnedMemoryExperimentRunLease,
  RunAgentMemoryExperimentOptions,
} from './types'
import { stringArray, uniqueStrings } from './validation'

export async function runSequenceCell(input: {
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

  let externalCallAttempted = false
  const costRecorder = createAgentMemoryCostRecorder({
    candidateRef: candidate.ref,
    maximumCostUsd: costUsd,
    operation: `${candidate.id}: memory sequence`,
  })
  const appendCleanedAttempt = (priorError?: unknown): void => {
    try {
      appendMemoryAttemptEvent(storage, attemptLogPath, {
        ...attempt,
        status: 'cleaned',
        recordedAt: (options.now ?? (() => new Date()))().toISOString(),
      })
    } catch (error) {
      throw new AgentMemoryCleanupError(
        [...(priorError ? [priorError] : []), error],
        `${candidate.id}: memory branch cleanup could not be recorded`,
      )
    }
  }
  const execute = async (): Promise<AgentMemorySequenceArtifact> => {
    context.signal.throwIfAborted()
    await lease.assertOwned()
    let rawAdapter: AgentMemoryAdapter | undefined
    let adapter: AgentMemoryAdapter | undefined
    let memory: AgentMemoryBranch | undefined
    let primaryError: unknown
    let completedArtifact: AgentMemorySequenceArtifact | undefined
    let finalClearStarted = false
    let finalClearCompleted = false
    try {
      const created = await candidate.createAdapter({
        branchId,
        purpose: 'execute',
        signal: context.signal,
        maximumCostUsd: costUsd,
        markExternalCall: () => {
          externalCallAttempted = true
        },
        recordExternalCost: (actualCostUsd) => {
          externalCallAttempted = true
          costRecorder.record(actualCostUsd)
        },
      })
      if (!created) throw new Error(`${candidate.id}: createAdapter returned no execution adapter`)
      rawAdapter = created
      adapter = trackExternalMemoryCalls(created, () => {
        externalCallAttempted = true
      })
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
      const probes: AgentMemorySequenceProbeResult[] = []
      for (const [ordinal, step] of scenario.sequence.steps.entries()) {
        context.signal.throwIfAborted()
        await lease.assertOwned()
        await writeStep(memory, step)
        await lease.assertOwned()
        if (options.executeStep) {
          const execution = createAgentMemoryExecutionContext(context, scenario.sequence)
          try {
            await options.executeStep({
              memory,
              candidateId: candidate.id,
              step: executionStep(step, ordinal),
              context: execution.context,
            })
          } finally {
            execution.dispose()
          }
        }
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
          resource: adapter,
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
          resource: adapter,
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
          resource: adapter,
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
            resource: adapter,
            run: () => {
              if (candidate.disposeAdapter) externalCallAttempted = true
              return candidate.disposeAdapter?.(rawAdapter!)
            },
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
    if (cleanupOwned && cleanupErrors.length === 0) appendCleanedAttempt(primaryError)
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

  if (costUsd === 0) {
    let artifact: AgentMemorySequenceArtifact | undefined
    let error: unknown
    try {
      artifact = await execute()
    } catch (caught) {
      error = caught
    }
    if (error) throw error
    if (!artifact) throw new Error(`${candidate.id}: memory sequence produced no result`)
    return artifact
  }
  const paid = await context.cost.runPaidCall({
    callId: memoryAttemptCostCallId(attempt, 'execute', 0),
    actor: `agent-knowledge:memory-experiment:${candidate.id}`,
    model: candidate.ref,
    maximumCharge: { externallyEnforcedMaximumUsd: costUsd },
    execute,
    receipt: () => costRecorder.receipt(externalCallAttempted),
    receiptFromError: () => costRecorder.receipt(externalCallAttempted),
  })
  if (!paid.succeeded) throw paid.error
  return paid.value
}

function executionStep(step: AgentMemorySequenceStep, ordinal: number): AgentMemoryExecutionStep {
  return {
    ordinal,
    ...(step.instruction !== undefined ? { instruction: step.instruction } : {}),
    ...(step.scope !== undefined ? { scope: structuredClone(step.scope) } : {}),
  }
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
