import {
  type RetrievalEvalArtifact,
  type RetrievalEvalScenario,
  scoreRetrievalArtifact,
} from '../retrieval-eval'

import type {
  KnowledgeBenchmarkArtifact,
  KnowledgeBenchmarkCase,
  KnowledgeBenchmarkEvaluation,
  KnowledgeClaimMatcher,
  KnowledgeMemoryBenchmarkCase,
  KnowledgeRetrievalBenchmarkCase,
} from './types'

import { mean, unique } from './utils'

import { isKnowledgeMemoryBenchmarkCase } from './validation'

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
  const dimensions: Record<string, number> = {}
  if (required.totalWeight > 0) {
    dimensions.memory_fact_recall = required.recall
    dimensions.memory_required_fact_count = required.total
    dimensions.memory_matched_fact_count = required.matched
  }
  if (testCase.expectedEventIds && testCase.expectedEventIds.length > 0) {
    dimensions.memory_event_recall = eventRecall
  }
  if (testCase.expectedActorIds && testCase.expectedActorIds.length > 0) {
    dimensions.memory_actor_recall = actorRecall
  }
  if (testCase.forbiddenFacts && testCase.forbiddenFacts.length > 0) {
    dimensions.memory_stale_safe = forbidden.safe
    dimensions.memory_stale_rate = forbidden.rate
    dimensions.memory_forbidden_fact_count = forbidden.total
    dimensions.memory_matched_forbidden_fact_count = forbidden.matched
  }
  return {
    score,
    passed: score >= 1,
    dimensions,
    applicableDimensions: Object.keys(dimensions),
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
