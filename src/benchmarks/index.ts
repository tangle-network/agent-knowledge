import { join } from 'node:path'
import {
  type CampaignResult,
  type CampaignStorage,
  type DispatchContext,
  fsCampaignStorage,
  type JudgeConfig,
  type RunCampaignOptions,
  runCampaign,
  type Scenario,
} from '@tangle-network/agent-eval/campaign'
import {
  type RetrievalEvalArtifact,
  type RetrievalEvalScenario,
  type RetrievalGoldTarget,
  type RetrievedKnowledgeHit,
  scoreRetrievalArtifact,
} from '../retrieval-eval'

export type KnowledgeBenchmarkTaskKind =
  | 'retrieval'
  | 'rag-answer'
  | 'hallucination'
  | 'kb-improvement'

export type KnowledgeBenchmarkFamily =
  | 'beir'
  | 'mteb-retrieval'
  | 'msmarco'
  | 'trec-dl'
  | 'miracl'
  | 'lotte'
  | 'bright'
  | 'crag'
  | 'hotpotqa'
  | 'kilt'
  | 'ragtruth'
  | 'faithbench'
  | 'first-party'
  | 'custom'

export type KnowledgeBenchmarkSplit = 'search' | 'dev' | 'holdout' | string

export interface KnowledgeBenchmarkSource {
  name?: string
  url?: string
  version?: string
  license?: string
  citation?: string
}

export interface KnowledgeBenchmarkSpec {
  id: string
  family: KnowledgeBenchmarkFamily
  taskKind: KnowledgeBenchmarkTaskKind
  primaryMetrics: readonly string[]
  adapter: string
  notes: string
}

export interface KnowledgeBenchmarkCaseBase {
  id: string
  family: KnowledgeBenchmarkFamily | string
  taskKind: KnowledgeBenchmarkTaskKind
  split?: KnowledgeBenchmarkSplit
  tags?: readonly string[]
  source?: KnowledgeBenchmarkSource
  metadata?: Record<string, unknown>
}

export interface KnowledgeRetrievalBenchmarkCase extends KnowledgeBenchmarkCaseBase {
  taskKind: 'retrieval'
  query: string
  expected: RetrievalGoldTarget | readonly RetrievalGoldTarget[]
  k?: number
}

export interface KnowledgeClaimMatcher {
  id: string
  anyOf: readonly string[]
  weight?: number
}

export interface KnowledgeAnswerBenchmarkCase extends KnowledgeBenchmarkCaseBase {
  taskKind: 'rag-answer' | 'hallucination' | 'kb-improvement'
  prompt: string
  requiredClaims?: readonly KnowledgeClaimMatcher[]
  forbiddenClaims?: readonly KnowledgeClaimMatcher[]
  expectedSourceIds?: readonly string[]
  referenceAnswer?: string
}

export type KnowledgeBenchmarkCase = KnowledgeRetrievalBenchmarkCase | KnowledgeAnswerBenchmarkCase

export interface KnowledgeBenchmarkArtifact {
  answer?: string
  text?: string
  hits?: readonly RetrievedKnowledgeHit[]
  citedSourceIds?: readonly string[]
  costUsd?: number
  durationMs?: number
  metadata?: Record<string, unknown>
}

export interface KnowledgeBenchmarkEvaluation {
  score: number
  passed: boolean
  dimensions: Record<string, number>
  notes: string
  raw: Record<string, unknown>
}

export interface KnowledgeBenchmarkScenario extends Scenario {
  kind: 'knowledge-benchmark'
  family: KnowledgeBenchmarkFamily | string
  taskKind: KnowledgeBenchmarkTaskKind
  splitTag: KnowledgeBenchmarkSplit
  case: KnowledgeBenchmarkCase
}

export type KnowledgeBenchmarkResponder<TArtifact = KnowledgeBenchmarkArtifact> = (input: {
  case: KnowledgeBenchmarkCase
  scenario: KnowledgeBenchmarkScenario
  context: DispatchContext
}) => Promise<TArtifact> | TArtifact

