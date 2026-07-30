import { canonicalDigest, inMemoryCampaignStorage } from '@tangle-network/agent-eval/campaign'
import { describe, expect, it } from 'vitest'
import type { AgentMemoryAdapter } from '../../src/memory/index'
import { createScopedTestAdapter, runAgentMemoryExperiment } from '../support/memory'

describe('agent memory experiment recovery safety', () => {
  it('returns with recoverable state when a provider write never settles', async () => {
    const storage = inMemoryCampaignStorage()
    const runDir = '/runs/hung-provider-write'
    let writeStarted!: () => void
    const started = new Promise<void>((resolve) => {
      writeStarted = resolve
    })
    const adapter: AgentMemoryAdapter = {
      id: 'hung-provider',
      branchIsolation: { mode: 'scoped' },
      async search() {
        return []
      },
      async getContext(query) {
        return { query, text: '', hits: [], sourceRecords: [] }
      },
      async write() {
        writeStarted()
        return new Promise<never>(() => undefined)
      },
      async clear() {},
    }
    const run = runAgentMemoryExperiment({
      experimentId: 'hung-provider-write',
      sequences: [
        {
          id: 'history',
          family: 'first-party',
          steps: [
            {
              id: 'write',
              scope: { agentId: 'worker' },
              writes: [{ kind: 'fact', text: 'fact' }],
              probes: [{ id: 'recall', query: 'fact', referenceAnswer: 'fact' }],
            },
          ],
        },
      ],
      candidates: [{ id: 'memory', ref: 'memory:v1', createAdapter: () => adapter }],
      runDir,
      storage,
      dispatchTimeoutMs: 5,
      cleanupTimeoutMs: 20,
    })

    await started
    let timeout: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([
      run.then(
        () => ({ status: 'resolved' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      ),
      new Promise<{ status: 'hung' }>((resolve) => {
        timeout = setTimeout(() => resolve({ status: 'hung' }), 500)
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout)
    })

    expect(outcome.status).toBe('rejected')
    if (outcome.status !== 'rejected') return
    expect(outcome.error).toBeInstanceOf(Error)
    expect((outcome.error as Error).message).toContain('cleanup failed after dispatch')
    const attempts = storage.read(`${runDir}/memory-attempts.jsonl`)!.trim().split('\n')
    expect(attempts).toHaveLength(1)
    expect(JSON.parse(attempts[0]!)).toMatchObject({ status: 'started', recovery: false })
  })

  it('cancels adapter creation and disposes an execution adapter that arrives late', async () => {
    const storage = inMemoryCampaignStorage()
    const controller = new AbortController()
    let resolveCreation!: (adapter: AgentMemoryAdapter) => void
    const creation = new Promise<AgentMemoryAdapter>((resolve) => {
      resolveCreation = resolve
    })
    let reportStarted!: () => void
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve
    })
    let reportDisposed!: () => void
    const disposed = new Promise<void>((resolve) => {
      reportDisposed = resolve
    })
    let providerSignal: AbortSignal | undefined
    let closeCalls = 0
    let disposeCalls = 0
    const lateAdapter = createScopedTestAdapter('late-execution-provider')
    lateAdapter.close = async () => {
      closeCalls += 1
    }
    const run = runAgentMemoryExperiment({
      experimentId: 'late-execution-adapter',
      sequences: [
        {
          id: 'history',
          family: 'first-party',
          steps: [
            {
              id: 'probe',
              scope: { agentId: 'worker' },
              probes: [{ id: 'recall', query: 'fact', referenceAnswer: 'fact' }],
            },
          ],
        },
      ],
      candidates: [
        {
          id: 'memory',
          ref: 'memory:v1',
          createAdapter({ signal }) {
            providerSignal = signal
            reportStarted()
            return creation
          },
          async disposeAdapter(adapter) {
            expect(adapter).toBe(lateAdapter)
            disposeCalls += 1
            reportDisposed()
          },
        },
      ],
      runDir: '/runs/late-execution-adapter',
      storage,
      signal: controller.signal,
    })

    await started
    controller.abort(new Error('caller cancellation'))
    await expect(run).rejects.toThrow()
    expect(providerSignal?.aborted).toBe(true)
    expect((providerSignal!.reason as Error).message).toBe(
      'memory: execution adapter creation aborted',
    )

    resolveCreation(lateAdapter)
    await disposed
    expect({ closeCalls, disposeCalls }).toEqual({ closeCalls: 1, disposeCalls: 1 })
  })

  it('cancels an abandoned-write visibility wait without clearing the branch', async () => {
    const storage = inMemoryCampaignStorage()
    const runDir = '/runs/cancelled-recovery-delay'
    const sequence = {
      id: 'history',
      family: 'first-party' as const,
      steps: [
        {
          id: 'probe',
          scope: { agentId: 'worker' },
          probes: [{ id: 'recall', query: 'fact', referenceAnswer: 'fact' }],
        },
      ],
    }
    storage.write(
      `${runDir}/memory-attempts.jsonl`,
      `${JSON.stringify({
        status: 'started',
        branchId: 'unfinished-branch',
        candidateId: 'memory',
        candidateRef: 'memory:v1',
        sequenceId: sequence.id,
        sequenceRef: canonicalDigest(sequence),
        rep: 0,
        seed: 1,
        cleanupBranches: true,
        externalCostUsdPerSequence: 0,
        externalRecoveryCostUsdPerAttempt: 0,
        recordedAt: '2026-01-01T00:00:00.000Z',
        recovery: false,
      })}\n`,
    )
    const controller = new AbortController()
    let recoveryStarted!: () => void
    const started = new Promise<void>((resolve) => {
      recoveryStarted = resolve
    })
    let clearCalls = 0
    let closeCalls = 0
    const run = runAgentMemoryExperiment({
      experimentId: 'cancelled-recovery-delay',
      sequences: [sequence],
      candidates: [
        {
          id: 'memory',
          ref: 'memory:v1',
          createAdapter({ purpose }) {
            if (purpose === 'recovery') recoveryStarted()
            return {
              id: 'delayed-provider',
              branchIsolation: {
                mode: 'scoped',
                processExitSafe: false,
                recoveryDelayMs: 1_000,
              },
              async search() {
                return []
              },
              async getContext(query) {
                return { query, text: '', hits: [], sourceRecords: [] }
              },
              async write(input) {
                return {
                  accepted: true,
                  id: 'write',
                  uri: 'memory://delayed-provider/write',
                  kind: input.kind,
                }
              },
              async clear() {
                clearCalls += 1
              },
              async close() {
                closeCalls += 1
              },
            }
          },
        },
      ],
      runDir,
      storage,
      signal: controller.signal,
    })

    await started
    controller.abort(new Error('caller cancellation'))
    await expect(run).rejects.toThrow('recovery failed')
    expect({ clearCalls, closeCalls }).toEqual({ clearCalls: 0, closeCalls: 1 })
    expect(storage.read(`${runDir}/memory-attempts.jsonl`)!.trim().split('\n')).toHaveLength(1)
  })

  it('refuses to clean an unfinished branch with changed sequence scopes', async () => {
    const storage = inMemoryCampaignStorage()
    const runDir = '/runs/changed-recovery-sequence'
    const recordedSequence = {
      id: 'history',
      family: 'first-party' as const,
      steps: [
        {
          id: 'probe',
          scope: { agentId: 'original-worker' },
          probes: [{ id: 'recall', query: 'fact', referenceAnswer: 'fact' }],
        },
      ],
    }
    storage.write(
      `${runDir}/memory-attempts.jsonl`,
      `${JSON.stringify({
        status: 'started',
        branchId: 'unfinished-branch',
        candidateId: 'memory',
        candidateRef: 'memory:v1',
        sequenceId: recordedSequence.id,
        sequenceRef: canonicalDigest(recordedSequence),
        rep: 0,
        seed: 1,
        cleanupBranches: true,
        externalCostUsdPerSequence: 0,
        externalRecoveryCostUsdPerAttempt: 0,
        recordedAt: '2026-01-01T00:00:00.000Z',
        recovery: false,
      })}\n`,
    )
    let adapterCreates = 0

    await expect(
      runAgentMemoryExperiment({
        experimentId: 'changed-recovery-sequence',
        sequences: [
          {
            ...recordedSequence,
            steps: [
              {
                ...recordedSequence.steps[0],
                scope: { agentId: 'different-worker' },
              },
            ],
          },
        ],
        candidates: [
          {
            id: 'memory',
            ref: 'memory:v1',
            createAdapter() {
              adapterCreates += 1
              return createScopedTestAdapter('memory')
            },
          },
        ],
        runDir,
        storage,
      }),
    ).rejects.toThrow("sequence 'history' changed")

    expect(adapterCreates).toBe(0)
  })
})
