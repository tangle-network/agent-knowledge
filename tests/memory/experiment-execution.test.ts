import { inMemoryCampaignStorage } from '@tangle-network/agent-eval/campaign'
import { describe, expect, it } from 'vitest'
import type { AgentMemoryAdapter, AgentMemoryHit } from '../../src/memory/index'
import { createScopedTestAdapter, hitText, runAgentMemoryExperiment } from '../support/memory'

describe('agent memory experiment execution', () => {
  it('keeps each history ordered while comparing candidate branches in parallel', async () => {
    const storage = inMemoryCampaignStorage()
    const snapshots: string[] = []
    const stepOrder = new Map<string, string[]>()
    let active = 0
    let maxActive = 0
    let release: (() => void) | undefined
    const twoActive = new Promise<void>((resolve) => {
      release = resolve
    })
    const sequence = (id: string) => ({
      id,
      family: 'first-party' as const,
      split: 'holdout' as const,
      steps: [
        {
          id: 'research',
          scope: { agentId: 'researcher', teamId: 'team-1' },
          writes: [
            {
              id: `${id}-event`,
              kind: 'fact' as const,
              text: `${id} launch date is Friday`,
              metadata: { eventId: `${id}-event`, actorId: 'researcher' },
            },
          ],
        },
        {
          id: 'delivery',
          scope: { agentId: 'builder', teamId: 'team-1' },
          probes: [
            {
              id: 'launch-date',
              query: `${id} launch date`,
              requiredFacts: [{ id: 'current', anyOf: [`${id} launch date is Friday`] }],
              expectedEventIds: [`${id}-event`],
              expectedActorIds: ['researcher'],
            },
          ],
        },
      ],
    })

    const result = await runAgentMemoryExperiment({
      experimentId: 'team-sharing-vs-private',
      sequences: [sequence('alpha'), sequence('beta')],
      candidates: [
        {
          id: 'private',
          ref: 'private:v1',
          policy: { read: ['private'], write: 'private' },
          createAdapter: ({ branchId }) => createScopedTestAdapter(`private:${branchId}`),
        },
        {
          id: 'team',
          ref: 'team:v1',
          policy: { read: ['team'], write: 'team' },
          createAdapter: ({ branchId }) => createScopedTestAdapter(`team:${branchId}`),
        },
      ],
      runDir: '/runs/team-sharing-vs-private',
      storage,
      maxConcurrency: 4,
      cleanupBranches: true,
      executeStepRef: 'test-runtime/v1',
      executeStep: async ({ memory, step }) => {
        const order = stepOrder.get(memory.branchId) ?? []
        order.push(step.id)
        stepOrder.set(memory.branchId, order)
        if (step.id === 'research') {
          active += 1
          maxActive = Math.max(maxActive, active)
          if (active === 2) release?.()
          await twoActive
          active -= 1
        }
      },
      onBranchSnapshot: ({ snapshot }) => {
        snapshots.push(snapshot.digest)
      },
    })

    expect(maxActive).toBeGreaterThanOrEqual(2)
    expect(result.rows[0]).toMatchObject({
      rank: 1,
      candidateId: 'team',
      scoreMean: 1,
      passRate: 1,
      totalSequences: 2,
      totalCells: 2,
      totalProbes: 2,
      cellsFailed: 0,
    })
    expect(result.rows[1]?.candidateId).toBe('private')
    expect(result.rows[1]?.scoreMean).toBeLessThan(0.3)
    expect(result.campaign.cells).toHaveLength(4)
    expect(snapshots).toHaveLength(4)
    expect([...stepOrder.values()].every((steps) => steps.join(',') === 'research,delivery')).toBe(
      true,
    )
    expect(storage.read(result.rankingJsonPath)).toContain('"candidateId": "team"')
    expect(storage.read(result.rankingMarkdownPath)).toContain('| 1 | team |')
  })

  it('uses distinct external branch ids for distinct run directories', async () => {
    const branchIds: string[] = []
    const sequence = {
      id: 'branch-id',
      family: 'first-party' as const,
      steps: [
        {
          id: 'probe',
          scope: { agentId: 'worker' },
          probes: [{ id: 'state', query: 'state', referenceAnswer: 'state' }],
        },
      ],
    }
    const run = (runDir: string) =>
      runAgentMemoryExperiment({
        experimentId: 'same-experiment',
        sequences: [sequence],
        candidates: [
          {
            id: 'memory',
            ref: 'memory:v1',
            createAdapter({ branchId }) {
              branchIds.push(branchId)
              return createScopedTestAdapter(branchId)
            },
          },
        ],
        runDir,
        storage: inMemoryCampaignStorage(),
      })

    await run('/runs/branch-id-a')
    await run('/runs/branch-id-b')

    expect(branchIds).toHaveLength(2)
    expect(branchIds[0]).not.toBe(branchIds[1])
  })

  it('uses a fresh external branch id for each distributed execution attempt', async () => {
    const branchIds: string[] = []
    const run = (runDir: string) =>
      runAgentMemoryExperiment({
        experimentId: 'distributed-experiment',
        experimentRunId: 'distributed-run-17',
        sequences: [
          {
            id: 'shared-history',
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
        candidates: [
          {
            id: 'memory',
            ref: 'memory:v1',
            createAdapter({ branchId }) {
              branchIds.push(branchId)
              return createScopedTestAdapter(branchId)
            },
          },
        ],
        runDir,
        storage: inMemoryCampaignStorage(),
      })

    await run('/worker-a/run')
    await run('/worker-b/run')

    expect(branchIds).toHaveLength(2)
    expect(branchIds[0]).not.toBe(branchIds[1])
  })

  it('waits for timed-out provider work to finish cleanup before returning', async () => {
    let releaseWrite!: () => void
    const writeMayFinish = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    let reportWriteStarted!: () => void
    const writeStarted = new Promise<void>((resolve) => {
      reportWriteStarted = resolve
    })
    const rows: AgentMemoryHit[] = []
    let clears = 0
    const adapter: AgentMemoryAdapter = {
      id: 'slow-provider',
      branchIsolation: { mode: 'scoped' },
      async search() {
        return [...rows]
      },
      async getContext(query) {
        return { query, text: rows.map(hitText).join('\n'), hits: [...rows], sourceRecords: [] }
      },
      async write(input) {
        reportWriteStarted()
        await writeMayFinish
        const hit = {
          id: 'late-write',
          uri: 'memory://slow-provider/late-write',
          kind: input.kind,
          text: input.text,
        }
        rows.push(hit)
        return { accepted: true, id: hit.id, uri: hit.uri, kind: hit.kind }
      },
      async clear() {
        clears += 1
        rows.length = 0
      },
    }
    const run = runAgentMemoryExperiment({
      experimentId: 'timeout-cleanup',
      sequences: [
        {
          id: 'slow-history',
          family: 'first-party',
          steps: [
            {
              id: 'write',
              scope: { agentId: 'worker' },
              writes: [{ kind: 'fact', text: 'late fact' }],
              probes: [{ id: 'fact', query: 'fact', referenceAnswer: 'late fact' }],
            },
          ],
        },
      ],
      candidates: [{ id: 'slow', ref: 'slow:v1', createAdapter: () => adapter }],
      runDir: '/runs/timeout-cleanup',
      storage: inMemoryCampaignStorage(),
      dispatchTimeoutMs: 5,
    })
    await writeStarted
    let settled = false
    void run.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 15))

    expect(settled).toBe(false)
    releaseWrite()
    const result = await run

    expect(result.rows[0]).toMatchObject({ cellsFailed: 1 })
    expect(result.campaign.cells[0]?.error).toContain('dispatch exceeded 5ms')
    expect(clears).toBe(1)
    expect(rows).toEqual([])
  })

  it('fails when cleanup after a timed-out provider write fails', async () => {
    let releaseWrite!: () => void
    const writeMayFinish = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    let reportWriteStarted!: () => void
    const writeStarted = new Promise<void>((resolve) => {
      reportWriteStarted = resolve
    })
    let clears = 0
    const adapter: AgentMemoryAdapter = {
      id: 'cleanup-failure',
      branchIsolation: { mode: 'scoped' },
      async search() {
        return []
      },
      async getContext(query) {
        return { query, text: '', hits: [], sourceRecords: [] }
      },
      async write(input) {
        reportWriteStarted()
        await writeMayFinish
        return {
          accepted: true,
          id: 'late-write',
          uri: 'memory://cleanup-failure/late-write',
          kind: input.kind,
        }
      },
      async clear() {
        clears += 1
        throw new Error('provider cleanup unavailable')
      },
    }
    const run = runAgentMemoryExperiment({
      experimentId: 'timeout-cleanup-failure',
      sequences: [
        {
          id: 'slow-history',
          family: 'first-party',
          steps: [
            {
              id: 'write',
              scope: { agentId: 'worker' },
              writes: [{ kind: 'fact', text: 'late fact' }],
              probes: [{ id: 'fact', query: 'fact', referenceAnswer: 'late fact' }],
            },
          ],
        },
      ],
      candidates: [{ id: 'slow', ref: 'slow:v1', createAdapter: () => adapter }],
      runDir: '/runs/timeout-cleanup-failure',
      storage: inMemoryCampaignStorage(),
      dispatchTimeoutMs: 5,
    })
    await writeStarted
    await new Promise((resolve) => setTimeout(resolve, 10))
    releaseWrite()

    await expect(run).rejects.toThrow('memory experiment cleanup failed after dispatch')
  })
})
