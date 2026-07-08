import { inMemoryCampaignStorage } from '@tangle-network/agent-eval/campaign'
import { describe, expect, it } from 'vitest'
import {
  buildFirstPartyMemoryLifecycleBenchmarkCases,
  buildIndustryMemoryBenchmarkSmokeCases,
  buildIndustryRagBenchmarkSmokeCases,
  buildRetrievalBenchmarkCasesFromQrels,
  createInMemoryBenchmarkAdapter,
  createNoopMemoryBenchmarkAdapter,
  INDUSTRY_MEMORY_BENCHMARKS,
  INDUSTRY_RAG_BENCHMARKS,
  isKnowledgeMemoryBenchmarkCase,
  type KnowledgeAnswerBenchmarkCase,
  type KnowledgeMemoryBenchmarkCase,
  parseKnowledgeBenchmarkJsonl,
  parseKnowledgeBenchmarkQrels,
  respondToIndustryMemoryBenchmarkSmokeCase,
  respondToIndustryRagBenchmarkSmokeCase,
  runKnowledgeBenchmarkSuite,
  runMemoryAdapterBenchmark,
  scoreKnowledgeBenchmarkArtifact,
  scoreMemoryBenchmarkArtifact,
} from '../src/benchmarks/index'

describe('knowledge benchmark adapters', () => {
  it('parses qrels/jsonl and builds retrieval cases for public benchmark formats', () => {
    expect(parseKnowledgeBenchmarkJsonl('{"id":"q1"}\n{"id":"q2"}\n')).toEqual([
      { id: 'q1' },
      { id: 'q2' },
    ])
    const qrels = parseKnowledgeBenchmarkQrels('q1 0 page-1 1\nq1 0 page-2 0\nq2 page-3 2')
    expect(qrels).toEqual([
      { queryId: 'q1', documentId: 'page-1', score: 1 },
      { queryId: 'q1', documentId: 'page-2', score: 0 },
      { queryId: 'q2', documentId: 'page-3', score: 2 },
    ])

    const cases = buildRetrievalBenchmarkCasesFromQrels({
      benchmarkId: 'beir/smoke',
      family: 'beir',
      queries: [
        { id: 'q1', text: 'refund policy', split: 'search' },
        { id: 'q2', text: 'shipping speed', split: 'holdout', tags: ['commerce'] },
      ],
      qrels,
      targetKind: 'page',
    })

    expect(cases).toHaveLength(2)
    expect(cases[0]).toMatchObject({
      id: 'beir/smoke:q1',
      taskKind: 'retrieval',
      split: 'search',
      expected: [{ kind: 'page', pageId: 'page-1' }],
    })
    expect(cases[1]?.tags).toEqual(['commerce', 'holdout'])
  })

  it('runs retrieval benchmark cases through the campaign-backed suite', async () => {
    const storage = inMemoryCampaignStorage()
    const cases = buildRetrievalBenchmarkCasesFromQrels({
      benchmarkId: 'beir/suite-smoke',
      family: 'beir',
      queries: [
        { id: 'q1', text: 'refund policy', split: 'search' },
        { id: 'q2', text: 'shipping speed', split: 'holdout' },
      ],
      qrels: [
        { queryId: 'q1', documentId: 'page-1', score: 1 },
        { queryId: 'q2', documentId: 'page-2', score: 1 },
      ],
      targetKind: 'page',
      k: 2,
    })
    const result = await runKnowledgeBenchmarkSuite({
      cases,
      runDir: '/runs/knowledge-benchmark-smoke',
      storage,
      respond: ({ case: testCase }) => ({
        costUsd: 0.01,
        hits: [
          testCase.id.endsWith('q1')
            ? { pageId: 'page-1', path: 'knowledge/page-1.md', rank: 1 }
            : { pageId: 'miss', path: 'knowledge/miss.md', rank: 1 },
        ],
      }),
    })

    expect(result.report.totalCases).toBe(2)
    expect(result.report.cellsFailed).toBe(0)
    expect(result.report.score.mean).toBe(0.5)
    expect(result.report.byFamily.beir?.n).toBe(2)
    expect(result.report.bySplit.search?.meanScore).toBe(1)
    expect(result.report.bySplit.holdout?.meanScore).toBe(0)
    expect(result.report.totalCostUsd).toBe(0.02)
    expect(storage.read(result.reportJsonPath)).toContain('"totalCases": 2')
    expect(storage.read(result.reportMarkdownPath)).toContain('# Knowledge Benchmark Report')
  })

  it('scores RAG answer, hallucination, and KB-improvement cases with claim/source checks', () => {
    const testCase: KnowledgeAnswerBenchmarkCase = {
      id: 'crag/smoke:q1',
      family: 'crag',
      taskKind: 'rag-answer',
      prompt: 'What is the refund policy?',
      requiredClaims: [{ id: 'refund-window', anyOf: ['30 day refund', '30-day refund'] }],
      forbiddenClaims: [{ id: 'unsupported-lifetime', anyOf: ['lifetime refund'] }],
      expectedSourceIds: ['src-policy', 'src-terms'],
    }

    const partial = scoreKnowledgeBenchmarkArtifact(testCase, {
      answer: 'The product has a 30-day refund period.',
      citedSourceIds: ['src-policy'],
    })
    expect(partial.dimensions.claim_recall).toBe(1)
    expect(partial.dimensions.citation_recall).toBe(0.5)
    expect(partial.dimensions.hallucination_safe).toBe(1)
    expect(partial.score).toBeCloseTo(5 / 6)
    expect(partial.passed).toBe(false)

    const hallucinated = scoreKnowledgeBenchmarkArtifact(
      { ...testCase, taskKind: 'hallucination' },
      { answer: 'The product has a lifetime refund.' },
    )
    expect(hallucinated.dimensions.hallucination_safe).toBe(0)
    expect(hallucinated.raw.matchedForbiddenClaimIds).toEqual(['unsupported-lifetime'])
  })

  it('declares every requested industry benchmark family', () => {
    const ids = new Set(INDUSTRY_RAG_BENCHMARKS.map((benchmark) => benchmark.id))
    for (const id of [
      'beir',
      'mteb-retrieval',
      'msmarco',
      'trec-dl',
      'miracl',
      'lotte',
      'bright',
      'crag',
      'hotpotqa',
      'kilt',
      'ragtruth',
      'faithbench',
      'first-party/kb-improvement',
    ]) {
      expect(ids.has(id)).toBe(true)
    }
  })

  it('runs one persisted benchmark cell for every declared industry family', async () => {
    const storage = inMemoryCampaignStorage()
    const cases = buildIndustryRagBenchmarkSmokeCases()
    const result = await runKnowledgeBenchmarkSuite({
      cases,
      runDir: '/runs/knowledge-benchmark-family-smoke',
      storage,
      respond: respondToIndustryRagBenchmarkSmokeCase,
    })

    expect(cases).toHaveLength(INDUSTRY_RAG_BENCHMARKS.length)
    expect(result.report.totalCases).toBe(INDUSTRY_RAG_BENCHMARKS.length)
    expect(result.report.totalCells).toBe(INDUSTRY_RAG_BENCHMARKS.length)
    expect(result.report.cellsFailed).toBe(0)
    expect(result.report.score.mean).toBe(1)
    expect(result.report.byTaskKind.retrieval?.n).toBe(7)
    expect(result.report.byTaskKind['rag-answer']?.n).toBe(3)
    expect(result.report.byTaskKind.hallucination?.n).toBe(2)
    expect(result.report.byTaskKind['kb-improvement']?.n).toBe(1)
    expect(result.report.totalCostUsd).toBeCloseTo(INDUSTRY_RAG_BENCHMARKS.length * 0.001)
    for (const benchmark of INDUSTRY_RAG_BENCHMARKS) {
      expect(result.report.byFamily[benchmark.family]?.n).toBeGreaterThanOrEqual(1)
    }
    expect(storage.read(result.reportJsonPath)).toContain('"totalCases": 13')
    expect(storage.read(result.reportMarkdownPath)).toContain('## Task Kinds')
  })

  it('calibrates memory scoring against stale and current facts', () => {
    const testCase: KnowledgeMemoryBenchmarkCase = {
      id: 'memora/smoke:q1',
      family: 'memora',
      taskKind: 'memory-update',
      prompt: 'What does the user currently prefer for daily briefings?',
      events: [
        {
          id: 'e-old',
          actorId: 'user',
          timestamp: '2026-01-01T00:00:00.000Z',
          text: 'The user used to prefer SMS briefings.',
        },
        {
          id: 'e-new',
          actorId: 'user',
          timestamp: '2026-02-01T00:00:00.000Z',
          text: 'The user now prefers email briefings.',
        },
      ],
      requiredFacts: [{ id: 'current-channel', anyOf: ['email briefings'] }],
      forbiddenFacts: [{ id: 'stale-channel', anyOf: ['SMS briefings'], obsolete: true }],
      expectedEventIds: ['e-new'],
      expectedActorIds: ['user'],
    }

    const strong = scoreMemoryBenchmarkArtifact(testCase, {
      answer: 'The user currently prefers email briefings.',
      citedEventIds: ['e-new'],
      actorIds: ['user'],
    })
    const weak = scoreMemoryBenchmarkArtifact(testCase, {
      answer: 'The user prefers SMS briefings.',
      citedEventIds: ['e-old'],
      actorIds: ['user'],
    })

    expect(strong.score).toBeGreaterThanOrEqual(0.7)
    expect(strong.passed).toBe(true)
    expect(weak.score).toBeLessThanOrEqual(0.3)
    expect(weak.passed).toBe(false)
    expect(strong.score - weak.score).toBeGreaterThanOrEqual(0.4)
    expect(weak.dimensions.memory_stale_safe).toBe(0)
  })

  it('runs one persisted benchmark cell for every declared memory benchmark family', async () => {
    const storage = inMemoryCampaignStorage()
    const cases = buildIndustryMemoryBenchmarkSmokeCases()
    const result = await runKnowledgeBenchmarkSuite({
      cases,
      runDir: '/runs/memory-benchmark-family-smoke',
      storage,
      respond: ({ case: testCase }) => {
        expect(isKnowledgeMemoryBenchmarkCase(testCase)).toBe(true)
        if (!isKnowledgeMemoryBenchmarkCase(testCase)) {
          throw new Error(`expected memory case, got ${testCase.taskKind}`)
        }
        return respondToIndustryMemoryBenchmarkSmokeCase({
          case: testCase,
        })
      },
    })

    expect(cases).toHaveLength(INDUSTRY_MEMORY_BENCHMARKS.length)
    expect(result.report.totalCases).toBe(INDUSTRY_MEMORY_BENCHMARKS.length)
    expect(result.report.totalCells).toBe(INDUSTRY_MEMORY_BENCHMARKS.length)
    expect(result.report.cellsFailed).toBe(0)
    expect(result.report.score.mean).toBe(1)
    expect(result.report.byTaskKind['memory-ingest']?.n).toBe(1)
    expect(result.report.byTaskKind['memory-recall']?.n).toBe(1)
    expect(result.report.byTaskKind['memory-temporal']?.n).toBe(1)
    expect(result.report.byTaskKind['memory-update']?.n).toBe(1)
    expect(result.report.byTaskKind['memory-forgetting']?.n).toBe(1)
    expect(result.report.byTaskKind['memory-reasoning']?.n).toBe(1)
    expect(result.report.byTaskKind['memory-summarization']?.n).toBe(1)
    expect(result.report.byTaskKind['memory-recommendation']?.n).toBe(1)
    expect(result.report.byTaskKind['memory-multiparty']?.n).toBe(1)
    expect(result.report.totalCostUsd).toBeCloseTo(INDUSTRY_MEMORY_BENCHMARKS.length * 0.001)
    for (const benchmark of INDUSTRY_MEMORY_BENCHMARKS) {
      expect(result.report.byFamily[benchmark.family]?.n).toBeGreaterThanOrEqual(1)
    }
    expect(storage.read(result.reportJsonPath)).toContain('"totalCases": 9')
    expect(storage.read(result.reportMarkdownPath)).toContain('memory_stale_safe')
  })

  it('ranks actual memory adapters on the first-party lifecycle benchmark', async () => {
    const storage = inMemoryCampaignStorage()
    const cases = buildFirstPartyMemoryLifecycleBenchmarkCases()
    const result = await runMemoryAdapterBenchmark({
      cases,
      runDir: '/runs/memory-adapter-ranking',
      storage,
      candidates: [
        {
          id: 'no-memory',
          createAdapter: () => createNoopMemoryBenchmarkAdapter(),
        },
        {
          id: 'in-memory',
          createAdapter: () => createInMemoryBenchmarkAdapter(),
          searchLimit: 1,
        },
      ],
    })

    expect(cases).toHaveLength(12)
    expect(result.rows).toHaveLength(2)
    expect(result.rows[0]?.candidateId).toBe('in-memory')
    expect(result.rows[0]?.scoreMean).toBeGreaterThan(0.9)
    expect(result.rows[0]?.totalCells).toBe(12)
    expect(result.rows[0]?.cellsFailed).toBe(0)
    expect(result.rows[1]?.candidateId).toBe('no-memory')
    expect(result.rows[1]?.scoreMean).toBeLessThan(0.3)
    expect(storage.read(result.rankingJsonPath)).toContain('"candidateId": "in-memory"')
    expect(storage.read(result.rankingMarkdownPath)).toContain('| 1 | in-memory |')
    expect(storage.read(result.rows[0]!.reportJsonPath)).toContain('"memory_stale_safe"')
  })
})
