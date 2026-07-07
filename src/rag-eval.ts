import type { JsonValue, JudgeConfig, Scenario } from '@tangle-network/agent-eval/campaign'
import { groundClaimInText } from './claim-grounding'
import { lintKnowledgeIndex } from './lint'
import type { RagAnswerQualityResult, RagGapFinding } from './rag-improvement-loop'
import type { KnowledgeIndex } from './types'
import { validateKnowledgeIndex } from './validate'

export type RagEvalProvider =
  | 'agent-knowledge'
  | 'ragas'
  | 'deepeval'
  | 'trulens'
  | 'ragchecker'
  | 'custom'

export type RagEvalMetricKey =
  | 'context_precision'
  | 'context_recall'
  | 'context_relevance'
  | 'context_sufficiency'
  | 'faithfulness'
  | 'groundedness'
  | 'answer_relevance'
  | 'answer_correctness'
  | 'citation_support'
  | 'abstention'
  | 'unsupported_answer_rate'

export type RagEvalSlice =
  | 'known-answer'
  | 'paraphrase'
  | 'distractor'
  | 'freshness'
  | 'multi-source'
  | 'unanswerable'
  | 'long-tail'
  | 'custom'

export interface RagEvalContext {
  id: string
  text: string
  rank?: number
  pageId?: string
  sourceId?: string
  anchorId?: string
  stale?: boolean
  metadata?: Record<string, JsonValue>
}

export interface RagEvalCitation {
  id: string
  claimId?: string
  contextId?: string
  pageId?: string
  sourceId?: string
  anchorId?: string
  quote?: string
  metadata?: Record<string, JsonValue>
}

export interface RagEvalClaim {
  id: string
  text: string
  citationIds?: readonly string[]
  metadata?: Record<string, JsonValue>
}

export interface RagRequiredContext {
  id?: string
  text?: string
  pageId?: string
  sourceId?: string
  anchorId?: string
}

export interface RagAnswerEvalScenario extends Scenario {
  kind: 'rag-answer-eval'
  query: string
  referenceAnswer?: string
  expectedClaims?: readonly string[]
  forbiddenClaims?: readonly string[]
  requiredContext?: readonly RagRequiredContext[]
  unanswerable?: boolean
  requireCitations?: boolean
  slices?: readonly RagEvalSlice[]
  thresholds?: Partial<Record<RagEvalMetricKey, number>>
}

export interface ExternalRagEvalScore {
  provider: RagEvalProvider | string
  scores: Record<string, number>
  reasons?: Record<string, string>
  metadata?: Record<string, JsonValue>
}

export interface RagAnswerEvalArtifact {
  query: string
  answer: string
  contexts: readonly RagEvalContext[]
  claims?: readonly RagEvalClaim[]
  citations?: readonly RagEvalCitation[]
  abstained?: boolean
  durationMs?: number
  costUsd?: number
  externalScores?: readonly ExternalRagEvalScore[]
  metadata?: Record<string, JsonValue>
}

export interface RagAnswerMetricSummary {
  metrics: Record<RagEvalMetricKey, number>
  composite: number
  passed: boolean
  findings: readonly RagGapFinding[]
  claimCount: number
  supportedClaimCount: number
  citedClaimCount: number
  supportedCitationCount: number
  matchedRequiredContextCount: number
  requiredContextCount: number
  providerScores: Record<string, Record<RagEvalMetricKey, number>>
}

export interface RagAnswerQualityJudgeOptions {
  name?: string
  thresholds?: Partial<Record<RagEvalMetricKey, number>>
  weights?: Partial<Record<RagEvalMetricKey, number>>
  externalScorePolicy?: 'prefer-external' | 'deterministic-first'
  minClaimSupport?: number
}

export interface RagAnswerEvalCase {
  scenario: RagAnswerEvalScenario
  artifact: RagAnswerEvalArtifact
}

