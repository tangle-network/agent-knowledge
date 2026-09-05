import { join } from 'node:path'
import { contentHash } from '@tangle-network/agent-eval'
import { writeJsonDurableWithinRoot } from '../durable-fs'
import type { EvalKnowledgeBundleBuildResult, KnowledgeReadinessSpec } from '../eval-readiness'
import { knowledgeFileTransactionPlanHash } from '../file-transaction'
import { sha256 } from '../ids'
import { assertImmutableRef } from '../immutable-ref'
import { buildKnowledgeIndex } from '../indexer'
import { ragAnswerEvidenceRejectionReasons } from '../rag-answer-evidence'
import { type KnowledgeBaseQualityReport, scoreKnowledgeBaseIndex } from '../rag-eval'
import {
  type RagKnowledgeImprovementPhase,
  type RagKnowledgeResearchOptions,
  type RunRagKnowledgeImprovementLoopOptions,
  type RunRagKnowledgeImprovementLoopResult,
  runRagKnowledgeImprovementLoop,
} from '../rag-improvement-loop'
import { readinessFor } from '../readiness-helpers'
import { mean } from '../statistics'
import { type ValidateKnowledgeResult, validateKnowledgeIndex } from '../validate'
import type {
  KnowledgeImprovementCandidateRecord,
  KnowledgeImprovementMetric,
  KnowledgeImprovementOptions,
  KnowledgeImprovementRunState,
} from './contracts'
import {
  EVALUATION_PHASES,
  improvementMetricSchema,
  KB_IMPROVEMENT_PAGES_DIRECTORY,
  KnowledgeImprovementEvidenceSchema,
  UPDATE_PHASES,
} from './contracts'
import {
  appendLedger,
  candidateEvidenceRelativePath,
  saveState,
  withCandidateWorkspace,
} from './state'
import { knowledgeFilePlanEntries } from './transition'
import {
  assertCandidateEvidence,
  candidateRefFor,
  clearCandidateMeasurement,
  hashKnowledgeBase,
  withBaselineSnapshot,
  withFrozenCandidateWorkspace,
} from './workspace'

export function assertKnowledgeImprovementOptions(options: KnowledgeImprovementOptions): void {
  assertImmutableRef(options.implementationRef, 'knowledge improvement implementationRef')
  if (
    options.answerQualityCostCeiling !== undefined &&
    (!Number.isFinite(options.answerQualityCostCeiling) || options.answerQualityCostCeiling < 0)
  ) {
    throw new Error(
      'knowledge improvement answerQualityCostCeiling must be a non-negative finite number',
    )
  }
  if (options.ragOptimization) {
    assertImmutableRef(
      options.ragOptimization.executionRef,
      'knowledge improvement RAG executionRef',
    )
  }
  if (options.retrieval) {
    assertImmutableRef(
      options.retrieval.executionRef,
      'knowledge improvement retrieval executionRef',
    )
  }
  if (options.step && options.knowledgeResearch?.step) {
    throw new Error('improveKnowledgeBase accepts either step or knowledgeResearch.step, not both')
  }
  const updateDrivers = [
    Boolean(options.step ?? options.knowledgeResearch),
    Boolean(options.updateKnowledge),
  ].filter(Boolean).length
  if (updateDrivers > 1) {
    throw new Error(
      'improveKnowledgeBase accepts only one knowledge-update driver: knowledgeResearch or updateKnowledge',
    )
  }
}

