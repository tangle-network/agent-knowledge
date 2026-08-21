import {
  acquisitionPlansForKnowledgeGaps,
  type DataAcquisitionPlan,
  type KnowledgeAcquisitionMode,
  type KnowledgeBundle,
  type KnowledgeFreshness,
  type KnowledgeImportance,
  type KnowledgeReadinessReport,
  type KnowledgeRequirement,
  type KnowledgeRequirementCategory,
  type KnowledgeSensitivity,
  scoreKnowledgeReadiness,
  type UserQuestion,
  userQuestionsForKnowledgeGaps,
} from '@tangle-network/agent-eval'
import { stringMetadata } from './metadata'
import { searchKnowledge } from './search'
import type { KnowledgeIndex, KnowledgeSearchResult } from './types'

export interface KnowledgeReadinessSpec {
  id: string
  description: string
  query: string
  requiredFor: string[]
  category: KnowledgeRequirementCategory
  acquisitionMode: KnowledgeAcquisitionMode
  importance: KnowledgeImportance
  freshness: KnowledgeFreshness
  sensitivity: KnowledgeSensitivity
  confidenceNeeded: number
  fallbackPolicy?: KnowledgeRequirement['fallbackPolicy']
  minSources?: number
  minHits?: number
  metadata?: Record<string, unknown>
}

/**
 * Defaults applied by `defineReadinessSpec` when the caller omits the field.
 *
 * These are deliberately conservative: a domain-specific topic that an agent
 * needs grounded to a high-confidence threshold from at least one authoritative
 * source. Override any field to specialise (e.g. `freshness: 'daily'` for a
 * topic that must reflect today's regulatory state).
 */
export const READINESS_SPEC_DEFAULTS = {
  category: 'domain_specific',
  acquisitionMode: 'search_web',
  importance: 'high',
  freshness: 'monthly',
  sensitivity: 'public',
  confidenceNeeded: 0.7,
  minSources: 1,
  minHits: 2,
} as const satisfies Pick<
  KnowledgeReadinessSpec,
  | 'category'
  | 'acquisitionMode'
  | 'importance'
  | 'freshness'
  | 'sensitivity'
  | 'confidenceNeeded'
  | 'minSources'
  | 'minHits'
>

/**
 * Inputs accepted by `defineReadinessSpec`. The four fields the caller cannot
 * sanely default (id, description, query, requiredFor) are required; everything
 * else is optional and pulls from `READINESS_SPEC_DEFAULTS`.
 */
export type DefineReadinessSpecInput = Pick<
  KnowledgeReadinessSpec,
  'id' | 'description' | 'query' | 'requiredFor'
> &
  Partial<Omit<KnowledgeReadinessSpec, 'id' | 'description' | 'query' | 'requiredFor'>>

/**
 * Builder that returns a fully-typed `KnowledgeReadinessSpec` from a slim input.
 *
 * Motivation: `KnowledgeReadinessSpec` has eleven required fields. Most of them
 * (category, acquisition mode, importance, freshness, sensitivity, confidence
 * threshold, source/hit minima) have a clear default for domain-specific KB
 * topics — agents end up copy-pasting the same boilerplate across every spec.
 * This helper collapses that boilerplate while keeping every field overridable.
 *
 * @example
 * defineReadinessSpec({
 *   id: 'coop/intent-grounding',
 *   description: 'Required grounding for coop pack intent stage',
 *   query: 'flock size space ventilation predator',
 *   requiredFor: ['IntentIntakeAgent', 'requirements'],
 * })
 *
 * @example  // override defaults where the topic demands it
 * defineReadinessSpec({
 *   id: 'medical/dosing',
 *   description: 'Dosing guidance for compounding pharmacy',
 *   query: 'compounding dose schedule',
 *   requiredFor: ['DosingAgent'],
 *   importance: 'blocking',
 *   freshness: 'daily',
 *   sensitivity: 'private',
 *   confidenceNeeded: 0.95,
 *   minSources: 3,
 * })
 */
export function defineReadinessSpec(input: DefineReadinessSpecInput): KnowledgeReadinessSpec {
  return {
    ...READINESS_SPEC_DEFAULTS,
    ...input,
  }
}

export interface BuildEvalKnowledgeBundleOptions {
  taskId: string
  index: KnowledgeIndex
  specs: KnowledgeReadinessSpec[]
  userAnswers?: Record<string, string>
  searchLimit?: number
  metadata?: Record<string, unknown>
  now?: Date
}

export interface EvalKnowledgeBundleBuildResult {
  bundle: KnowledgeBundle
  report: KnowledgeReadinessReport
  requirements: KnowledgeRequirement[]
  searchResultsByRequirement: Record<string, KnowledgeSearchResult[]>
  questions: UserQuestion[]
  acquisitionPlans: DataAcquisitionPlan[]
}

