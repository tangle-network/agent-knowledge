import { inMemoryCampaignStorage } from '@tangle-network/agent-eval/campaign'
import { describe, expect, it } from 'vitest'
import type {
  AgentMemoryAdapter,
  AgentMemoryBranchSnapshot,
  AgentMemoryScope,
} from '../../src/memory/index'
import { createScopedTestAdapter, runAgentMemoryExperiment } from '../support/memory'

describe('agent memory experiment parallel operations', () => {
  it('runs independent writes concurrently and keeps journal order deterministic', async () => {
    let activeWrites = 0
    let maxActiveWrites = 0
    let snapshot: AgentMemoryBranchSnapshot | undefined
    const adapter = createScopedTestAdapter('parallel-writes', async (_scope, text) => {
      activeWrites += 1
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites)
      await new Promise<void>((resolve) => setTimeout(resolve, text.includes('first') ? 10 : 1))
      activeWrites -= 1
    })

    const result = await runAgentMemoryExperiment({
      experimentId: 'parallel-write-order',
      sequences: [
        {
          id: 'history',
          family: 'first-party',
          steps: [
            {
              id: 'write',
              parallelWrites: true,
              parallelProbes: false,
              writes: [
                {
                  id: 'first',
                  kind: 'fact',
                  text: 'first fact',
                  scope: { agentId: 'first-agent' },
                },
                {
                  id: 'second',
                  kind: 'fact',
                  text: 'second fact',
                  scope: { agentId: 'second-agent' },
                },
              ],
              probes: [
                {
                  id: 'first',
                  query: 'first',
                  scope: { agentId: 'first-agent' },
                  referenceAnswer: 'first fact',
                },
                {
                  id: 'second',
                  query: 'second',
                  scope: { agentId: 'second-agent' },
                  referenceAnswer: 'second fact',
                },
              ],
            },
          ],
        },
      ],
      candidates: [
        {
          id: 'memory',
          ref: 'memory:parallel',
          createAdapter: () => adapter,
        },
      ],
      runDir: '/runs/parallel-write-order',
      storage: inMemoryCampaignStorage(),
      controllerMode: 'process-local',
      onBranchSnapshot(input) {
        snapshot = input.snapshot
      },
    })

    expect(result.rows[0]).toMatchObject({ cellsFailed: 0, scoreMean: 1 })
    expect(maxActiveWrites).toBe(2)
    expect(snapshot?.journal.map((entry) => entry.sequence)).toEqual([0, 1])
    expect(snapshot?.journal.map((entry) => entry.input.id)).toEqual(['first', 'second'])
  })

  it('drains successful sibling writes before clearing a partially failed step', async () => {
    let adapter: AgentMemoryAdapter | undefined
    const touchedScopes: AgentMemoryScope[] = []
    adapter = createScopedTestAdapter('parallel-write-failure', async (scope, text) => {
      touchedScopes.push(structuredClone(scope))
      if (text.includes('fail')) throw new Error('simulated write failure')
      await new Promise<void>((resolve) => setTimeout(resolve, 10))
    })

    const result = await runAgentMemoryExperiment({
      experimentId: 'parallel-write-failure',
      sequences: [
        {
          id: 'history',
          family: 'first-party',
          steps: [
            {
              id: 'write',
              parallelWrites: true,
              writes: [
                {
                  id: 'survivor',
                  kind: 'fact',
                  text: 'successful sibling',
                  scope: { agentId: 'survivor' },
                },
                {
                  id: 'failure',
                  kind: 'fact',
                  text: 'fail this write',
                  scope: { agentId: 'failure' },
                },
              ],
              probes: [
                {
                  id: 'unused',
                  query: 'sibling',
                  scope: { agentId: 'survivor' },
                  referenceAnswer: 'successful sibling',
                },
              ],
            },
          ],
        },
      ],
      candidates: [
        {
          id: 'memory',
          ref: 'memory:parallel-failure',
          createAdapter: () => adapter!,
        },
      ],
      runDir: '/runs/parallel-write-failure',
      storage: inMemoryCampaignStorage(),
      controllerMode: 'process-local',
    })

    expect(result.rows[0]).toMatchObject({ cellsFailed: 1 })
    expect(touchedScopes).toHaveLength(2)
    for (const scope of touchedScopes) {
      await expect(adapter.search('sibling', { scope })).resolves.toEqual([])
    }
  })
})
