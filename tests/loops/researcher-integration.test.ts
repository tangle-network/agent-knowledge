import { runLoop } from '@tangle-network/agent-runtime/loops'
import type { CreateSandboxOptions, SandboxEvent, SandboxInstance } from '@tangle-network/sandbox'
import { describe, expect, it } from 'vitest'
import {
  multiHarnessResearcherFanout,
  type ResearchOutput,
  type ResearchTask,
  researcherProfile,
} from '../../src/profiles/researcher'

function ageMs(days: number): number {
  return Date.now() - days * 24 * 60 * 60 * 1000
}

function researchPayload(overrides: { namespace?: string; quality?: number } = {}): ResearchOutput {
  const namespace = overrides.namespace ?? 'cust_42'
  const quality = overrides.quality ?? 1
  const item = {
    id: 'item-1',
    namespace,
    claim: 'cpg-founder ICP engages with founder-pov threads',
    evidence: [
      {
        source: 'twitter',
        quote: quality >= 0.5 ? 'Engagement rate 4.2x' : '',
        url: 'https://x.com/example/status/1',
        capturedAt: ageMs(7),
      },
    ],
    confidence: 0.82 * quality,
    authoredBy: { kind: 'agent' as const, id: 'researcher-stub' },
  }
  return {
    items: [item],
    citations:
      quality >= 0.5
        ? [
            {
              url: 'https://x.com/example/status/1',
              quote: 'Engagement rate 4.2x',
              confidence: 0.82,
            },
          ]
        : [],
    proposedWrites: [{ kind: 'insert', namespace, item }],
  }
}

function stubClient(perCall: Array<() => ResearchOutput | { __error: string }>): {
  client: { create(opts?: CreateSandboxOptions): Promise<SandboxInstance> }
  callCount: () => number
} {
  let i = 0
  return {
    callCount: () => i,
    client: {
      async create() {
        const idx = i
        i += 1
        const factory = perCall[idx] ?? perCall[perCall.length - 1]
        return {
          async *streamPrompt() {
            if (!factory) {
              yield { type: 'noise', data: {} } satisfies SandboxEvent
              return
            }
            const value = factory()
            if ('__error' in value) {
              throw new Error(value.__error)
            }
            yield {
              type: 'result',
              data: { result: value },
            } satisfies SandboxEvent
          },
        } as unknown as SandboxInstance
      },
    },
  }
}

const task: ResearchTask = {
  question: 'What does cpg-founder ICP engage with on Twitter?',
  knowledgeNamespace: 'cust_42',
  sources: ['twitter', 'web'],
  maxItems: 10,
  minConfidence: 0.6,
}

describe('researcherProfile end-to-end through runLoop', () => {
  it('drives a single AgentRunSpec via fanout-vote and selects a clean winner', async () => {
    const { agentRuns, output, validator, driver } = multiHarnessResearcherFanout({
      harnesses: ['researcher-a', 'researcher-b', 'researcher-c'],
      task,
    })
    const { client } = stubClient([
      () => researchPayload({ quality: 1 }),
      () => researchPayload({ quality: 1 }),
      () => researchPayload({ quality: 1 }),
    ])

    const result = await runLoop({
      driver,
      agentRuns,
      output,
      validator,
      task,
      ctx: { sandboxClient: client },
    })

    expect(result.decision).toBe('pick-winner')
    expect(result.iterations).toHaveLength(3)
    expect(result.winner).toBeDefined()
    expect(result.winner?.output.items).toHaveLength(1)
    expect(result.winner?.output.proposedWrites).toHaveLength(1)
    expect(result.winner?.verdict?.valid).toBe(true)
  })

  it('fails-out when every harness emits a cross-namespace leak', async () => {
    const { agentRuns, output, validator, driver } = multiHarnessResearcherFanout({
      harnesses: ['researcher-a', 'researcher-b'],
      task,
    })
    const { client } = stubClient([
      () => researchPayload({ namespace: 'cust_99' }),
      () => researchPayload({ namespace: 'cust_77' }),
    ])

    const result = await runLoop({
      driver,
      agentRuns,
      output,
      validator,
      task,
      ctx: { sandboxClient: client },
    })

    expect(result.decision).toBe('fail')
    expect(result.iterations).toHaveLength(2)
    for (const iter of result.iterations) {
      expect(iter.verdict?.valid).toBe(false)
      expect(iter.verdict?.notes).toMatch(/namespace violation/)
    }
    // The kernel surfaces a structural top-of-attempts even on `fail`.
    // The contract is `decision === 'fail'` + `winner.verdict.valid === false`;
    // never a winner with `valid === true` when every output leaked.
    if (result.winner) {
      expect(result.winner.verdict?.valid).toBe(false)
    }
  })

  it('selects the higher-quality output across heterogeneous harnesses', async () => {
    const { agentRuns, output, validator, driver } = multiHarnessResearcherFanout({
      harnesses: ['low-quality', 'high-quality'],
      task,
    })
    const { client } = stubClient([
      () => researchPayload({ quality: 0.1 }), // no quoted citation → density floor fails
      () => researchPayload({ quality: 1 }),
    ])

    const result = await runLoop({
      driver,
      agentRuns,
      output,
      validator,
      task,
      ctx: { sandboxClient: client },
    })

    expect(result.decision).toBe('pick-winner')
    expect(result.winner?.iterationIndex).toBe(1)
    expect(result.winner?.agentRunName).toBe('researcher-high-quality')
  })

  it('passes proposedWrites through unchanged — caller is responsible for materialize', async () => {
    const single = researcherProfile({ harness: 'researcher-stub' })
    const driver = multiHarnessResearcherFanout({ harnesses: ['researcher-stub'], task }).driver
    const { client } = stubClient([() => researchPayload({ quality: 1 })])

    const result = await runLoop({
      driver,
      agentRuns: [single.agentRunSpec],
      output: single.output,
      validator: multiHarnessResearcherFanout({ harnesses: ['researcher-stub'], task }).validator,
      task,
      ctx: { sandboxClient: client },
    })

    // The winner carries proposedWrites that the caller must explicitly
    // route to applyKnowledgeWriteBlocks (or a KbStore put). The profile
    // itself never wrote anything to disk — that's the invariant.
    const writes = result.winner?.output.proposedWrites ?? []
    expect(writes).toHaveLength(1)
    expect(writes[0]?.kind).toBe('insert')
    expect(writes[0]?.namespace).toBe('cust_42')
  })
})