export interface RagAnswerQualityHookOptions {
  scenarios: readonly RagAnswerEvalScenario[]
  run: (scenario: RagAnswerEvalScenario) => MaybePromise<RagAnswerEvalArtifact>
  externalEvaluator?: (
    item: RagAnswerEvalCase,
  ) => MaybePromise<ExternalRagEvalScore | readonly ExternalRagEvalScore[] | undefined>
  thresholds?: Partial<Record<RagEvalMetricKey, number>>
  weights?: Partial<Record<RagEvalMetricKey, number>>
}

export interface RagCalibrationOptions {
  scenario: RagAnswerEvalScenario
  strong: RagAnswerEvalArtifact
  weak: RagAnswerEvalArtifact
  judge?: JudgeConfig<RagAnswerEvalArtifact, RagAnswerEvalScenario>
  minStrongScore?: number
  maxWeakScore?: number
  signal?: AbortSignal
}

export interface RagCalibrationResult {
  passed: boolean
  strongScore: number
  weakScore: number
  gap: number
}

export interface KnowledgeBaseQualityOptions {
  now?: Date
  strict?: boolean
  minCitationRate?: number
  maxStaleSourceRate?: number
}

export interface KnowledgeBaseQualityReport {
  ok: boolean
  metrics: {
    page_count: number
    source_count: number
    citation_rate: number
    source_backed_page_rate: number
    stale_source_rate: number
    duplicate_source_hash_rate: number
    lint_error_count: number
    lint_warning_count: number
  }
  findings: readonly RagGapFinding[]
}

type MaybePromise<T> = T | Promise<T>

const defaultThresholds: Partial<Record<RagEvalMetricKey, number>> = {
  context_precision: 0.5,
  context_recall: 0.8,
  context_relevance: 0.5,
  context_sufficiency: 0.8,
  faithfulness: 0.9,
  answer_relevance: 0.7,
  citation_support: 0.9,
  abstention: 1,
  unsupported_answer_rate: 0,
}

const defaultWeights: Partial<Record<RagEvalMetricKey, number>> = {
  context_relevance: 1,
  context_sufficiency: 1,
  faithfulness: 2,
  answer_relevance: 1,
  citation_support: 1,
  abstention: 1,
}

const metricAliases: Record<string, RagEvalMetricKey> = {
  answer_correctness: 'answer_correctness',
  answer_relevance: 'answer_relevance',
  answer_relevancy: 'answer_relevance',
  answerrelevancy: 'answer_relevance',
  context_precision: 'context_precision',
  context_recall: 'context_recall',
  context_relevance: 'context_relevance',
  context_relevancy: 'context_relevance',
  context_sufficiency: 'context_sufficiency',
  contextual_precision: 'context_precision',
  contextual_recall: 'context_recall',
  contextual_relevancy: 'context_relevance',
  faithfulness: 'faithfulness',
  groundedness: 'groundedness',
  claim_recall: 'context_recall',
  claim_precision: 'faithfulness',
  citation_support: 'citation_support',
  abstention: 'abstention',
  unsupported_answer_rate: 'unsupported_answer_rate',
}

export function ragAnswerQualityJudge(
  options: RagAnswerQualityJudgeOptions = {},
): JudgeConfig<RagAnswerEvalArtifact, RagAnswerEvalScenario> {
  return {
    name: options.name ?? 'rag-answer-quality',
    dimensions: [
      { key: 'context_precision', description: 'share of retrieved context that is useful' },
      { key: 'context_recall', description: 'share of required evidence present in context' },
      { key: 'context_relevance', description: 'context relevance to the query and answer target' },
      { key: 'context_sufficiency', description: 'whether context is enough to answer' },
      { key: 'faithfulness', description: 'share of answer claims supported by retrieved context' },
      { key: 'answer_relevance', description: 'answer addresses the user query' },
      { key: 'answer_correctness', description: 'answer contains expected claims' },
      { key: 'citation_support', description: 'citations support the claims they cite' },
      { key: 'abstention', description: 'answer abstains exactly when the case is unanswerable' },
    ],
    appliesTo: (scenario) => scenario.kind === 'rag-answer-eval',
    async score({ artifact, scenario }) {
      const summary = scoreRagAnswerArtifact(artifact, scenario, options)
      return {
        dimensions: summary.metrics,
        composite: summary.composite,
        notes: summary.findings.map((finding) => finding.message).join('; '),
      }
    },
  }
}

