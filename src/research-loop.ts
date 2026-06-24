import {
  blockingKnowledgeEval,
  type ControlEvalResult,
  type ControlRuntimeConfig,
  objectiveEval,
} from '@tangle-network/agent-eval'
import type {
  BuildEvalKnowledgeBundleOptions,
  EvalKnowledgeBundleBuildResult,
  KnowledgeReadinessSpec,
} from './eval-readiness'
import { createKnowledgeEvent } from './events'
import { buildKnowledgeIndex } from './indexer'
import { lintKnowledgeIndex } from './lint'
import { type ApplyWriteBlocksResult, applyKnowledgeWriteBlocks } from './proposals'
import { readinessFor } from './readiness-helpers'
import {
  type AddSourceOptions,
  type AddSourceTextInput,
  addSourcePath,
  addSourceText,
} from './sources'
import { initKnowledgeBase } from './store'
import type { KnowledgeEvent, KnowledgeIndex, KnowledgeLintFinding, SourceRecord } from './types'
import {
  type ValidateKnowledgeOptions,
  type ValidateKnowledgeResult,
  validateKnowledgeIndex,
} from './validate'

export interface KnowledgeResearchLoopContext {
  root: string
  goal: string
  iteration: number
  index: KnowledgeIndex
  lintFindings: KnowledgeLintFinding[]
  validation: ValidateKnowledgeResult
  readiness?: EvalKnowledgeBundleBuildResult
  previousSteps: KnowledgeResearchLoopStep[]
  signal?: AbortSignal
}

export interface KnowledgeResearchLoopDecision {
  /**
   * Free-form notes from the researcher. Keep this human-readable; products can
   * store it as the research transcript.
   */
  notes?: string
  /**
   * Local files to register as immutable sources before applying proposals.
   */
  sourcePaths?: string[]
  /**
   * Textual source artifacts discovered by an agent, browser worker, connector,
   * or deep-research process.
   */
  sourceTexts?: AddSourceTextInput[]
  /**
   * Safe write protocol text. The loop parses and applies only accepted
   * `---FILE: knowledge/...---` blocks.
   */
  proposalText?: string
  /**
   * The researcher decides when the wiki is good enough. The loop deliberately
   * does not encode a domain-specific definition of "done".
   */
  done?: boolean
  metadata?: Record<string, unknown>
}

export interface KnowledgeResearchLoopStep {
  iteration: number
  notes?: string
  addedSources: SourceRecord[]
  applied?: ApplyWriteBlocksResult
  lintFindings: KnowledgeLintFinding[]
  validation: ValidateKnowledgeResult
  readiness?: EvalKnowledgeBundleBuildResult
  event: KnowledgeEvent
  done: boolean
  metadata?: Record<string, unknown>
}

export interface RunKnowledgeResearchLoopOptions {
  root: string
  goal: string
  maxIterations?: number
  actor?: string
  strict?: ValidateKnowledgeOptions['strict']
  readinessSpecs?: KnowledgeReadinessSpec[]
  readinessTaskId?: string
  readiness?: Omit<BuildEvalKnowledgeBundleOptions, 'taskId' | 'index' | 'specs'>
  sourceOptions?: Pick<AddSourceOptions, 'adapters' | 'now'>
  signal?: AbortSignal
  step(
    context: KnowledgeResearchLoopContext,
  ): Promise<KnowledgeResearchLoopDecision> | KnowledgeResearchLoopDecision
  onStep?: (step: KnowledgeResearchLoopStep) => Promise<void> | void
}

export interface KnowledgeResearchLoopResult {
  root: string
  goal: string
  iterations: number
  done: boolean
  index: KnowledgeIndex
  lintFindings: KnowledgeLintFinding[]
  validation: ValidateKnowledgeResult
  readiness?: EvalKnowledgeBundleBuildResult
  steps: KnowledgeResearchLoopStep[]
}

export type KnowledgeControlLoopState = KnowledgeResearchLoopContext
export type KnowledgeControlLoopAction = KnowledgeResearchLoopDecision
export type KnowledgeControlLoopActionResult = KnowledgeResearchLoopStep

export interface KnowledgeControlLoopAdapterOptions {
  root: string
  goal: string
  actor?: string
  strict?: ValidateKnowledgeOptions['strict']
  readinessSpecs?: KnowledgeReadinessSpec[]
  readinessTaskId?: string
  readiness?: Omit<BuildEvalKnowledgeBundleOptions, 'taskId' | 'index' | 'specs'>
  sourceOptions?: Pick<AddSourceOptions, 'adapters' | 'now'>
}

export type KnowledgeControlLoopAdapter = Pick<
  ControlRuntimeConfig<
    KnowledgeControlLoopState,
    KnowledgeControlLoopAction,
    KnowledgeControlLoopActionResult,
    ControlEvalResult
  >,
  'intent' | 'observe' | 'validate' | 'act' | 'shouldStop'
>

/**
 * Adapter for running knowledge growth through `agent-eval`'s generic control
 * runtime. The caller still owns `decide`: that can be a proposer agent,
 * reviewer agent, deterministic policy, or a composition of all three.
 */
