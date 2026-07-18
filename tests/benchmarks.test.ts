import { createRunCostLedger, inMemoryCampaignStorage } from '@tangle-network/agent-eval/campaign'
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
  knowledgeBenchmarkJudge,
  parseKnowledgeBenchmarkJsonl,
  parseKnowledgeBenchmarkQrels,
  type RunMemoryAdapterBenchmarkOptions,
  respondToIndustryMemoryBenchmarkSmokeCase,
  respondToIndustryRagBenchmarkSmokeCase,
  runKnowledgeBenchmarkSuite,
  runMemoryAdapterBenchmark as runMemoryAdapterBenchmarkRaw,
  scoreKnowledgeBenchmarkArtifact,
  scoreMemoryBenchmarkArtifact,
} from '../src/benchmarks/index'
import type { AgentMemoryAdapter, AgentMemoryHit, AgentMemoryScope } from '../src/memory/types'

function runMemoryAdapterBenchmark(options: RunMemoryAdapterBenchmarkOptions) {
  return runMemoryAdapterBenchmarkRaw({
    ...options,
    ...(options.storage && !options.controllerMode && !options.acquireRunLease
      ? { controllerMode: 'process-local' as const }
      : {}),
  })
}

describe('knowledge benchmark adapters', () => {
  it('versions benchmark scoring for resumable cache safety', () => {
    expect(knowledgeBenchmarkJudge().judgeVersion).toBe('agent-knowledge:knowledge-benchmark:v2')
  })

  it('requires a responder version for resumable benchmark rows', async () => {
    await expect(
      runKnowledgeBenchmarkSuite({
        cases: buildIndustryRagBenchmarkSmokeCases().slice(0, 1),
        runDir: '/runs/missing-responder-ref',
        storage: inMemoryCampaignStorage(),
        respond: respondToIndustryRagBenchmarkSmokeCase,
      }),
    ).rejects.toThrow('respondRef is required when resumable is enabled')
  })

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
      respondRef: 'retriever-fixture:v1',
      costCeiling: 1,
      respond: async ({ case: testCase, context }) => {
        const paid = await context.cost.runPaidCall({
          actor: 'benchmark-retriever',
          model: 'retriever-fixture',
          maximumCharge: { externallyEnforcedMaximumUsd: 0.01 },
          execute: async () => ({
            costUsd: 0.01,
            hits: [
              testCase.id.endsWith('q1')
                ? { pageId: 'page-1', path: 'knowledge/page-1.md', rank: 1 }
                : { pageId: 'miss', path: 'knowledge/miss.md', rank: 1 },
            ],
          }),
          receipt: () => ({
            model: 'retriever-fixture',
            inputTokens: 0,
            outputTokens: 0,
            usageUnknown: true,
            actualCostUsd: 0.01,
          }),
        })
        if (!paid.succeeded) throw paid.error
        return paid.value
      },
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
      respondRef: 'industry-rag-smoke:v1',
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
    expect(result.report.totalCostUsd).toBe(0)
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
    expect(strong.applicableDimensions).toEqual(
      expect.arrayContaining([
        'memory_fact_recall',
        'memory_event_recall',
        'memory_actor_recall',
        'memory_stale_safe',
      ]),
    )

    const recallOnly = scoreMemoryBenchmarkArtifact(
      { ...testCase, forbiddenFacts: undefined, expectedActorIds: undefined },
      { answer: 'The user currently prefers email briefings.', citedEventIds: ['e-new'] },
    )
    expect(recallOnly.dimensions).not.toHaveProperty('memory_stale_safe')
    expect(recallOnly.dimensions).not.toHaveProperty('memory_actor_recall')
    expect(recallOnly.applicableDimensions).not.toContain('memory_stale_safe')
  })

  it('runs one persisted benchmark cell for every declared memory benchmark family', async () => {
    const storage = inMemoryCampaignStorage()
    const cases = buildIndustryMemoryBenchmarkSmokeCases()
    const result = await runKnowledgeBenchmarkSuite({
      cases,
      runDir: '/runs/memory-benchmark-family-smoke',
      storage,
      respondRef: 'industry-memory-smoke:v1',
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
    expect(result.report.totalCostUsd).toBe(0)
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
          ref: 'no-memory:v1',
          createAdapter: () => createNoopMemoryBenchmarkAdapter(),
        },
        {
          id: 'in-memory',
          ref: 'in-memory:v1',
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

  it('requires an explicit controller policy for custom benchmark storage', async () => {
    await expect(
      runMemoryAdapterBenchmarkRaw({
        cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
        runDir: '/runs/custom-benchmark-storage',
        storage: inMemoryCampaignStorage(),
        candidates: [
          {
            id: 'in-memory',
            ref: 'in-memory:v1',
            createAdapter: () => createInMemoryBenchmarkAdapter(),
          },
        ],
      }),
    ).rejects.toThrow("requires acquireRunLease or controllerMode='process-local'")
  })

  it('recovers an unfinished provider scope before retrying a direct benchmark cell', async () => {
    const storage = inMemoryCampaignStorage()
    const providerRows = new Map<string, AgentMemoryHit[]>()
    const operations: string[] = []
    const purposes: string[] = []
    let firstExecution = true
    const candidate = {
      id: 'recoverable',
      ref: 'recoverable:v1',
      adapterId: 'recoverable-provider',
      recoveryCostUsdPerAttempt: 0.1,
      createAdapter({ purpose }: { purpose: 'execute' | 'recovery' }) {
        purposes.push(purpose)
        const label = purpose === 'recovery' ? 'recovery' : firstExecution ? 'first' : 'retry'
        if (purpose === 'execute') firstExecution = false
        const adapter: AgentMemoryAdapter = {
          id: 'recoverable-provider',
          branchIsolation: { mode: 'scoped' },
          async search(_query, options) {
            return [...(providerRows.get(options?.scope?.namespace ?? '') ?? [])]
          },
          async getContext(query, options) {
            const hits = await adapter.search(query, options)
            return { query, text: hits.map((hit) => hit.text).join('\n'), hits, sourceRecords: [] }
          },
          async write(input) {
            operations.push(`write:${label}`)
            const namespace = input.scope?.namespace ?? ''
            const hit: AgentMemoryHit = {
              id: input.id ?? `${label}:memory`,
              uri: `memory://recoverable/${label}`,
              kind: input.kind,
              text: input.text,
              metadata: input.metadata,
            }
            providerRows.set(namespace, [...(providerRows.get(namespace) ?? []), hit])
            return { accepted: true, id: hit.id, uri: hit.uri, kind: hit.kind }
          },
          async clear(scope) {
            operations.push(`clear:${label}`)
            if (label === 'first') throw new Error('provider cleanup unavailable')
            providerRows.delete(scope?.namespace ?? '')
          },
          async close() {},
        }
        return adapter
      },
    }
    const run = () =>
      runMemoryAdapterBenchmark({
        cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
        runDir: '/runs/direct-benchmark-recovery',
        storage,
        candidates: [candidate],
        costCeiling: 1,
      })

    await expect(run()).rejects.toThrow('memory benchmark attempt cleanup failed')
    expect(providerRows.size).toBe(1)

    const result = await run()
    expect(result.rows[0]).toMatchObject({ candidateId: 'recoverable', cellsFailed: 0 })
    expect(result.rows[0]?.totalCostUsd).toBe(0.1)
    expect(result.totalCostUsd).toBe(0.1)
    expect(purposes).toEqual(['execute', 'recovery', 'execute'])
    expect(operations.indexOf('clear:recovery')).toBeLessThan(operations.indexOf('write:retry'))
    expect(providerRows.size).toBe(0)
    const events = storage
      .read(result.attemptLogPath)!
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { status: string; recovery: boolean })
    expect(events.map(({ status, recovery }) => ({ status, recovery }))).toEqual([
      { status: 'started', recovery: false },
      { status: 'cleaned', recovery: true },
      { status: 'started', recovery: false },
      { status: 'cleaned', recovery: false },
    ])
  })

  it('includes paid cleanup for a retired candidate in the benchmark total', async () => {
    const storage = inMemoryCampaignStorage()
    const runDir = '/runs/retired-candidate-recovery-cost'
    storage.write(
      `${runDir}/memory-adapter-attempts.jsonl`,
      `${JSON.stringify({
        schema: 3,
        status: 'started',
        attemptId: 'retired-attempt',
        candidateId: 'retired',
        candidateRef: 'retired:v1',
        adapterId: 'retired-provider',
        caseId: 'old-case',
        cellId: 'old-cell',
        scope: { namespace: 'retired-scope' },
        adapterCreationCostUsd: 0.05,
        costUsdPerCase: 0,
        recoveryCostUsdPerAttempt: 0.1,
        recordedAt: '2026-01-01T00:00:00.000Z',
        recovery: false,
      })}\n`,
    )
    let retiredClears = 0
    const result = await runMemoryAdapterBenchmark({
      cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
      runDir,
      storage,
      costCeiling: 1,
      candidates: [
        {
          id: 'active',
          ref: 'active:v1',
          adapterId: 'active-provider',
          createAdapter: () => createInMemoryBenchmarkAdapter({ id: 'active-provider' }),
        },
      ],
      recoveryCandidates: [
        {
          id: 'retired',
          ref: 'retired:v1',
          adapterId: 'retired-provider',
          adapterCreationCostUsd: 0.05,
          recoveryCostUsdPerAttempt: 0.1,
          createAdapter({ markExternalCall }) {
            markExternalCall()
            const adapter = createInMemoryBenchmarkAdapter({ id: 'retired-provider' })
            adapter.clear = async () => {
              retiredClears += 1
            }
            return adapter
          },
        },
      ],
    })

    expect(retiredClears).toBe(1)
    expect(result.rows[0]).toMatchObject({ candidateId: 'active', totalCostUsd: 0 })
    expect(result).toMatchObject({ totalCostUsd: 0.15, unrankedRecoveryCostUsd: 0.15 })
    expect(storage.read(result.rankingJsonPath)).toContain('"unrankedRecoveryCostUsd": 0.15')
  })

  it('refuses benchmark recovery when candidate cost settings changed', async () => {
    const storage = inMemoryCampaignStorage()
    const runDir = '/runs/benchmark-changed-recovery-costs'
    storage.write(
      `${runDir}/memory-adapter-attempts.jsonl`,
      `${JSON.stringify({
        schema: 3,
        status: 'started',
        attemptId: 'unfinished-attempt',
        candidateId: 'memory',
        candidateRef: 'memory:v1',
        adapterId: 'memory-provider',
        caseId: 'old-case',
        cellId: 'old-cell',
        scope: { namespace: 'unfinished-scope' },
        adapterCreationCostUsd: 0,
        costUsdPerCase: 0,
        recoveryCostUsdPerAttempt: 0,
        recordedAt: '2026-01-01T00:00:00.000Z',
        recovery: false,
      })}\n`,
    )
    let adapterCreates = 0

    await expect(
      runMemoryAdapterBenchmark({
        cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
        runDir,
        storage,
        costCeiling: 1,
        candidates: [
          {
            id: 'memory',
            ref: 'memory:v1',
            adapterId: 'memory-provider',
            costUsdPerCase: 0.1,
            createAdapter() {
              adapterCreates += 1
              return createInMemoryBenchmarkAdapter({ id: 'memory-provider' })
            },
          },
        ],
      }),
    ).rejects.toThrow('candidate cost settings changed')

    expect(adapterCreates).toBe(0)
    expect(
      storage.read(`${runDir}/memory-adapter-attempts.jsonl`)?.trim().split('\n'),
    ).toHaveLength(1)
  })

  it('bounds repeated direct benchmark recovery across process restarts', async () => {
    const storage = inMemoryCampaignStorage()
    const runDir = '/runs/benchmark-recovery-retry-limit'
    storage.write(
      `${runDir}/memory-adapter-attempts.jsonl`,
      `${JSON.stringify({
        schema: 3,
        status: 'started',
        attemptId: 'unfinished-attempt',
        candidateId: 'memory',
        candidateRef: 'memory:v1',
        adapterId: 'memory-provider',
        caseId: 'old-case',
        cellId: 'old-cell',
        scope: { namespace: 'unfinished-scope' },
        adapterCreationCostUsd: 0,
        costUsdPerCase: 0,
        recoveryCostUsdPerAttempt: 0,
        recordedAt: '2026-01-01T00:00:00.000Z',
        recovery: false,
      })}\n`,
    )
    let recoveryCreates = 0
    const run = () =>
      runMemoryAdapterBenchmark({
        cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
        runDir,
        storage,
        maxRecoveryRetriesPerAttempt: 2,
        candidates: [
          {
            id: 'memory',
            ref: 'memory:v1',
            adapterId: 'memory-provider',
            createAdapter({ purpose }) {
              if (purpose === 'recovery') recoveryCreates += 1
              throw new Error('provider recovery unavailable')
            },
          },
        ],
      })

    await expect(run()).rejects.toThrow('provider recovery unavailable')
    await expect(run()).rejects.toThrow('provider recovery unavailable')
    await expect(run()).rejects.toThrow('exhausted 2 recovery attempts')
    expect(recoveryCreates).toBe(2)
    expect(
      storage.read(`${runDir}/memory-adapter-recovery-attempts.jsonl`)?.trim().split('\n'),
    ).toHaveLength(2)
  })

  it('closes a recovery adapter that arrives after its factory timeout', async () => {
    const storage = inMemoryCampaignStorage()
    const runDir = '/runs/late-benchmark-recovery-adapter'
    storage.write(
      `${runDir}/memory-adapter-attempts.jsonl`,
      `${JSON.stringify({
        schema: 3,
        status: 'started',
        attemptId: 'unfinished-attempt',
        candidateId: 'memory',
        candidateRef: 'memory:v1',
        adapterId: 'memory-provider',
        caseId: 'old-case',
        cellId: 'old-cell',
        scope: { namespace: 'unfinished-scope' },
        adapterCreationCostUsd: 0,
        costUsdPerCase: 0,
        recoveryCostUsdPerAttempt: 0,
        recordedAt: '2026-01-01T00:00:00.000Z',
        recovery: false,
      })}\n`,
    )
    let resolveCreation!: (adapter: AgentMemoryAdapter) => void
    const creation = new Promise<AgentMemoryAdapter>((resolve) => {
      resolveCreation = resolve
    })
    let reportClosed!: () => void
    const closed = new Promise<void>((resolve) => {
      reportClosed = resolve
    })
    let closeCalls = 0
    const lateAdapter = createInMemoryBenchmarkAdapter({ id: 'memory-provider' })
    lateAdapter.close = async () => {
      closeCalls += 1
      reportClosed()
    }

    await expect(
      runMemoryAdapterBenchmark({
        cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
        runDir,
        storage,
        cleanupTimeoutMs: 10,
        candidates: [
          {
            id: 'memory',
            ref: 'memory:v1',
            adapterId: 'memory-provider',
            createAdapter: ({ purpose }) =>
              purpose === 'recovery' ? creation : createInMemoryBenchmarkAdapter(),
          },
        ],
      }),
    ).rejects.toThrow('benchmark recovery adapter creation did not finish within 10ms')

    resolveCreation(lateAdapter)
    await closed
    expect(closeCalls).toBe(1)
  })

  it('reconciles a crash after direct recovery but before its cost receipt', async () => {
    const storage = inMemoryCampaignStorage()
    const append = storage.append!.bind(storage)
    let failRecoveryReceipt = false
    storage.append = (path, value, expectedBytes) => {
      if (
        failRecoveryReceipt &&
        path.endsWith('/cost-ledger.jsonl') &&
        value.includes('"status":"settled"') &&
        value.includes('memory-adapter-recovery')
      ) {
        failRecoveryReceipt = false
        throw new Error('simulated process exit before benchmark recovery receipt')
      }
      return append(path, value, expectedBytes)
    }

    let firstExecution = true
    let recoveryClears = 0
    const candidate = {
      id: 'receipt-crash',
      ref: 'receipt-crash:v1',
      adapterId: 'receipt-crash-provider',
      costUsdPerCase: 0.1,
      recoveryCostUsdPerAttempt: 0.1,
      createAdapter({ purpose }: { purpose: 'execute' | 'recovery' }) {
        const adapter = createInMemoryBenchmarkAdapter({ id: 'receipt-crash-provider' })
        const clear = adapter.clear!
        const failThisExecution = purpose === 'execute' && firstExecution
        if (purpose === 'execute') firstExecution = false
        adapter.clear = async (scope) => {
          if (purpose === 'recovery') recoveryClears += 1
          if (failThisExecution) throw new Error('leave direct benchmark state active')
          await clear(scope)
        }
        return adapter
      },
    }
    const run = () =>
      runMemoryAdapterBenchmark({
        cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
        runDir: '/runs/direct-recovery-receipt-crash',
        storage,
        costCeiling: 1,
        candidates: [candidate],
      })

    await expect(run()).rejects.toThrow('memory benchmark attempt cleanup failed')
    failRecoveryReceipt = true
    await expect(run()).rejects.toThrow('failed to persist')
    expect(
      storage
        .read('/runs/direct-recovery-receipt-crash/memory-adapter-attempts.jsonl')
        ?.trim()
        .split('\n'),
    ).toHaveLength(2)

    const result = await run()
    const costLedger = createRunCostLedger({
      storage,
      runDir: '/runs/direct-recovery-receipt-crash',
      costCeilingUsd: 1,
    })

    expect(result.rows[0]).toMatchObject({
      candidateId: 'receipt-crash',
      cellsFailed: 0,
    })
    expect(result.rows[0]?.totalCostUsd).toBeCloseTo(0.3)
    expect(result.totalCostUsd).toBeCloseTo(0.3)
    expect(recoveryClears).toBe(1)
    expect(costLedger.summary()).toMatchObject({ unresolvedCalls: 0, accountingComplete: true })
    expect(costLedger.summary().totalCostUsd).toBeCloseTo(0.3)
  })

  it('bounds direct benchmark cleanup and preserves its recovery record', async () => {
    const storage = inMemoryCampaignStorage()
    const adapter = createInMemoryBenchmarkAdapter({ id: 'hung-cleanup' })
    let closeCalls = 0
    adapter.clear = () => new Promise<void>(() => {})
    adapter.close = async () => {
      closeCalls += 1
    }
    const startedAt = Date.now()

    await expect(
      runMemoryAdapterBenchmark({
        cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
        runDir: '/runs/direct-benchmark-cleanup-timeout',
        storage,
        cleanupTimeoutMs: 10,
        candidates: [
          {
            id: 'hung-cleanup',
            ref: 'hung-cleanup:v1',
            createAdapter: () => adapter,
          },
        ],
      }),
    ).rejects.toThrow('memory adapter benchmark cleanup failed')

    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(
      storage
        .read('/runs/direct-benchmark-cleanup-timeout/memory-adapter-attempts.jsonl')
        ?.trim()
        .split('\n'),
    ).toHaveLength(1)
    expect(closeCalls).toBe(0)
  })

  it('counts billable adapter creation in the shared benchmark budget', async () => {
    const storage = inMemoryCampaignStorage()
    let creates = 0
    const result = await runMemoryAdapterBenchmark({
      cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
      runDir: '/runs/paid-adapter-creation',
      storage,
      costCeiling: 0.5,
      candidates: [
        {
          id: 'paid-creation',
          ref: 'paid-creation:v1',
          adapterId: 'paid-creation-provider',
          adapterCreationCostUsd: 0.2,
          createAdapter({ markExternalCall }) {
            markExternalCall()
            creates += 1
            return createInMemoryBenchmarkAdapter({ id: 'paid-creation-provider' })
          },
        },
      ],
    })

    const ledger = createRunCostLedger({
      storage,
      runDir: '/runs/paid-adapter-creation',
      costCeilingUsd: 0.5,
    })
    expect(creates).toBe(1)
    expect(result.rows[0]).toMatchObject({ candidateId: 'paid-creation', totalCostUsd: 0.2 })
    expect(result.totalCostUsd).toBe(0.2)
    expect(ledger.list()).toMatchObject([
      {
        actor: 'agent-knowledge:memory-adapter:paid-creation',
        costUsd: 0.2,
        tags: {
          candidateId: 'paid-creation',
          memoryAdapterCreation: 'execute',
          runDir: '/runs/paid-adapter-creation/paid-creation',
        },
      },
    ])
  })

  it('does not recreate or recharge a billable adapter when every cell resumes', async () => {
    const storage = inMemoryCampaignStorage()
    let creates = 0
    const run = () =>
      runMemoryAdapterBenchmark({
        cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
        runDir: '/runs/resumed-paid-adapter-creation',
        storage,
        costCeiling: 0.5,
        candidates: [
          {
            id: 'paid-resume',
            ref: 'paid-resume:v1',
            adapterId: 'paid-resume-provider',
            adapterCreationCostUsd: 0.2,
            createAdapter({ markExternalCall }) {
              markExternalCall()
              creates += 1
              return createInMemoryBenchmarkAdapter({ id: 'paid-resume-provider' })
            },
          },
        ],
      })

    const initial = await run()
    const resumed = await run()

    expect(creates).toBe(1)
    expect(initial).toMatchObject({ totalCostUsd: 0.2 })
    expect(resumed).toMatchObject({ totalCostUsd: 0.2 })
    expect(resumed.rows[0]).toMatchObject({ adapterId: 'paid-resume-provider' })
    expect(resumed.rows[0]?.report.cellsCached).toBe(1)
  })

  it('closes a mismatched lazy adapter before any benchmark case writes', async () => {
    const storage = inMemoryCampaignStorage()
    let closes = 0
    let writes = 0
    const adapter = createInMemoryBenchmarkAdapter({ id: 'actual-provider' })
    const write = adapter.write.bind(adapter)
    adapter.write = async (input) => {
      writes += 1
      return write(input)
    }
    adapter.close = async () => {
      closes += 1
    }

    await expect(
      runMemoryAdapterBenchmark({
        cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
        runDir: '/runs/mismatched-lazy-adapter',
        storage,
        candidates: [
          {
            id: 'candidate',
            ref: 'candidate:v1',
            adapterId: 'expected-provider',
            createAdapter: () => adapter,
          },
        ],
      }),
    ).rejects.toThrow("returned id 'actual-provider', expected 'expected-provider'")
    expect({ closes, writes }).toEqual({ closes: 1, writes: 0 })
    expect(
      storage.read('/runs/mismatched-lazy-adapter/memory-adapter-attempts.jsonl'),
    ).toBeUndefined()
  })

  it('aborts execute adapter creation at the configured timeout', async () => {
    const storage = inMemoryCampaignStorage()
    let aborted = false
    const startedAt = Date.now()

    await expect(
      runMemoryAdapterBenchmark({
        cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
        runDir: '/runs/timed-out-adapter-creation',
        storage,
        cleanupTimeoutMs: 10,
        candidates: [
          {
            id: 'hung-factory',
            ref: 'hung-factory:v1',
            createAdapter: ({ signal }) =>
              new Promise((_resolve, reject) => {
                signal.addEventListener(
                  'abort',
                  () => {
                    aborted = true
                    reject(signal.reason)
                  },
                  { once: true },
                )
              }),
          },
        ],
      }),
    ).rejects.toThrow('benchmark execute adapter creation did not finish within 10ms')
    expect(aborted).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(
      storage.read('/runs/timed-out-adapter-creation/memory-adapter-attempts.jsonl'),
    ).toBeUndefined()
  })

  it('does not charge a local adapter factory failure', async () => {
    const storage = inMemoryCampaignStorage()
    await expect(
      runMemoryAdapterBenchmark({
        cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
        runDir: '/runs/local-adapter-creation-failure',
        storage,
        costCeiling: 0.5,
        candidates: [
          {
            id: 'local-failure',
            ref: 'local-failure:v1',
            adapterCreationCostUsd: 0.2,
            createAdapter() {
              throw new Error('invalid local configuration')
            },
          },
        ],
      }),
    ).rejects.toThrow('invalid local configuration')

    const ledger = createRunCostLedger({
      storage,
      runDir: '/runs/local-adapter-creation-failure',
      costCeilingUsd: 0.5,
    })
    expect(ledger.summary()).toMatchObject({ totalCostUsd: 0, unresolvedCalls: 0 })
  })

  it('enforces one cost ceiling across every compared adapter', async () => {
    const result = await runMemoryAdapterBenchmark({
      cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
      runDir: '/runs/shared-adapter-cost-ceiling',
      storage: inMemoryCampaignStorage(),
      costCeiling: 0.75,
      candidates: ['first', 'second'].map((id) => ({
        id,
        ref: `${id}:v1`,
        costUsdPerCase: 0.5,
        createAdapter: () => createInMemoryBenchmarkAdapter({ id }),
      })),
    })

    expect(result.totalCostUsd).toBe(0.5)
    expect(result.rows).toHaveLength(2)
    expect(result.rows.find((row) => row.candidateId === 'first')).toMatchObject({
      cellsFailed: 0,
      totalCostUsd: 0.5,
    })
    expect(result.rows.find((row) => row.candidateId === 'second')).toMatchObject({
      cellsFailed: 1,
      totalCostUsd: 0,
    })
  })

  it('runs sequential paid adapter cases after exact external-cost receipts', async () => {
    const result = await runMemoryAdapterBenchmark({
      cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 2),
      runDir: '/runs/sequential-adapter-cost-accounting',
      storage: inMemoryCampaignStorage(),
      costCeiling: 0.2,
      maxConcurrency: 1,
      candidates: [
        {
          id: 'sequential-paid',
          ref: 'sequential-paid:v1',
          costUsdPerCase: 0.1,
          createAdapter: () => createInMemoryBenchmarkAdapter({ id: 'sequential-paid' }),
        },
      ],
    })

    expect(result.rows[0]).toMatchObject({ cellsFailed: 0, totalCostUsd: 0.2 })
    expect(result.totalCostUsd).toBe(0.2)
  })

  it('refuses paid adapter calls when no dollar limit is configured', async () => {
    let providerCalls = 0
    const adapter = createInMemoryBenchmarkAdapter({ id: 'paid-by-default' })
    const write = adapter.write.bind(adapter)
    adapter.write = async (input) => {
      providerCalls += 1
      return write(input)
    }

    const result = await runMemoryAdapterBenchmark({
      cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
      runDir: '/runs/default-zero-cost-ceiling',
      storage: inMemoryCampaignStorage(),
      candidates: [
        {
          id: 'paid-by-default',
          ref: 'paid-by-default:v1',
          costUsdPerCase: 0.01,
          createAdapter: () => adapter,
        },
      ],
    })

    expect(result.rows[0]).toMatchObject({ cellsFailed: 1, totalCostUsd: 0 })
    expect(providerCalls).toBe(0)
  })

  it('does not reuse resumable rows when adapter benchmark options change', async () => {
    const storage = inMemoryCampaignStorage()
    const run = (searchLimit: number) =>
      runMemoryAdapterBenchmark({
        cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
        runDir: '/runs/memory-adapter-cache-identity',
        storage,
        candidates: [
          {
            id: 'in-memory',
            ref: 'in-memory:v1',
            createAdapter: () => createInMemoryBenchmarkAdapter(),
            searchLimit,
          },
        ],
      })

    const initial = await run(1)
    const changed = await run(2)
    const repeated = await run(2)

    expect(initial.rows[0]?.report.cellsCached).toBe(0)
    expect(changed.rows[0]?.report.cellsCached).toBe(0)
    expect(repeated.rows[0]?.report.cellsCached).toBe(1)
  })

  it('isolates and clears every concurrent adapter repetition', async () => {
    const adapter = createInMemoryBenchmarkAdapter()
    const clearedScopes: AgentMemoryScope[] = []
    const clear = adapter.clear!
    adapter.clear = async (scope) => {
      clearedScopes.push(scope ?? {})
      await clear(scope)
    }

    const result = await runMemoryAdapterBenchmark({
      cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
      runDir: '/runs/isolated-memory-repetitions',
      storage: inMemoryCampaignStorage(),
      reps: 3,
      maxConcurrency: 3,
      candidates: [
        {
          id: 'in-memory',
          ref: 'in-memory:v1',
          createAdapter: () => adapter,
        },
      ],
    })

    expect(result.rows[0]?.totalCells).toBe(3)
    expect(result.rows[0]?.cellsFailed).toBe(0)
    expect(clearedScopes).toHaveLength(3)
    expect(new Set(clearedScopes.map((scope) => scope.namespace)).size).toBe(3)
    expect(new Set(clearedScopes.map((scope) => scope.tags?.benchmarkAttemptId)).size).toBe(3)
  })

  it('settles timed-out provider work before clearing and closing the adapter', async () => {
    let closed = false
    let writes = 0
    let writesAfterClose = 0
    let clears = 0
    let clearsAfterClose = 0
    let contextReads = 0
    const adapter: AgentMemoryAdapter = {
      id: 'delayed-provider',
      branchIsolation: { mode: 'scoped' },
      async search() {
        return []
      },
      async getContext(query) {
        contextReads += 1
        return { query, text: '', hits: [], sourceRecords: [] }
      },
      async write(input) {
        await new Promise((resolve) => setTimeout(resolve, 25))
        writes += 1
        if (closed) writesAfterClose += 1
        return {
          accepted: true,
          id: input.id ?? String(writes),
          uri: `memory://delayed-provider/${writes}`,
          kind: input.kind,
        }
      },
      async clear() {
        await new Promise((resolve) => setTimeout(resolve, 1))
        clears += 1
        if (closed) clearsAfterClose += 1
      },
      async close() {
        closed = true
      },
    }

    const result = await runMemoryAdapterBenchmark({
      cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
      runDir: '/runs/timed-out-memory-provider',
      storage: inMemoryCampaignStorage(),
      dispatchTimeoutMs: 5,
      candidates: [
        {
          id: 'delayed-provider',
          ref: 'delayed-provider:v1',
          createAdapter: () => adapter,
        },
        {
          id: 'no-memory',
          ref: 'no-memory:v1',
          createAdapter: () => createNoopMemoryBenchmarkAdapter(),
        },
      ],
    })

    expect(result.rows[0]).toMatchObject({ candidateId: 'no-memory', cellsFailed: 0 })
    expect(result.rows[1]).toMatchObject({ candidateId: 'delayed-provider', cellsFailed: 1 })
    expect({ closed, writes, writesAfterClose, clears, clearsAfterClose, contextReads }).toEqual({
      closed: true,
      writes: 1,
      writesAfterClose: 0,
      clears: 1,
      clearsAfterClose: 0,
      contextReads: 0,
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect({ writes, writesAfterClose, clears, clearsAfterClose }).toEqual({
      writes: 1,
      writesAfterClose: 0,
      clears: 1,
      clearsAfterClose: 0,
    })
  })

  it('rejects every unsafe candidate id before creating any adapter', async () => {
    let creates = 0
    await expect(
      runMemoryAdapterBenchmark({
        cases: buildFirstPartyMemoryLifecycleBenchmarkCases().slice(0, 1),
        runDir: '/runs/invalid-memory-candidate',
        storage: inMemoryCampaignStorage(),
        candidates: [
          {
            id: 'valid',
            ref: 'valid:v1',
            createAdapter() {
              creates += 1
              return createInMemoryBenchmarkAdapter()
            },
          },
          {
            id: '../invalid',
            ref: 'invalid:v1',
            createAdapter() {
              creates += 1
              return createInMemoryBenchmarkAdapter()
            },
          },
        ],
      }),
    ).rejects.toThrow('must be a safe directory segment')
    expect(creates).toBe(0)
  })
})
