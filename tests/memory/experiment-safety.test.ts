import { inMemoryCampaignStorage } from '@tangle-network/agent-eval/campaign'
import { describe, expect, it } from 'vitest'
import type { AgentMemoryAdapter } from '../../src/memory/index'
import { createScopedTestAdapter, hitText, runAgentMemoryExperiment } from '../support/memory'

describe('agent memory experiment safety', () => {
  it('allows one controller per run while its history workers run in parallel', async () => {
    const storage = inMemoryCampaignStorage()
    let reportStarted: (() => void) | undefined
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve
    })
    let releaseWorker: (() => void) | undefined
    const continueWorker = new Promise<void>((resolve) => {
      releaseWorker = resolve
    })
    const options: RunAgentMemoryExperimentOptions = {
      experimentId: 'single-controller',
      sequences: [
        {
          id: 'one',
          family: 'first-party',
          steps: [
            {
              id: 'work',
              scope: { agentId: 'worker' },
              writes: [{ kind: 'fact', text: 'parallel worker fact' }],
              probes: [
                {
                  id: 'recall',
                  query: 'worker fact',
                  referenceAnswer: 'parallel worker fact',
                },
              ],
            },
          ],
        },
      ],
      candidates: [
        {
          id: 'memory',
          ref: 'memory:v1',
          createAdapter: () => createScopedTestAdapter('single-controller'),
        },
      ],
      runDir: '/runs/single-controller',
      storage,
      executeStepRef: 'blocking-step:v1',
      async executeStep() {
        reportStarted?.()
        await continueWorker
      },
    }

    const firstRun = runAgentMemoryExperiment(options)
    await started
    await expect(
      runAgentMemoryExperiment({ ...options, storage: inMemoryCampaignStorage() }),
    ).rejects.toThrow('active controller')
    releaseWorker?.()
    const result = await firstRun

    expect(result.rows[0]).toMatchObject({ candidateId: 'memory', cellsFailed: 0 })
  })

  it('leaves a lost controller branch for the next owner and accepts duplicate cleanup receipts', async () => {
    const storage = inMemoryCampaignStorage()
    let firstControllerOwned = true
    let expireFirstController = true
    let controllerCount = 0
    let searches = 0
    let clears = 0
    let closes = 0
    let factVisible = false
    const purposes: string[] = []
    const options: RunAgentMemoryExperimentOptions = {
      experimentId: 'lost-controller',
      sequences: [
        {
          id: 'one',
          family: 'first-party',
          steps: [
            {
              id: 'work',
              scope: { agentId: 'worker' },
              writes: [{ kind: 'fact', text: 'must be cleaned' }],
              probes: [{ id: 'probe', query: 'must', referenceAnswer: 'must be cleaned' }],
            },
          ],
        },
      ],
      candidates: [
        {
          id: 'memory',
          ref: 'memory:v1',
          createAdapter({ purpose }) {
            purposes.push(purpose)
            const adapter: AgentMemoryAdapter = {
              id: 'lost-controller',
              branchIsolation: { mode: 'scoped' },
              async search() {
                searches += 1
                return factVisible
                  ? [
                      {
                        id: 'write',
                        uri: 'memory://lost-controller/write',
                        kind: 'fact',
                        text: 'must be cleaned',
                      },
                    ]
                  : []
              },
              async getContext(query, searchOptions) {
                const hits = await adapter.search(query, searchOptions)
                return { query, text: hits.map(hitText).join('\n'), hits, sourceRecords: [] }
              },
              async write(input) {
                factVisible = true
                return {
                  accepted: true,
                  id: 'write',
                  uri: 'memory://lost-controller/write',
                  kind: input.kind,
                }
              },
              async clear() {
                clears += 1
                factVisible = false
              },
              async close() {
                closes += 1
              },
            }
            return adapter
          },
        },
      ],
      runDir: '/runs/lost-controller',
      storage,
      acquireRunLease: async () => {
        controllerCount += 1
        const controller = controllerCount
        return {
          assertOwned() {
            if (controller === 1 && !firstControllerOwned) {
              throw new Error('controller ownership expired')
            }
          },
          release() {},
        }
      },
      executeStepRef: 'expire-controller:v1',
      async executeStep() {
        if (expireFirstController) {
          expireFirstController = false
          firstControllerOwned = false
        }
      },
    }
    const run = () => runAgentMemoryExperiment(options)

    await expect(run()).rejects.toThrow('controller ownership expired')
    expect(searches).toBe(0)
    expect(clears).toBe(0)
    expect(closes).toBe(1)
    expect(factVisible).toBe(true)

    const result = await run()
    expect(result.rows[0]).toMatchObject({ candidateId: 'memory', cellsFailed: 0 })
    expect(purposes).toEqual(['execute', 'recovery', 'execute'])
    expect(clears).toBe(2)
    expect(closes).toBe(3)
    expect(factVisible).toBe(false)

    const journal = storage.read(result.attemptLogPath)!
    const lines = journal.trim().split('\n')
    const last = lines.at(-1)!
    expect(storage.append!(result.attemptLogPath, `${last}\n`, Buffer.byteLength(journal))).toBe(
      Buffer.byteLength(journal) + Buffer.byteLength(`${last}\n`),
    )
    const callsBeforeCachedRun = {
      purposes: purposes.length,
      searches,
      clears,
      closes,
    }
    const cached = await run()
    expect(cached.campaign.aggregates.cellsCached).toBe(1)
    expect({ purposes: purposes.length, searches, clears, closes }).toEqual(callsBeforeCachedRun)
  })

  it('preserves both the run failure and controller release failure', async () => {
    const error = await runAgentMemoryExperiment({
      experimentId: 'run-and-release-failure',
      sequences: [
        {
          id: 'one',
          family: 'first-party',
          steps: [
            {
              id: 'probe',
              probes: [{ id: 'probe', query: 'state', referenceAnswer: 'state' }],
            },
          ],
        },
      ],
      candidates: [
        {
          id: 'unused',
          ref: 'unused:v1',
          createAdapter: () => createScopedTestAdapter('unused'),
        },
      ],
      runDir: '/runs/run-and-release-failure',
      storage: inMemoryCampaignStorage(),
      acquireRunLease: async () => ({
        assertOwned() {
          throw new Error('run ownership failed')
        },
        release() {
          throw new Error('release failed')
        },
      }),
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors.map((item) => String(item))).toEqual([
      'Error: run ownership failed',
      'Error: release failed',
    ])
  })

  it('fails the experiment when accepted writes cannot be cleared after a failed step', async () => {
    let clears = 0
    let closes = 0
    let disposals = 0
    const run = runAgentMemoryExperiment({
      experimentId: 'failed-step-cleanup',
      sequences: [
        {
          id: 'failure',
          family: 'first-party',
          steps: [
            {
              id: 'write-then-fail',
              scope: { agentId: 'worker' },
              writes: [{ kind: 'fact', text: 'partial state' }],
              probes: [{ id: 'state', query: 'partial state', referenceAnswer: 'partial state' }],
            },
          ],
        },
      ],
      candidates: [
        {
          id: 'scoped',
          ref: 'scoped:v1',
          createAdapter() {
            const base = createScopedTestAdapter('failure')
            return {
              ...base,
              async clear(scope) {
                clears += 1
                await base.clear?.(scope)
                throw new Error('provider clear failed')
              },
              async close() {
                closes += 1
              },
            }
          },
          async disposeAdapter() {
            disposals += 1
          },
        },
      ],
      runDir: '/runs/failed-step-cleanup',
      storage: inMemoryCampaignStorage(),
      cleanupBranches: true,
      executeStepRef: 'failing-worker/v1',
      async executeStep() {
        throw new Error('worker failed')
      },
    })

    await expect(run).rejects.toThrow('memory experiment cleanup failed after dispatch')
    expect(clears).toBe(1)
    expect(closes).toBe(1)
    expect(disposals).toBe(1)
  })

  it('cleans an unjournaled provider side effect and ranks failed histories below complete ones', async () => {
    let dirtyRows = 0
    let clears = 0
    const result = await runAgentMemoryExperiment({
      experimentId: 'provider-side-effect-cleanup',
      sequences: [
        {
          id: 'one',
          family: 'first-party',
          steps: [
            {
              id: 'remember',
              scope: { agentId: 'worker' },
              writes: [{ kind: 'fact', text: 'Launch is Friday.' }],
              probes: [{ id: 'launch', query: 'launch', referenceAnswer: 'Launch is Friday.' }],
            },
          ],
        },
      ],
      candidates: [
        {
          id: 'side-effect-then-error',
          ref: 'side-effect-then-error:v1',
          createAdapter: () => ({
            id: 'side-effect-then-error',
            branchIsolation: { mode: 'scoped' },
            async search() {
              return []
            },
            async getContext(query) {
              return { query, text: '', hits: [], sourceRecords: [] }
            },
            async write() {
              dirtyRows += 1
              throw new Error('provider disconnected after commit')
            },
            async clear() {
              clears += 1
              dirtyRows = 0
            },
          }),
        },
        {
          id: 'complete',
          ref: 'complete:v1',
          createAdapter: () => createScopedTestAdapter('complete'),
        },
      ],
      runDir: '/runs/provider-side-effect-cleanup',
      storage: inMemoryCampaignStorage(),
      cleanupBranches: true,
      maxConcurrency: 2,
    })

    expect(dirtyRows).toBe(0)
    expect(clears).toBe(1)
    expect(result.rows[0]).toMatchObject({
      candidateId: 'complete',
      cellsFailed: 0,
      scoreMean: 1,
    })
    expect(result.rows[1]).toMatchObject({
      candidateId: 'side-effect-then-error',
      cellsFailed: 1,
      scoreMean: 0,
      passRate: 0,
    })
  })

  it('closes and disposes an adapter when branch validation fails', async () => {
    let closes = 0
    let disposals = 0
    const result = await runAgentMemoryExperiment({
      experimentId: 'invalid-branch-cleanup',
      sequences: [
        {
          id: 'one',
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
          id: 'legacy',
          ref: 'legacy:v1',
          createAdapter() {
            const { branchIsolation: _branchIsolation, ...legacy } =
              createScopedTestAdapter('legacy')
            return {
              ...legacy,
              async close() {
                closes += 1
              },
            }
          },
          async disposeAdapter() {
            disposals += 1
          },
        },
      ],
      runDir: '/runs/invalid-branch-cleanup',
      storage: inMemoryCampaignStorage(),
      cleanupBranches: false,
    })

    expect(result.rows[0]).toMatchObject({ cellsFailed: 1 })
    expect(result.campaign.cells[0]?.error).toContain('adapter must declare branchIsolation')
    expect(closes).toBe(1)
    expect(disposals).toBe(1)
  })

  it('fails closed when cleanup is requested for an adapter without scoped clear', async () => {
    let disposals = 0
    const result = await runAgentMemoryExperiment({
      experimentId: 'unsupported-cleanup',
      sequences: [
        {
          id: 'one',
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
          id: 'no-clear',
          ref: 'no-clear:v1',
          createAdapter() {
            const { clear: _clear, ...adapter } = createScopedTestAdapter('no-clear')
            return adapter
          },
          async disposeAdapter() {
            disposals += 1
          },
        },
      ],
      runDir: '/runs/unsupported-cleanup',
      storage: inMemoryCampaignStorage(),
      cleanupBranches: true,
    })

    expect(result.rows[0]).toMatchObject({ cellsFailed: 1 })
    expect(result.campaign.cells[0]?.error).toContain('requires an adapter with scoped clear')
    expect(disposals).toBe(1)
  })

  it('rejects dynamic writes whose scope cannot be cleaned after a crash', async () => {
    let providerWrites = 0
    const result = await runAgentMemoryExperiment({
      experimentId: 'undeclared-dynamic-scope',
      sequences: [
        {
          id: 'one',
          family: 'first-party',
          steps: [
            {
              id: 'agent-step',
              scope: { agentId: 'declared' },
              probes: [{ id: 'state', query: 'state', referenceAnswer: 'state' }],
            },
          ],
        },
      ],
      candidates: [
        {
          id: 'scoped',
          ref: 'scoped:v1',
          createAdapter: () =>
            createScopedTestAdapter('scoped', async () => {
              providerWrites += 1
            }),
        },
      ],
      runDir: '/runs/undeclared-dynamic-scope',
      storage: inMemoryCampaignStorage(),
      cleanupBranches: true,
      executeStepRef: 'dynamic-scope-test/v1',
      executeStep: async ({ memory }) => {
        await memory.write({
          kind: 'fact',
          text: 'must not reach the provider',
          scope: { agentId: 'undeclared' },
        })
      },
    })

    expect(result.rows[0]).toMatchObject({ cellsFailed: 1 })
    expect(result.campaign.cells[0]?.error).toContain(
      'write scope was not declared in the experiment sequence cleanupScopes',
    )
    expect(providerWrites).toBe(0)
  })

  it('requires an external-state disposer when scoped cleanup is disabled', async () => {
    let creates = 0
    await expect(
      runAgentMemoryExperiment({
        experimentId: 'missing-disposer',
        sequences: [
          {
            id: 'one',
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
            id: 'persistent',
            ref: 'persistent:v1',
            createAdapter() {
              creates += 1
              return createScopedTestAdapter('persistent')
            },
          },
        ],
        runDir: '/runs/missing-disposer',
        storage: inMemoryCampaignStorage(),
        cleanupBranches: false,
      }),
    ).rejects.toThrow('requires disposeAdapter')

    expect(creates).toBe(0)
  })

  it('rejects probes that cannot distinguish a useful memory system', async () => {
    await expect(
      runAgentMemoryExperiment({
        experimentId: 'no-target',
        sequences: [
          {
            id: 'one',
            family: 'first-party',
            steps: [
              {
                id: 'probe',
                scope: { agentId: 'worker' },
                probes: [{ id: 'state', query: 'state' }],
              },
            ],
          },
        ],
        candidates: [
          {
            id: 'memory',
            ref: 'memory:v1',
            createAdapter: () => createScopedTestAdapter('memory'),
          },
        ],
        runDir: '/runs/no-target',
        storage: inMemoryCampaignStorage(),
      }),
    ).rejects.toThrow('has no measurable target')
  })
})