export async function measureCandidate(
  runId: string,
  runDir: string,
  state: KnowledgeImprovementRunState,
  candidate: KnowledgeImprovementCandidateRecord,
  options: KnowledgeImprovementOptions,
  now: () => Date,
): Promise<{
  candidate: KnowledgeImprovementCandidateRecord
  evaluation: KnowledgeImprovementMetric
  lifecycle?: RunRagKnowledgeImprovementLoopResult
  finalEvaluated: boolean
}> {
  return withCandidateWorkspace(runDir, candidate, async (candidateRoot) => {
    const currentCandidateHash = await hashKnowledgeBase(candidateRoot)
    if (
      candidate.status === 'candidate-ready' &&
      candidate.candidateHash === currentCandidateHash &&
      candidate.evidenceHash !== undefined &&
      candidate.promotionPlanHash !== undefined
    ) {
      const evidence = await assertCandidateEvidence(
        runDir,
        candidateRefFor(runId, state, candidate),
        state.implementationRef,
      )
      return {
        candidate,
        evaluation: evidence.evaluation,
        ...(evidence.lifecycle === null
          ? {}
          : { lifecycle: evidence.lifecycle as RunRagKnowledgeImprovementLoopResult }),
        finalEvaluated: shouldRunEvaluationStage(options),
      }
    }

    clearCandidateMeasurement(candidate)
    const lifecycles: RunRagKnowledgeImprovementLoopResult[] = []
    if (candidate.status === 'running') {
      const updateLifecycle = await runCandidateUpdateLifecycle(
        runId,
        candidate,
        candidateRoot,
        options,
        now,
      )
      if (updateLifecycle) lifecycles.push(updateLifecycle)
    }
    return withFrozenCandidateWorkspace(runDir, candidate, candidateRoot, async (snapshot) => {
      let lifecycle = mergeLifecycleResults(options.goal, lifecycles)
      const development = await evaluateCandidate(
        runDir,
        state,
        candidate,
        snapshot,
        lifecycle,
        options,
        now,
        false,
      )
      if (!development.evaluation.passed || !shouldRunEvaluationStage(options)) {
        return {
          ...development,
          ...(lifecycle ? { lifecycle } : {}),
          finalEvaluated: false,
        }
      }

      candidate.finalEvaluationStartedAt = now().toISOString()
      candidate.updatedAt = candidate.finalEvaluationStartedAt
      state.updatedAt = candidate.finalEvaluationStartedAt
      await saveState(runDir, state, options.onState)
      await appendLedger(runDir, {
        type: 'candidate.final-evaluation-started',
        runId: state.runId,
        candidateId: candidate.candidateId,
      })
      const evaluationLifecycle = await runCandidateEvaluationLifecycle(
        runId,
        runDir,
        candidate,
        snapshot.root,
        snapshot.hash,
        options,
        now,
      )
      if (evaluationLifecycle) lifecycles.push(evaluationLifecycle)
      lifecycle = mergeLifecycleResults(options.goal, lifecycles)
      const measured = await evaluateCandidate(
        runDir,
        state,
        candidate,
        snapshot,
        lifecycle,
        options,
        now,
        true,
      )
      return {
        ...measured,
        ...(lifecycle ? { lifecycle } : {}),
        finalEvaluated: true,
      }
    })
  })
}

async function runCandidateUpdateLifecycle(
  runId: string,
  candidate: KnowledgeImprovementCandidateRecord,
  candidateRoot: string,
  options: KnowledgeImprovementOptions,
  now: () => Date,
): Promise<RunRagKnowledgeImprovementLoopResult | undefined> {
  if (!shouldRunUpdateStage(options)) return undefined
  const lifecycle = await runRagKnowledgeImprovementLoop({
    goal: options.goal,
    acquireKnowledge: options.acquireKnowledge,
    knowledgeResearch: candidateKnowledgeResearchOptions(candidateRoot, options),
    updateKnowledge: candidateUpdateHook(runId, candidate, candidateRoot, options),
    enabledPhases: selectedStagePhases(options, UPDATE_PHASES),
    requiredPhases: selectedStageRequiredPhases(options, UPDATE_PHASES),
    signal: options.signal,
    now,
  })
  return lifecycle
}

