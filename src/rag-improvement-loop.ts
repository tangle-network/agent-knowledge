import type { ComparisonCost } from '@tangle-network/agent-eval/campaign'
import type { AgentCandidateJsonValue as JsonValue } from '@tangle-network/agent-interface'
import { assertRagAnswerEvidence, ragAnswerEvidenceRejectionReasons } from './rag-answer-evidence'
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

export type RagOptimizationSelection = Pick<
  RunRagOptimizationResult,
  'methodName' | 'baseline' | 'winner' | 'baselineConfig' | 'winnerConfig'
>

export type RetrievalOptimizationSelection = Pick<
  RunRetrievalImprovementLoopResult,
  'methodName' | 'baseline' | 'winner' | 'baselineConfig' | 'winnerConfig'
>

export interface RagPhaseInputBase {
  goal: string
  phases: readonly RagKnowledgeImprovementPhaseResult[]
  /** Selected candidate only. Adaptive update callbacks run before final scoring starts. */
  optimization?: RagOptimizationSelection
  signal?: AbortSignal
}

export interface RagDiagnosisInput extends RagPhaseInputBase {
  retrieval?: RetrievalOptimizationSelection
}

export interface RagKnowledgeAcquisitionInput extends RagPhaseInputBase {
  retrieval?: RetrievalOptimizationSelection
  findings: readonly RagGapFinding[]
}

export interface RagKnowledgeUpdateInput extends RagPhaseInputBase {
  retrieval?: RetrievalOptimizationSelection
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
  retrieval?: RetrievalOptimizationSelection
  findings: readonly RagGapFinding[]
  acquisition?: KnowledgeResearchLoopDecision
  knowledgeUpdate?: RagKnowledgeUpdateResult
}

export interface RagAnswerQualityResult {
  passed: boolean
  metrics: Record<string, number>
  finalScenarioIds: readonly string[]
  datasetRef: string
  evaluatorRef: string
  cost: ComparisonCost
  findings?: readonly RagGapFinding[]
  metadata?: Record<string, JsonValue>
}

export interface RagPromotionInput extends RagPhaseInputBase {
  retrieval?: RetrievalOptimizationSelection
  /** Full final-case result available only to the terminal promotion decision. */
  optimizationComparison?: RunRagOptimizationResult['comparison']
  /** Full final-case result available only to the terminal promotion decision. */
  retrievalComparison?: RunRetrievalImprovementLoopResult['comparison']
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
  /** Maximum total answer-evaluation spend accepted for promotion. */
  answerQualityCostCeiling?: number
  /**
   * Makes a side-effect-free promotion decision after the library has rejected
   * missing, regressing, unaccounted, or over-budget final evidence.
   */
  decidePromotion?: (input: RagPromotionInput) => MaybePromise<RagPromotionResult>
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
  assertOptionalCostCeiling(options.answerQualityCostCeiling, 'answerQualityCostCeiling')
  const now = options.now ?? (() => new Date())
  const phases: RagKnowledgeImprovementPhaseResult[] = []
  let optimization: RunRagOptimizationResult | undefined
  let retrieval: RunRetrievalImprovementLoopResult | undefined
  let findings: RagGapFinding[] = []
  let acquisition: KnowledgeResearchLoopDecision | undefined
  let knowledgeUpdate: RagKnowledgeUpdateResult | undefined
  let answerQuality: RagAnswerQualityResult | undefined
  let promotion: RagPromotionResult | undefined

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
              optimization: selectRagOptimization(optimization),
              signal: options.signal,
              retrieval: selectRetrievalOptimization(retrieval),
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
            optimization: selectRagOptimization(optimization),
            signal: options.signal,
            retrieval: selectRetrievalOptimization(retrieval),
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
            optimization: selectRagOptimization(optimization),
            signal: options.signal,
            retrieval: selectRetrievalOptimization(retrieval),
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

  if (phaseEnabled(options, 'answer-quality')) {
    if (options.evaluateAnswers) {
      answerQuality = await runPhase(
        phases,
        now,
        'answer-quality',
        async () => {
          assertNotAborted(options.signal)
          const result = await options.evaluateAnswers!({
            goal: options.goal,
            phases,
            optimization: selectRagOptimization(optimization),
            signal: options.signal,
            retrieval: selectRetrievalOptimization(retrieval),
            findings,
            acquisition,
            knowledgeUpdate,
          })
          assertRagAnswerEvidence(result)
          return result
        },
        summarizeAnswerQuality,
      )
      findings = [...findings, ...(answerQuality.findings ?? [])]
    } else {
      skipPhase(phases, now, 'answer-quality', 'no answer-quality hook provided')
    }
  }