export interface RunKnowledgeBenchmarkSuiteOptions<TArtifact = KnowledgeBenchmarkArtifact> {
  cases: readonly KnowledgeBenchmarkCase[]
  respond: KnowledgeBenchmarkResponder<TArtifact>
  runDir: string
  splits?: readonly KnowledgeBenchmarkSplit[]
  repo?: string
  seed?: number
  reps?: number
  resumable?: boolean
  costCeiling?: number
  maxConcurrency?: number
  dispatchTimeoutMs?: number
  expectUsage?: 'assert' | 'warn' | 'off'
  storage?: CampaignStorage
  now?: () => Date
}

export interface KnowledgeBenchmarkDistribution {
  n: number
  min: number
  mean: number
  median: number
  p90: number
  max: number
}

export interface KnowledgeBenchmarkSliceSummary {
  n: number
  meanScore: number
  passRate: number
  score: KnowledgeBenchmarkDistribution
}

export interface KnowledgeBenchmarkReport {
  totalCases: number
  totalCells: number
  cellsFailed: number
  cellsCached: number
  totalCostUsd: number
  bySplit: Record<string, KnowledgeBenchmarkSliceSummary>
  byFamily: Record<string, KnowledgeBenchmarkSliceSummary>
  byTaskKind: Record<string, KnowledgeBenchmarkSliceSummary>
  dimensions: Record<string, KnowledgeBenchmarkDistribution>
  score: KnowledgeBenchmarkDistribution
}

export interface RunKnowledgeBenchmarkSuiteResult<TArtifact = KnowledgeBenchmarkArtifact> {
  scenarios: readonly KnowledgeBenchmarkScenario[]
  campaign: CampaignResult<TArtifact, KnowledgeBenchmarkScenario>
  report: KnowledgeBenchmarkReport
  reportJsonPath: string
  reportMarkdownPath: string
}

export interface KnowledgeRetrievalBenchmarkQuery {
  id: string
  text: string
  split?: KnowledgeBenchmarkSplit
  tags?: readonly string[]
  metadata?: Record<string, unknown>
}

export interface KnowledgeRetrievalBenchmarkQrel {
  queryId: string
  documentId: string
  score: number
}

export interface BuildRetrievalBenchmarkCasesFromQrelsOptions {
  benchmarkId: string
  family: KnowledgeBenchmarkFamily | string
  queries: readonly KnowledgeRetrievalBenchmarkQuery[]
  qrels: readonly KnowledgeRetrievalBenchmarkQrel[]
  source?: KnowledgeBenchmarkSource
  tags?: readonly string[]
  k?: number
  targetKind?: 'page' | 'page-path' | 'source'
  documentTarget?: (
    documentId: string,
    qrel: KnowledgeRetrievalBenchmarkQrel,
  ) => RetrievalGoldTarget
  splitOf?: (queryId: string) => KnowledgeBenchmarkSplit
}