export function scoreRagAnswerArtifact(
  artifact: RagAnswerEvalArtifact,
  scenario: RagAnswerEvalScenario,
  options: RagAnswerQualityJudgeOptions = {},
): RagAnswerMetricSummary {
  const claims = normalizeClaims(artifact)
  const abstained = artifact.abstained ?? looksLikeAbstention(artifact.answer)
  const requiredTargets = requiredContextTargets(scenario)
  const matchedRequiredContextCount = requiredTargets.filter((target) =>
    artifact.contexts.some((context) => contextMatchesTarget(context, target)),
  ).length
  const requiredContextCount = requiredTargets.length
  const contextRecall =
    requiredContextCount === 0
      ? neutralScore(Boolean(scenario.unanswerable) || artifact.contexts.length > 0)
      : matchedRequiredContextCount / requiredContextCount
  const relevantContextCount = artifact.contexts.filter((context) =>
    contextIsRelevant(context, scenario),
  ).length
  const contextPrecision =
    artifact.contexts.length === 0
      ? scenario.unanswerable
        ? 1
        : 0
      : relevantContextCount / artifact.contexts.length
  const contextRelevance =
    artifact.contexts.length === 0
      ? scenario.unanswerable
        ? 1
        : 0
      : average(artifact.contexts.map((context) => contextRelevanceScore(context, scenario)))
  const contextSufficiency = requiredContextCount === 0 ? contextRelevance : contextRecall
  const support = claims.map((claim) => claimSupport(claim.text, artifact.contexts, options))
  const supportedClaimCount = support.filter(Boolean).length
  const faithfulness =
    claims.length === 0 ? (abstained ? 1 : 0) : supportedClaimCount / Math.max(1, claims.length)
  const citation = scoreCitations(claims, artifact, scenario, options)
  const answerRelevance = scoreAnswerRelevance(artifact, scenario, abstained)
  const answerCorrectness = scoreAnswerCorrectness(artifact, scenario, abstained)
  const abstention = scenario.unanswerable ? (abstained ? 1 : 0) : abstained ? 0 : 1
  const unsupportedAnswerRate =
    claims.length === 0 ? (abstained ? 0 : 1) : 1 - supportedClaimCount / Math.max(1, claims.length)

  const deterministicMetrics: Record<RagEvalMetricKey, number> = {
    context_precision: clamp01(contextPrecision),
    context_recall: clamp01(contextRecall),
    context_relevance: clamp01(contextRelevance),
    context_sufficiency: clamp01(contextSufficiency),
    faithfulness: clamp01(faithfulness),
    groundedness: clamp01(faithfulness),
    answer_relevance: clamp01(answerRelevance),
    answer_correctness: clamp01(answerCorrectness),
    citation_support: clamp01(citation.support),
    abstention: clamp01(abstention),
    unsupported_answer_rate: clamp01(unsupportedAnswerRate),
  }
  const providerScores = normalizeExternalRagScores(artifact.externalScores ?? [])
  const metrics = mergeMetrics(deterministicMetrics, providerScores, options.externalScorePolicy)
  const thresholds = { ...defaultThresholds, ...scenario.thresholds, ...options.thresholds }
  const findings = diagnoseRagAnswerFailure(metrics, scenario, thresholds)
  const composite = weightedComposite(metrics, options.weights ?? defaultWeights)

  return {
    metrics,
    composite,
    passed: findings.every(
      (finding) => finding.severity !== 'error' && finding.severity !== 'critical',
    ),
    findings,
    claimCount: claims.length,
    supportedClaimCount,
    citedClaimCount: citation.citedClaimCount,
    supportedCitationCount: citation.supportedCitationCount,
    matchedRequiredContextCount,
    requiredContextCount,
    providerScores,
  }
}