async function runCandidateEvaluationLifecycle(
  runId: string,
  runDir: string,
  candidate: KnowledgeImprovementCandidateRecord,
  candidateRoot: string,
  candidateHash: string,
  options: KnowledgeImprovementOptions,
  now: () => Date,
): Promise<RunRagKnowledgeImprovementLoopResult | undefined> {
  if (!shouldRunEvaluationStage(options)) return undefined
  const candidateIndex = await buildKnowledgeIndex(candidateRoot)
  return withBaselineSnapshot(runDir, candidate.baseHash, (baselineRoot) =>
    runRagKnowledgeImprovementLoop({
      goal: options.goal,
      optimization: options.ragOptimization
        ? {
            ...options.ragOptimization,
            executionRef: candidateExecutionRef(
              options.ragOptimization.executionRef,
              candidateHash,
            ),
            runDir:
              options.ragOptimization.runDir ??
              join(runDir, 'rag-optimization', candidate.candidateId),
            run: (input) =>
              options.ragOptimization!.run({
                ...input,
                runId,
                iteration: candidate.iteration,
                candidateId: candidate.candidateId,
                root: candidateRoot,
                baselineRoot,
                candidateRoot,
                candidateIndex,
                baseHash: candidate.baseHash,
              }),
          }
        : undefined,
      retrieval: options.retrieval
        ? {
            ...options.retrieval,
            executionRef: candidateExecutionRef(options.retrieval.executionRef, candidateHash),
            index: candidateIndex,
            runDir: options.retrieval.runDir ?? join(runDir, 'retrieval', candidate.candidateId),
          }
        : undefined,
      diagnose: options.diagnose,
      evaluateAnswers: options.evaluateAnswers,
      answerQualityCostCeiling: options.answerQualityCostCeiling,
      decidePromotion: options.decidePromotion,
      enabledPhases: selectedStagePhases(options, EVALUATION_PHASES),
      requiredPhases: selectedStageRequiredPhases(options, EVALUATION_PHASES),
      signal: options.signal,
      now,
    }),
  )
}

function candidateExecutionRef(executionRef: string, candidateHash: string): string {
  return `sha256:${sha256(`${executionRef}\n${candidateHash}`)}`
}

function candidateKnowledgeResearchOptions(
  candidateRoot: string,
  options: KnowledgeImprovementOptions,
): RagKnowledgeResearchOptions | undefined {
  if (!options.step && !options.knowledgeResearch) return undefined
  const { step: researchStep, ...rest } = options.knowledgeResearch ?? {}
  const step = options.step ?? researchStep
  return {
    ...rest,
    root: candidateRoot,
    step,
    maxIterations:
      rest.maxIterations ?? (step ? (options.candidateResearchIterations ?? 3) : undefined),
    strict: rest.strict ?? options.strict,
    readinessSpecs: rest.readinessSpecs ?? options.readinessSpecs,
    readinessTaskId: rest.readinessTaskId ?? options.readinessTaskId,
    readiness: rest.readiness ?? options.readiness,
  }
}

function candidateUpdateHook(
  runId: string,
  candidate: KnowledgeImprovementCandidateRecord,
  candidateRoot: string,
  options: KnowledgeImprovementOptions,
): RunRagKnowledgeImprovementLoopOptions['updateKnowledge'] {
  if (!options.updateKnowledge) return undefined
  return (input) =>
    options.updateKnowledge!({
      ...input,
      runId,
      iteration: candidate.iteration,
      candidateId: candidate.candidateId,
      root: candidateRoot,
      baselineRoot: options.root,
      candidateRoot,
      baseHash: candidate.baseHash,
    })
}

function shouldRunUpdateStage(options: KnowledgeImprovementOptions): boolean {
  const phases = selectedStagePhases(options, UPDATE_PHASES)
  if (phases.length === 0) return false
  return Boolean(
    options.acquireKnowledge ||
      options.step ||
      options.knowledgeResearch ||
      options.updateKnowledge ||
      selectedStageRequiredPhases(options, UPDATE_PHASES).length > 0,
  )
}

function shouldRunEvaluationStage(options: KnowledgeImprovementOptions): boolean {
  const phases = selectedStagePhases(options, EVALUATION_PHASES)
  if (phases.length === 0) return false
  return Boolean(
    options.ragOptimization ||
      options.retrieval ||
      options.diagnose ||
      options.evaluateAnswers ||
      options.decidePromotion ||
      options.evaluate ||
      selectedStageRequiredPhases(options, EVALUATION_PHASES).length > 0,
  )
}

function selectedStagePhases(
  options: Pick<KnowledgeImprovementOptions, 'enabledPhases'>,
  stagePhases: readonly RagKnowledgeImprovementPhase[],
): RagKnowledgeImprovementPhase[] {
  const requested = options.enabledPhases ?? stagePhases
  return requested.filter((phase) => stagePhases.includes(phase))
}

