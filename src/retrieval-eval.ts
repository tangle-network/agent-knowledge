import { canonicalJson } from '@tangle-network/agent-eval'
import type {
  DispatchContext,
  JudgeConfig,
  MutableSurface,
  Scenario,
} from '@tangle-network/agent-eval/campaign'
import type { AgentCandidateJsonValue as JsonValue } from '@tangle-network/agent-interface'
import { searchKnowledge } from './search'
import type { KnowledgeIndex, KnowledgeSearchResult } from './types'

export type RetrievalConfig = Record<string, JsonValue>

export type RetrievalGoldTarget =
  | { kind: 'page'; pageId: string }
  | { kind: 'page-path'; path: string }
  | { kind: 'source'; sourceId: string }
  | { kind: 'source-anchor'; sourceId: string; anchorId: string }
  | { kind: 'source-span'; sourceId: string; charStart: number; charEnd: number }

export interface RetrievalEvalScenario extends Scenario {
  kind: 'retrieval-eval'
  query: string
  expected: RetrievalGoldTarget | readonly RetrievalGoldTarget[]
  k?: number
}

export interface RetrievedSourceSpan {
  sourceId: string
  anchorId?: string
  charStart?: number
  charEnd?: number
}

export interface RetrievedKnowledgeHit {
  pageId: string
  path: string
  title?: string
  rank: number
  score?: number
  normalizedScore?: number
  sourceIds?: readonly string[]
  sourceSpans?: readonly RetrievedSourceSpan[]
  snippet?: string
  metadata?: Record<string, JsonValue>
}

export interface RetrievalEvalArtifact {
  config: RetrievalConfig
  query: string
  requestedK: number
  hits: readonly RetrievedKnowledgeHit[]
  durationMs: number
  /** Informational copy. Billable retrievers account through context.cost.runPaidCall. */
  costUsd?: number
  metadata?: Record<string, JsonValue>
}

export interface RetrievalMetricSummary {
  recall: number
  mrr: number
  ndcg: number
  precisionAtK: number
  expectedCount: number
  matchedCount: number
  relevantHitCount: number
  firstHitRank: number | null
  matchedTargetIds: readonly string[]
}

export interface RetrievalEvalRetrieverInput {
  index?: KnowledgeIndex
  config: RetrievalConfig
  scenario: RetrievalEvalScenario
  k: number
  signal: AbortSignal
  context: DispatchContext
}

export interface RetrievalEvalRetrieverResult {
  hits: readonly RetrievedKnowledgeHit[]
  /** Informational copy. Billable retrievers account through context.cost.runPaidCall. */
  costUsd?: number
  metadata?: Record<string, JsonValue>
}

export type RetrievalEvalRetriever = (
  input: RetrievalEvalRetrieverInput,
) => Promise<readonly RetrievedKnowledgeHit[] | RetrievalEvalRetrieverResult>

export interface BuildRetrievalEvalDispatchOptions {
  index?: KnowledgeIndex
  defaultK?: number
  retrieve?: RetrievalEvalRetriever
}

export interface RetrievalMetricWeights {
  recall?: number
  mrr?: number
  ndcg?: number
  precisionAtK?: number
}

export interface RetrievalRecallJudgeOptions {
  name?: string
  weights?: RetrievalMetricWeights
}

export interface PartitionRetrievalScenariosOptions {
  selectionFraction?: number
  finalFraction?: number
  seed?: number
}

export interface RetrievalScenarioPartitions {
  trainScenarios: RetrievalEvalScenario[]
  selectionScenarios: RetrievalEvalScenario[]
  finalScenarios: RetrievalEvalScenario[]
}

export function retrievalConfigSurface(config: RetrievalConfig): string {
  return canonicalJson(config)
}

