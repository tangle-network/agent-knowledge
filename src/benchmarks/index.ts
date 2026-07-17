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
import { memoryHitToSourceRecord, memoryWriteResultToSourceRecord } from '../memory/source-record'
import type {
  AgentMemoryAdapter,
  AgentMemoryHit,
  AgentMemoryScope,
  AgentMemoryWriteInput,
} from '../memory/types'
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
  | 'memory-ingest'
  | 'memory-recall'
  | 'memory-temporal'
  | 'memory-update'
  | 'memory-forgetting'
  | 'memory-reasoning'
  | 'memory-summarization'
  | 'memory-recommendation'
  | 'memory-multiparty'

export type KnowledgeAnswerBenchmarkTaskKind = 'rag-answer' | 'hallucination' | 'kb-improvement'

export type KnowledgeMemoryBenchmarkTaskKind = Exclude<
  KnowledgeBenchmarkTaskKind,
  'retrieval' | KnowledgeAnswerBenchmarkTaskKind
>

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
  | 'locomo'
  | 'longmemeval'
  | 'longmemeval-v2'
  | 'memora'
  | 'memoryagentbench'
  | 'memorybank'
  | 'groupmembench'
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

export interface KnowledgeMemoryEvent {
  id: string
  text: string
  actorId?: string
  sessionId?: string
  timestamp?: string
  metadata?: Record<string, unknown>
}

export interface KnowledgeMemoryFactMatcher extends KnowledgeClaimMatcher {
  sourceEventIds?: readonly string[]
  validAt?: string
  obsolete?: boolean
}

export interface KnowledgeAnswerBenchmarkCase extends KnowledgeBenchmarkCaseBase {
  taskKind: KnowledgeAnswerBenchmarkTaskKind
  prompt: string
  requiredClaims?: readonly KnowledgeClaimMatcher[]
  forbiddenClaims?: readonly KnowledgeClaimMatcher[]
  expectedSourceIds?: readonly string[]
  referenceAnswer?: string
}

export interface KnowledgeMemoryBenchmarkCase extends KnowledgeBenchmarkCaseBase {
  taskKind: KnowledgeMemoryBenchmarkTaskKind
  events: readonly KnowledgeMemoryEvent[]
  prompt: string
  requiredFacts?: readonly KnowledgeMemoryFactMatcher[]
  forbiddenFacts?: readonly KnowledgeMemoryFactMatcher[]
  expectedEventIds?: readonly string[]
  expectedActorIds?: readonly string[]
  referenceAnswer?: string
}

export type KnowledgeBenchmarkCase =
  | KnowledgeRetrievalBenchmarkCase
  | KnowledgeAnswerBenchmarkCase
  | KnowledgeMemoryBenchmarkCase