export function diagnoseRagAnswerFailure(
  metrics: Record<RagEvalMetricKey, number>,
  scenario: RagAnswerEvalScenario,
  thresholds: Partial<Record<RagEvalMetricKey, number>> = defaultThresholds,
): RagGapFinding[] {
  const findings: RagGapFinding[] = []
  if (below(metrics.context_recall, thresholds.context_recall)) {
    findings.push({
      id: `${scenario.id}:context-recall`,
      kind: scenario.slices?.includes('multi-source')
        ? 'missing-multihop-evidence'
        : 'retrieval-miss',
      severity: 'error',
      scenarioId: scenario.id,
      message: 'Required evidence was not present in retrieved context.',
      evidence: { context_recall: metrics.context_recall },
    })
  }
  if (below(metrics.context_precision, thresholds.context_precision)) {
    findings.push({
      id: `${scenario.id}:context-precision`,
      kind: 'retrieval-noise',
      severity: 'warning',
      scenarioId: scenario.id,
      message: 'Retrieved context contains too much irrelevant material.',
      evidence: { context_precision: metrics.context_precision },
    })
  }
  if (below(metrics.faithfulness, thresholds.faithfulness)) {
    findings.push({
      id: `${scenario.id}:faithfulness`,
      kind: 'generator-unsupported-claim',
      severity: 'error',
      scenarioId: scenario.id,
      message: 'The answer contains claims not supported by retrieved context.',
      evidence: { faithfulness: metrics.faithfulness },
    })
  }
  if (below(metrics.citation_support, thresholds.citation_support)) {
    findings.push({
      id: `${scenario.id}:citation-support`,
      kind: 'citation-mismatch',
      severity: 'error',
      scenarioId: scenario.id,
      message: 'Citations do not support the claims they are attached to.',
      evidence: { citation_support: metrics.citation_support },
    })
  }
  if (below(metrics.abstention, thresholds.abstention)) {
    findings.push({
      id: `${scenario.id}:abstention`,
      kind: 'incorrect-abstention',
      severity: 'error',
      scenarioId: scenario.id,
      message: scenario.unanswerable
        ? 'The system answered a case marked unanswerable.'
        : 'The system abstained from an answerable case.',
      evidence: { abstention: metrics.abstention },
    })
  }
  return findings
}

export function createRagAnswerQualityHook(
  options: RagAnswerQualityHookOptions,
): () => Promise<RagAnswerQualityResult> {
  return async () => {
    const summaries: RagAnswerMetricSummary[] = []
    const findings: RagGapFinding[] = []
    for (const scenario of options.scenarios) {
      const initialArtifact = await options.run(scenario)
      const external = await options.externalEvaluator?.({ scenario, artifact: initialArtifact })
      const artifact = external
        ? {
            ...initialArtifact,
            externalScores: [
              ...(initialArtifact.externalScores ?? []),
              ...(Array.isArray(external) ? external : [external]),
            ],
          }
        : initialArtifact
      const summary = scoreRagAnswerArtifact(artifact, scenario, {
        thresholds: options.thresholds,
        weights: options.weights,
      })
      summaries.push(summary)
      findings.push(...summary.findings)
    }
    const metrics = aggregateRagAnswerMetrics(summaries)
    return {
      passed: findings.length === 0,
      metrics,
      findings,
      metadata: { scenarioCount: options.scenarios.length },
    }
  }
}