export function createKnowledgeControlLoopAdapter(
  options: KnowledgeControlLoopAdapterOptions,
): KnowledgeControlLoopAdapter {
  let initialized = false
  const appliedSteps: KnowledgeResearchLoopStep[] = []

  return {
    intent: options.goal,
    async observe({ history, abortSignal }) {
      if (abortSignal.aborted) throw new Error('Knowledge control loop aborted')
      if (!initialized) {
        await initKnowledgeBase(options.root)
        initialized = true
      }
      const index = await buildKnowledgeIndex(options.root)
      const validation = validateKnowledgeIndex(index, { strict: options.strict })
      const lintFindings = lintKnowledgeIndex(index)
      const readiness = readinessFor(options, index)
      return {
        root: options.root,
        goal: options.goal,
        iteration: history.length + 1,
        index,
        lintFindings,
        validation,
        readiness,
        previousSteps: [...appliedSteps],
        signal: abortSignal,
      }
    },
    validate({ state }) {
      const errorFindings = state.validation.findings.filter(
        (finding) => finding.severity === 'error',
      )
      const evals: ControlEvalResult[] = [
        objectiveEval({
          id: 'knowledge-valid',
          passed: state.validation.ok,
          severity: 'critical',
          detail: state.validation.ok
            ? 'Knowledge index is valid.'
            : 'Knowledge index has validation errors.',
          metadata: { findings: state.validation.findings },
        }),
        objectiveEval({
          id: 'knowledge-lint-errors',
          passed: errorFindings.length === 0,
          severity: 'error',
          detail:
            errorFindings.length === 0
              ? 'No lint errors.'
              : `${errorFindings.length} lint error(s).`,
          metadata: { findings: errorFindings },
        }),
      ]
      if (state.readiness) evals.push(blockingKnowledgeEval(state.readiness.report))
      return evals
    },
    shouldStop() {
      return { stop: false, pass: false, reason: 'knowledge driver owns stop decisions' }
    },
    async act(action, ctx) {
      const step = await applyKnowledgeResearchDecision(options, action, ctx.state.iteration)
      appliedSteps.push(step)
      return step
    },
  }
}

export async function runKnowledgeResearchLoop(
  options: RunKnowledgeResearchLoopOptions,
): Promise<KnowledgeResearchLoopResult> {
  const maxIterations = Math.max(1, options.maxIterations ?? 3)
  await initKnowledgeBase(options.root)
  const steps: KnowledgeResearchLoopStep[] = []
  let index = await buildKnowledgeIndex(options.root)
  let validation = validateKnowledgeIndex(index, { strict: options.strict })
  let lintFindings = lintKnowledgeIndex(index)
  let readiness = readinessFor(options, index)
  let done = false

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    if (options.signal?.aborted) throw new Error('Knowledge research loop aborted')
    const decision = await options.step({
      root: options.root,
      goal: options.goal,
      iteration,
      index,
      lintFindings,
      validation,
      readiness,
      previousSteps: steps,
      signal: options.signal,
    })

    done = Boolean(decision.done)
    const step = await applyKnowledgeResearchDecision(options, decision, iteration)
    index = await buildKnowledgeIndex(options.root)
    validation = step.validation
    lintFindings = step.lintFindings
    readiness = step.readiness
    steps.push(step)
    await options.onStep?.(step)

    if (done) break
    if (!step.applied && step.addedSources.length === 0) break
  }

  return {
    root: options.root,
    goal: options.goal,
    iterations: steps.length,
    done,
    index,
    lintFindings,
    validation,
    readiness,
    steps,
  }
}

async function applyKnowledgeResearchDecision(
  options: KnowledgeControlLoopAdapterOptions,
  decision: KnowledgeResearchLoopDecision,
  iteration = 1,
): Promise<KnowledgeResearchLoopStep> {
  const addedSources: SourceRecord[] = []
  for (const sourcePath of decision.sourcePaths ?? []) {
    addedSources.push(...(await addSourcePath(options.root, sourcePath, options.sourceOptions)))
  }
  for (const sourceText of decision.sourceTexts ?? []) {
    addedSources.push(await addSourceText(options.root, sourceText, options.sourceOptions))
  }

  const applied = decision.proposalText
    ? await applyKnowledgeWriteBlocks(options.root, decision.proposalText)
    : undefined

  const index = await buildKnowledgeIndex(options.root)
  const validation = validateKnowledgeIndex(index, { strict: options.strict })
  const lintFindings = lintKnowledgeIndex(index)
  const readiness = readinessFor(options, index)
  const done = Boolean(decision.done)
  const event = createKnowledgeEvent({
    type: 'research.iteration',
    actor: options.actor,
    target: options.root,
    metadata: {
      goal: options.goal,
      iteration,
      done,
      addedSourceCount: addedSources.length,
      written: applied?.written,
      warningCount: applied?.warnings.length ?? 0,
      errorCount: validation.findings.filter((finding) => finding.severity === 'error').length,
    },
  })

  return {
    iteration,
    notes: decision.notes,
    addedSources,
    applied,
    lintFindings,
    validation,
    readiness,
    event,
    done,
    metadata: decision.metadata,
  }
}
