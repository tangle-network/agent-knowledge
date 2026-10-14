import { assertRagAnswerEvidence, ragAnswerEvidenceRejectionReasons } from './rag-answer-evidence'
import type {
  RagAnswerQualityResult,
  RagKnowledgeImprovementPhase,
  RagKnowledgeImprovementPhaseResult,
  RagKnowledgeUpdateResult,
  RagOptimizationSelection,
  RagPromotionResult,
  RunRagKnowledgeImprovementLoopOptions,
  RunRagKnowledgeImprovementLoopResult,
} from './rag-improvement-loop'
import { type RunRagOptimizationResult, runRagOptimization } from './rag-optimization'
import {
  type KnowledgeResearchLoopDecision,
  type RunKnowledgeResearchLoopOptions,
  runKnowledgeResearchLoop,
} from './research-loop'
import {
  type RunRetrievalImprovementLoopResult,
  runRetrievalImprovementLoop,
} from './retrieval-optimization'

type MaybePromise<T> = T | Promise<T>

export async function runRagKnowledgeImprovementPhases(
  options: RunRagKnowledgeImprovementLoopOptions,
  previous?: RunRagKnowledgeImprovementLoopResult,
): Promise<RunRagKnowledgeImprovementLoopResult> {
  assertConfiguredRequiredPhases(options)
  assertOptionalCostCeiling(options.answerQualityCostCeiling, 'answerQualityCostCeiling')
  const now = options.now ?? (() => new Date())
  const phases: RagKnowledgeImprovementPhaseResult[] = [...(previous?.phases ?? [])]
  let optimization = previous?.optimization
  let retrieval = previous?.retrieval
  let findings = [...(previous?.findings ?? [])]
  let acquisition = previous?.acquisition
  let knowledgeUpdate = previous?.knowledgeUpdate
  let answerQuality = previous?.answerQuality
  let promotion = previous?.promotion

  const context = () => ({
    goal: options.goal,
    phases,
    optimization: selectOptimization(optimization),
    signal: options.signal,
    retrieval: selectOptimization(retrieval),
  })
  // One executor owns phase enablement, cancellation, timing, and status records.
  // Actions and their inputs remain lazy: later phases see the preceding results.
  async function runPhase<T>(
    phase: RagKnowledgeImprovementPhase,
    previousValue: T | undefined,
    action: (() => MaybePromise<T>) | undefined,
    summarize: (result: T) => string,
    missing: string,
  ): Promise<T | undefined> {
    if (!phaseEnabled(options, phase)) return previousValue
    const startedAt = now().toISOString()
    if (!action) {
      phases.push({ phase, status: 'skipped', summary: missing, startedAt, finishedAt: startedAt })
      return previousValue
    }
    try {
      assertNotAborted(options.signal)
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

  findings = [
    ...(await runPhase(
      'gap-diagnosis',
      findings,
      options.diagnose && (() => options.diagnose!(context())),
      (diagnosed) => `${diagnosed.length} finding(s)`,
      'no diagnosis hook provided',
    ))!,
  ]
  acquisition = await runPhase(
    'knowledge-acquisition',
    acquisition,
    options.acquireKnowledge && (() => options.acquireKnowledge!({ ...context(), findings })),
    summarizeAcquisitionDecision,
    'no acquisition hook provided',
  )
  knowledgeUpdate = await runPhase(
    'knowledge-update',
    knowledgeUpdate,
    options.updateKnowledge
      ? () => options.updateKnowledge!({ ...context(), findings, acquisition })
      : options.knowledgeResearch
        ? () => runKnowledgeResearchUpdate(options, acquisition)
        : undefined,
    (result) => result.summary,
    'no update hook or research loop provided',
  )

  if (
    options.optimization ||
    options.enabledPhases?.includes('rag-optimization') ||
    options.requiredPhases?.includes('rag-optimization')
  ) {
    optimization = await runPhase(
      'rag-optimization',
      optimization,
      options.optimization && (() => runRagOptimization(options.optimization!)),
      summarizeOptimization,
      'no full RAG optimization options provided',
    )
  }
  retrieval = await runPhase(
    'retrieval-tuning',
    retrieval,
    options.retrieval && (() => runRetrievalImprovementLoop(options.retrieval!)),
    summarizeOptimization,
    'no retrieval options provided',
  )
  const runsAnswerQuality =
    phaseEnabled(options, 'answer-quality') && Boolean(options.evaluateAnswers)
  answerQuality = await runPhase(
    'answer-quality',
    answerQuality,
    options.evaluateAnswers &&
      (async () => {
        const result = await options.evaluateAnswers!({
          ...context(),
          findings,
          acquisition,
          knowledgeUpdate,
        })
        assertRagAnswerEvidence(result)
        return result
      }),
    summarizeAnswerQuality,
    'no answer-quality hook provided',
  )
  if (runsAnswerQuality) {
    findings = [...findings, ...(answerQuality!.findings ?? [])]
  }
  promotion = await runPhase(
    'promotion',
    promotion,
    options.decidePromotion &&
      (() => {
        const evidenceRejection = rejectUnsafePromotionEvidence({
          optimization: optimization?.comparison,
          optimizationCostCeiling: options.optimization?.costCeiling,
          retrieval: retrieval?.comparison,
          retrievalCostCeiling: options.retrieval?.costCeiling,
          answerQuality,
          answerQualityCostCeiling: options.answerQualityCostCeiling,
        })
        return (
          evidenceRejection ??
          options.decidePromotion!({
            ...context(),
            optimizationComparison: optimization?.comparison,
            retrievalComparison: retrieval?.comparison,
            findings,
            acquisition,
            knowledgeUpdate,
            answerQuality,
          })
        )
      }),
    (result) => `${result.promoted ? 'promoted' : 'held'}: ${result.reason}`,
    'no promotion decision hook provided',
  )

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
    if (!comparison.best.decision.promote) {
      reasons.push(
        comparison.best.decision.low < 0
          ? `${label} final comparison does not rule out a regression`
          : `${label} final comparison does not establish the required improvement`,
      )
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

function summarizeOptimization(
  result: RunRagOptimizationResult | RunRetrievalImprovementLoopResult,
): string {
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

function selectOptimization(
  result: RunRagOptimizationResult | RunRetrievalImprovementLoopResult | undefined,
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