function selectedStageRequiredPhases(
  options: Pick<KnowledgeImprovementOptions, 'requiredPhases'>,
  stagePhases: readonly RagKnowledgeImprovementPhase[],
): RagKnowledgeImprovementPhase[] {
  return (options.requiredPhases ?? []).filter((phase) => stagePhases.includes(phase))
}

function mergeLifecycleResults(
  goal: string,
  lifecycles: readonly RunRagKnowledgeImprovementLoopResult[],
): RunRagKnowledgeImprovementLoopResult | undefined {
  if (lifecycles.length === 0) return undefined
  return {
    goal,
    phases: lifecycles.flatMap((lifecycle) => lifecycle.phases),
    optimization: lastDefined(lifecycles.map((lifecycle) => lifecycle.optimization)),
    retrieval: lastDefined(lifecycles.map((lifecycle) => lifecycle.retrieval)),
    findings: lifecycles.flatMap((lifecycle) => lifecycle.findings),
    acquisition: lastDefined(lifecycles.map((lifecycle) => lifecycle.acquisition)),
    knowledgeUpdate: lastDefined(lifecycles.map((lifecycle) => lifecycle.knowledgeUpdate)),
    answerQuality: lastDefined(lifecycles.map((lifecycle) => lifecycle.answerQuality)),
    promotion: lastDefined(lifecycles.map((lifecycle) => lifecycle.promotion)),
  }
}

function lastDefined<T>(values: readonly (T | undefined)[]): T | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    if (values[index] !== undefined) return values[index]
  }
  return undefined
}

async function evaluateCandidate(
  runDir: string,
  state: KnowledgeImprovementRunState,
  candidate: KnowledgeImprovementCandidateRecord,
  snapshot: { root: string; hash: string },
  lifecycle: RunRagKnowledgeImprovementLoopResult | undefined,
  options: KnowledgeImprovementOptions,
  now: () => Date,
  useConfiguredEvaluator: boolean,
): Promise<{
  candidate: KnowledgeImprovementCandidateRecord
  evaluation: KnowledgeImprovementMetric
}> {
  return withBaselineSnapshot(runDir, state.baseHash, async (baselineRoot) => {
    const [baselineIndex, candidateIndex] = await Promise.all([
      buildKnowledgeIndex(baselineRoot),
      buildKnowledgeIndex(snapshot.root),
    ])
    const validation = validateKnowledgeIndex(candidateIndex, { strict: options.strict })
    const readiness = readinessFor(options, candidateIndex)
    const kbQuality = scoreKnowledgeBaseIndex(candidateIndex, {
      strict: options.strict,
      ...options.kbQuality,
    })
    const candidateHash = snapshot.hash
    const evaluator = useConfiguredEvaluator ? options.evaluate : options.evaluateDevelopment
    const configuredMetric = evaluator
      ? evaluator({
          runId: state.runId,
          iteration: candidate.iteration,
          root: options.root,
          baselineRoot,
          candidateRoot: snapshot.root,
          baselineIndex,
          candidateIndex,
          baseHash: state.baseHash,
          candidateHash,
          validation,
          readiness,
          kbQuality,
          lifecycle,
          signal: options.signal,
        })
      : undefined
    const metric =
      configuredMetric ??
      defaultKnowledgeImprovementMetric(
        validation,
        readiness,
        options.readinessSpecs,
        kbQuality,
        lifecycle,
      )
    const evaluation = applyLifecycleFailures(
      normalizeMetric(await metric),
      lifecycle,
      options.answerQualityCostCeiling,
    )
    const measuredHash = await hashKnowledgeBase(snapshot.root)
    if (measuredHash !== candidateHash) {
      throw new Error(
        `knowledge candidate changed during evaluation: expected ${candidateHash}, got ${measuredHash}`,
      )
    }
    candidate.candidateHash = candidateHash
    candidate.promotionPlanHash = knowledgeFileTransactionPlanHash(
      await knowledgeFilePlanEntries(baselineRoot, snapshot.root),
      KB_IMPROVEMENT_PAGES_DIRECTORY,
    )
    const evidence = KnowledgeImprovementEvidenceSchema.parse(
      JSON.parse(
        JSON.stringify({
          kind: 'knowledge-improvement-evidence',
          runId: state.runId,
          candidateId: candidate.candidateId,
          iteration: candidate.iteration,
          goalHash: sha256(state.goal),
          implementationRef: state.implementationRef,
          baseHash: candidate.baseHash,
          candidateHash,
          promotionPlanHash: candidate.promotionPlanHash,
          validation,
          readiness: readiness ?? null,
          kbQuality,
          evaluation,
          lifecycle: lifecycle ?? null,
        }),
      ),
    )
    candidate.evidenceHash = contentHash(evidence)
    candidate.updatedAt = now().toISOString()
    await writeJsonDurableWithinRoot(
      runDir,
      candidateEvidenceRelativePath(candidate.candidateId),
      evidence,
    )
    await appendLedger(runDir, {
      type: 'candidate.evaluated',
      runId: state.runId,
      candidateId: candidate.candidateId,
      score: evaluation.score,
      passed: evaluation.passed,
    })
    return { candidate, evaluation }
  })
}

