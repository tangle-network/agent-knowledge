import { buildKnowledgeIndex } from './indexer'
import { lintKnowledgeIndex } from './lint'
import { applyKnowledgeWriteBlocks, type ApplyWriteBlocksResult } from './proposals'
import { initKnowledgeBase } from './store'
import type { KnowledgeEvent, KnowledgeIndex, KnowledgeLintFinding, SourceRecord } from './types'
import { createKnowledgeEvent } from './events'
import { validateKnowledgeIndex, type ValidateKnowledgeOptions, type ValidateKnowledgeResult } from './validate'
import {
  addSourcePath,
  addSourceText,
  type AddSourceTextInput,
  type AddSourceOptions,
} from './sources'
import {
  buildEvalKnowledgeBundle,
  type BuildEvalKnowledgeBundleOptions,
  type EvalKnowledgeBundleBuildResult,
  type KnowledgeReadinessSpec,
} from './eval-readiness'

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
  step(context: KnowledgeResearchLoopContext): Promise<KnowledgeResearchLoopDecision> | KnowledgeResearchLoopDecision
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

    const addedSources: SourceRecord[] = []
    for (const sourcePath of decision.sourcePaths ?? []) {
      addedSources.push(...await addSourcePath(options.root, sourcePath, options.sourceOptions))
    }
    for (const sourceText of decision.sourceTexts ?? []) {
      addedSources.push(await addSourceText(options.root, sourceText, options.sourceOptions))
    }

    const applied = decision.proposalText
      ? await applyKnowledgeWriteBlocks(options.root, decision.proposalText)
      : undefined

    index = await buildKnowledgeIndex(options.root)
    validation = validateKnowledgeIndex(index, { strict: options.strict })
    lintFindings = lintKnowledgeIndex(index)
    readiness = readinessFor(options, index)
    done = Boolean(decision.done)

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
    const step: KnowledgeResearchLoopStep = {
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
    steps.push(step)
    await options.onStep?.(step)

    if (done) break
    if (!applied && addedSources.length === 0) break
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

function readinessFor(
  options: RunKnowledgeResearchLoopOptions,
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