export async function calibrateRagAnswerJudge(
  options: RagCalibrationOptions,
): Promise<RagCalibrationResult> {
  const judge = options.judge ?? ragAnswerQualityJudge()
  const strong = await judge.score({
    artifact: options.strong,
    scenario: options.scenario,
    signal: options.signal ?? new AbortController().signal,
  })
  const weak = await judge.score({
    artifact: options.weak,
    scenario: options.scenario,
    signal: options.signal ?? new AbortController().signal,
  })
  const strongScore = strong.composite
  const weakScore = weak.composite
  const minStrongScore = options.minStrongScore ?? 0.7
  const maxWeakScore = options.maxWeakScore ?? 0.3
  return {
    passed: strongScore >= minStrongScore && weakScore <= maxWeakScore,
    strongScore,
    weakScore,
    gap: strongScore - weakScore,
  }
}

export function normalizeExternalRagScores(
  scores: readonly ExternalRagEvalScore[],
): Record<string, Record<RagEvalMetricKey, number>> {
  const normalized: Record<string, Record<RagEvalMetricKey, number>> = {}
  for (const item of scores) {
    const provider = item.provider || 'custom'
    const providerScores = (normalized[provider] ?? {}) as Record<RagEvalMetricKey, number>
    for (const [key, value] of Object.entries(item.scores)) {
      const canonical = metricAliases[normalizeMetricName(key)]
      if (!canonical) continue
      if (Number.isFinite(value)) providerScores[canonical] = clamp01(value)
    }
    normalized[provider] = providerScores
  }
  return normalized
}

export function toRagasEvaluationRows(cases: readonly RagAnswerEvalCase[]) {
  return cases.map(({ scenario, artifact }) => ({
    user_input: scenario.query,
    response: artifact.answer,
    retrieved_contexts: artifact.contexts.map((context) => context.text),
    reference: scenario.referenceAnswer,
    reference_contexts: requiredContextTexts(scenario),
  }))
}

export function toDeepEvalTestCases(cases: readonly RagAnswerEvalCase[]) {
  return cases.map(({ scenario, artifact }) => ({
    input: scenario.query,
    actual_output: artifact.answer,
    expected_output: scenario.referenceAnswer,
    retrieval_context: artifact.contexts.map((context) => context.text),
    context: requiredContextTexts(scenario),
  }))
}

export function toTruLensRecords(cases: readonly RagAnswerEvalCase[]) {
  return cases.map(({ scenario, artifact }) => ({
    input: scenario.query,
    output: artifact.answer,
    context: artifact.contexts.map((context) => context.text).join('\n\n'),
  }))
}

export function toRagCheckerRecords(cases: readonly RagAnswerEvalCase[]) {
  return cases.map(({ scenario, artifact }) => ({
    query_id: scenario.id,
    query: scenario.query,
    gt_answer: scenario.referenceAnswer,
    response: artifact.answer,
    retrieved_context: artifact.contexts.map((context) => ({
      doc_id: context.id,
      text: context.text,
    })),
    claims: normalizeClaims(artifact).map((claim) => claim.text),
  }))
}