export function retrievalConfigFromSurface(surface: MutableSurface): RetrievalConfig {
  if (typeof surface !== 'string') {
    throw new Error(
      `retrievalConfigFromSurface expected a JSON string surface, got ${typeof surface}`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(surface)
  } catch (error) {
    throw new Error(`retrievalConfigFromSurface could not parse JSON: ${(error as Error).message}`)
  }
  if (!isJsonObject(parsed)) {
    throw new Error('retrievalConfigFromSurface expected a JSON object')
  }
  return parsed
}

export function buildRetrievalEvalDispatch(options: BuildRetrievalEvalDispatchOptions) {
  if (!options.retrieve && !options.index) {
    throw new Error('buildRetrievalEvalDispatch requires either index or retrieve')
  }
  const defaultK = options.defaultK ?? 5
  const retrieve = options.retrieve ?? defaultSearchRetriever

  return async (
    surface: MutableSurface,
    scenario: RetrievalEvalScenario,
    context: DispatchContext,
  ): Promise<RetrievalEvalArtifact> => {
    const config = retrievalConfigFromSurface(surface)
    const k = retrievalK(config, scenario, defaultK)
    const startedAt = Date.now()
    const result = await retrieve({
      index: options.index,
      config,
      scenario,
      k,
      signal: context.signal,
      context,
    })
    const normalized = normalizeRetrieverResult(result)
    return {
      config,
      query: scenario.query,
      requestedK: k,
      hits: normalized.hits,
      durationMs: Date.now() - startedAt,
      costUsd: normalized.costUsd,
      metadata: normalized.metadata,
    }
  }
}

export function retrievalRecallJudge(
  options: RetrievalRecallJudgeOptions = {},
): JudgeConfig<RetrievalEvalArtifact, RetrievalEvalScenario> {
  const weights = normalizeWeights(options.weights ?? { recall: 1 })
  return {
    name: options.name ?? 'retrieval-recall',
    dimensions: [
      { key: 'recall', description: 'fraction of expected knowledge targets retrieved' },
      { key: 'mrr', description: 'reciprocal rank of the first matching hit' },
      { key: 'ndcg', description: 'rank-aware gain for newly matched targets' },
      {
        key: 'precision_at_k',
        description: 'share of returned hits that match at least one target',
      },
    ],
    appliesTo: (scenario) => scenario.kind === 'retrieval-eval',
    async score({ artifact, scenario }) {
      const metrics = scoreRetrievalArtifact(artifact, scenario)
      const composite =
        (metrics.recall * weights.recall +
          metrics.mrr * weights.mrr +
          metrics.ndcg * weights.ndcg +
          metrics.precisionAtK * weights.precisionAtK) /
        (weights.recall + weights.mrr + weights.ndcg + weights.precisionAtK)
      return {
        dimensions: {
          recall: metrics.recall,
          mrr: metrics.mrr,
          ndcg: metrics.ndcg,
          precision_at_k: metrics.precisionAtK,
        },
        composite,
        notes: `matched ${metrics.matchedCount}/${metrics.expectedCount}; first_hit_rank=${metrics.firstHitRank ?? 'none'}`,
      }
    },
  }
}

export function scoreRetrievalArtifact(
  artifact: RetrievalEvalArtifact,
  scenario: RetrievalEvalScenario,
): RetrievalMetricSummary {
  const targets = normalizeTargets(scenario.expected)
  if (targets.length === 0) {
    throw new Error(`retrieval eval scenario ${scenario.id} has no expected targets`)
  }

  const matchedTargetIds = new Set<string>()
  let firstHitRank: number | null = null
  let relevantHitCount = 0
  let dcg = 0

  for (const hit of artifact.hits) {
    const newlyMatched = targets.filter((target) => {
      const targetId = retrievalTargetId(target)
      return !matchedTargetIds.has(targetId) && hitMatchesTarget(hit, target)
    })

    if (newlyMatched.length === 0) {
      continue
    }

    relevantHitCount += 1
    if (firstHitRank === null) {
      firstHitRank = hit.rank
    }
    dcg += 1 / Math.log2(hit.rank + 1)
    for (const target of newlyMatched) {
      matchedTargetIds.add(retrievalTargetId(target))
    }
  }

  const expectedCount = targets.length
  const matchedCount = matchedTargetIds.size
  const idealRankCount = Math.min(expectedCount, Math.max(1, artifact.requestedK))
  const idcg = idealDcg(idealRankCount)
  return {
    recall: matchedCount / expectedCount,
    mrr: firstHitRank === null ? 0 : 1 / firstHitRank,
    ndcg: idcg === 0 ? 0 : dcg / idcg,
    precisionAtK: artifact.hits.length === 0 ? 0 : relevantHitCount / artifact.hits.length,
    expectedCount,
    matchedCount,
    relevantHitCount,
    firstHitRank,
    matchedTargetIds: [...matchedTargetIds].sort(),
  }
}

export function partitionRetrievalScenarios(
  scenarios: readonly RetrievalEvalScenario[],
  options: PartitionRetrievalScenariosOptions = {},
): RetrievalScenarioPartitions {
  if (scenarios.length < 4) {
    throw new Error(
      'partitionRetrievalScenarios requires at least 4 scenarios for non-empty train and selection partitions plus 2 final scenarios',
    )
  }
  const selectionFraction = options.selectionFraction ?? 0.2
  const finalFraction = options.finalFraction ?? 0.2
  assertPartitionFraction(selectionFraction, 'selectionFraction')
  assertPartitionFraction(finalFraction, 'finalFraction')
  if (selectionFraction + finalFraction >= 1) {
    throw new Error('selectionFraction + finalFraction must be less than 1')
  }
  const shuffled = seededShuffle(scenarios, options.seed ?? 42)
  const finalCount = Math.max(2, Math.round(shuffled.length * finalFraction))
  const selectionCount = Math.max(1, Math.round(shuffled.length * selectionFraction))
  if (finalCount + selectionCount >= shuffled.length) {
    throw new Error('retrieval scenario fractions leave no training scenarios')
  }
  const trainEnd = shuffled.length - selectionCount - finalCount
  return {
    trainScenarios: shuffled.slice(0, trainEnd),
    selectionScenarios: shuffled.slice(trainEnd, trainEnd + selectionCount),
    finalScenarios: shuffled.slice(trainEnd + selectionCount),
  }
}

function assertPartitionFraction(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${name} must be greater than 0 and less than 1`)
  }
}

function retrievalK(
  config: RetrievalConfig,
  scenario: RetrievalEvalScenario,
  defaultK: number,
): number {
  const rawK = config.k ?? config.topK ?? scenario.k ?? defaultK
  if (typeof rawK !== 'number' || !Number.isFinite(rawK) || rawK <= 0) {
    throw new Error(`retrieval k must be a positive number, got ${String(rawK)}`)
  }
  return Math.floor(rawK)
}

async function defaultSearchRetriever(
  input: RetrievalEvalRetrieverInput,
): Promise<RetrievalEvalRetrieverResult> {
  if (!input.index) {
    throw new Error('default retrieval eval search requires an index')
  }
  const results = searchKnowledge(input.index, input.scenario.query, input.k)
  return { hits: results.map(hitFromSearchResult) }
}

function hitFromSearchResult(result: KnowledgeSearchResult): RetrievedKnowledgeHit {
  return {
    pageId: result.page.id,
    path: result.page.path,
    title: result.page.title,
    rank: result.rank,
    score: result.score,
    normalizedScore: result.normalizedScore,
    sourceIds: result.page.sourceIds,
    snippet: result.snippet,
  }
}

function normalizeRetrieverResult(
  result: readonly RetrievedKnowledgeHit[] | RetrievalEvalRetrieverResult,
): RetrievalEvalRetrieverResult {
  if (isHitArray(result)) {
    return { hits: result }
  }
  return result
}

function normalizeTargets(
  expected: RetrievalGoldTarget | readonly RetrievalGoldTarget[],
): RetrievalGoldTarget[] {
  return isTargetArray(expected) ? [...expected] : [expected]
}

function isHitArray(
  result: readonly RetrievedKnowledgeHit[] | RetrievalEvalRetrieverResult,
): result is readonly RetrievedKnowledgeHit[] {
  return Array.isArray(result)
}

function isTargetArray(
  expected: RetrievalGoldTarget | readonly RetrievalGoldTarget[],
): expected is readonly RetrievalGoldTarget[] {
  return Array.isArray(expected)
}

function hitMatchesTarget(hit: RetrievedKnowledgeHit, target: RetrievalGoldTarget): boolean {
  switch (target.kind) {
    case 'page':
      return hit.pageId === target.pageId
    case 'page-path':
      return hit.path === target.path
    case 'source':
      return Boolean(hit.sourceIds?.includes(target.sourceId))
    case 'source-anchor':
      return Boolean(
        hit.sourceSpans?.some(
          (span) => span.sourceId === target.sourceId && span.anchorId === target.anchorId,
        ),
      )
    case 'source-span':
      return Boolean(
        hit.sourceSpans?.some(
          (span) => span.sourceId === target.sourceId && spanOverlaps(span, target),
        ),
      )
  }
}

function spanOverlaps(
  hit: RetrievedSourceSpan,
  target: Extract<RetrievalGoldTarget, { kind: 'source-span' }>,
): boolean {
  if (typeof hit.charStart !== 'number' || typeof hit.charEnd !== 'number') {
    return false
  }
  return hit.charStart < target.charEnd && target.charStart < hit.charEnd
}

function retrievalTargetId(target: RetrievalGoldTarget): string {
  switch (target.kind) {
    case 'page':
      return `page:${target.pageId}`
    case 'page-path':
      return `page-path:${target.path}`
    case 'source':
      return `source:${target.sourceId}`
    case 'source-anchor':
      return `source-anchor:${target.sourceId}:${target.anchorId}`
    case 'source-span':
      return `source-span:${target.sourceId}:${target.charStart}:${target.charEnd}`
  }
}

function idealDcg(count: number): number {
  let score = 0
  for (let i = 1; i <= count; i += 1) {
    score += 1 / Math.log2(i + 1)
  }
  return score
}

function normalizeWeights(weights: RetrievalMetricWeights): Required<RetrievalMetricWeights> {
  const normalized = {
    recall: normalizeWeight(weights.recall),
    mrr: normalizeWeight(weights.mrr),
    ndcg: normalizeWeight(weights.ndcg),
    precisionAtK: normalizeWeight(weights.precisionAtK),
  }
  const total = normalized.recall + normalized.mrr + normalized.ndcg + normalized.precisionAtK
  if (total <= 0) {
    throw new Error('retrievalRecallJudge requires at least one positive metric weight')
  }
  return normalized
}

function normalizeWeight(value: number | undefined): number {
  if (value === undefined) {
    return 0
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `retrievalRecallJudge metric weights must be non-negative finite numbers, got ${String(value)}`,
    )
  }
  return value
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items]
  let state = seed >>> 0
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0
    const j = state % (i + 1)
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}