function defaultKnowledgeImprovementMetric(
  validation: ValidateKnowledgeResult,
  readiness: EvalKnowledgeBundleBuildResult | undefined,
  readinessSpecs: readonly KnowledgeReadinessSpec[] | undefined,
  kbQuality: KnowledgeBaseQualityReport,
  lifecycle: RunRagKnowledgeImprovementLoopResult | undefined,
): KnowledgeImprovementMetric {
  const blockingMissing = readiness?.report.blockingMissingRequirements.length ?? 0
  const blockingTotal = readinessSpecs?.filter((spec) => spec.importance === 'blocking').length ?? 0
  const blockingReadiness =
    blockingTotal === 0 ? 1 : Math.max(0, blockingTotal - blockingMissing) / blockingTotal
  const answerQuality = lifecycle?.answerQuality
    ? mean(Object.values(lifecycle.answerQuality.metrics))
    : 1
  const promotionDecision = lifecycle?.promotion ? (lifecycle.promotion.promoted ? 1 : 0) : 1
  const dimensions = {
    validation: validation.ok ? 1 : 0,
    kb_quality: kbQuality.ok ? 1 : 0,
    blocking_readiness: blockingReadiness,
    answer_quality: answerQuality,
    promotion_decision: promotionDecision,
  }
  const failedReasons = [
    validation.ok ? undefined : 'candidate validation failed',
    kbQuality.ok ? undefined : 'candidate KB quality check failed',
    blockingMissing === 0
      ? undefined
      : `${blockingMissing}/${blockingTotal} blocking knowledge requirements still missing`,
  ].filter((reason): reason is string => Boolean(reason))
  return {
    score: mean(Object.values(dimensions)),
    passed: failedReasons.length === 0,
    dimensions,
    notes:
      failedReasons.length === 0 ? 'candidate passed configured checks' : failedReasons.join('; '),
    provenance: {
      evaluator: '@tangle-network/agent-knowledge/default-knowledge-improvement-metric',
      version: '1',
      method: 'deterministic',
    },
  }
}

function applyLifecycleFailures(
  metric: KnowledgeImprovementMetric,
  lifecycle: RunRagKnowledgeImprovementLoopResult | undefined,
  answerQualityCostCeiling: number | undefined,
): KnowledgeImprovementMetric {
  const answerQualityFailures = lifecycle?.answerQuality
    ? ragAnswerEvidenceRejectionReasons(lifecycle.answerQuality, answerQualityCostCeiling)
    : []
  const reasons = [
    metric.notes,
    ...answerQualityFailures,
    lifecycle?.promotion && !lifecycle.promotion.promoted
      ? `promotion decision held: ${lifecycle.promotion.reason}`
      : undefined,
  ].filter((reason): reason is string => Boolean(reason))
  const forcedFailure =
    answerQualityFailures.length > 0 ||
    Boolean(lifecycle?.promotion && !lifecycle.promotion.promoted)
  return {
    ...metric,
    passed: metric.passed && !forcedFailure,
    notes: reasons.length > 0 ? reasons.join('; ') : metric.notes,
  }
}

function normalizeMetric(metric: KnowledgeImprovementMetric): KnowledgeImprovementMetric {
  return improvementMetricSchema.parse(metric)
}