export const INDUSTRY_RAG_BENCHMARKS: readonly KnowledgeBenchmarkSpec[] = [
  {
    id: 'beir',
    family: 'beir',
    taskKind: 'retrieval',
    primaryMetrics: ['nDCG@10', 'Recall@100', 'MRR@10'],
    adapter: 'buildRetrievalBenchmarkCasesFromQrels',
    notes: 'Classic zero-shot retrieval suites using query/corpus/qrels files.',
  },
  {
    id: 'mteb-retrieval',
    family: 'mteb-retrieval',
    taskKind: 'retrieval',
    primaryMetrics: ['nDCG@10', 'Recall@100'],
    adapter: 'buildRetrievalBenchmarkCasesFromQrels',
    notes: 'MTEB retrieval task shape; same qrels bridge, different dataset provenance.',
  },
  {
    id: 'msmarco',
    family: 'msmarco',
    taskKind: 'retrieval',
    primaryMetrics: ['MRR@10', 'Recall@100'],
    adapter: 'buildRetrievalBenchmarkCasesFromQrels',
    notes: 'Passage retrieval and reranking smoke for web-style questions.',
  },
  {
    id: 'trec-dl',
    family: 'trec-dl',
    taskKind: 'retrieval',
    primaryMetrics: ['nDCG@10', 'MAP', 'Recall@100'],
    adapter: 'buildRetrievalBenchmarkCasesFromQrels',
    notes: 'Deep Learning Track judgments over MS MARCO-derived corpora.',
  },
  {
    id: 'miracl',
    family: 'miracl',
    taskKind: 'retrieval',
    primaryMetrics: ['nDCG@10', 'Recall@100'],
    adapter: 'buildRetrievalBenchmarkCasesFromQrels',
    notes: 'Multilingual retrieval; use language tags on cases.',
  },
  {
    id: 'lotte',
    family: 'lotte',
    taskKind: 'retrieval',
    primaryMetrics: ['Success@5', 'Recall@100'],
    adapter: 'buildRetrievalBenchmarkCasesFromQrels',
    notes: 'Long-tail search tasks; map collection/domain into tags.',
  },
  {
    id: 'bright',
    family: 'bright',
    taskKind: 'retrieval',
    primaryMetrics: ['nDCG@10', 'Recall@100'],
    adapter: 'buildRetrievalBenchmarkCasesFromQrels',
    notes: 'Reasoning-heavy retrieval; preserve domain tags for slice reporting.',
  },
  {
    id: 'crag',
    family: 'crag',
    taskKind: 'rag-answer',
    primaryMetrics: ['claim_recall', 'citation_recall', 'hallucination_safe'],
    adapter: 'KnowledgeAnswerBenchmarkCase',
    notes: 'Answer quality and freshness cases; use required/forbidden claims plus citations.',
  },
  {
    id: 'hotpotqa',
    family: 'hotpotqa',
    taskKind: 'rag-answer',
    primaryMetrics: ['claim_recall', 'citation_recall'],
    adapter: 'KnowledgeAnswerBenchmarkCase',
    notes: 'Multihop QA; encode each supporting fact as a required claim.',
  },
  {
    id: 'kilt',
    family: 'kilt',
    taskKind: 'rag-answer',
    primaryMetrics: ['claim_recall', 'citation_recall'],
    adapter: 'KnowledgeAnswerBenchmarkCase',
    notes: 'Knowledge-intensive generation with provenance; encode expected pages/sources.',
  },
  {
    id: 'ragtruth',
    family: 'ragtruth',
    taskKind: 'hallucination',
    primaryMetrics: ['hallucination_safe', 'forbidden_claim_rate'],
    adapter: 'KnowledgeAnswerBenchmarkCase',
    notes: 'Hallucination detection; encode hallucinated spans as forbidden claims.',
  },
  {
    id: 'faithbench',
    family: 'faithbench',
    taskKind: 'hallucination',
    primaryMetrics: ['hallucination_safe', 'forbidden_claim_rate'],
    adapter: 'KnowledgeAnswerBenchmarkCase',
    notes: 'Faithfulness benchmark; score unsupported claims as forbidden claims.',
  },
  {
    id: 'first-party/kb-improvement',
    family: 'first-party',
    taskKind: 'kb-improvement',
    primaryMetrics: ['claim_recall', 'hallucination_safe', 'score'],
    adapter: 'KnowledgeAnswerBenchmarkCase',
    notes: 'Project-owned candidate-KB validation; grade the produced KB text or answer bundle.',
  },
]

export function buildIndustryRagBenchmarkSmokeCases(
  specs: readonly KnowledgeBenchmarkSpec[] = INDUSTRY_RAG_BENCHMARKS,
): KnowledgeBenchmarkCase[] {
  return specs.map((spec) => {
    const source = {
      name: spec.id,
      version: 'smoke',
    }
    const split = spec.taskKind === 'retrieval' ? 'search' : 'holdout'
    const tags = unique(['industry-smoke', spec.id, spec.family, spec.taskKind])
    if (spec.taskKind === 'retrieval') {
      return {
        id: `${spec.id}/smoke:q1`,
        family: spec.family,
        taskKind: 'retrieval',
        split,
        tags,
        source,
        query: `${spec.id} smoke retrieval query`,
        expected: [{ kind: 'page', pageId: `${spec.id}:doc-1` }],
        k: 5,
        metadata: {
          adapter: spec.adapter,
          primaryMetrics: spec.primaryMetrics,
        },
      }
    }

    return {
      id: `${spec.id}/smoke:q1`,
      family: spec.family,
      taskKind: spec.taskKind,
      split,
      tags,
      source,
      prompt: `${spec.id} smoke benchmark prompt`,
      requiredClaims: [
        {
          id: `${spec.id}:required`,
          anyOf: [`${spec.id} supported answer`],
        },
      ],
      forbiddenClaims: [
        {
          id: `${spec.id}:unsupported`,
          anyOf: [`${spec.id} unsupported claim`],
        },
      ],
      expectedSourceIds: [`${spec.id}:source-1`],
      referenceAnswer: `${spec.id} supported answer`,
      metadata: {
        adapter: spec.adapter,
        primaryMetrics: spec.primaryMetrics,
      },
    }
  })
}

