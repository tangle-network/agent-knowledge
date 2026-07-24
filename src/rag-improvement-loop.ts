import type { JsonValue } from '@tangle-network/agent-eval/campaign'
import {
  type RunRagOptimizationOptions,
  type RunRagOptimizationResult,
  runRagOptimization,
} from './rag-optimization'
import {
  type KnowledgeResearchLoopDecision,
  type KnowledgeResearchLoopResult,
  type RunKnowledgeResearchLoopOptions,
  runKnowledgeResearchLoop,
} from './research-loop'
import {
  type RunRetrievalImprovementLoopOptions,
  type RunRetrievalImprovementLoopResult,
  runRetrievalImprovementLoop,
} from './retrieval-optimization'

export type RagKnowledgeImprovementPhase =
  | 'rag-optimization'
  | 'retrieval-tuning'
  | 'gap-diagnosis'
  | 'knowledge-acquisition'
  | 'knowledge-update'
  | 'answer-quality'
  | 'promotion'

export type RagKnowledgeImprovementPhaseStatus = 'completed' | 'skipped' | 'failed'

export type RagGapKind =
  | 'missing-source'
  | 'stale-source'
  | 'retrieval-miss'
  | 'retrieval-noise'
  | 'chunking-mismatch'
  | 'missing-multihop-evidence'
  | 'generator-unsupported-claim'
  | 'citation-mismatch'
  | 'incorrect-abstention'
  | 'unknown'

export type RagGapSeverity = 'info' | 'warning' | 'error' | 'critical'

export interface RagGapFinding {
  id: string
  kind: RagGapKind
  severity: RagGapSeverity
  message: string
  scenarioId?: string
  evidence?: Record<string, JsonValue>
}

export interface RagKnowledgeImprovementPhaseResult {
  phase: RagKnowledgeImprovementPhase
  status: RagKnowledgeImprovementPhaseStatus
  summary: string
  startedAt: string
  finishedAt: string
  metadata?: Record<string, JsonValue>
}

export interface RagPhaseInputBase {
  goal: string
  phases: readonly RagKnowledgeImprovementPhaseResult[]
  optimization?: RunRagOptimizationResult
  signal?: AbortSignal
}

export interface RagDiagnosisInput extends RagPhaseInputBase {
  retrieval?: RunRetrievalImprovementLoopResult
}

export interface RagKnowledgeAcquisitionInput extends RagPhaseInputBase {
  retrieval?: RunRetrievalImprovementLoopResult
  findings: readonly RagGapFinding[]
}

export interface RagKnowledgeUpdateInput extends RagPhaseInputBase {
  retrieval?: RunRetrievalImprovementLoopResult
  findings: readonly RagGapFinding[]
  acquisition?: KnowledgeResearchLoopDecision
}

export interface RagKnowledgeUpdateResult {
  applied: boolean
  summary: string
  research?: KnowledgeResearchLoopResult
  metadata?: Record<string, JsonValue>
}

export interface RagAnswerQualityInput extends RagPhaseInputBase {
  retrieval?: RunRetrievalImprovementLoopResult
  findings: readonly RagGapFinding[]
  acquisition?: KnowledgeResearchLoopDecision
  knowledgeUpdate?: RagKnowledgeUpdateResult
}

export interface RagAnswerQualityResult {
  passed: boolean
  metrics: Record<string, number>
  findings?: readonly RagGapFinding[]
  metadata?: Record<string, JsonValue>
}

export interface RagPromotionInput extends RagPhaseInputBase {
  retrieval?: RunRetrievalImprovementLoopResult
  findings: readonly RagGapFinding[]
  acquisition?: KnowledgeResearchLoopDecision
  knowledgeUpdate?: RagKnowledgeUpdateResult
  answerQuality?: RagAnswerQualityResult
}

export interface RagPromotionResult {
  promoted: boolean
  reason: string
  metadata?: Record<string, JsonValue>
}

export interface RagKnowledgeResearchOptions
  extends Omit<RunKnowledgeResearchLoopOptions, 'goal' | 'signal' | 'step'> {
  goal?: string
  step?: RunKnowledgeResearchLoopOptions['step']
}