export interface KnowledgeBenchmarkArtifact {
  answer?: string
  text?: string
  hits?: readonly RetrievedKnowledgeHit[]
  citedSourceIds?: readonly string[]
  rememberedFacts?: readonly string[]
  citedEventIds?: readonly string[]
  usedMemoryIds?: readonly string[]
  actorIds?: readonly string[]
  /** Informational copy. Billable responders account through context.cost.runPaidCall. */
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

export interface MemoryAdapterBenchmarkCandidate {
  id: string
  label?: string
  createAdapter: () => AgentMemoryAdapter | Promise<AgentMemoryAdapter>
  searchLimit?: number
  costUsdPerCase?: number
  scope?: AgentMemoryScope
}

export interface RunMemoryAdapterBenchmarkOptions {
  cases: readonly KnowledgeMemoryBenchmarkCase[]
  candidates: readonly MemoryAdapterBenchmarkCandidate[]
  runDir: string
  storage?: CampaignStorage
  repo?: string
  seed?: number
  reps?: number
  resumable?: boolean
  costCeiling?: number
  maxConcurrency?: number
  dispatchTimeoutMs?: number
  expectUsage?: 'assert' | 'warn' | 'off'
  now?: () => Date
}

export interface MemoryAdapterBenchmarkRankingRow {
  rank: number
  candidateId: string
  label: string
  adapterId: string
  scoreMean: number
  passRate: number
  totalCases: number
  totalCells: number
  cellsFailed: number
  totalCostUsd: number
  reportJsonPath: string
  reportMarkdownPath: string
  report: KnowledgeBenchmarkReport
}

export interface RunMemoryAdapterBenchmarkResult {
  rows: readonly MemoryAdapterBenchmarkRankingRow[]
  rankingJsonPath: string
  rankingMarkdownPath: string
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

export const INDUSTRY_RAG_BENCHMARKS: readonly (KnowledgeBenchmarkSpec & {
  taskKind: 'retrieval' | KnowledgeAnswerBenchmarkTaskKind
})[] = [
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

export const INDUSTRY_MEMORY_BENCHMARKS: readonly (KnowledgeBenchmarkSpec & {
  taskKind: KnowledgeMemoryBenchmarkTaskKind
})[] = [
  {
    id: 'locomo/qa',
    family: 'locomo',
    taskKind: 'memory-recall',
    primaryMetrics: ['memory_fact_recall', 'memory_event_recall'],
    adapter: 'KnowledgeMemoryBenchmarkCase',
    notes: 'Long-term conversational QA over multi-session histories.',
  },
  {
    id: 'locomo/event-summary',
    family: 'locomo',
    taskKind: 'memory-summarization',
    primaryMetrics: ['memory_fact_recall', 'memory_event_recall'],
    adapter: 'KnowledgeMemoryBenchmarkCase',
    notes: 'Event summarization over long conversational histories.',
  },
  {
    id: 'longmemeval',
    family: 'longmemeval',
    taskKind: 'memory-temporal',
    primaryMetrics: ['memory_fact_recall', 'memory_stale_safe', 'memory_event_recall'],
    adapter: 'KnowledgeMemoryBenchmarkCase',
    notes: 'Long-term assistant memory with temporal and update-sensitive probes.',
  },
  {
    id: 'longmemeval-v2',
    family: 'longmemeval-v2',
    taskKind: 'memory-reasoning',
    primaryMetrics: ['memory_fact_recall', 'memory_event_recall', 'score'],
    adapter: 'KnowledgeMemoryBenchmarkCase',
    notes: 'Experience reuse from long agent histories; track accuracy and latency.',
  },
  {
    id: 'memora',
    family: 'memora',
    taskKind: 'memory-update',
    primaryMetrics: ['memory_fact_recall', 'memory_stale_safe', 'memory_stale_rate'],
    adapter: 'KnowledgeMemoryBenchmarkCase',
    notes: 'Forgetting-aware memory accuracy: reward current facts and penalize obsolete ones.',
  },
  {
    id: 'memoryagentbench',
    family: 'memoryagentbench',
    taskKind: 'memory-ingest',
    primaryMetrics: ['memory_fact_recall', 'memory_event_recall'],
    adapter: 'KnowledgeMemoryBenchmarkCase',
    notes: 'Incremental multi-turn information intake before later recall.',
  },
  {
    id: 'memorybank',
    family: 'memorybank',
    taskKind: 'memory-recommendation',
    primaryMetrics: ['memory_fact_recall', 'memory_stale_safe'],
    adapter: 'KnowledgeMemoryBenchmarkCase',
    notes: 'Personalized memory use for preference-aware downstream choices.',
  },
  {
    id: 'groupmembench',
    family: 'groupmembench',
    taskKind: 'memory-multiparty',
    primaryMetrics: ['memory_fact_recall', 'memory_actor_recall', 'memory_stale_safe'],
    adapter: 'KnowledgeMemoryBenchmarkCase',
    notes: 'Multi-party memory with speaker attribution, update, and term ambiguity pressure.',
  },
  {
    id: 'first-party/memory-lifecycle',
    family: 'first-party',
    taskKind: 'memory-forgetting',
    primaryMetrics: ['memory_fact_recall', 'memory_stale_safe', 'memory_event_recall'],
    adapter: 'KnowledgeMemoryBenchmarkCase',
    notes: 'Project-owned lifecycle pack for ingest, recall, update, forgetting, and ambiguity.',
  },
]

export function buildIndustryRagBenchmarkSmokeCases(
  specs: readonly (KnowledgeBenchmarkSpec & {
    taskKind: 'retrieval' | KnowledgeAnswerBenchmarkTaskKind
  })[] = INDUSTRY_RAG_BENCHMARKS,
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
  if (isKnowledgeMemoryBenchmarkCase(testCase)) {
    return respondToIndustryMemoryBenchmarkSmokeCase({ case: testCase })
  }
  if (testCase.taskKind === 'retrieval') {
    const expected = Array.isArray(testCase.expected) ? testCase.expected[0] : testCase.expected
    const hit = hitForExpectedTarget(expected, testCase.id)
    return {
      hits: [hit],
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
    durationMs: 1,
    metadata: {
      smoke: true,
    },
  }
}

export function buildIndustryMemoryBenchmarkSmokeCases(
  specs: readonly (KnowledgeBenchmarkSpec & {
    taskKind: KnowledgeMemoryBenchmarkTaskKind
  })[] = INDUSTRY_MEMORY_BENCHMARKS,
): KnowledgeMemoryBenchmarkCase[] {
  return specs.map((spec) => {
    const currentEventId = `${spec.id}:event-current`
    const staleEventId = `${spec.id}:event-stale`
    const actorId = spec.taskKind === 'memory-multiparty' ? 'teammate-ada' : 'user'
    const currentFact = `${spec.id} current memory`
    const staleFact = `${spec.id} stale memory`
    return {
      id: `${spec.id}/smoke:q1`,
      family: spec.family,
      taskKind: spec.taskKind,
      split: spec.taskKind === 'memory-forgetting' ? 'holdout' : 'dev',
      tags: unique(['memory-smoke', spec.id, spec.family, spec.taskKind]),
      source: {
        name: spec.id,
        version: 'smoke',
      },
      events: [
        {
          id: staleEventId,
          actorId,
          sessionId: `${spec.id}:session-1`,
          timestamp: '2026-01-01T00:00:00.000Z',
          text: `${actorId} once had this obsolete fact: ${staleFact}.`,
        },
        {
          id: currentEventId,
          actorId,
          sessionId: `${spec.id}:session-2`,
          timestamp: '2026-02-01T00:00:00.000Z',
          text: `${actorId} updated the durable fact to: ${currentFact}.`,
        },
      ],
      prompt: `Use memory to answer the ${spec.id} smoke probe.`,
      requiredFacts: [
        {
          id: `${spec.id}:current`,
          anyOf: [currentFact],
          sourceEventIds: [currentEventId],
        },
      ],
      forbiddenFacts: [
        {
          id: `${spec.id}:stale`,
          anyOf: [staleFact],
          sourceEventIds: [staleEventId],
          obsolete: true,
        },
      ],
      expectedEventIds: [currentEventId],
      expectedActorIds: [actorId],
      referenceAnswer: currentFact,
      metadata: {
        adapter: spec.adapter,
        primaryMetrics: spec.primaryMetrics,
      },
    }
  })
}

export function respondToIndustryMemoryBenchmarkSmokeCase(input: {
  case: KnowledgeMemoryBenchmarkCase
}): KnowledgeBenchmarkArtifact {
  const testCase = input.case
  const facts = testCase.requiredFacts
    ?.map((fact) => fact.anyOf[0])
    .filter((fragment): fragment is string => Boolean(fragment))
  return {
    answer: facts?.join(' ') ?? '',
    rememberedFacts: facts ?? [],
    citedEventIds: testCase.expectedEventIds ?? [],
    actorIds: testCase.expectedActorIds ?? [],
    durationMs: 1,
    metadata: {
      smoke: true,
    },
  }
}

export function buildFirstPartyMemoryLifecycleBenchmarkCases(): KnowledgeMemoryBenchmarkCase[] {
  const base = {
    family: 'first-party',
    source: {
      name: 'first-party/memory-lifecycle',
      version: 'real-v1',
    },
  } as const
  return [
    memoryLifecycleCase({
      ...base,
      id: 'first-party/memory-lifecycle:allergy',
      taskKind: 'memory-ingest',
      split: 'dev',
      actorId: 'user',
      prompt: 'What food restriction should catering remember for this user?',
      staleText: 'The user said they had no food allergies on the first onboarding form.',
      currentText: 'The user later corrected the profile: they have a severe peanut allergy.',
      required: 'severe peanut allergy',
      forbidden: 'no food allergies',
    }),
    memoryLifecycleCase({
      ...base,
      id: 'first-party/memory-lifecycle:account-tier',
      taskKind: 'memory-recall',
      split: 'dev',
      actorId: 'sales-ops',
      prompt: 'What is the customer account tier now?',
      staleText: 'Sales ops originally marked the customer as starter tier.',
      currentText: 'Sales ops updated the customer to enterprise tier after procurement approval.',
      required: 'enterprise tier',
      forbidden: 'starter tier',
    }),
    memoryLifecycleCase({
      ...base,
      id: 'first-party/memory-lifecycle:launch-date',
      taskKind: 'memory-temporal',
      split: 'holdout',
      actorId: 'pm',
      prompt: 'What launch date should the agent use?',
      staleText: 'The PM first planned the launch for April 3.',
      currentText: 'The PM moved the launch date to April 17 after legal review.',
      required: 'April 17',
      forbidden: 'April 3',
    }),
    memoryLifecycleCase({
      ...base,
      id: 'first-party/memory-lifecycle:briefing-channel',
      taskKind: 'memory-update',
      split: 'holdout',
      actorId: 'user',
      prompt: 'How should daily briefings be delivered now?',
      staleText: 'The user used to want daily briefings by SMS.',
      currentText: 'The user changed daily briefings to email only.',
      required: 'email only',
      forbidden: 'SMS',
    }),
    memoryLifecycleCase({
      ...base,
      id: 'first-party/memory-lifecycle:shipping-address',
      taskKind: 'memory-forgetting',
      split: 'holdout',
      actorId: 'user',
      prompt: 'What shipping address is current?',
      staleText: 'The old shipping address was 14 Pine Street, Apartment 2.',
      currentText: 'The current shipping address is 88 Cedar Avenue, Suite 9.',
      required: '88 Cedar Avenue, Suite 9',
      forbidden: '14 Pine Street',
    }),
    memoryLifecycleCase({
      ...base,
      id: 'first-party/memory-lifecycle:approval-owner',
      taskKind: 'memory-reasoning',
      split: 'holdout',
      actorId: 'finance',
      prompt: 'Who owns travel approval now?',
      staleText: 'Finance said Liam owned travel approvals last quarter.',
      currentText: 'Finance reassigned travel approvals to Maya this quarter.',
      required: 'Maya',
      forbidden: 'Liam',
    }),
    memoryLifecycleCase({
      ...base,
      id: 'first-party/memory-lifecycle:project-summary',
      taskKind: 'memory-summarization',
      split: 'dev',
      actorId: 'pm',
      prompt: 'Summarize the current Project Orion risks.',
      staleText: 'The old Project Orion risk was logo color churn.',
      currentText: 'The current Project Orion risks are vendor delay and a QA staffing gap.',
      required: 'vendor delay',
      extraRequired: 'QA staffing gap',
      forbidden: 'logo color churn',
    }),
    memoryLifecycleCase({
      ...base,
      id: 'first-party/memory-lifecycle:meeting-format',
      taskKind: 'memory-recommendation',
      split: 'holdout',
      actorId: 'user',
      prompt: 'What meeting format should the agent recommend?',
      staleText: 'The user previously preferred long video calls for planning.',
      currentText: 'The user now prefers async docs for planning instead of video calls.',
      required: 'async docs',
      forbidden: 'long video calls',
    }),
    memoryLifecycleCase({
      ...base,
      id: 'first-party/memory-lifecycle:multiparty-ada',
      taskKind: 'memory-multiparty',
      split: 'holdout',
      actorId: 'ada',
      prompt: 'Which SDK language did Ada ask for?',
      staleText: 'Ben asked for a Python notebook example.',
      currentText: 'Ada asked for a Rust SDK example.',
      required: 'Rust SDK',
      forbidden: 'Python notebook',
    }),
    memoryLifecycleCase({
      ...base,
      id: 'first-party/memory-lifecycle:timezone',
      taskKind: 'memory-recall',
      split: 'dev',
      actorId: 'user',
      prompt: 'What timezone should scheduling use for this user?',
      staleText: 'The user profile originally listed Pacific time.',
      currentText: 'The user corrected scheduling to America/Denver time.',
      required: 'America/Denver',
      forbidden: 'Pacific time',
    }),
    memoryLifecycleCase({
      ...base,
      id: 'first-party/memory-lifecycle:dinner-preference',
      taskKind: 'memory-update',
      split: 'holdout',
      actorId: 'user',
      prompt: 'What dinner preference should the assistant use?',
      staleText: 'The user was previously vegetarian for team dinners.',
      currentText: 'The user updated dinner restrictions to no shellfish.',
      required: 'no shellfish',
      forbidden: 'vegetarian',
    }),
    memoryLifecycleCase({
      ...base,
      id: 'first-party/memory-lifecycle:support-sla',
      taskKind: 'memory-temporal',
      split: 'holdout',
      actorId: 'support-lead',
      prompt: 'What support SLA is current?',
      staleText: 'Support used to promise a 24 hour response SLA.',
      currentText: 'Support changed the current response SLA to 2 business hours.',
      required: '2 business hours',
      forbidden: '24 hour',
    }),
  ]
}

export function createMemoryAdapterBenchmarkResponder(options: {
  adapter: AgentMemoryAdapter
  candidateId: string
  searchLimit?: number
  scope?: AgentMemoryScope
  costUsdPerCase?: number
  now?: () => Date
}): KnowledgeBenchmarkResponder<KnowledgeBenchmarkArtifact> {
  return async ({ case: testCase, context: dispatchContext }) => {
    if (!isKnowledgeMemoryBenchmarkCase(testCase)) {
      return { answer: '', metadata: { candidateId: options.candidateId, skipped: true } }
    }
    const costUsd = options.costUsdPerCase ?? 0
    if (!Number.isFinite(costUsd) || costUsd < 0) {
      throw new Error(`memory adapter costUsdPerCase must be non-negative finite, got ${costUsd}`)
    }

    const execute = async (): Promise<KnowledgeBenchmarkArtifact> => {
      const startedAt = Date.now()
      const scope = benchmarkMemoryScope(options.candidateId, testCase, options.scope)
      for (const event of testCase.events) {
        await options.adapter.write({
          id: event.id,
          kind: 'message',
          text: event.text,
          role: event.actorId === 'user' ? 'user' : 'assistant',
          title: `${testCase.id}:${event.id}`,
          scope,
          metadata: compactObject({
            benchmarkCaseId: testCase.id,
            eventId: event.id,
            actorId: event.actorId,
            sessionId: event.sessionId,
            timestamp: event.timestamp,
            ...event.metadata,
          }) as Record<string, unknown>,
        })
      }

      const adapterContext = await options.adapter.getContext(testCase.prompt, {
        scope,
        limit: options.searchLimit ?? 1,
        metadata: {
          benchmarkCaseId: testCase.id,
          candidateId: options.candidateId,
        },
      })
      const hits = adapterContext.hits
      return {
        answer: adapterContext.text,
        rememberedFacts: hits.map((hit) => hit.text),
        citedEventIds: unique(hits.map(memoryEventId).filter((id): id is string => Boolean(id))),
        usedMemoryIds: hits.map((hit) => hit.id),
        actorIds: unique(hits.map(memoryActorId).filter((id): id is string => Boolean(id))),
        costUsd,
        durationMs: Math.max(0, Date.now() - startedAt),
        metadata: {
          candidateId: options.candidateId,
          adapterId: options.adapter.id,
          hitCount: hits.length,
        },
      }
    }

    if (costUsd === 0) return execute()
    const receipt = {
      model: options.adapter.id,
      inputTokens: 0,
      outputTokens: 0,
      usageUnknown: true,
      actualCostUsd: costUsd,
    } as const
    const paid = await dispatchContext.cost.runPaidCall({
      actor: `agent-knowledge:memory-adapter:${options.adapter.id}`,
      model: options.adapter.id,
      maximumCharge: { externallyEnforcedMaximumUsd: costUsd },
      execute,
      receipt: () => receipt,
      receiptFromError: () => receipt,
    })
    if (!paid.succeeded) throw paid.error
    return paid.value
  }
}

export async function runMemoryAdapterBenchmark(
  options: RunMemoryAdapterBenchmarkOptions,
): Promise<RunMemoryAdapterBenchmarkResult> {
  if (options.candidates.length === 0)
    throw new Error('memory adapter benchmark requires candidates')
  assertUniqueNonEmptyStrings(
    options.candidates.map((candidate) => candidate.id),
    'memory adapter candidate id',
  )
  for (const candidate of options.candidates) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(candidate.id)) {
      throw new Error(
        `memory adapter candidate id '${candidate.id}' must be a safe directory segment`,
      )
    }
  }
  const storage = options.storage ?? fsCampaignStorage()
  const rows: MemoryAdapterBenchmarkRankingRow[] = []
  for (const candidate of options.candidates) {
    const adapter = await candidate.createAdapter()
    let primaryError: unknown
    try {
      const run = await runKnowledgeBenchmarkSuite({
        cases: options.cases,
        respond: createMemoryAdapterBenchmarkResponder({
          adapter,
          candidateId: candidate.id,
          searchLimit: candidate.searchLimit,
          scope: candidate.scope,
          costUsdPerCase: candidate.costUsdPerCase,
          now: options.now,
        }),
        runDir: join(options.runDir, candidate.id),
        storage,
        repo: options.repo,
        seed: options.seed,
        reps: options.reps,
        resumable: options.resumable,
        costCeiling: options.costCeiling,
        maxConcurrency: options.maxConcurrency,
        dispatchTimeoutMs: options.dispatchTimeoutMs,
        expectUsage: options.expectUsage ?? 'off',
        now: options.now,
      })
      rows.push({
        rank: 0,
        candidateId: candidate.id,
        label: candidate.label ?? candidate.id,
        adapterId: adapter.id,
        scoreMean: run.report.score.mean,
        passRate: run.report.dimensions.passed?.mean ?? 0,
        totalCases: run.report.totalCases,
        totalCells: run.report.totalCells,
        cellsFailed: run.report.cellsFailed,
        totalCostUsd: run.report.totalCostUsd,
        reportJsonPath: run.reportJsonPath,
        reportMarkdownPath: run.reportMarkdownPath,
        report: run.report,
      })
    } catch (error) {
      primaryError = error
    }
    const cleanupErrors: unknown[] = []
    try {
      await adapter.flush?.()
    } catch (error) {
      cleanupErrors.push(error)
    }
    try {
      await adapter.close?.()
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (primaryError || cleanupErrors.length > 0) {
      const errors = [...(primaryError ? [primaryError] : []), ...cleanupErrors]
      if (errors.length === 1) throw errors[0]
      throw new AggregateError(errors, `${candidate.id}: memory adapter benchmark cleanup failed`)
    }
  }

  const ranked = rows
    .sort((a, b) => b.scoreMean - a.scoreMean || a.totalCostUsd - b.totalCostUsd)
    .map((row, index) => ({ ...row, rank: index + 1 }))
  const rankingJsonPath = join(options.runDir, 'memory-adapter-ranking.json')
  const rankingMarkdownPath = join(options.runDir, 'memory-adapter-ranking.md')
  storage.write(rankingJsonPath, `${JSON.stringify({ rows: ranked }, null, 2)}\n`)
  storage.write(rankingMarkdownPath, renderMemoryAdapterRankingMarkdown(ranked))
  return {
    rows: ranked,
    rankingJsonPath,
    rankingMarkdownPath,
  }
}

export function createNoopMemoryBenchmarkAdapter(id = 'no-memory'): AgentMemoryAdapter {
  return {
    id,
    branchIsolation: { mode: 'scoped' },
    async search() {
      return []
    },
    async getContext(query) {
      return { query, text: '', hits: [], sourceRecords: [] }
    },
    async write(input) {
      return {
        accepted: false,
        id: input.id ?? `${id}:ignored`,
        uri: `memory://${id}/ignored`,
        kind: input.kind,
      }
    },
    async clear() {},
    async flush() {},
  }
}

export function createInMemoryBenchmarkAdapter(options: { id?: string } = {}): AgentMemoryAdapter {
  const id = options.id ?? 'in-memory'
  const rows: Array<{
    seq: number
    input: AgentMemoryWriteInput
    hit: AgentMemoryHit
  }> = []
  let seq = 0
  const adapter: AgentMemoryAdapter = {
    id,
    branchIsolation: { mode: 'scoped' },
    async search(query, searchOptions = {}) {
      const scored = rows
        .filter((row) => memoryScopeMatches(row.input.scope, searchOptions.scope))
        .filter((row) => !searchOptions.kinds?.length || searchOptions.kinds.includes(row.hit.kind))
        .map((row) => {
          const lexical = tokenOverlap(query, row.hit.text)
          const recency = row.seq / Math.max(1, seq)
          return {
            ...row.hit,
            score: lexical + recency * 0.01,
            normalizedScore: lexical,
          }
        })
        .filter((hit) =>
          searchOptions.minScore === undefined ? true : hit.score! >= searchOptions.minScore,
        )
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      return scored.slice(0, searchOptions.limit ?? 5)
    },
    async getContext(query, searchOptions = {}) {
      const hits = await adapter.search(query, searchOptions)
      return {
        query,
        hits,
        sourceRecords: hits.map((hit) =>
          memoryHitToSourceRecord(hit, { scope: searchOptions.scope }),
        ),
        text: renderMemoryHits(hits),
      }
    },
    async write(input) {
      seq += 1
      const memoryId = input.id ?? `${id}:${seq}`
      const hit: AgentMemoryHit = {
        id: memoryId,
        uri: `memory://${id}/${encodeURIComponent(memoryId)}`,
        kind: input.kind,
        text: input.text,
        title: input.title,
        score: 1,
        normalizedScore: 1,
        createdAt: input.metadata?.timestamp as string | undefined,
        metadata: {
          ...(input.metadata ?? {}),
          scope: input.scope,
        },
      }
      rows.push({ seq, input, hit })
      return {
        accepted: true,
        id: memoryId,
        uri: hit.uri,
        kind: input.kind,
        sourceRecord: memoryWriteResultToSourceRecord(
          {
            accepted: true,
            id: memoryId,
            uri: hit.uri,
            kind: input.kind,
            metadata: hit.metadata,
          },
          input.text,
          { scope: input.scope },
        ),
        metadata: hit.metadata,
      }
    },
    async clear(scope) {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (memoryScopeMatches(rows[index]!.input.scope, scope)) rows.splice(index, 1)
      }
    },
    async flush() {},
  }
  return adapter
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
  assertKnowledgeBenchmarkCases(options.cases)
  const storage = options.storage ?? fsCampaignStorage()
  const scenarios = buildKnowledgeBenchmarkScenarios(options.cases, options.splits)
  const dispatch: RunCampaignOptions<KnowledgeBenchmarkScenario, TArtifact>['dispatch'] = async (
    scenario,
    context,
  ) => {
    const artifact = await options.respond({ case: scenario.case, scenario, context })
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
      { key: 'memory_fact_recall', description: 'current memory fact coverage' },
      { key: 'memory_event_recall', description: 'expected memory event/source coverage' },
      { key: 'memory_stale_safe', description: '1 when obsolete memory is not reused' },
      { key: 'memory_actor_recall', description: 'expected speaker/user attribution coverage' },
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
  if (isKnowledgeMemoryBenchmarkCase(testCase)) {
    return scoreMemoryBenchmarkArtifact(testCase, artifact)
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

export function scoreMemoryBenchmarkArtifact<TArtifact>(
  testCase: KnowledgeMemoryBenchmarkCase,
  artifact: TArtifact,
): KnowledgeBenchmarkEvaluation {
  const memoryArtifact = artifact as KnowledgeBenchmarkArtifact
  const text = [
    memoryArtifact.text,
    memoryArtifact.answer,
    ...(memoryArtifact.rememberedFacts ?? []),
  ]
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join('\n')
  const required = scoreClaims(text, testCase.requiredFacts ?? [])
  const forbidden = scoreForbiddenClaims(text, testCase.forbiddenFacts ?? [])
  const eventIds = unique([
    ...(memoryArtifact.citedEventIds ?? []),
    ...(memoryArtifact.usedMemoryIds ?? []),
  ])
  const eventRecall = scoreCitationRecall(eventIds, testCase.expectedEventIds ?? [])
  const actorRecall = scoreCitationRecall(
    memoryArtifact.actorIds ?? [],
    testCase.expectedActorIds ?? [],
  )
  const components = [
    required.totalWeight > 0 ? required.recall : undefined,
    testCase.expectedEventIds && testCase.expectedEventIds.length > 0 ? eventRecall : undefined,
    testCase.expectedActorIds && testCase.expectedActorIds.length > 0 ? actorRecall : undefined,
    testCase.forbiddenFacts && testCase.forbiddenFacts.length > 0 ? forbidden.safe : undefined,
  ].filter((value): value is number => value !== undefined)
  const score = mean(components)
  return {
    score,
    passed: score >= 1,
    dimensions: {
      memory_fact_recall: required.recall,
      memory_event_recall: eventRecall,
      memory_actor_recall: actorRecall,
      memory_stale_safe: forbidden.safe,
      memory_stale_rate: forbidden.rate,
      memory_required_fact_count: required.total,
      memory_matched_fact_count: required.matched,
      memory_forbidden_fact_count: forbidden.total,
      memory_matched_forbidden_fact_count: forbidden.matched,
    },
    notes: `memory required=${required.matched}/${required.total}; stale=${forbidden.matched}/${forbidden.total}; event_recall=${eventRecall.toFixed(3)}; actor_recall=${actorRecall.toFixed(3)}`,
    raw: {
      matchedRequiredFactIds: required.matchedIds,
      matchedForbiddenFactIds: forbidden.matchedIds,
      citedEventIds: eventIds,
      actorIds: memoryArtifact.actorIds ?? [],
    },
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

function memoryLifecycleCase(input: {
  id: string
  family: KnowledgeBenchmarkFamily
  source: KnowledgeBenchmarkSource
  taskKind: KnowledgeMemoryBenchmarkTaskKind
  split: KnowledgeBenchmarkSplit
  actorId: string
  prompt: string
  staleText: string
  currentText: string
  required: string
  extraRequired?: string
  forbidden: string
}): KnowledgeMemoryBenchmarkCase {
  const staleEventId = `${input.id}:stale`
  const currentEventId = `${input.id}:current`
  return {
    id: input.id,
    family: input.family,
    taskKind: input.taskKind,
    split: input.split,
    tags: unique(['first-party-memory-lifecycle', input.taskKind, input.split]),
    source: input.source,
    events: [
      {
        id: staleEventId,
        actorId: input.actorId,
        sessionId: `${input.id}:session-1`,
        timestamp: '2026-01-01T00:00:00.000Z',
        text: input.staleText,
      },
      {
        id: currentEventId,
        actorId: input.actorId,
        sessionId: `${input.id}:session-2`,
        timestamp: '2026-02-01T00:00:00.000Z',
        text: input.currentText,
      },
    ],
    prompt: input.prompt,
    requiredFacts: [
      {
        id: `${input.id}:required-1`,
        anyOf: [input.required],
        sourceEventIds: [currentEventId],
      },
      ...(input.extraRequired
        ? [
            {
              id: `${input.id}:required-2`,
              anyOf: [input.extraRequired],
              sourceEventIds: [currentEventId],
            },
          ]
        : []),
    ],
    forbiddenFacts: [
      {
        id: `${input.id}:stale`,
        anyOf: [input.forbidden],
        sourceEventIds: [staleEventId],
        obsolete: true,
      },
    ],
    expectedEventIds: [currentEventId],
    expectedActorIds: [input.actorId],
    referenceAnswer: input.required,
  }
}

function renderMemoryAdapterRankingMarkdown(
  rows: readonly MemoryAdapterBenchmarkRankingRow[],
): string {
  return [
    '# Memory Adapter Ranking',
    '',
    '| rank | candidate | adapter | cases | cells | failed | mean score | pass rate | cost |',
    '| ---: | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(
      (row) =>
        `| ${row.rank} | ${row.label} | ${row.adapterId} | ${row.totalCases} | ${row.totalCells} | ${row.cellsFailed} | ${formatNumber(row.scoreMean)} | ${formatNumber(row.passRate)} | $${formatNumber(row.totalCostUsd)} |`,
    ),
    '',
  ].join('\n')
}

function benchmarkMemoryScope(
  candidateId: string,
  testCase: KnowledgeMemoryBenchmarkCase,
  scope: AgentMemoryScope = {},
): AgentMemoryScope {
  return {
    ...scope,
    namespace: scope.namespace ?? 'agent-knowledge-memory-benchmark',
    tags: {
      ...(scope.tags ?? {}),
      benchmarkCandidateId: candidateId,
      benchmarkCaseId: testCase.id,
    },
  }
}

function memoryEventId(hit: AgentMemoryHit): string | undefined {
  const eventId = hit.metadata?.eventId
  return typeof eventId === 'string' ? eventId : undefined
}

function memoryActorId(hit: AgentMemoryHit): string | undefined {
  const actorId = hit.metadata?.actorId
  return typeof actorId === 'string' ? actorId : undefined
}

function memoryScopeMatches(stored?: AgentMemoryScope, requested?: AgentMemoryScope): boolean {
  if (!requested) return true
  if (requested.tenantId !== undefined && stored?.tenantId !== requested.tenantId) return false
  if (requested.userId !== undefined && stored?.userId !== requested.userId) return false
  if (requested.agentId !== undefined && stored?.agentId !== requested.agentId) return false
  if (requested.teamId !== undefined && stored?.teamId !== requested.teamId) return false
  if (requested.runId !== undefined && stored?.runId !== requested.runId) return false
  if (requested.sessionId !== undefined && stored?.sessionId !== requested.sessionId) return false
  if (requested.namespace !== undefined && stored?.namespace !== requested.namespace) return false
  for (const [key, value] of Object.entries(requested.tags ?? {})) {
    if (stored?.tags?.[key] !== value) return false
  }
  return true
}

function tokenOverlap(query: string, text: string): number {
  const queryTokens = new Set(tokenize(query))
  if (queryTokens.size === 0) return 0
  const textTokens = new Set(tokenize(text))
  let matched = 0
  for (const token of queryTokens) {
    if (textTokens.has(token)) matched += 1
  }
  return matched / queryTokens.size
}

function tokenize(text: string): string[] {
  const stop = new Set([
    'the',
    'and',
    'for',
    'this',
    'that',
    'with',
    'what',
    'should',
    'agent',
    'user',
    'current',
    'now',
    'use',
  ])
  return text
    .toLowerCase()
    .split(/[^a-z0-9/]+/)
    .filter((token) => token.length > 2 && !stop.has(token))
}

function renderMemoryHits(hits: readonly AgentMemoryHit[]): string {
  return hits
    .map((hit, index) => {
      const eventId = memoryEventId(hit)
      const actorId = memoryActorId(hit)
      return [
        `[${index + 1}] ${hit.title ?? hit.id}`,
        eventId ? `event=${eventId}` : '',
        actorId ? `actor=${actorId}` : '',
        hit.text,
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n\n')
}

export function isKnowledgeMemoryBenchmarkCase(
  testCase: KnowledgeBenchmarkCase,
): testCase is KnowledgeMemoryBenchmarkCase {
  return testCase.taskKind.startsWith('memory-')
}

function assertKnowledgeBenchmarkCases(cases: readonly KnowledgeBenchmarkCase[]): void {
  if (cases.length === 0) throw new Error('knowledge benchmark requires cases')
  assertUniqueNonEmptyStrings(
    cases.map((testCase) => testCase.id),
    'knowledge benchmark case id',
  )
  for (const testCase of cases) {
    if (typeof testCase.family !== 'string' || !testCase.family.trim()) {
      throw new Error(`knowledge benchmark case ${testCase.id} requires a family`)
    }
    if (testCase.taskKind === 'retrieval') continue
    if (isKnowledgeMemoryBenchmarkCase(testCase)) {
      assertUniqueNonEmptyStrings(
        testCase.events.map((event) => event.id),
        `${testCase.id} memory event id`,
      )
      for (const event of testCase.events) {
        assertNonEmptyBenchmarkString(event.text, `${testCase.id} memory event ${event.id} text`)
      }
      assertClaimMatchers(testCase.requiredFacts ?? [], `${testCase.id} requiredFacts`)
      assertClaimMatchers(testCase.forbiddenFacts ?? [], `${testCase.id} forbiddenFacts`)
      assertUniqueNonEmptyStrings(
        testCase.expectedEventIds ?? [],
        `${testCase.id} expected event id`,
      )
      assertUniqueNonEmptyStrings(
        testCase.expectedActorIds ?? [],
        `${testCase.id} expected actor id`,
      )
    } else {
      assertClaimMatchers(testCase.requiredClaims ?? [], `${testCase.id} requiredClaims`)
      assertClaimMatchers(testCase.forbiddenClaims ?? [], `${testCase.id} forbiddenClaims`)
      assertUniqueNonEmptyStrings(testCase.expectedSourceIds ?? [], `${testCase.id} source id`)
    }
  }
}

function assertClaimMatchers(claims: readonly KnowledgeClaimMatcher[], label: string): void {
  assertUniqueNonEmptyStrings(
    claims.map((claim) => claim.id),
    `${label} matcher id`,
  )
  for (const claim of claims) {
    if (claim.anyOf.length === 0) throw new Error(`${label} matcher ${claim.id} requires anyOf`)
    assertUniqueNonEmptyStrings(claim.anyOf, `${label} matcher ${claim.id} anyOf`)
    if (claim.weight !== undefined && (!Number.isFinite(claim.weight) || claim.weight <= 0)) {
      throw new Error(`${label} matcher ${claim.id} weight must be a positive finite number`)
    }
    const sourceEventIds = (claim as Partial<KnowledgeMemoryFactMatcher>).sourceEventIds
    if (sourceEventIds !== undefined) {
      assertUniqueNonEmptyStrings(sourceEventIds, `${label} matcher ${claim.id} source event id`)
    }
  }
}

function assertUniqueNonEmptyStrings(values: readonly string[], label: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    assertNonEmptyBenchmarkString(value, label)
    if (seen.has(value)) throw new Error(`duplicate ${label}: ${value}`)
    seen.add(value)
  }
}

function assertNonEmptyBenchmarkString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be non-empty`)
}

function scoreClaims(text: string, claims: readonly KnowledgeClaimMatcher[]) {
  let matched = 0
  let matchedWeight = 0
  let totalWeight = 0
  const matchedIds: string[] = []
  const haystack = text.toLowerCase()
  for (const claim of claims) {
    if (
      !claim.id.trim() ||
      claim.anyOf.length === 0 ||
      claim.anyOf.some((value) => !value.trim())
    ) {
      throw new Error(
        'claim matchers require a non-empty id and at least one non-empty alternative',
      )
    }
    const weight = claim.weight ?? 1
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new Error(`claim matcher ${claim.id} weight must be a positive finite number`)
    }
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

function compactObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactObject)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, compactObject(entry)]),
  )
}