export function respondToIndustryRagBenchmarkSmokeCase(input: {
  case: KnowledgeBenchmarkCase
}): KnowledgeBenchmarkArtifact {
  const testCase = input.case
  if (testCase.taskKind === 'retrieval') {
    const expected = Array.isArray(testCase.expected) ? testCase.expected[0] : testCase.expected
    const hit = hitForExpectedTarget(expected, testCase.id)
    return {
      hits: [hit],
      costUsd: 0.001,
      durationMs: 1,
      metadata: {
        smoke: true,
      },
    }
  }

  return {
    answer: (testCase.requiredClaims ?? [])
      .map((claim) => claim.anyOf[0])
      .filter((fragment): fragment is string => Boolean(fragment))
      .join(' '),
    citedSourceIds: testCase.expectedSourceIds ?? [],
    costUsd: 0.001,
    durationMs: 1,
    metadata: {
      smoke: true,
    },
  }
}

export function parseKnowledgeBenchmarkJsonl<T = unknown>(text: string): T[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as T
      } catch (error) {
        throw new Error(`invalid JSONL row ${index + 1}: ${(error as Error).message}`)
      }
    })
}

export function parseKnowledgeBenchmarkQrels(text: string): KnowledgeRetrievalBenchmarkQrel[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .flatMap((line, index) => {
      const parts = line.split(/\t|\s+/)
      if (parts.length < 3) return []
      const [queryId, maybeZeroOrDocId, maybeDocIdOrScore, maybeScore] = parts
      if (!queryId || !maybeZeroOrDocId || !maybeDocIdOrScore) return []
      if (queryId.toLowerCase() === 'qid' || queryId.toLowerCase() === 'query-id') return []
      const documentId = maybeScore === undefined ? maybeZeroOrDocId : maybeDocIdOrScore
      const scoreText = maybeScore === undefined ? maybeDocIdOrScore : maybeScore
      const score = Number(scoreText)
      if (!documentId || !Number.isFinite(score)) {
        throw new Error(`invalid qrels row ${index + 1}: expected query id, doc id, score`)
      }
      return [{ queryId, documentId, score }]
    })
}

export function buildRetrievalBenchmarkCasesFromQrels(
  options: BuildRetrievalBenchmarkCasesFromQrelsOptions,
): KnowledgeRetrievalBenchmarkCase[] {
  const qrelsByQuery = new Map<string, KnowledgeRetrievalBenchmarkQrel[]>()
  for (const qrel of options.qrels) {
    if (qrel.score <= 0) continue
    const list = qrelsByQuery.get(qrel.queryId) ?? []
    list.push(qrel)
    qrelsByQuery.set(qrel.queryId, list)
  }

  return options.queries.flatMap((query) => {
    const qrels = qrelsByQuery.get(query.id) ?? []
    if (qrels.length === 0) return []
    const split = query.split ?? options.splitOf?.(query.id)
    const expected = qrels.map((qrel) =>
      options.documentTarget
        ? options.documentTarget(qrel.documentId, qrel)
        : defaultDocumentTarget(qrel.documentId, options.targetKind ?? 'page'),
    )
    return [
      compactObject({
        id: `${options.benchmarkId}:${query.id}`,
        family: options.family,
        taskKind: 'retrieval' as const,
        query: query.text,
        expected,
        k: options.k,
        split,
        tags: unique([...(options.tags ?? []), ...(query.tags ?? []), ...(split ? [split] : [])]),
        source: options.source,
        metadata: query.metadata,
      }) as KnowledgeRetrievalBenchmarkCase,
    ]
  })
}

