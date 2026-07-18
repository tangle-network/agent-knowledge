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
    ).toHaveLength(1)

    const result = await run()
    const costLedger = createRunCostLedger({
      storage,
      runDir: '/runs/direct-recovery-receipt-crash',
      costCeilingUsd: 1,
    })

    expect(result.rows[0]).toMatchObject({ candidateId: 'receipt-crash', cellsFailed: 0 })
    expect(recoveryClears).toBe(2)
    expect(costLedger.summary()).toMatchObject({
      unresolvedCalls: 0,
      totalCostUsd: 0.4,
      accountingComplete: true,
    })
  })

  it('bounds direct benchmark cleanup and preserves its recovery record', async () => {
    const storage = inMemoryCampaignStorage()
    const adapter = createInMemoryBenchmarkAdapter({ id: 'hung-cleanup' })
    adapter.clear = () => new Promise<void>(() => {})
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
    ).rejects.toThrow('memory benchmark attempt cleanup failed')

    expect(Date.now() - startedAt).toBeLessThan(500)
    expect(
      storage
        .read('/runs/direct-benchmark-cleanup-timeout/memory-adapter-attempts.jsonl')
        ?.trim()
        .split('\n'),
    ).toHaveLength(1)
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