  if (phaseEnabled(options, 'promotion')) {
    if (options.decidePromotion) {
      promotion = await runPhase(
        phases,
        now,
        'promotion',
        async () => {
          assertNotAborted(options.signal)
          const evidenceRejection = rejectUnsafePromotionEvidence({
            optimization: optimization?.comparison,
            optimizationCostCeiling: options.optimization?.costCeiling,
            retrieval: retrieval?.comparison,
            retrievalCostCeiling: options.retrieval?.costCeiling,
            answerQuality,
            answerQualityCostCeiling: options.answerQualityCostCeiling,
          })
          if (evidenceRejection) return evidenceRejection
          return options.decidePromotion!({
            goal: options.goal,
            phases,
            optimization: selectRagOptimization(optimization),
            optimizationComparison: optimization?.comparison,
            signal: options.signal,
            retrieval: selectRetrievalOptimization(retrieval),
            retrievalComparison: retrieval?.comparison,
            findings,
            acquisition,
            knowledgeUpdate,
            answerQuality,
          })
        },
        (result) => `${result.promoted ? 'promoted' : 'held'}: ${result.reason}`,
      )
    } else {
      skipPhase(phases, now, 'promotion', 'no promotion decision hook provided')
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

function rejectUnsafePromotionEvidence(evidence: {
  optimization?: RunRagOptimizationResult['comparison']
  optimizationCostCeiling?: number
  retrieval?: RunRetrievalImprovementLoopResult['comparison']
  retrievalCostCeiling?: number
  answerQuality?: RagAnswerQualityResult
  answerQualityCostCeiling?: number
}): RagPromotionResult | undefined {
  const reasons: string[] = []
  if (!evidence.optimization && !evidence.retrieval && !evidence.answerQuality) {
    reasons.push('promotion requires final RAG, retrieval, or answer-quality evidence')
  }
  for (const [label, comparison, costCeiling] of [
    ['RAG', evidence.optimization, evidence.optimizationCostCeiling],
    ['retrieval', evidence.retrieval, evidence.retrievalCostCeiling],
  ] as const) {
    if (!comparison) continue
    if (!comparison.totalCost.accountingComplete) {
      reasons.push(`${label} final comparison has incomplete cost accounting`)
    }
    const optimizerSource = comparison.best.provenance?.source
    if (optimizerSource && optimizerSource.evidence !== 'observed') {
      reasons.push(`${label} optimizer package identity was not observed`)
    }
    if (comparison.best.liftCi.low < 0) {
      reasons.push(`${label} final comparison does not rule out a regression`)
    }
    if (
      costCeiling !== undefined &&
      exceedsCostCeiling(comparison.totalCost.totalCostUsd, costCeiling)
    ) {
      reasons.push(
        `${label} final comparison cost ${comparison.totalCost.totalCostUsd} exceeds ${costCeiling}`,
      )
    }
  }
  if (evidence.answerQuality) {
    reasons.push(
      ...ragAnswerEvidenceRejectionReasons(
        evidence.answerQuality,
        evidence.answerQualityCostCeiling,
      ),
    )
  }
  if (reasons.length === 0) return undefined
  return {
    promoted: false,
    reason: reasons.join('; '),
  }
}

function assertOptionalCostCeiling(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`${label} must be a non-negative finite number`)
  }
}

function exceedsCostCeiling(totalCostUsd: number, costCeiling: number): boolean {
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(totalCostUsd), Math.abs(costCeiling)) * 8
  return totalCostUsd - costCeiling > tolerance
}

function summarizeRagOptimization(result: RunRagOptimizationResult): string {
  return `${result.methodName}; winner=${result.winner.surfaceHash}`
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
  return `${result.methodName}; winner=${result.winner.surfaceHash}`
}

function selectRagOptimization(
  result: RunRagOptimizationResult | undefined,
): RagOptimizationSelection | undefined {
  if (!result) return undefined
  return {
    methodName: result.methodName,
    baseline: structuredClone(result.baseline),
    winner: structuredClone(result.winner),
    baselineConfig: structuredClone(result.baselineConfig),
    winnerConfig: structuredClone(result.winnerConfig),
  }
}

function selectRetrievalOptimization(
  result: RunRetrievalImprovementLoopResult | undefined,
): RetrievalOptimizationSelection | undefined {
  if (!result) return undefined
  return {
    methodName: result.methodName,
    baseline: structuredClone(result.baseline),
    winner: structuredClone(result.winner),
    baselineConfig: structuredClone(result.baselineConfig),
    winnerConfig: structuredClone(result.winnerConfig),
  }
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
      return Boolean(options.decidePromotion)
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
      return 'required phase promotion requires a decidePromotion hook'
  }
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error('RAG knowledge improvement loop aborted')
  }
}