export function buildEvalKnowledgeBundle(
  options: BuildEvalKnowledgeBundleOptions,
): EvalKnowledgeBundleBuildResult {
  const searchLimit = options.searchLimit ?? 5
  const now = options.now ?? new Date()
  const searchResultsByRequirement: Record<string, KnowledgeSearchResult[]> = {}
  const requirements = options.specs.map((spec) => {
    const results = searchKnowledge(options.index, spec.query, searchLimit)
    searchResultsByRequirement[spec.id] = results
    return requirementFromSearch(options.index, spec, results, now)
  })
  const report = scoreKnowledgeReadiness({
    taskId: options.taskId,
    requirements,
    userAnswers: options.userAnswers,
    evidenceIds: requirements.flatMap((requirement) => requirement.evidenceIds),
    claimIds: [],
    wikiPageIds: unique(
      requirements.flatMap((requirement) =>
        pageIdsFromResults(searchResultsByRequirement[requirement.id] ?? []),
      ),
    ),
    metadata: options.metadata,
  })
  const questions = userQuestionsForKnowledgeGaps(report.blockingMissingRequirements)
  const acquisitionPlans = acquisitionPlansForKnowledgeGaps([
    ...report.blockingMissingRequirements,
    ...report.nonBlockingGaps,
  ])

  return {
    bundle: report.bundle,
    report,
    requirements,
    searchResultsByRequirement,
    questions,
    acquisitionPlans,
  }
}

function requirementFromSearch(
  index: KnowledgeIndex,
  spec: KnowledgeReadinessSpec,
  results: KnowledgeSearchResult[],
  now: Date,
): KnowledgeRequirement {
  const hitCount = results.length
  const sourceIds = unique(results.flatMap((result) => result.page.sourceIds))
  const sources = index.sources.filter((source) => sourceIds.includes(source.id))
  const bestScore = results[0]?.normalizedScore ?? 0
  const sourceCoverage = spec.minSources
    ? Math.min(1, sourceIds.length / spec.minSources)
    : sourceIds.length > 0
      ? 1
      : 0
  const hitCoverage = spec.minHits ? Math.min(1, hitCount / spec.minHits) : hitCount > 0 ? 1 : 0
  const freshness = sourceFreshness(sources, now)
  const currentConfidence = round(Math.min(bestScore, sourceCoverage, hitCoverage, freshness.score))

  return {
    id: spec.id,
    description: spec.description,
    requiredFor: spec.requiredFor,
    category: spec.category,
    acquisitionMode: spec.acquisitionMode,
    importance: spec.importance,
    freshness: spec.freshness,
    sensitivity: spec.sensitivity,
    confidenceNeeded: spec.confidenceNeeded,
    currentConfidence,
    evidenceIds: unique([
      ...sourceIds.map((sourceId) => `source:${sourceId}`),
      ...results.map((result) => `page:${result.page.id}`),
    ]),
    fallbackPolicy:
      spec.fallbackPolicy ?? (spec.importance === 'blocking' ? 'block' : 'continue_with_caveat'),
    metadata: {
      ...spec.metadata,
      query: spec.query,
      hitCount,
      sourceCount: sourceIds.length,
      bestNormalizedScore: bestScore,
      expiredSourceIds: freshness.expiredSourceIds,
      freshnessScore: freshness.score,
      // An unknown freshness bound is absent from the record rather than present
      // and undefined: the two are the same JSON, so the canonical encoder refuses
      // the key instead of guessing which was meant.
      ...(freshness.validUntil === undefined ? {} : { validUntil: freshness.validUntil }),
      ...(freshness.lastVerifiedAt === undefined
        ? {}
        : { lastVerifiedAt: freshness.lastVerifiedAt }),
    },
  }
}

function sourceFreshness(
  sources: KnowledgeIndex['sources'],
  now: Date,
): { score: number; validUntil?: string; lastVerifiedAt?: string; expiredSourceIds: string[] } {
  if (sources.length === 0) return { score: 0, expiredSourceIds: [] }
  const validUntilValues = sources
    .map(
      (source) =>
        source.validUntil ??
        stringMetadata(source.metadata, 'validUntil') ??
        stringMetadata(source.metadata, 'expiresAt'),
    )
    .filter(isIsoDate)
  const lastVerifiedValues = sources
    .map((source) => source.lastVerifiedAt ?? stringMetadata(source.metadata, 'lastVerifiedAt'))
    .filter(isIsoDate)
  const expiredSourceIds = sources
    .filter((source) => {
      const validUntil =
        source.validUntil ??
        stringMetadata(source.metadata, 'validUntil') ??
        stringMetadata(source.metadata, 'expiresAt')
      return validUntil ? Date.parse(validUntil) <= now.getTime() : false
    })
    .map((source) => source.id)
  return {
    score: expiredSourceIds.length > 0 ? 0 : 1,
    validUntil: earliestIso(validUntilValues),
    lastVerifiedAt: latestIso(lastVerifiedValues),
    expiredSourceIds,
  }
}

function isIsoDate(value: string | undefined): value is string {
  return Boolean(value && Number.isFinite(Date.parse(value)))
}

function earliestIso(values: string[]): string | undefined {
  return values.sort((a, b) => Date.parse(a) - Date.parse(b))[0]
}

function latestIso(values: string[]): string | undefined {
  return values.sort((a, b) => Date.parse(b) - Date.parse(a))[0]
}

function pageIdsFromResults(results: KnowledgeSearchResult[]): string[] {
  return results.map((result) => result.page.id)
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
