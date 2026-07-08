import type {
  BuildEvalKnowledgeBundleOptions,
  EvalKnowledgeBundleBuildResult,
  KnowledgeReadinessSpec,
} from './eval-readiness'
import { buildKnowledgeIndex } from './indexer'
import {
  type KnowledgeBaseQualityOptions,
  type KnowledgeBaseQualityReport,
  scoreKnowledgeBaseIndex,
} from './rag-eval'
import { readinessFor } from './readiness-helpers'
import type { KnowledgeIndex } from './types'
import {
  type ValidateKnowledgeOptions,
  type ValidateKnowledgeResult,
  validateKnowledgeIndex,
} from './validate'

export interface EvaluateKnowledgeBaseReadinessOptions {
  root: string
  goal: string
  readinessSpecs?: readonly KnowledgeReadinessSpec[]
  readinessTaskId?: string
  readiness?: Omit<BuildEvalKnowledgeBundleOptions, 'taskId' | 'index' | 'specs'>
  strict?: ValidateKnowledgeOptions['strict']
  kbQuality?: KnowledgeBaseQualityOptions
}

export interface KnowledgeBaseReadinessEvaluation {
  ready: boolean
  summary: string
  index: KnowledgeIndex
  validation: ValidateKnowledgeResult
  readiness?: EvalKnowledgeBundleBuildResult
  kbQuality: KnowledgeBaseQualityReport
  dimensions: {
    validation: number
    kb_quality: number
    blocking_readiness: number
  }
}

export async function evaluateKnowledgeBaseReadiness(
  options: EvaluateKnowledgeBaseReadinessOptions,
): Promise<KnowledgeBaseReadinessEvaluation> {
  const index = await buildKnowledgeIndex(options.root)
  const validation = validateKnowledgeIndex(index, { strict: options.strict })
  const readiness = readinessFor(
    {
      ...options,
      readinessSpecs: options.readinessSpecs ? [...options.readinessSpecs] : undefined,
    },
    index,
  )
  const kbQuality = scoreKnowledgeBaseIndex(index, {
    strict: options.strict,
    ...options.kbQuality,
  })
  const blockingMissing = readiness?.report.blockingMissingRequirements.length ?? 0
  const blockingTotal =
    options.readinessSpecs?.filter((spec) => spec.importance === 'blocking').length ?? 0
  const blockingReadiness =
    blockingTotal === 0 ? 1 : Math.max(0, blockingTotal - blockingMissing) / blockingTotal
  const ready = validation.ok && kbQuality.ok && blockingMissing === 0
  const failures = [
    validation.ok ? undefined : `${validation.findings.length} validation finding(s)`,
    kbQuality.ok ? undefined : `${kbQuality.findings.length} KB quality finding(s)`,
    blockingMissing === 0
      ? undefined
      : `${blockingMissing}/${blockingTotal} blocking readiness requirement(s) missing`,
  ].filter((failure): failure is string => Boolean(failure))

  return {
    ready,
    summary: ready ? 'knowledge base passed readiness checks' : failures.join('; '),
    index,
    validation,
    readiness,
    kbQuality,
    dimensions: {
      validation: validation.ok ? 1 : 0,
      kb_quality: kbQuality.ok ? 1 : 0,
      blocking_readiness: blockingReadiness,
    },
  }
}
