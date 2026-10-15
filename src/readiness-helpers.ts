import {
  type BuildEvalKnowledgeBundleOptions,
  buildEvalKnowledgeBundle,
  type EvalKnowledgeBundleBuildResult,
  type KnowledgeReadinessSpec,
} from './eval-readiness'
import type { KnowledgeBaseQualityOptions } from './rag-eval'
import { scoreValidatedKnowledgeBaseIndex } from './rag-eval/knowledge-base'
import type { KnowledgeIndex } from './types'
import { prepareKnowledgeValidation, type ValidateKnowledgeOptions } from './validate'

/**
 * The subset of a research-loop options object the readiness gate needs:
 * the goal (default task id), the readiness specs, an optional task-id
 * override, and the rest of the bundle options minus the fields this helper
 * supplies (`taskId`/`index`/`specs`).
 *
 * The research-loop options shape satisfies this structurally.
 */
export interface ReadinessGateOptions {
  goal: string
  readinessSpecs?: readonly KnowledgeReadinessSpec[]
  readinessTaskId?: string
  readiness?: Omit<BuildEvalKnowledgeBundleOptions, 'taskId' | 'index' | 'specs'>
}

/**
 * Build the readiness bundle for a loop run over the given index, or
 * `undefined` when no readiness specs are configured (no gate to report).
 */
export function readinessFor(
  options: ReadinessGateOptions,
  index: KnowledgeIndex,
): EvalKnowledgeBundleBuildResult | undefined {
  if (!options.readinessSpecs?.length) return undefined
  return buildEvalKnowledgeBundle({
    ...(options.readiness ?? {}),
    taskId: options.readinessTaskId ?? options.goal,
    index,
    specs: [...options.readinessSpecs],
  })
}

/** Assess one index without repeating lint/schema work for its two policy gates. */
export function assessKnowledgeIndex(
  options: ReadinessGateOptions & {
    strict?: ValidateKnowledgeOptions['strict']
    kbQuality?: KnowledgeBaseQualityOptions
  },
  index: KnowledgeIndex,
) {
  const prepared = prepareKnowledgeValidation(index)
  const validation = prepared.validate({ strict: options.strict })
  const readiness = readinessFor(options, index)
  const qualityOptions = { strict: options.strict, ...options.kbQuality }
  const qualityValidation =
    Boolean(qualityOptions.strict) === Boolean(options.strict)
      ? validation
      : prepared.validate(qualityOptions)
  return {
    validation,
    readiness,
    kbQuality: scoreValidatedKnowledgeBaseIndex(index, qualityOptions, qualityValidation),
  }
}
