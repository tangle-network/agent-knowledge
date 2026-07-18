import type { RetrievalGoldTarget, RetrievedKnowledgeHit } from '../retrieval-eval'

import type {
  KnowledgeAnswerBenchmarkTaskKind,
  KnowledgeBenchmarkArtifact,
  KnowledgeBenchmarkCase,
  KnowledgeBenchmarkFamily,
  KnowledgeBenchmarkSource,
  KnowledgeBenchmarkSpec,
  KnowledgeBenchmarkSplit,
  KnowledgeMemoryBenchmarkCase,
  KnowledgeMemoryBenchmarkTaskKind,
} from './types'

import { unique } from './utils'

import { isKnowledgeMemoryBenchmarkCase } from './validation'

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
