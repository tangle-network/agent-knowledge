import { randomUUID } from 'node:crypto'
import type { CampaignStorage } from '@tangle-network/agent-eval/campaign'
import { runBoundedMemoryLifecycle } from '../memory/lifecycle'
import type { OwnedAgentMemoryRunLease } from '../memory/run-control'
import type { AgentMemoryAdapter, AgentMemoryScope } from '../memory/types'
import { memoryActorId, memoryEventId } from './adapters'
import {
  appendMemoryBenchmarkAttemptEvent,
  assertScopedMemoryBenchmarkAdapter,
  type MemoryAdapterBenchmarkAttemptEvent,
  memoryBenchmarkCostCallId,
} from './memory-recovery'
import type {
  KnowledgeBenchmarkArtifact,
  KnowledgeBenchmarkResponder,
  KnowledgeMemoryBenchmarkCase,
} from './types'
import { compactObject, unique } from './utils'
import { isKnowledgeMemoryBenchmarkCase } from './validation'

export function createMemoryAdapterBenchmarkResponder(options: {
  adapter: AgentMemoryAdapter
  candidateId: string
  candidateRef: string
  storage: CampaignStorage
  attemptLogPath: string
  lease: OwnedAgentMemoryRunLease
  cleanupTimeoutMs: number
  searchLimit?: number
  scope?: AgentMemoryScope
  costUsdPerCase?: number
  adapterCreationCostUsd?: number
  recoveryCostUsdPerAttempt?: number
  now?: () => Date
}): KnowledgeBenchmarkResponder<KnowledgeBenchmarkArtifact> {
  assertScopedMemoryBenchmarkAdapter(options.adapter)
  return async ({ case: testCase, context: dispatchContext }) => {
    if (!isKnowledgeMemoryBenchmarkCase(testCase)) {
      return { answer: '', metadata: { candidateId: options.candidateId, skipped: true } }
    }
    const costUsd = options.costUsdPerCase ?? 0
    if (!Number.isFinite(costUsd) || costUsd < 0) {
      throw new Error(`memory adapter costUsdPerCase must be non-negative finite, got ${costUsd}`)
    }

    dispatchContext.signal.throwIfAborted()
    await options.lease.assertOwned()
    const startedAt = Date.now()
    const attemptId = randomUUID()
    const scope = benchmarkMemoryScope(
      options.candidateId,
      testCase,
      dispatchContext.cellId,
      attemptId,
      options.scope,
    )
    const attempt: MemoryAdapterBenchmarkAttemptEvent = {
      status: 'started',
      attemptId,
      candidateId: options.candidateId,
      candidateRef: options.candidateRef,
      adapterId: options.adapter.id,
      caseId: testCase.id,
      cellId: dispatchContext.cellId,
      scope,
      adapterCreationCostUsd: options.adapterCreationCostUsd ?? 0,
      costUsdPerCase: costUsd,
      recoveryCostUsdPerAttempt: options.recoveryCostUsdPerAttempt ?? 0,
      recordedAt: (options.now ?? (() => new Date()))().toISOString(),
      recovery: false,
    }
    appendMemoryBenchmarkAttemptEvent(options.storage, options.attemptLogPath, attempt)

    let externalCallAttempted = false
    const appendCleanedAttempt = (priorError?: unknown): void => {
      try {
        appendMemoryBenchmarkAttemptEvent(options.storage, options.attemptLogPath, {
          ...attempt,
          status: 'cleaned',
          recordedAt: (options.now ?? (() => new Date()))().toISOString(),
        })
      } catch (error) {
        throw new MemoryAdapterBenchmarkCleanupError(
          [...(priorError ? [priorError] : []), error],
          `${options.candidateId}: memory benchmark cleanup could not be recorded`,
        )
      }
    }
    const execute = async (): Promise<KnowledgeBenchmarkArtifact> => {
      dispatchContext.signal.throwIfAborted()
      await options.lease.assertOwned()
      let artifact: KnowledgeBenchmarkArtifact | undefined
      let primaryError: unknown
      try {
        for (const event of testCase.events) {
          dispatchContext.signal.throwIfAborted()
          await options.lease.assertOwned()
          externalCallAttempted = true
          await options.adapter.write({
            id: event.id,
            kind: 'message',
            text: event.text,
            role: event.actorId === 'user' ? 'user' : 'assistant',
            title: `${testCase.id}:${event.id}`,
            scope,
            metadata: compactObject({
              benchmarkCaseId: testCase.id,
              benchmarkCellId: dispatchContext.cellId,
              benchmarkAttemptId: attemptId,
              eventId: event.id,
              actorId: event.actorId,
              sessionId: event.sessionId,
              timestamp: event.timestamp,
              ...event.metadata,
            }) as Record<string, unknown>,
          })
          dispatchContext.signal.throwIfAborted()
          await options.lease.assertOwned()
        }
        externalCallAttempted = true
        await options.adapter.flush?.()
        dispatchContext.signal.throwIfAborted()
        await options.lease.assertOwned()

        externalCallAttempted = true
        const adapterContext = await options.adapter.getContext(testCase.prompt, {
          scope,
          limit: options.searchLimit ?? 1,
          metadata: {
            benchmarkCaseId: testCase.id,
            benchmarkCellId: dispatchContext.cellId,
            benchmarkAttemptId: attemptId,
            candidateId: options.candidateId,
          },
        })
        dispatchContext.signal.throwIfAborted()
        await options.lease.assertOwned()
        const hits = adapterContext.hits
        artifact = {
          answer: adapterContext.text,
          rememberedFacts: hits.map((hit) => hit.text),
          citedEventIds: unique(hits.map(memoryEventId).filter((id): id is string => Boolean(id))),
          usedMemoryIds: hits.map((hit) => hit.id),
          actorIds: unique(hits.map(memoryActorId).filter((id): id is string => Boolean(id))),
          costUsd,
          durationMs: Math.max(0, Date.now() - startedAt),
          metadata: {
            candidateId: options.candidateId,
            adapterId: options.adapter.id,
            hitCount: hits.length,
          },
        }
      } catch (error) {
        primaryError = error
      }

      const cleanupErrors: unknown[] = []
      let cleanupOwned = true
      try {
        await options.lease.assertOwned()
      } catch (error) {
        cleanupOwned = false
        cleanupErrors.push(error)
      }
      if (cleanupOwned) {
        try {
          await runBoundedMemoryLifecycle({
            operation: `${options.candidateId}: benchmark attempt flush`,
            timeoutMs: options.cleanupTimeoutMs,
            resource: options.adapter,
            run: () => {
              externalCallAttempted = true
              return options.adapter.flush?.()
            },
          })
        } catch (error) {
          cleanupErrors.push(error)
        }
        try {
          await runBoundedMemoryLifecycle({
            operation: `${options.candidateId}: benchmark attempt cleanup`,
            timeoutMs: options.cleanupTimeoutMs,
            resource: options.adapter,
            run: () => {
              externalCallAttempted = true
              return options.adapter.clear!(scope)
            },
          })
        } catch (error) {
          cleanupErrors.push(error)
        }
      }
      if (cleanupOwned && cleanupErrors.length === 0) appendCleanedAttempt(primaryError)
      if (cleanupErrors.length > 0) {
        const errors = [...(primaryError ? [primaryError] : []), ...cleanupErrors]
        throw new MemoryAdapterBenchmarkCleanupError(
          errors,
          `${options.candidateId}: memory benchmark attempt cleanup failed`,
        )
      }
      if (primaryError) throw primaryError
      if (!artifact)
        throw new Error(`${options.candidateId}: memory benchmark produced no artifact`)
      return artifact
    }

    if (costUsd === 0) {
      let artifact: KnowledgeBenchmarkArtifact | undefined
      let error: unknown
      try {
        artifact = await execute()
      } catch (caught) {
        error = caught
      }
      if (error) throw error
      if (!artifact)
        throw new Error(`${options.candidateId}: memory benchmark produced no artifact`)
      return artifact
    }
    const receipt = {
      model: options.adapter.id,
      inputTokens: 0,
      outputTokens: 0,
      actualCostUsd: costUsd,
    } as const
    const paid = await dispatchContext.cost.runPaidCall({
      callId: memoryBenchmarkCostCallId(attempt, 'execute', 0),
      actor: `agent-knowledge:memory-adapter:${options.adapter.id}`,
      model: options.adapter.id,
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
}

export class MemoryAdapterBenchmarkCleanupError extends AggregateError {}

function benchmarkMemoryScope(
  candidateId: string,
  testCase: KnowledgeMemoryBenchmarkCase,
  cellId: string,
  attemptId: string,
  scope: AgentMemoryScope = {},
): AgentMemoryScope {
  return {
    ...scope,
    namespace: `${scope.namespace ?? 'agent-knowledge-memory-benchmark'}:${attemptId}`,
    tags: {
      ...(scope.tags ?? {}),
      benchmarkCandidateId: candidateId,
      benchmarkCaseId: testCase.id,
      benchmarkCellId: cellId,
      benchmarkAttemptId: attemptId,
    },
  }
}