export function scoreKnowledgeBaseIndex(
  index: KnowledgeIndex,
  options: KnowledgeBaseQualityOptions = {},
): KnowledgeBaseQualityReport {
  const validation = validateKnowledgeIndex(index, { strict: options.strict })
  const lintFindings = lintKnowledgeIndex(index)
  const now = options.now ?? new Date()
  const staleSourceCount = index.sources.filter((source) => {
    return source.validUntil ? Date.parse(source.validUntil) < now.getTime() : false
  }).length
  const sourceHashCounts = new Map<string, number>()
  for (const source of index.sources) {
    sourceHashCounts.set(source.contentHash, (sourceHashCounts.get(source.contentHash) ?? 0) + 1)
  }
  const duplicateSourceHashCount = [...sourceHashCounts.values()].filter(
    (count) => count > 1,
  ).length
  const pagesWithInlineCitations = index.pages.filter(
    (page) => sourceRefs(page.text).length > 0,
  ).length
  const pagesWithSources = index.pages.filter((page) => page.sourceIds.length > 0).length
  const metrics = {
    page_count: index.pages.length,
    source_count: index.sources.length,
    citation_rate: index.pages.length === 0 ? 1 : pagesWithInlineCitations / index.pages.length,
    source_backed_page_rate: index.pages.length === 0 ? 1 : pagesWithSources / index.pages.length,
    stale_source_rate: index.sources.length === 0 ? 0 : staleSourceCount / index.sources.length,
    duplicate_source_hash_rate:
      index.sources.length === 0 ? 0 : duplicateSourceHashCount / index.sources.length,
    lint_error_count: validation.findings.filter((finding) => finding.severity === 'error').length,
    lint_warning_count: lintFindings.filter((finding) => finding.severity === 'warning').length,
  }
  const findings: RagGapFinding[] = []
  if (metrics.lint_error_count > 0) {
    findings.push({
      id: 'kb:lint-errors',
      kind: 'unknown',
      severity: 'critical',
      message: `${metrics.lint_error_count} validation error(s) in the knowledge index.`,
      evidence: { lint_error_count: metrics.lint_error_count },
    })
  }
  if (metrics.citation_rate < (options.minCitationRate ?? 0)) {
    findings.push({
      id: 'kb:citation-rate',
      kind: 'missing-source',
      severity: 'error',
      message: 'Inline citation coverage is below the configured minimum.',
      evidence: { citation_rate: metrics.citation_rate },
    })
  }
  if (metrics.stale_source_rate > (options.maxStaleSourceRate ?? 1)) {
    findings.push({
      id: 'kb:stale-source-rate',
      kind: 'stale-source',
      severity: 'error',
      message: 'Stale source rate exceeds the configured maximum.',
      evidence: { stale_source_rate: metrics.stale_source_rate },
    })
  }
  return { ok: findings.length === 0, metrics, findings }
}

function requiredContextTargets(scenario: RagAnswerEvalScenario): RagRequiredContext[] {
  if (scenario.requiredContext?.length) return [...scenario.requiredContext]
  return (scenario.expectedClaims ?? []).map((text) => ({ text }))
}

function requiredContextTexts(scenario: RagAnswerEvalScenario): string[] {
  return requiredContextTargets(scenario).flatMap((target) => (target.text ? [target.text] : []))
}

function contextMatchesTarget(context: RagEvalContext, target: RagRequiredContext): boolean {
  if (target.id && context.id === target.id) return true
  if (target.pageId && context.pageId === target.pageId) return true
  if (target.sourceId && context.sourceId === target.sourceId) return true
  if (target.anchorId && context.anchorId === target.anchorId) return true
  if (target.text && textSupportScore(target.text, context.text) >= 0.7) return true
  return false
}

function contextIsRelevant(context: RagEvalContext, scenario: RagAnswerEvalScenario): boolean {
  return contextRelevanceScore(context, scenario) >= 0.3
}

function contextRelevanceScore(context: RagEvalContext, scenario: RagAnswerEvalScenario): number {
  const targets = [
    scenario.query,
    scenario.referenceAnswer,
    ...(scenario.expectedClaims ?? []),
    ...requiredContextTexts(scenario),
  ].filter((value): value is string => Boolean(value?.trim()))
  if (targets.length === 0) return 1
  return Math.max(...targets.map((target) => textSupportScore(target, context.text)))
}

function claimSupport(
  claim: string,
  contexts: readonly RagEvalContext[],
  options: Pick<RagAnswerQualityJudgeOptions, 'minClaimSupport'>,
): boolean {
  if (contexts.length === 0) return false
  const combined = contexts.map((context) => context.text).join('\n\n')
  const deterministic = groundClaimInText(claim, combined, {
    minOverlap: options.minClaimSupport ?? 0.7,
  })
  return (
    deterministic.grounded || textSupportScore(claim, combined) >= (options.minClaimSupport ?? 0.7)
  )
}

