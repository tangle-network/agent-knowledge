import {
  acquisitionPlansForKnowledgeGaps,
  scoreKnowledgeReadiness,
  userQuestionsForKnowledgeGaps,
  type DataAcquisitionPlan,
  type KnowledgeAcquisitionMode,
  type KnowledgeBundle,
  type KnowledgeFreshness,
  type KnowledgeImportance,
  type KnowledgeReadinessReport,
  type KnowledgeRequirement,
  type KnowledgeRequirementCategory,
  type KnowledgeSensitivity,
  type UserQuestion,
} from '@tangle-network/agent-eval'
import type { KnowledgeIndex, KnowledgeSearchResult } from './types'
import { searchKnowledge } from './search'

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

export interface BuildEvalKnowledgeBundleOptions {
  taskId: string
  index: KnowledgeIndex
  specs: KnowledgeReadinessSpec[]
  userAnswers?: Record<string, string>
  searchLimit?: number
  metadata?: Record<string, unknown>
}

export interface EvalKnowledgeBundleBuildResult {
  bundle: KnowledgeBundle
  report: KnowledgeReadinessReport
  requirements: KnowledgeRequirement[]
  searchResultsByRequirement: Record<string, KnowledgeSearchResult[]>
  questions: UserQuestion[]
  acquisitionPlans: DataAcquisitionPlan[]
}

export function buildEvalKnowledgeBundle(options: BuildEvalKnowledgeBundleOptions): EvalKnowledgeBundleBuildResult {
  const searchLimit = options.searchLimit ?? 5
  const searchResultsByRequirement: Record<string, KnowledgeSearchResult[]> = {}
  const requirements = options.specs.map((spec) => {
    const results = searchKnowledge(options.index, spec.query, searchLimit)
    searchResultsByRequirement[spec.id] = results
    return requirementFromSearch(spec, results)
  })
  const report = scoreKnowledgeReadiness({
    taskId: options.taskId,
    requirements,
    userAnswers: options.userAnswers,
    evidenceIds: requirements.flatMap((requirement) => requirement.evidenceIds),
    claimIds: [],
    wikiPageIds: unique(requirements.flatMap((requirement) => pageIdsFromResults(searchResultsByRequirement[requirement.id] ?? []))),
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
  spec: KnowledgeReadinessSpec,
  results: KnowledgeSearchResult[],
): KnowledgeRequirement {
  const hitCount = results.length
  const sourceIds = unique(results.flatMap((result) => result.page.sourceIds))
  const bestScore = results[0]?.normalizedScore ?? 0
  const sourceCoverage = spec.minSources ? Math.min(1, sourceIds.length / spec.minSources) : (sourceIds.length > 0 ? 1 : 0)
  const hitCoverage = spec.minHits ? Math.min(1, hitCount / spec.minHits) : (hitCount > 0 ? 1 : 0)
  const currentConfidence = round(Math.min(bestScore, sourceCoverage, hitCoverage))

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
    fallbackPolicy: spec.fallbackPolicy ?? (spec.importance === 'blocking' ? 'block' : 'continue_with_caveat'),
    metadata: {
      ...spec.metadata,
      query: spec.query,
      hitCount,
      sourceCount: sourceIds.length,
      bestNormalizedScore: bestScore,
    },
  }
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