export interface RunRagKnowledgeImprovementLoopOptions {
  goal: string
  optimization?: RunRagOptimizationOptions
  retrieval?: RunRetrievalImprovementLoopOptions
  diagnose?: (input: RagDiagnosisInput) => MaybePromise<readonly RagGapFinding[]>
  acquireKnowledge?: (
    input: RagKnowledgeAcquisitionInput,
  ) => MaybePromise<KnowledgeResearchLoopDecision>
  knowledgeResearch?: RagKnowledgeResearchOptions
  updateKnowledge?: (input: RagKnowledgeUpdateInput) => MaybePromise<RagKnowledgeUpdateResult>
  evaluateAnswers?: (input: RagAnswerQualityInput) => MaybePromise<RagAnswerQualityResult>
  promote?: (input: RagPromotionInput) => MaybePromise<RagPromotionResult>
  enabledPhases?: readonly RagKnowledgeImprovementPhase[]
  requiredPhases?: readonly RagKnowledgeImprovementPhase[]
  signal?: AbortSignal
  now?: () => Date
}

export interface RunRagKnowledgeImprovementLoopResult {
  goal: string
  phases: readonly RagKnowledgeImprovementPhaseResult[]
  optimization?: RunRagOptimizationResult
  retrieval?: RunRetrievalImprovementLoopResult
  findings: readonly RagGapFinding[]
  acquisition?: KnowledgeResearchLoopDecision
  knowledgeUpdate?: RagKnowledgeUpdateResult
  answerQuality?: RagAnswerQualityResult
  promotion?: RagPromotionResult
}

type MaybePromise<T> = T | Promise<T>

export async function runRagKnowledgeImprovementLoop(
  options: RunRagKnowledgeImprovementLoopOptions,
): Promise<RunRagKnowledgeImprovementLoopResult> {
  assertConfiguredRequiredPhases(options)
  const now = options.now ?? (() => new Date())
  const phases: RagKnowledgeImprovementPhaseResult[] = []
  let optimization: RunRagOptimizationResult | undefined
  let retrieval: RunRetrievalImprovementLoopResult | undefined
  let findings: RagGapFinding[] = []
  let acquisition: KnowledgeResearchLoopDecision | undefined
  let knowledgeUpdate: RagKnowledgeUpdateResult | undefined
  let answerQuality: RagAnswerQualityResult | undefined
  let promotion: RagPromotionResult | undefined

  if (
    phaseEnabled(options, 'rag-optimization') &&
    (options.optimization ||
      options.enabledPhases?.includes('rag-optimization') ||
      options.requiredPhases?.includes('rag-optimization'))
  ) {
    if (options.optimization) {
      optimization = await runPhase(
        phases,
        now,
        'rag-optimization',
        async () => {
          assertNotAborted(options.signal)
          return runRagOptimization(options.optimization!)
        },
        summarizeRagOptimization,
      )
    } else {
      skipPhase(phases, now, 'rag-optimization', 'no full RAG optimization options provided')
    }
  }

  if (phaseEnabled(options, 'retrieval-tuning')) {
    if (options.retrieval) {
      retrieval = await runPhase(
        phases,
        now,
        'retrieval-tuning',
        async () => {
          assertNotAborted(options.signal)
          return runRetrievalImprovementLoop(options.retrieval!)
        },
        summarizeRetrievalResult,
      )
    } else {
      skipPhase(phases, now, 'retrieval-tuning', 'no retrieval options provided')
    }
  }

  if (phaseEnabled(options, 'gap-diagnosis')) {
    if (options.diagnose) {
      findings = [
        ...(await runPhase(
          phases,
          now,
          'gap-diagnosis',
          async () => {
            assertNotAborted(options.signal)
            return options.diagnose!({
              goal: options.goal,
              phases,
              optimization,
              signal: options.signal,
              retrieval,
            })
          },
          (diagnosed) => `${diagnosed.length} finding(s)`,
        )),
      ]
    } else {
      skipPhase(phases, now, 'gap-diagnosis', 'no diagnosis hook provided')
    }
  }

  if (phaseEnabled(options, 'knowledge-acquisition')) {
    if (options.acquireKnowledge) {
      acquisition = await runPhase(
        phases,
        now,
        'knowledge-acquisition',
        async () => {
          assertNotAborted(options.signal)
          return options.acquireKnowledge!({
            goal: options.goal,
            phases,
            optimization,
            signal: options.signal,
            retrieval,
            findings,
          })
        },
        summarizeAcquisitionDecision,
      )
    } else {
      skipPhase(phases, now, 'knowledge-acquisition', 'no acquisition hook provided')
    }
  }

  if (phaseEnabled(options, 'knowledge-update')) {
    if (options.updateKnowledge) {
      knowledgeUpdate = await runPhase(
        phases,
        now,
        'knowledge-update',
        async () => {
          assertNotAborted(options.signal)
          return options.updateKnowledge!({
            goal: options.goal,
            phases,
            optimization,
            signal: options.signal,
            retrieval,
            findings,
            acquisition,
          })
        },
        (result) => result.summary,
      )
    } else if (options.knowledgeResearch) {
      knowledgeUpdate = await runPhase(
        phases,
        now,
        'knowledge-update',
        async () => {
          assertNotAborted(options.signal)
          return runKnowledgeResearchUpdate(options, acquisition)
        },
        (result) => result.summary,
      )
    } else {
      skipPhase(phases, now, 'knowledge-update', 'no update hook or research loop provided')
    }
  }

  if (phaseEnabled(options, 'answer-quality')) {
    if (options.evaluateAnswers) {
      answerQuality = await runPhase(
        phases,
        now,
        'answer-quality',
        async () => {
          assertNotAborted(options.signal)
          return options.evaluateAnswers!({
            goal: options.goal,
            phases,
            optimization,
            signal: options.signal,
            retrieval,
            findings,
            acquisition,
            knowledgeUpdate,
          })
        },
        summarizeAnswerQuality,
      )
      findings = [...findings, ...(answerQuality.findings ?? [])]
    } else {
      skipPhase(phases, now, 'answer-quality', 'no answer-quality hook provided')
    }
  }

  if (phaseEnabled(options, 'promotion')) {
    if (options.promote) {
      promotion = await runPhase(
        phases,
        now,
        'promotion',
        async () => {
          assertNotAborted(options.signal)
          return options.promote!({
            goal: options.goal,
            phases,
            optimization,
            signal: options.signal,
            retrieval,
            findings,
            acquisition,
            knowledgeUpdate,
            answerQuality,
          })
        },
        (result) => `${result.promoted ? 'promoted' : 'held'}: ${result.reason}`,
      )
    } else {
      skipPhase(phases, now, 'promotion', 'no promotion hook provided')
    }
  }

  return {
    goal: options.goal,
    phases,
    optimization,
    retrieval,
    findings,
    acquisition,
    knowledgeUpdate,
    answerQuality,
    promotion,
  }
}

