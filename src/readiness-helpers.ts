import {
  type BuildEvalKnowledgeBundleOptions,
  buildEvalKnowledgeBundle,
  type EvalKnowledgeBundleBuildResult,
  type KnowledgeReadinessSpec,
} from './eval-readiness'
import type { KnowledgeIndex } from './types'

/**
 * The subset of a research-loop options object the readiness gate needs:
 * the goal (default task id), the readiness specs, an optional task-id
 * override, and the rest of the bundle options minus the fields this helper
 * supplies (`taskId`/`index`/`specs`).
 *
 * Both the single-agent (`research-loop`) and two-agent (`verified-research-loop`)
 * options shapes satisfy this structurally, so the gate is single-sourced.
 */
export interface ReadinessGateOptions {
  goal: string
  readinessSpecs?: KnowledgeReadinessSpec[]
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
    specs: options.readinessSpecs,
  })
}
