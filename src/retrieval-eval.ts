import {
  type DispatchContext,
  type Gate,
  type GenerationRecord,
  heldOutGate,
  type JsonValue,
  type JudgeConfig,
  type MutableSurface,
  type ParameterCandidate,
  parameterSweepProposer,
  type RunImprovementLoopOptions,
  type RunImprovementLoopResult,
  runImprovementLoop,
  type Scenario,
  type SurfaceProposer,
} from '@tangle-network/agent-eval/campaign'
import { searchKnowledge } from './search'
import type { KnowledgeIndex, KnowledgeSearchResult } from './types'

export type RetrievalConfig = Record<string, JsonValue>
export type RetrievalParameterSearchSpace = Record<string, readonly JsonValue[]>

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

export interface BuildRetrievalParameterCandidatesOptions {
  baseline?: RetrievalConfig
}

export interface RetrievalParameterSweepProposerOptions {
  candidates?: readonly ParameterCandidate[]
  searchSpace?: RetrievalParameterSearchSpace
  baseline?: RetrievalConfig
}

type RetrievalLoopBaseOptions = RunImprovementLoopOptions<
  RetrievalEvalScenario,
  RetrievalEvalArtifact
>

export interface RunRetrievalImprovementLoopOptions {
  baseline: RetrievalConfig
  scenarios: readonly RetrievalEvalScenario[]
  holdoutScenarios?: readonly RetrievalEvalScenario[]
  index?: KnowledgeIndex
  defaultK?: number
  retrieve?: RetrievalEvalRetriever
  candidates?: readonly ParameterCandidate[]
  searchSpace?: RetrievalParameterSearchSpace
  judges?: readonly JudgeConfig<RetrievalEvalArtifact, RetrievalEvalScenario>[]
  gate?: Gate<RetrievalEvalArtifact, RetrievalEvalScenario>
  metricWeights?: RetrievalMetricWeights
  targetRecall?: number
  holdoutFraction?: number
  splitSeed?: number
  deltaThreshold?: number
  runDir?: RetrievalLoopBaseOptions['runDir']
  seed?: RetrievalLoopBaseOptions['seed']
  reps?: RetrievalLoopBaseOptions['reps']
  resumable?: RetrievalLoopBaseOptions['resumable']
  costCeiling?: RetrievalLoopBaseOptions['costCeiling']
  maxConcurrency?: RetrievalLoopBaseOptions['maxConcurrency']
  dispatchTimeoutMs?: RetrievalLoopBaseOptions['dispatchTimeoutMs']
  expectUsage?: RetrievalLoopBaseOptions['expectUsage']
  tracing?: RetrievalLoopBaseOptions['tracing']
  storage?: RetrievalLoopBaseOptions['storage']
  populationSize?: RetrievalLoopBaseOptions['populationSize']
  maxGenerations?: RetrievalLoopBaseOptions['maxGenerations']
  promoteTopK?: RetrievalLoopBaseOptions['promoteTopK']
  maxImprovementShots?: RetrievalLoopBaseOptions['maxImprovementShots']
  report?: RetrievalLoopBaseOptions['report']
  findings?: RetrievalLoopBaseOptions['findings']
  now?: RetrievalLoopBaseOptions['now']
}