export async function runKnowledgeBenchmarkSuite<TArtifact = KnowledgeBenchmarkArtifact>(
  options: RunKnowledgeBenchmarkSuiteOptions<TArtifact>,
): Promise<RunKnowledgeBenchmarkSuiteResult<TArtifact>> {
  const storage = options.storage ?? fsCampaignStorage()
  const scenarios = buildKnowledgeBenchmarkScenarios(options.cases, options.splits)
  const dispatch: RunCampaignOptions<KnowledgeBenchmarkScenario, TArtifact>['dispatch'] = async (
    scenario,
    context,
  ) => {
    const artifact = await options.respond({ case: scenario.case, scenario, context })
    observeArtifactCost(context, artifact)
    return artifact
  }
  const campaign = await runCampaign<KnowledgeBenchmarkScenario, TArtifact>({
    scenarios,
    dispatch,
    dispatchRef: 'agent-knowledge:benchmark-suite',
    judges: [knowledgeBenchmarkJudge<TArtifact>()],
    runDir: options.runDir,
    repo: options.repo,
    seed: options.seed,
    reps: options.reps,
    resumable: options.resumable,
    costCeiling: options.costCeiling,
    maxConcurrency: options.maxConcurrency,
    dispatchTimeoutMs: options.dispatchTimeoutMs,
    expectUsage: options.expectUsage ?? 'off',
    storage,
    now: options.now,
  })
  const report = summarizeKnowledgeBenchmarkCampaign({ scenarios, campaign })
  const reportJsonPath = join(campaign.runDir, 'knowledge-benchmark-report.json')
  const reportMarkdownPath = join(campaign.runDir, 'knowledge-benchmark-report.md')
  storage.write(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`)
  storage.write(reportMarkdownPath, renderKnowledgeBenchmarkReportMarkdown(report))
  return {
    scenarios,
    campaign,
    report,
    reportJsonPath,
    reportMarkdownPath,
  }
}

export function renderKnowledgeBenchmarkReportMarkdown(report: KnowledgeBenchmarkReport): string {
  return [
    '# Knowledge Benchmark Report',
    '',
    `- cases: ${report.totalCases}`,
    `- cells: ${report.totalCells} total, ${report.cellsFailed} failed, ${report.cellsCached} cached`,
    `- cost: $${formatNumber(report.totalCostUsd)}`,
    `- score: mean ${formatNumber(report.score.mean)}, median ${formatNumber(report.score.median)}, p90 ${formatNumber(report.score.p90)}, n=${report.score.n}`,
    '',
    '## Task Kinds',
    '',
    renderSliceTable(report.byTaskKind),
    '',
    '## Splits',
    '',
    renderSliceTable(report.bySplit),
    '',
    '## Dimensions',
    '',
    '| dimension | n | mean | p90 |',
    '| --- | ---: | ---: | ---: |',
    ...Object.entries(report.dimensions)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([key, dist]) =>
          `| ${key} | ${dist.n} | ${formatNumber(dist.mean)} | ${formatNumber(dist.p90)} |`,
      ),
    '',
  ].join('\n')
}

export function buildKnowledgeBenchmarkScenarios(
  cases: readonly KnowledgeBenchmarkCase[],
  splits?: readonly KnowledgeBenchmarkSplit[],
): KnowledgeBenchmarkScenario[] {
  const splitSet = splits ? new Set(splits) : null
  return cases.flatMap((testCase) => {
    const splitTag = testCase.split ?? 'dev'
    if (splitSet && !splitSet.has(splitTag)) return []
    return [
      compactObject({
        id: testCase.id,
        kind: 'knowledge-benchmark' as const,
        family: testCase.family,
        taskKind: testCase.taskKind,
        splitTag,
        tags: unique([splitTag, ...(testCase.tags ?? [])]),
        case: compactObject(testCase),
      }) as KnowledgeBenchmarkScenario,
    ]
  })
}

export function knowledgeBenchmarkJudge<TArtifact = KnowledgeBenchmarkArtifact>(): JudgeConfig<
  TArtifact,
  KnowledgeBenchmarkScenario
> {
  return {
    name: 'knowledge-benchmark',
    dimensions: [
      { key: 'score', description: 'primary knowledge benchmark score' },
      { key: 'passed', description: '1 when the benchmark case passes' },
      { key: 'claim_recall', description: 'required claim coverage' },
      { key: 'citation_recall', description: 'expected citation/source coverage' },
      { key: 'hallucination_safe', description: '1 when no forbidden claim appears' },
    ],
    appliesTo: (scenario) => scenario.kind === 'knowledge-benchmark',
    score({ artifact, scenario }) {
      const evaluation = scoreKnowledgeBenchmarkArtifact(scenario.case, artifact)
      return {
        dimensions: {
          score: evaluation.score,
          passed: evaluation.passed ? 1 : 0,
          ...evaluation.dimensions,
        },
        composite: evaluation.score,
        notes: evaluation.notes,
      }
    },
  }
}

export function scoreKnowledgeBenchmarkArtifact<TArtifact>(
  testCase: KnowledgeBenchmarkCase,
  artifact: TArtifact,
): KnowledgeBenchmarkEvaluation {
  if (testCase.taskKind === 'retrieval') {
    const retrievalArtifact = normalizeRetrievalArtifact(testCase, artifact)
    const metrics = scoreRetrievalArtifact(retrievalArtifact, retrievalScenarioForCase(testCase))
    return {
      score: metrics.recall,
      passed: metrics.recall >= 1,
      dimensions: {
        recall: metrics.recall,
        mrr: metrics.mrr,
        ndcg: metrics.ndcg,
        precision_at_k: metrics.precisionAtK,
        expected_count: metrics.expectedCount,
        matched_count: metrics.matchedCount,
      },
      notes: `matched ${metrics.matchedCount}/${metrics.expectedCount}; first_hit_rank=${metrics.firstHitRank ?? 'none'}`,
      raw: { matchedTargetIds: metrics.matchedTargetIds },
    }
  }

  const answerArtifact = artifact as KnowledgeBenchmarkArtifact
  const text = answerArtifact.text ?? answerArtifact.answer ?? ''
  const required = scoreClaims(text, testCase.requiredClaims ?? [])
  const forbidden = scoreForbiddenClaims(text, testCase.forbiddenClaims ?? [])
  const citation = scoreCitationRecall(
    answerArtifact.citedSourceIds ?? [],
    testCase.expectedSourceIds ?? [],
  )
  const components = [
    required.totalWeight > 0 ? required.recall : undefined,
    testCase.expectedSourceIds && testCase.expectedSourceIds.length > 0 ? citation : undefined,
    forbidden.safe,
  ].filter((value): value is number => value !== undefined)
  const score = mean(components)
  return {
    score,
    passed: score >= 1,
    dimensions: {
      claim_recall: required.recall,
      citation_recall: citation,
      hallucination_safe: forbidden.safe,
      forbidden_claim_rate: forbidden.rate,
      required_claim_count: required.total,
      matched_claim_count: required.matched,
      forbidden_claim_count: forbidden.total,
      matched_forbidden_claim_count: forbidden.matched,
    },
    notes: `required=${required.matched}/${required.total}; forbidden=${forbidden.matched}/${forbidden.total}; citation_recall=${citation.toFixed(3)}`,
    raw: {
      matchedRequiredClaimIds: required.matchedIds,
      matchedForbiddenClaimIds: forbidden.matchedIds,
    },
  }
}

export function summarizeKnowledgeBenchmarkCampaign<TArtifact>(input: {
  scenarios: readonly KnowledgeBenchmarkScenario[]
  campaign: CampaignResult<TArtifact, KnowledgeBenchmarkScenario>
}): KnowledgeBenchmarkReport {
  const scenariosById = new Map(input.scenarios.map((scenario) => [scenario.id, scenario]))
  const rows = input.campaign.cells.map((cell) => {
    const score = Object.values(cell.judgeScores)[0]
    const scenario = scenariosById.get(cell.scenarioId)
    return {
      cell,
      scenario,
      composite: score?.composite ?? 0,
      passed: (score?.dimensions.passed ?? 0) >= 1,
      dimensions: score?.dimensions ?? {},
    }
  })
  const successful = rows.filter((row) => !row.cell.error)
  return {
    totalCases: input.scenarios.length,
    totalCells: input.campaign.cells.length,
    cellsFailed: input.campaign.aggregates.cellsFailed,
    cellsCached: input.campaign.aggregates.cellsCached,
    totalCostUsd: input.campaign.aggregates.totalCostUsd,
    bySplit: summarizeSlices(successful, (row) => row.scenario?.splitTag ?? 'unknown'),
    byFamily: summarizeSlices(successful, (row) => row.scenario?.family ?? 'unknown'),
    byTaskKind: summarizeSlices(successful, (row) => row.scenario?.taskKind ?? 'unknown'),
    dimensions: summarizeDimensions(successful.map((row) => row.dimensions)),
    score: distribution(successful.map((row) => row.composite)),
  }
}

function retrievalScenarioForCase(
  testCase: KnowledgeRetrievalBenchmarkCase,
): RetrievalEvalScenario {
  return {
    id: testCase.id,
    kind: 'retrieval-eval',
    query: testCase.query,
    expected: testCase.expected,
    ...(testCase.k !== undefined ? { k: testCase.k } : {}),
  }
}

function normalizeRetrievalArtifact<TArtifact>(
  testCase: KnowledgeRetrievalBenchmarkCase,
  artifact: TArtifact,
): RetrievalEvalArtifact {
  const maybe = artifact as Partial<RetrievalEvalArtifact> & KnowledgeBenchmarkArtifact
  const hits = maybe.hits ?? []
  if (Array.isArray(maybe.hits) && maybe.query && maybe.requestedK !== undefined) {
    return maybe as RetrievalEvalArtifact
  }
  return {
    config: {},
    query: testCase.query,
    requestedK: testCase.k ?? Math.max(1, hits.length),
    hits,
    durationMs: maybe.durationMs ?? 0,
    ...(maybe.costUsd !== undefined ? { costUsd: maybe.costUsd } : {}),
    ...(maybe.metadata ? { metadata: maybe.metadata } : {}),
  }
}

function defaultDocumentTarget(
  documentId: string,
  targetKind: 'page' | 'page-path' | 'source',
): RetrievalGoldTarget {
  switch (targetKind) {
    case 'page':
      return { kind: 'page', pageId: documentId }
    case 'page-path':
      return { kind: 'page-path', path: documentId }
    case 'source':
      return { kind: 'source', sourceId: documentId }
  }
}

function hitForExpectedTarget(
  expected: RetrievalGoldTarget | undefined,
  fallbackId: string,
): RetrievedKnowledgeHit {
  if (!expected) {
    return {
      pageId: fallbackId,
      path: `${fallbackId}.md`,
      rank: 1,
    }
  }
  switch (expected.kind) {
    case 'page':
      return {
        pageId: expected.pageId,
        path: `${expected.pageId}.md`,
        rank: 1,
      }
    case 'page-path':
      return {
        pageId: expected.path,
        path: expected.path,
        rank: 1,
      }
    case 'source':
      return {
        pageId: expected.sourceId,
        path: `${expected.sourceId}.md`,
        sourceIds: [expected.sourceId],
        rank: 1,
      }
    case 'source-anchor':
      return {
        pageId: expected.sourceId,
        path: `${expected.sourceId}.md`,
        sourceIds: [expected.sourceId],
        sourceSpans: [{ sourceId: expected.sourceId, anchorId: expected.anchorId }],
        rank: 1,
      }
    case 'source-span':
      return {
        pageId: expected.sourceId,
        path: `${expected.sourceId}.md`,
        sourceIds: [expected.sourceId],
        sourceSpans: [
          {
            sourceId: expected.sourceId,
            charStart: expected.charStart,
            charEnd: expected.charEnd,
          },
        ],
        rank: 1,
      }
  }
}

function scoreClaims(text: string, claims: readonly KnowledgeClaimMatcher[]) {
  let matched = 0
  let matchedWeight = 0
  let totalWeight = 0
  const matchedIds: string[] = []
  const haystack = text.toLowerCase()
  for (const claim of claims) {
    const weight = claim.weight ?? 1
    totalWeight += weight
    if (claim.anyOf.some((fragment) => haystack.includes(fragment.toLowerCase()))) {
      matched += 1
      matchedWeight += weight
      matchedIds.push(claim.id)
    }
  }
  return {
    total: claims.length,
    matched,
    totalWeight,
    recall: totalWeight === 0 ? 1 : matchedWeight / totalWeight,
    matchedIds,
  }
}

function scoreForbiddenClaims(text: string, claims: readonly KnowledgeClaimMatcher[]) {
  const matched = scoreClaims(text, claims)
  return {
    total: claims.length,
    matched: matched.matched,
    matchedIds: matched.matchedIds,
    rate: claims.length === 0 ? 0 : matched.matched / claims.length,
    safe: matched.matched === 0 ? 1 : 0,
  }
}

function scoreCitationRecall(
  citedSourceIds: readonly string[],
  expectedSourceIds: readonly string[],
): number {
  if (expectedSourceIds.length === 0) return 1
  const cited = new Set(citedSourceIds)
  const matched = expectedSourceIds.filter((sourceId) => cited.has(sourceId)).length
  return matched / expectedSourceIds.length
}

function summarizeDimensions(
  rows: Array<Record<string, number>>,
): Record<string, KnowledgeBenchmarkDistribution> {
  const values = new Map<string, number[]>()
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (!Number.isFinite(value)) continue
      const list = values.get(key) ?? []
      list.push(value)
      values.set(key, list)
    }
  }
  return Object.fromEntries([...values.entries()].map(([key, vals]) => [key, distribution(vals)]))
}

function summarizeSlices<T>(
  rows: T[],
  keyOf: (row: T) => string,
): Record<string, KnowledgeBenchmarkSliceSummary> {
  const grouped = new Map<string, T[]>()
  for (const row of rows) {
    const key = keyOf(row)
    const list = grouped.get(key) ?? []
    list.push(row)
    grouped.set(key, list)
  }
  return Object.fromEntries(
    [...grouped.entries()].map(([key, list]) => {
      const withShape = list as Array<{ composite: number; passed: boolean }>
      return [
        key,
        {
          n: list.length,
          meanScore: mean(withShape.map((row) => row.composite)),
          passRate: mean(withShape.map((row) => (row.passed ? 1 : 0))),
          score: distribution(withShape.map((row) => row.composite)),
        },
      ]
    }),
  )
}

function distribution(values: readonly number[]): KnowledgeBenchmarkDistribution {
  const finite = [...values].filter(Number.isFinite).sort((a, b) => a - b)
  if (finite.length === 0) return { n: 0, min: 0, mean: 0, median: 0, p90: 0, max: 0 }
  return {
    n: finite.length,
    min: finite[0]!,
    mean: mean(finite),
    median: percentile(finite, 0.5),
    p90: percentile(finite, 0.9),
    max: finite[finite.length - 1]!,
  }
}

function percentile(sortedValues: readonly number[], p: number): number {
  if (sortedValues.length === 0) return 0
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(p * sortedValues.length) - 1),
  )
  return sortedValues[index]!
}

function mean(values: readonly number[]): number {
  const finite = values.filter(Number.isFinite)
  if (finite.length === 0) return 0
  return finite.reduce((sum, value) => sum + value, 0) / finite.length
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function renderSliceTable(slices: Record<string, KnowledgeBenchmarkSliceSummary>): string {
  const rows = Object.entries(slices).map(
    ([key, slice]) =>
      `| ${key} | ${slice.n} | ${formatNumber(slice.meanScore)} | ${formatNumber(slice.passRate)} | ${formatNumber(slice.score.p90)} |`,
  )
  return [
    '| slice | n | mean score | pass rate | score p90 |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...(rows.length ? rows : ['| none | 0 | 0 | 0 | 0 |']),
  ].join('\n')
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  return value.toFixed(value === 0 || Math.abs(value) >= 10 ? 0 : 3)
}

function observeArtifactCost(context: DispatchContext, artifact: unknown): void {
  const costUsd = (artifact as { costUsd?: unknown })?.costUsd
  if (costUsd === undefined) return
  if (typeof costUsd !== 'number' || !Number.isFinite(costUsd) || costUsd < 0) {
    throw new Error(
      `benchmark artifact costUsd must be non-negative finite, got ${String(costUsd)}`,
    )
  }
  context.cost.observe(costUsd, 'agent-knowledge:benchmark')
}

function compactObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactObject)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, compactObject(entry)]),
  )
}
