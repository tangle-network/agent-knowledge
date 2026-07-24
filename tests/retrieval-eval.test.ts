import {
  inMemoryCampaignStorage,
  type OptimizationMethod,
  runCampaign,
} from '@tangle-network/agent-eval/campaign'
import { describe, expect, it } from 'vitest'
import {
  buildRetrievalEvalDispatch,
  type KnowledgeIndex,
  type RetrievalEvalArtifact,
  type RetrievalEvalScenario,
  retrievalConfigFromSurface,
  retrievalConfigSurface,
  retrievalRecallJudge,
  runRetrievalImprovementLoop,
  scoreRetrievalArtifact,
} from '../src/index'
import { fixedOptimizationMethod, testExecutionRef } from './support/optimization'

const signal = new AbortController().signal
const executionRef = testExecutionRef('retrieval-eval-fixture')

function testContext() {
  return {
    cellId: 'cell-1',
    rep: 0,
    seed: 123,
    signal,
  } as Parameters<ReturnType<typeof buildRetrievalEvalDispatch>>[2]
}

function fixtureIndex(): KnowledgeIndex {
  return {
    root: 'memory://retrieval-eval',
    generatedAt: '2026-01-01T00:00:00.000Z',
    sources: [
      {
        id: 'src-flash',
        uri: 'memory://flash',
        title: 'Flash Attention Source',
        contentHash: 'sha256:flash',
        text: 'Flash Attention improves memory bandwidth usage.',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'src-cache',
        uri: 'memory://cache',
        title: 'Cache Source',
        contentHash: 'sha256:cache',
        text: 'Cache eviction policy notes.',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    pages: [
      {
        id: 'flash-attention',
        path: 'knowledge/concepts/flash-attention.md',
        title: 'Flash Attention',
        text: 'IO aware attention improves memory bandwidth with tiled SRAM reads.',
        frontmatter: {},
        sourceIds: ['src-flash'],
        tags: ['attention'],
        outLinks: [],
      },
      {
        id: 'cache-policy',
        path: 'knowledge/concepts/cache-policy.md',
        title: 'Cache Policy',
        text: 'LRU and TTL cache eviction policies.',
        frontmatter: {},
        sourceIds: ['src-cache'],
        tags: ['runtime'],
        outLinks: [],
      },
    ],
    graph: { nodes: [], edges: [] },
  }
}

describe('retrieval eval', () => {
  it('dispatches local search and scores page/source recall deterministically', async () => {
    const scenario: RetrievalEvalScenario = {
      id: 'q-memory-bandwidth',
      kind: 'retrieval-eval',
      query: 'memory bandwidth',
      expected: { kind: 'page', pageId: 'flash-attention' },
    }
    const dispatch = buildRetrievalEvalDispatch({ index: fixtureIndex() })
    const artifact = await dispatch(retrievalConfigSurface({ k: 2 }), scenario, testContext())

    expect(artifact.requestedK).toBe(2)
    expect(artifact.hits[0]?.pageId).toBe('flash-attention')

    const judge = retrievalRecallJudge()
    const score = await judge.score({ artifact, scenario, signal })
    expect(score.dimensions.recall).toBe(1)
    expect(score.dimensions.mrr).toBe(1)
    expect(score.composite).toBe(1)

    const sourceScenario: RetrievalEvalScenario = {
      id: 'q-source',
      kind: 'retrieval-eval',
      query: 'memory bandwidth',
      expected: { kind: 'source', sourceId: 'src-flash' },
    }
    const sourceScore = await judge.score({ artifact, scenario: sourceScenario, signal })
    expect(sourceScore.dimensions.recall).toBe(1)
  })

  it('requires span evidence for span targets instead of accepting broad source hits', () => {
    const scenario: RetrievalEvalScenario = {
      id: 'q-span',
      kind: 'retrieval-eval',
      query: 'specific source span',
      expected: { kind: 'source-span', sourceId: 'src-1', charStart: 10, charEnd: 20 },
    }
    const broadSourceHit: RetrievalEvalArtifact = {
      config: { k: 1 },
      query: scenario.query,
      requestedK: 1,
      durationMs: 0,
      hits: [
        {
          pageId: 'page-1',
          path: 'knowledge/page-1.md',
          rank: 1,
          sourceIds: ['src-1'],
        },
      ],
    }
    expect(scoreRetrievalArtifact(broadSourceHit, scenario).recall).toBe(0)

    const spanHit: RetrievalEvalArtifact = {
      ...broadSourceHit,
      hits: [
        {
          pageId: 'page-1',
          path: 'knowledge/page-1.md',
          rank: 1,
          sourceIds: ['src-1'],
          sourceSpans: [{ sourceId: 'src-1', charStart: 15, charEnd: 25 }],
        },
      ],
    }
    expect(scoreRetrievalArtifact(spanHit, scenario).recall).toBe(1)
  })

  it('accounts billable retrieval through the agent-eval paid-call path', async () => {
    const scenario: RetrievalEvalScenario = {
      id: 'q-cost',
      kind: 'retrieval-eval',
      query: 'costed retrieval',
      expected: { kind: 'page', pageId: 'page-1' },
    }
    const dispatch = buildRetrievalEvalDispatch({
      retrieve: async ({ context }) => {
        const paid = await context.cost.runPaidCall({
          actor: 'test-retriever',
          model: 'retriever-fixture',
          maximumCharge: { externallyEnforcedMaximumUsd: 0.25 },
          execute: async () => ({
            costUsd: 0.25,
            hits: [{ pageId: 'page-1', path: 'knowledge/page-1.md', rank: 1 }],
          }),
          receipt: () => ({
            model: 'retriever-fixture',
            inputTokens: 0,
            outputTokens: 0,
            usageUnknown: true,
            actualCostUsd: 0.25,
          }),
        })
        if (!paid.succeeded) throw paid.error
        return paid.value
      },
    })
    const campaign = await runCampaign({
      scenarios: [scenario],
      dispatch: (input, context) => dispatch(retrievalConfigSurface({ k: 1 }), input, context),
      runDir: '/runs/retrieval-cost',
      storage: inMemoryCampaignStorage(),
      expectUsage: 'assert',
    })

    expect(campaign.cells[0]?.artifact).toMatchObject({ costUsd: 0.25 })
    expect(campaign.aggregates.totalCostUsd).toBe(0.25)
    expect(campaign.aggregates.cost.totalCalls).toBe(1)
  })

  it('runs a complete OptimizationMethod without exposing final cases to it', async () => {
    const seen: string[][] = []
    const method: OptimizationMethod<RetrievalEvalScenario, RetrievalEvalArtifact> = {
      name: 'official-compatible-fixture',
      async optimize(input) {
        seen.push([
          ...input.trainScenarios.map((scenario) => scenario.id),
          ...input.selectionScenarios.map((scenario) => scenario.id),
        ])
        return {
          winnerSurface: '{\n  "k": 2\n}',
          cost: { totalCostUsd: 0, accountingComplete: true, incompleteReasons: [] },
        }
      },
    }
    const result = await runRetrievalImprovementLoop({
      executionRef,
      baseline: { k: 1 },
      method,
      trainScenarios: [retrievalScenario('train', 'train query')],
      selectionScenarios: [retrievalScenario('selection', 'selection query')],
      finalScenarios: [
        retrievalScenario('final-a', 'final query a'),
        retrievalScenario('final-b', 'final query b'),
      ],
      retrieve: retrievalFixture,
      runDir: '/runs/retrieval-method-test',
      storage: inMemoryCampaignStorage(),
      expectUsage: 'off',
      resamples: 200,
    })

    expect(seen).toEqual([['train', 'selection']])
    expect(result.winnerConfig).toEqual({ k: 2 })
    expect(result.winner.surface).toBe('{"k":2}')
    expect(result.winner.surfaceHash).not.toBe(result.baseline.surfaceHash)
    expect(result.comparison.best.scenarioScores.map((row) => row.scenarioId)).toEqual([
      'final-a',
      'final-b',
    ])
  })

  it('requires the caller to supply a complete OptimizationMethod', async () => {
    const options = {
      baseline: { k: 1 },
      trainScenarios: [retrievalScenario('missing-method-train', 'train query')],
      selectionScenarios: [retrievalScenario('missing-method-selection', 'selection query')],
      finalScenarios: [
        retrievalScenario('missing-method-final-a', 'final query a'),
        retrievalScenario('missing-method-final-b', 'final query b'),
      ],
      retrieve: retrievalFixture,
      runDir: '/runs/retrieval-missing-method-test',
      storage: inMemoryCampaignStorage(),
      expectUsage: 'off',
    } as unknown as Parameters<typeof runRetrievalImprovementLoop>[0]

    await expect(runRetrievalImprovementLoop(options)).rejects.toThrow(
      'knowledge optimization requires a complete OptimizationMethod',
    )
  })

  it('requires an immutable execution identity before starting the method', async () => {
    let methodCalled = false
    const method: OptimizationMethod<RetrievalEvalScenario, RetrievalEvalArtifact> = {
      name: 'must-not-run-without-identity',
      async optimize(input) {
        methodCalled = true
        return {
          winnerSurface: input.baselineSurface,
          cost: { totalCostUsd: 0, accountingComplete: true, incompleteReasons: [] },
        }
      },
    }

    await expect(
      runRetrievalImprovementLoop({
        executionRef: 'git:ABCDEF',
        baseline: { k: 1 },
        method,
        trainScenarios: [retrievalScenario('identity-train', 'train query')],
        selectionScenarios: [retrievalScenario('identity-selection', 'selection query')],
        finalScenarios: [
          retrievalScenario('identity-final-a', 'final query a'),
          retrievalScenario('identity-final-b', 'final query b'),
        ],
        retrieve: retrievalFixture,
        runDir: '/runs/retrieval-invalid-identity-test',
        storage: inMemoryCampaignStorage(),
        expectUsage: 'off',
      }),
    ).rejects.toThrow(
      'knowledge optimization executionRef must be lowercase sha256:<64 hex> or git:<40 hex>',
    )
    expect(methodCalled).toBe(false)
  })

  it('rejects renamed duplicate scenarios before starting the method', async () => {
    let methodCalled = false
    const method: OptimizationMethod<RetrievalEvalScenario, RetrievalEvalArtifact> = {
      name: 'must-not-run',
      async optimize(input) {
        methodCalled = true
        return {
          winnerSurface: input.baselineSurface,
          cost: { totalCostUsd: 0, accountingComplete: true, incompleteReasons: [] },
        }
      },
    }

    await expect(
      runRetrievalImprovementLoop({
        executionRef,
        baseline: { k: 1 },
        method,
        trainScenarios: [
          retrievalScenario('duplicate-train-a', 'same query'),
          retrievalScenario('duplicate-train-b', 'same query'),
        ],
        selectionScenarios: [retrievalScenario('selection', 'selection query')],
        finalScenarios: [
          retrievalScenario('final-a', 'final query a'),
          retrievalScenario('final-b', 'final query b'),
        ],
        retrieve: retrievalFixture,
        runDir: '/runs/retrieval-duplicate-test',
        storage: inMemoryCampaignStorage(),
        expectUsage: 'off',
      }),
    ).rejects.toThrow(
      "train partition duplicates scenario content at 'duplicate-train-a'/'duplicate-train-b'",
    )
    expect(methodCalled).toBe(false)
  })

  it('rejects a non-object method winner before retrieval runs', async () => {
    let retrievalCalls = 0
    const method: OptimizationMethod<RetrievalEvalScenario, RetrievalEvalArtifact> = {
      name: 'invalid-config-winner',
      async optimize() {
        return {
          winnerSurface: 'null',
          cost: { totalCostUsd: 0, accountingComplete: true, incompleteReasons: [] },
        }
      },
    }

    await expect(
      runRetrievalImprovementLoop({
        executionRef,
        baseline: { k: 1 },
        method,
        trainScenarios: [retrievalScenario('invalid-train', 'train query')],
        selectionScenarios: [retrievalScenario('invalid-selection', 'selection query')],
        finalScenarios: [
          retrievalScenario('invalid-final-a', 'final query a'),
          retrievalScenario('invalid-final-b', 'final query b'),
        ],
        retrieve: async (input) => {
          retrievalCalls += 1
          return retrievalFixture(input)
        },
        runDir: '/runs/retrieval-invalid-config-test',
        storage: inMemoryCampaignStorage(),
        expectUsage: 'off',
      }),
    ).rejects.toThrow('serialized knowledge candidate must be a JSON object')
    expect(retrievalCalls).toBe(0)
  })

  it('runs and resumes a supplied complete retrieval method', async () => {
    const storage = inMemoryCampaignStorage()
    const retrievedK: number[] = []
    let activeExecutionRef = testExecutionRef('retrieval-resume-v1')
    let candidateImproves = true
    const trainScenarios = [retrievalScenario('train', 'train query')]
    const selectionScenarios = [
      retrievalScenario('selection-a', 'selection query a'),
      retrievalScenario('selection-b', 'selection query b'),
      retrievalScenario('selection-c', 'selection query c'),
    ]
    const finalScenarios = [
      retrievalScenario('final-a', 'final query a'),
      retrievalScenario('final-b', 'final query b'),
    ]
    const method = fixedOptimizationMethod<RetrievalEvalScenario, RetrievalEvalArtifact>(
      retrievalConfigSurface({ k: 2 }),
      'fixture-retrieval',
    )
    const run = () =>
      runRetrievalImprovementLoop({
        executionRef: activeExecutionRef,
        baseline: { k: 1 },
        method,
        trainScenarios,
        selectionScenarios,
        finalScenarios,
        retrieve: async (input) => {
          retrievedK.push(input.k)
          const findsGold = candidateImproves ? input.k >= 2 : input.k === 1
          return {
            hits: findsGold
              ? [{ pageId: 'gold', path: 'knowledge/gold.md', rank: 1 }]
              : [{ pageId: 'distractor', path: 'knowledge/distractor.md', rank: 1 }],
          }
        },
        runDir: '/runs/retrieval-method-test',
        storage,
        expectUsage: 'off',
        resamples: 200,
      })
    const result = await run()

    expect(result.winnerConfig).toMatchObject({ k: 2 })
    expect(result.methodName).toBe('fixture-retrieval')
    expect(result.trainScenarios).toHaveLength(1)
    expect(result.selectionScenarios).toHaveLength(3)
    expect(result.finalScenarios).toHaveLength(2)

    const callsAfterFirstRun = retrievedK.length
    const resumed = await run()
    expect(retrievedK).toHaveLength(callsAfterFirstRun)
    expect(resumed.winner.surfaceHash).toBe(result.winner.surfaceHash)

    candidateImproves = false
    activeExecutionRef = testExecutionRef('retrieval-resume-v2')
    const changed = await run()
    expect(retrievedK.length).toBeGreaterThan(callsAfterFirstRun)
    expect(changed.comparison.best.lift).toBe(-1)
  })

  it('fails loudly on invalid config surfaces and empty expected labels', () => {
    expect(() => retrievalConfigFromSurface('not-json')).toThrow(/could not parse JSON/)
    expect(() =>
      scoreRetrievalArtifact(
        {
          config: { k: 1 },
          query: 'empty labels',
          requestedK: 1,
          durationMs: 0,
          hits: [],
        },
        {
          id: 'q-empty',
          kind: 'retrieval-eval',
          query: 'empty labels',
          expected: [],
        },
      ),
    ).toThrow(/has no expected targets/)
  })
})

function retrievalScenario(id: string, query: string): RetrievalEvalScenario {
  return {
    id,
    kind: 'retrieval-eval',
    query,
    expected: { kind: 'page', pageId: 'gold' },
  }
}

async function retrievalFixture({ k }: { k: number }) {
  return {
    hits: [
      { pageId: 'distractor', path: 'knowledge/distractor.md', rank: 1 },
      ...(k >= 2 ? [{ pageId: 'gold', path: 'knowledge/gold.md', rank: 2 }] : []),
    ],
  }
}