export interface RunRetrievalImprovementLoopResult
  extends RunImprovementLoopResult<RetrievalEvalArtifact, RetrievalEvalScenario> {
  baselineConfig: RetrievalConfig
  winnerConfig: RetrievalConfig
  trainScenarios: readonly RetrievalEvalScenario[]
  holdoutScenarios: readonly RetrievalEvalScenario[]
  candidates: readonly ParameterCandidate[]
  targetRecall?: number
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

export function buildRetrievalParameterCandidates(
  searchSpace: RetrievalParameterSearchSpace,
  options: BuildRetrievalParameterCandidatesOptions = {},
): ParameterCandidate[] {
  const candidates: ParameterCandidate[] = []
  for (const [path, values] of Object.entries(searchSpace).sort(([a], [b]) => a.localeCompare(b))) {
    for (const value of values) {
      if (
        options.baseline &&
        canonicalJson(getConfigPath(options.baseline, path)) === canonicalJson(value)
      ) {
        continue
      }
      candidates.push({
        label: `${path}=${formatCandidateValue(value)}`,
        rationale: `Set retrieval config ${path} to ${formatCandidateValue(value)}`,
        changes: [{ path, value }],
      })
    }
  }
  return candidates
}

export function retrievalParameterSweepProposer(
  options: RetrievalParameterSweepProposerOptions,
): SurfaceProposer {
  const candidates =
    options.candidates ??
    (options.searchSpace
      ? buildRetrievalParameterCandidates(options.searchSpace, { baseline: options.baseline })
      : [])

  if (candidates.length === 0) {
    throw new Error('retrievalParameterSweepProposer requires at least one candidate')
  }

  return parameterSweepProposer({ candidates })
}

export async function runRetrievalImprovementLoop(
  options: RunRetrievalImprovementLoopOptions,
): Promise<RunRetrievalImprovementLoopResult> {
  const split = splitRetrievalScenarios(options)
  const candidates = resolveRetrievalCandidates(options)
  const populationSize = options.populationSize ?? Math.max(1, Math.min(4, candidates.length))
  const maxGenerations =
    options.maxGenerations ?? Math.max(1, Math.ceil(candidates.length / populationSize))
  const proposer = withTargetRecallStop(
    retrievalParameterSweepProposer({ candidates }),
    options.targetRecall,
  )
  const gate =
    options.gate ??
    heldOutGate<RetrievalEvalArtifact, RetrievalEvalScenario>({
      scenarios: split.holdoutScenarios,
      deltaThreshold: options.deltaThreshold ?? 0.02,
    })
  const result = await runImprovementLoop<RetrievalEvalScenario, RetrievalEvalArtifact>({
    baselineSurface: retrievalConfigSurface(options.baseline),
    scenarios: split.trainScenarios,
    holdoutScenarios: split.holdoutScenarios,
    dispatchWithSurface: buildRetrievalEvalDispatch({
      index: options.index,
      defaultK: options.defaultK,
      retrieve: options.retrieve,
    }),
    judges: [...(options.judges ?? [retrievalRecallJudge({ weights: options.metricWeights })])],
    proposer,
    gate,
    autoOnPromote: 'none',
    runDir: options.runDir ?? '.agent-knowledge/retrieval-improvement',
    seed: options.seed,
    reps: options.reps,
    resumable: options.resumable,
    costCeiling: options.costCeiling,
    maxConcurrency: options.maxConcurrency,
    dispatchTimeoutMs: options.dispatchTimeoutMs,
    expectUsage: options.expectUsage ?? 'off',
    tracing: options.tracing,
    storage: options.storage,
    populationSize,
    maxGenerations,
    promoteTopK: options.promoteTopK,
    maxImprovementShots: options.maxImprovementShots,
    report: options.report,
    findings: options.findings,
    now: options.now,
  })

  return {
    ...result,
    baselineConfig: options.baseline,
    winnerConfig: retrievalConfigFromSurface(result.winnerSurface),
    trainScenarios: split.trainScenarios,
    holdoutScenarios: split.holdoutScenarios,
    candidates,
    targetRecall: options.targetRecall,
  }
}

function splitRetrievalScenarios(options: RunRetrievalImprovementLoopOptions): {
  trainScenarios: RetrievalEvalScenario[]
  holdoutScenarios: RetrievalEvalScenario[]
} {
  const scenarios = [...options.scenarios]
  if (scenarios.length === 0) {
    throw new Error('runRetrievalImprovementLoop requires at least one training scenario')
  }
  if (options.holdoutScenarios) {
    const holdoutScenarios = [...options.holdoutScenarios]
    if (holdoutScenarios.length === 0) {
      throw new Error('runRetrievalImprovementLoop holdoutScenarios must not be empty')
    }
    return { trainScenarios: scenarios, holdoutScenarios }
  }

  if (scenarios.length < 2) {
    throw new Error(
      'runRetrievalImprovementLoop requires at least 2 scenarios when holdoutScenarios are not provided',
    )
  }
  const holdoutFraction = options.holdoutFraction ?? 0.3
  if (!Number.isFinite(holdoutFraction) || holdoutFraction <= 0 || holdoutFraction >= 1) {
    throw new Error(
      `runRetrievalImprovementLoop holdoutFraction must be > 0 and < 1, got ${String(holdoutFraction)}`,
    )
  }
  const shuffled = seededShuffle(scenarios, options.splitSeed ?? options.seed ?? 42)
  const holdoutCount = Math.min(
    shuffled.length - 1,
    Math.max(1, Math.round(shuffled.length * holdoutFraction)),
  )
  const splitIndex = shuffled.length - holdoutCount
  return {
    trainScenarios: shuffled.slice(0, splitIndex),
    holdoutScenarios: shuffled.slice(splitIndex),
  }
}

function resolveRetrievalCandidates(
  options: RunRetrievalImprovementLoopOptions,
): ParameterCandidate[] {
  const candidates = options.candidates
    ? [...options.candidates]
    : options.searchSpace
      ? buildRetrievalParameterCandidates(options.searchSpace, { baseline: options.baseline })
      : []

  if (candidates.length === 0) {
    throw new Error('runRetrievalImprovementLoop requires candidates or searchSpace')
  }
  return candidates
}

function withTargetRecallStop(
  proposer: SurfaceProposer,
  targetRecall: number | undefined,
): SurfaceProposer {
  if (targetRecall === undefined) {
    return proposer
  }
  if (!Number.isFinite(targetRecall) || targetRecall < 0 || targetRecall > 1) {
    throw new Error(`targetRecall must be between 0 and 1, got ${String(targetRecall)}`)
  }
  return {
    kind: `${proposer.kind}:target-recall`,
    propose: (context) => proposer.propose(context),
    decide(args) {
      const baseDecision = proposer.decide?.(args)
      if (baseDecision?.stop) {
        return baseDecision
      }
      const bestRecall = bestObservedRecall(args.history)
      if (bestRecall >= targetRecall) {
        return {
          stop: true,
          reason: `target recall ${targetRecall} reached with train recall ${bestRecall}`,
        }
      }
      return { stop: false }
    },
  }
}

function bestObservedRecall(history: GenerationRecord[]): number {
  let best = Number.NEGATIVE_INFINITY
  for (const generation of history) {
    for (const candidate of generation.candidates) {
      const recall = candidate.dimensions.recall
      if (recall !== undefined && Number.isFinite(recall) && recall > best) {
        best = recall
      }
    }
  }
  return best
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

function getConfigPath(config: RetrievalConfig, path: string): JsonValue | undefined {
  let current: JsonValue | undefined = config
  for (const part of path.split('.')) {
    if (!isJsonObject(current)) {
      return undefined
    }
    current = current[part]
  }
  return current
}

function formatCandidateValue(value: JsonValue): string {
  if (typeof value === 'string') {
    return value
  }
  return canonicalJson(value)
}

function canonicalJson(value: JsonValue | undefined): string {
  if (value === undefined) {
    return 'undefined'
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (isJsonObject(value)) {
    const entries = Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value)
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