function scoreCitations(
  claims: readonly RagEvalClaim[],
  artifact: RagAnswerEvalArtifact,
  scenario: RagAnswerEvalScenario,
  options: Pick<RagAnswerQualityJudgeOptions, 'minClaimSupport'>,
): { support: number; citedClaimCount: number; supportedCitationCount: number } {
  if (claims.length === 0)
    return { support: scenario.unanswerable ? 1 : 0, citedClaimCount: 0, supportedCitationCount: 0 }
  const citations = artifact.citations ?? []
  const citedClaims = claims.filter((claim) => citationsForClaim(claim, citations).length > 0)
  if (citedClaims.length === 0) {
    return {
      support: scenario.requireCitations ? 0 : 1,
      citedClaimCount: 0,
      supportedCitationCount: 0,
    }
  }
  let supportedCitationCount = 0
  for (const claim of citedClaims) {
    const citedContexts = contextsForClaim(claim, citations, artifact.contexts)
    if (claimSupport(claim.text, citedContexts, options)) supportedCitationCount += 1
  }
  return {
    support: supportedCitationCount / citedClaims.length,
    citedClaimCount: citedClaims.length,
    supportedCitationCount,
  }
}

function citationsForClaim(
  claim: RagEvalClaim,
  citations: readonly RagEvalCitation[],
): RagEvalCitation[] {
  const claimCitationIds = new Set(claim.citationIds ?? [])
  return citations.filter((citation) => {
    return citation.claimId === claim.id || (citation.id && claimCitationIds.has(citation.id))
  })
}

function contextsForClaim(
  claim: RagEvalClaim,
  citations: readonly RagEvalCitation[],
  contexts: readonly RagEvalContext[],
): readonly RagEvalContext[] {
  const matchedCitations = citationsForClaim(claim, citations)
  const matchedContexts = contexts.filter((context) =>
    matchedCitations.some((citation) => {
      if (citation.contextId && citation.contextId === context.id) return true
      if (citation.pageId && citation.pageId === context.pageId) return true
      if (citation.sourceId && citation.sourceId === context.sourceId) return true
      if (citation.anchorId && citation.anchorId === context.anchorId) return true
      return false
    }),
  )
  return matchedContexts.length > 0 ? matchedContexts : contexts
}

function scoreAnswerRelevance(
  artifact: RagAnswerEvalArtifact,
  scenario: RagAnswerEvalScenario,
  abstained: boolean,
): number {
  if (scenario.unanswerable) return abstained ? 1 : 0
  if (abstained) return 0
  const targets = [
    scenario.referenceAnswer,
    ...(scenario.expectedClaims ?? []),
    scenario.query,
  ].filter((value): value is string => Boolean(value?.trim()))
  return Math.max(...targets.map((target) => textSupportScore(target, artifact.answer)))
}

function scoreAnswerCorrectness(
  artifact: RagAnswerEvalArtifact,
  scenario: RagAnswerEvalScenario,
  abstained: boolean,
): number {
  if (scenario.unanswerable) return abstained ? 1 : 0
  const expected = scenario.expectedClaims ?? []
  const forbidden = scenario.forbiddenClaims ?? []
  const expectedScore =
    expected.length === 0
      ? scoreAnswerRelevance(artifact, scenario, abstained)
      : average(expected.map((claim) => textSupportScore(claim, artifact.answer)))
  const forbiddenPenalty =
    forbidden.length === 0
      ? 0
      : forbidden.filter((claim) => textSupportScore(claim, artifact.answer) >= 0.7).length /
        forbidden.length
  return clamp01(expectedScore * (1 - forbiddenPenalty))
}

function normalizeClaims(artifact: RagAnswerEvalArtifact): RagEvalClaim[] {
  if (artifact.claims?.length) return [...artifact.claims]
  return splitSentences(artifact.answer).map((text, index) => ({ id: `claim-${index + 1}`, text }))
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0 && !looksLikeAbstention(sentence))
}

function looksLikeAbstention(answer: string): boolean {
  const normalized = answer.toLowerCase()
  return [
    "i don't know",
    'i do not know',
    'not enough information',
    'cannot answer',
    "can't answer",
    'insufficient information',
    'no reliable answer',
  ].some((phrase) => normalized.includes(phrase))
}

