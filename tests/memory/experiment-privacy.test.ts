import { inMemoryCampaignStorage } from '@tangle-network/agent-eval/campaign'
import { describe, expect, it } from 'vitest'
import { createScopedTestAdapter, runAgentMemoryExperiment } from '../support/memory'

describe('agent memory experiment privacy', () => {
  it('does not expose random seeds or repetitions to candidate adapters', async () => {
    const adapterInputs: unknown[] = []
    await runAgentMemoryExperiment({
      experimentId: 'paired-seeds',
      sequences: [
        {
          id: 'paired-history',
          family: 'first-party',
          steps: [
            {
              id: 'probe',
              scope: { agentId: 'worker' },
              probes: [{ id: 'state', query: 'state', referenceAnswer: 'state' }],
            },
          ],
        },
      ],
      candidates: ['a', 'b'].map((candidateId) => ({
        id: candidateId,
        ref: `${candidateId}:v1`,
        createAdapter: (input) => {
          const {
            markExternalCall: _markExternalCall,
            recordExternalCost: _recordExternalCost,
            signal: _signal,
            ...visible
          } = input
          adapterInputs.push(structuredClone(visible))
          return createScopedTestAdapter(candidateId)
        },
      })),
      reps: 2,
      runDir: '/runs/paired-seeds',
      storage: inMemoryCampaignStorage(),
      maxConcurrency: 4,
    })

    expect(adapterInputs).toHaveLength(4)
    for (const input of adapterInputs) {
      expect(input).not.toHaveProperty('rep')
      expect(input).not.toHaveProperty('seed')
    }
  })

  it('never exposes evaluation labels or dataset identity to candidate callbacks', async () => {
    const adapterInputs: unknown[] = []
    const stepInputs: unknown[] = []
    const executionContexts: object[] = []
    const executionCostResults: unknown[] = []
    await runAgentMemoryExperiment({
      experimentId: 'redacted-candidate-input',
      sequences: [
        {
          id: 'FINAL_SEQUENCE_SECRET',
          family: 'first-party',
          split: 'test',
          steps: [
            {
              id: 'FINAL_STEP_SECRET',
              instruction: 'Remember the supplied launch state.',
              scope: { agentId: 'worker' },
              writes: [{ kind: 'fact', text: 'launch state' }],
              probes: [
                {
                  id: 'FINAL_PROBE_SECRET',
                  query: 'launch state',
                  requiredFacts: [
                    { id: 'EXPECTED_FACT_ID_SECRET', anyOf: ['EXPECTED_FACT_SECRET'] },
                  ],
                  referenceAnswer: 'REFERENCE_ANSWER_SECRET',
                },
              ],
              metadata: { privateLabel: 'STEP_METADATA_SECRET' },
            },
          ],
          metadata: { privateLabel: 'SEQUENCE_METADATA_SECRET' },
        },
      ],
      candidates: [
        {
          id: 'redacted',
          ref: 'redacted:v1',
          createAdapter(input) {
            const {
              markExternalCall: _markExternalCall,
              recordExternalCost: _recordExternalCost,
              signal: _signal,
              ...visible
            } = input
            adapterInputs.push(structuredClone(visible))
            return createScopedTestAdapter('redacted')
          },
        },
      ],
      executeStepRef: 'redacted-worker/v1',
      async executeStep(input) {
        executionContexts.push(input.context)
        executionCostResults.push(
          await input.context.cost.runPaidCall({
            actor: 'redacted-worker',
            model: 'free-local-test',
            maximumCharge: { externallyEnforcedMaximumUsd: 0 },
            execute: async () => 'complete',
            receipt: () => ({
              model: 'free-local-test',
              inputTokens: 0,
              outputTokens: 0,
              actualCostUsd: 0,
            }),
          }),
        )
        const { memory: _memory, context: _context, ...visible } = input
        stepInputs.push(structuredClone(visible))
      },
      runDir: '/runs/redacted-candidate-input',
      storage: inMemoryCampaignStorage(),
    })

    expect(executionContexts).toHaveLength(1)
    const actualContext = executionContexts[0]!
    expect(Reflect.ownKeys(actualContext).map(String).sort()).toEqual(['cost', 'signal'])
    for (const privateKey of [
      'cellId',
      'rep',
      'generation',
      'seed',
      'trace',
      'artifacts',
      'cycleId',
      'resumedFrom',
      'placement',
    ]) {
      expect(privateKey in actualContext).toBe(false)
    }
    expect(Reflect.ownKeys((actualContext as { cost: object }).cost).map(String)).toEqual([
      'runPaidCall',
    ])
    const costResult = executionCostResults[0] as {
      succeeded: boolean
      receipt?: Record<string, unknown>
    }
    expect(costResult.succeeded).toBe(true)
    expect(costResult.receipt).toBeDefined()
    expect(costResult.receipt).not.toHaveProperty('tags')
    expect(costResult.receipt).not.toHaveProperty('phase')

    const visible = JSON.stringify(
      publicRuntimeSurface({
        adapterInputs,
        stepInputs,
        executionContexts,
        executionCostResults,
      }),
    )
    for (const privateLabel of [
      'FINAL_SEQUENCE_SECRET',
      'FINAL_STEP_SECRET',
      'FINAL_PROBE_SECRET',
      'EXPECTED_FACT_ID_SECRET',
      'EXPECTED_FACT_SECRET',
      'REFERENCE_ANSWER_SECRET',
      'STEP_METADATA_SECRET',
      'SEQUENCE_METADATA_SECRET',
    ]) {
      expect(visible).not.toContain(privateLabel)
    }
    expect(stepInputs).toEqual([
      {
        candidateId: 'redacted',
        step: {
          ordinal: 0,
          instruction: 'Remember the supplied launch state.',
          scope: { agentId: 'worker' },
        },
      },
    ])
  })

  it('redacts campaign cell identity from execution cancellation', async () => {
    let abortReason: unknown
    await runAgentMemoryExperiment({
      experimentId: 'redacted-execution-abort',
      sequences: [
        {
          id: 'FINAL_ABORT_SEQUENCE_SECRET',
          family: 'first-party',
          steps: [
            {
              id: 'FINAL_ABORT_STEP_SECRET',
              probes: [
                {
                  id: 'FINAL_ABORT_PROBE_SECRET',
                  query: 'state',
                  referenceAnswer: 'FINAL_ABORT_EXPECTED_SECRET',
                },
              ],
            },
          ],
        },
      ],
      candidates: [
        {
          id: 'redacted',
          ref: 'redacted:v1',
          createAdapter: () => createScopedTestAdapter('redacted-abort'),
        },
      ],
      executeStepRef: 'redacted-abort-worker/v1',
      async executeStep({ context }) {
        if (context.signal.aborted) {
          abortReason = context.signal.reason
          return
        }
        await new Promise<void>((resolve) => {
          context.signal.addEventListener(
            'abort',
            () => {
              abortReason = context.signal.reason
              resolve()
            },
            { once: true },
          )
        })
      },
      dispatchTimeoutMs: 5,
      runDir: '/runs/redacted-execution-abort',
      storage: inMemoryCampaignStorage(),
    }).catch(() => undefined)

    expect(abortReason).toBeInstanceOf(Error)
    expect((abortReason as Error).name).toBe('AbortError')
    expect((abortReason as Error).message).toBe('memory execution aborted')
    expect(String(abortReason)).not.toContain('FINAL_ABORT_SEQUENCE_SECRET')
    expect(String(abortReason)).not.toContain('FINAL_ABORT_STEP_SECRET')
    expect(String(abortReason)).not.toContain('FINAL_ABORT_PROBE_SECRET')
    expect(String(abortReason)).not.toContain('FINAL_ABORT_EXPECTED_SECRET')
  })
})

function publicRuntimeSurface(value: unknown, seen = new WeakSet<object>()): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === undefined
  ) {
    return value
  }
  if (typeof value === 'function') return '[function]'
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  if (value instanceof Error) return { name: value.name, message: value.message }
  if (Array.isArray(value)) return value.map((item) => publicRuntimeSurface(item, seen))
  return Object.fromEntries(
    Object.keys(value).map((key) => [
      key,
      publicRuntimeSurface((value as Record<string, unknown>)[key], seen),
    ]),
  )
}