function summarizeRagOptimization(result: RunRagOptimizationResult): string {
  return `${result.methodName}; winner=${result.winner.surfaceHash}; final_lift=${result.comparison.best.lift.toFixed(3)}`
}

async function runKnowledgeResearchUpdate(
  options: RunRagKnowledgeImprovementLoopOptions,
  acquisition: KnowledgeResearchLoopDecision | undefined,
): Promise<RagKnowledgeUpdateResult> {
  const research = options.knowledgeResearch
  if (!research) {
    throw new Error('knowledgeResearch options are required to run the knowledge update phase')
  }
  const { goal, step, ...rest } = research
  const researchStep = step ?? acquisitionBackedResearchStep(acquisition)
  const maxIterations = step ? rest.maxIterations : 1
  const result = await runKnowledgeResearchLoop({
    ...rest,
    goal: goal ?? options.goal,
    maxIterations,
    signal: options.signal,
    step: researchStep,
  })
  return {
    applied: result.steps.some((stepResult) => {
      return stepResult.addedSources.length > 0 || Boolean(stepResult.applied)
    }),
    summary: `${result.iterations} research iteration(s); done=${String(result.done)}`,
    research: result,
  }
}

function acquisitionBackedResearchStep(
  acquisition: KnowledgeResearchLoopDecision | undefined,
): RunKnowledgeResearchLoopOptions['step'] {
  if (!acquisition) {
    throw new Error(
      'knowledgeResearch requires either a step hook or a knowledge-acquisition result to apply',
    )
  }
  return () => ({ ...acquisition, done: acquisition.done ?? true })
}

