import { inMemoryCampaignStorage, runCampaign } from '@tangle-network/agent-eval/campaign'
import { describe, expect, it } from 'vitest'
import {
  buildRetrievalEvalDispatch,
  buildRetrievalParameterCandidates,
  type KnowledgeIndex,
  type RetrievalEvalArtifact,
  type RetrievalEvalScenario,
  retrievalConfigFromSurface,
  retrievalConfigSurface,
  retrievalParameterSweepProposer,
  retrievalRecallJudge,
  runRetrievalImprovementLoop,
  scoreRetrievalArtifact,
} from '../src/index'

const signal = new AbortController().signal

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

  it('builds parameter candidates and delegates proposal to agent-eval', async () => {
    const baseline = { k: 5, hybrid: false, reranker: null, chunk: { overlap: 100 } }
    const candidates = buildRetrievalParameterCandidates(
      {
        'chunk.overlap': [100, 200],
        hybrid: [false, true],
        k: [5, 10],
      },
      { baseline },
    )

    expect(candidates.map((candidate) => candidate.label)).toEqual([
      'chunk.overlap=200',
      'hybrid=true',
      'k=10',
    ])

    const proposer = retrievalParameterSweepProposer({ candidates })
    const proposals = await proposer.propose({
      currentSurface: retrievalConfigSurface(baseline),
      history: [],
      findings: [],
      populationSize: 2,
      generation: 0,
      signal,
    })
    const surfaces = proposals.map((proposal) =>
      typeof proposal === 'string' ? proposal : 'surface' in proposal ? proposal.surface : proposal,
    )

    expect(surfaces).toHaveLength(2)
    expect(JSON.parse(surfaces[0] as string)).toMatchObject({ chunk: { overlap: 200 } })
    expect(JSON.parse(surfaces[1] as string)).toMatchObject({ hybrid: true })
  })

  it('runs an agent-eval loop that auto-selects the better retrieval config', async () => {
    const trainScenario: RetrievalEvalScenario = {
      id: 'q-train',
      kind: 'retrieval-eval',
      query: 'needs second result',
      expected: { kind: 'page', pageId: 'gold' },
    }
    const holdoutScenario: RetrievalEvalScenario = {
      id: 'q-holdout',
      kind: 'retrieval-eval',
      query: 'held out needs second result',
      expected: { kind: 'page', pageId: 'gold' },
    }

    const result = await runRetrievalImprovementLoop({
      baseline: { k: 1 },
      scenarios: [trainScenario],
      holdoutScenarios: [holdoutScenario],
      searchSpace: { k: [1, 2] },
      retrieve: async ({ k }) => ({
        hits: [
          { pageId: 'distractor', path: 'knowledge/distractor.md', rank: 1 },
          ...(k >= 2 ? [{ pageId: 'gold', path: 'knowledge/gold.md', rank: 2 }] : []),
        ],
      }),
      targetRecall: 1,
      deltaThreshold: 0.01,
      populationSize: 1,
      maxGenerations: 1,
      runDir: 'memory://retrieval-loop-test',
      storage: inMemoryCampaignStorage(),
      expectUsage: 'off',
    })

    expect(result.winnerConfig).toMatchObject({ k: 2 })
    expect(result.trainScenarios).toHaveLength(1)
    expect(result.holdoutScenarios).toHaveLength(1)
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