function mergeMetrics(
  deterministic: Record<RagEvalMetricKey, number>,
  providerScores: Record<string, Record<RagEvalMetricKey, number>>,
  policy: RagAnswerQualityJudgeOptions['externalScorePolicy'] = 'prefer-external',
): Record<RagEvalMetricKey, number> {
  if (policy === 'deterministic-first') return deterministic
  const merged = { ...deterministic }
  for (const scores of Object.values(providerScores)) {
    for (const [key, value] of Object.entries(scores) as Array<[RagEvalMetricKey, number]>) {
      merged[key] = value
      if (key === 'groundedness') merged.faithfulness = value
      if (key === 'faithfulness') merged.groundedness = value
    }
  }
  return merged
}

function aggregateRagAnswerMetrics(
  summaries: readonly RagAnswerMetricSummary[],
): Record<string, number> {
  const keys = new Set<RagEvalMetricKey>()
  for (const summary of summaries) {
    for (const key of Object.keys(summary.metrics) as RagEvalMetricKey[]) keys.add(key)
  }
  const out: Record<string, number> = {}
  for (const key of [...keys].sort()) {
    out[key] = average(summaries.map((summary) => summary.metrics[key]))
  }
  out.composite = average(summaries.map((summary) => summary.composite))
  return out
}

function weightedComposite(
  metrics: Record<RagEvalMetricKey, number>,
  weights: Partial<Record<RagEvalMetricKey, number>>,
): number {
  let weighted = 0
  let total = 0
  for (const [key, weight] of Object.entries(weights) as Array<[RagEvalMetricKey, number]>) {
    if (!Number.isFinite(weight) || weight <= 0) continue
    const metric = metrics[key]
    if (!Number.isFinite(metric)) continue
    const value = key === 'unsupported_answer_rate' ? 1 - metric : metric
    weighted += value * weight
    total += weight
  }
  return total === 0 ? 0 : weighted / total
}

function normalizeMetricName(metric: string): string {
  return metric
    .trim()
    .toLowerCase()
    .replace(/[@/.-]+/g, '_')
    .replace(/\s+/g, '_')
}

function textSupportScore(needle: string, haystack: string): number {
  const needleWords = contentWords(needle)
  if (needleWords.length === 0) return 0
  const haystackWords = new Set(contentWords(haystack))
  const present = needleWords.filter((word) => haystackWords.has(word))
  return present.length / needleWords.length
}

function contentWords(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .map((word) => stem(word.trim()))
    .filter((word) => (word.length >= 3 || /^\d+$/.test(word)) && !stopwords.has(word))
  return [...new Set(normalized)]
}

function stem(word: string): string {
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3)
  if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2)
  if (word.endsWith('s') && word.length > 3) return word.slice(0, -1)
  return word
}

function sourceRefs(text: string): string[] {
  const refs: string[] = []
  const regex = /\[\^([A-Za-z0-9_-]+)(?:#([A-Za-z0-9_.:-]+))?\]/g
  let match = regex.exec(text)
  while (match !== null) {
    refs.push(match[0])
    match = regex.exec(text)
  }
  return refs
}

function below(metric: number, threshold: number | undefined): boolean {
  return threshold !== undefined && metric < threshold
}

function neutralScore(condition: boolean): number {
  return condition ? 1 : 0
}

function average(values: readonly number[]): number {
  const finite = values.filter(Number.isFinite)
  return finite.length === 0 ? 0 : finite.reduce((sum, value) => sum + value, 0) / finite.length
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

const stopwords = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'as',
  'by',
  'at',
  'from',
  'that',
  'this',
  'these',
  'those',
  'it',
  'its',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'has',
  'have',
  'had',
  'can',
  'will',
  'would',
  'should',
  'may',
  'might',
  'not',
  'no',
  'than',
  'then',
  'over',
  'under',
  'about',
  'into',
  'their',
  'they',
  'them',
  'what',
  'when',
  'where',
  'who',
  'why',
  'how',
])