async function runPhase<T>(
  phases: RagKnowledgeImprovementPhaseResult[],
  now: () => Date,
  phase: RagKnowledgeImprovementPhase,
  action: () => MaybePromise<T>,
  summarize: (result: T) => string,
): Promise<T> {
  const startedAt = now().toISOString()
  try {
    const result = await action()
    phases.push({
      phase,
      status: 'completed',
      summary: summarize(result),
      startedAt,
      finishedAt: now().toISOString(),
    })
    return result
  } catch (error) {
    phases.push({
      phase,
      status: 'failed',
      summary: (error as Error).message,
      startedAt,
      finishedAt: now().toISOString(),
    })
    throw error
  }
}

function skipPhase(
  phases: RagKnowledgeImprovementPhaseResult[],
  now: () => Date,
  phase: RagKnowledgeImprovementPhase,
  summary: string,
): void {
  const timestamp = now().toISOString()
  phases.push({ phase, status: 'skipped', summary, startedAt: timestamp, finishedAt: timestamp })
}

function summarizeRetrievalResult(result: RunRetrievalImprovementLoopResult): string {
  return `${result.methodName}; winner=${result.winner.surfaceHash}; final_lift=${result.comparison.best.lift.toFixed(3)}`
}

function summarizeAcquisitionDecision(decision: KnowledgeResearchLoopDecision): string {
  const sourcePathCount = decision.sourcePaths?.length ?? 0
  const sourceTextCount = decision.sourceTexts?.length ?? 0
  const proposal = decision.proposalText ? 'proposal' : 'no proposal'
  return `${sourcePathCount} path source(s), ${sourceTextCount} text source(s), ${proposal}`
}

function summarizeAnswerQuality(result: RagAnswerQualityResult): string {
  const metrics = Object.entries(result.metrics)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${formatMetric(value)}`)
    .join(', ')
  return `${result.passed ? 'passed' : 'failed'}${metrics ? `; ${metrics}` : ''}`
}

function formatMetric(value: number): string {
  return Number.isFinite(value) ? value.toFixed(3) : String(value)
}

function phaseEnabled(
  options: RunRagKnowledgeImprovementLoopOptions,
  phase: RagKnowledgeImprovementPhase,
): boolean {
  return !options.enabledPhases || options.enabledPhases.includes(phase)
}

function assertConfiguredRequiredPhases(options: RunRagKnowledgeImprovementLoopOptions): void {
  for (const phase of options.requiredPhases ?? []) {
    if (!phaseEnabled(options, phase)) {
      throw new Error(`required phase ${phase} is not enabled`)
    }
    if (!phaseConfigured(options, phase)) {
      throw new Error(requiredPhaseMessage(phase))
    }
  }
}

function phaseConfigured(
  options: RunRagKnowledgeImprovementLoopOptions,
  phase: RagKnowledgeImprovementPhase,
): boolean {
  switch (phase) {
    case 'rag-optimization':
      return Boolean(options.optimization)
    case 'retrieval-tuning':
      return Boolean(options.retrieval)
    case 'gap-diagnosis':
      return Boolean(options.diagnose)
    case 'knowledge-acquisition':
      return Boolean(options.acquireKnowledge)
    case 'knowledge-update':
      return Boolean(options.updateKnowledge ?? options.knowledgeResearch)
    case 'answer-quality':
      return Boolean(options.evaluateAnswers)
    case 'promotion':
      return Boolean(options.promote)
  }
}

function requiredPhaseMessage(phase: RagKnowledgeImprovementPhase): string {
  switch (phase) {
    case 'rag-optimization':
      return 'required phase rag-optimization requires optimization options'
    case 'retrieval-tuning':
      return 'required phase retrieval-tuning requires retrieval options'
    case 'gap-diagnosis':
      return 'required phase gap-diagnosis requires a diagnose hook'
    case 'knowledge-acquisition':
      return 'required phase knowledge-acquisition requires an acquireKnowledge hook'
    case 'knowledge-update':
      return 'required phase knowledge-update requires updateKnowledge or knowledgeResearch'
    case 'answer-quality':
      return 'required phase answer-quality requires an evaluateAnswers hook'
    case 'promotion':
      return 'required phase promotion requires a promote hook'
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error('RAG knowledge improvement loop aborted')
  }
}
