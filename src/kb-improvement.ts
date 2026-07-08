import { cp, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import type {
  BuildEvalKnowledgeBundleOptions,
  EvalKnowledgeBundleBuildResult,
  KnowledgeReadinessSpec,
} from './eval-readiness'
import { sha256, stableId } from './ids'
import { buildKnowledgeIndex, writeKnowledgeIndex } from './indexer'
import {
  type KnowledgeBaseQualityOptions,
  type KnowledgeBaseQualityReport,
  scoreKnowledgeBaseIndex,
} from './rag-eval'
import {
  type RagAnswerQualityResult,
  type RagKnowledgeImprovementPhase,
  type RagKnowledgeImprovementPhaseResult,
  type RagKnowledgeResearchOptions,
  type RagKnowledgeUpdateInput,
  type RagKnowledgeUpdateResult,
  type RagPromotionResult,
  type RunRagKnowledgeImprovementLoopOptions,
  type RunRagKnowledgeImprovementLoopResult,
  runRagKnowledgeImprovementLoop,
} from './rag-improvement-loop'
import { readinessFor } from './readiness-helpers'
import type { RunKnowledgeResearchLoopOptions } from './research-loop'
import type { RetrievalConfig, RunRetrievalImprovementLoopOptions } from './retrieval-eval'
import { initKnowledgeBase, layoutFor } from './store'
import type { KnowledgeIndex } from './types'
import {
  type ValidateKnowledgeOptions,
  type ValidateKnowledgeResult,
  validateKnowledgeIndex,
} from './validate'

export type KnowledgeImprovementStatus =
  | 'running'
  | 'candidate-ready'
  | 'promoted'
  | 'rejected'
  | 'blocked'

export interface KnowledgeImprovementMetric {
  score: number
  passed: boolean
  dimensions?: Record<string, number>
  notes?: string
}

export interface KnowledgeImprovementEvaluationInput {
  runId: string
  iteration: number
  root: string
  baselineRoot: string
  candidateRoot: string
  baselineIndex: KnowledgeIndex
  candidateIndex: KnowledgeIndex
  baseHash: string
  candidateHash: string
  validation: ValidateKnowledgeResult
  readiness?: EvalKnowledgeBundleBuildResult
  kbQuality: KnowledgeBaseQualityReport
  lifecycle?: RunRagKnowledgeImprovementLoopResult
  signal?: AbortSignal
}

export type KnowledgeImprovementEvaluator = (
  input: KnowledgeImprovementEvaluationInput,
) => Promise<KnowledgeImprovementMetric> | KnowledgeImprovementMetric

export interface KnowledgeImprovementLifecycleRecord {
  stage: 'candidate-update' | 'candidate-evaluation'
  phases: readonly RagKnowledgeImprovementPhaseResult[]
  findingCount: number
  retrievalWinnerConfig?: RetrievalConfig
  answerQuality?: RagAnswerQualityResult
  promotionDecision?: RagPromotionResult
}

export interface KnowledgeImprovementCandidateRecord {
  iteration: number
  candidateId: string
  candidateRoot: string
  baseHash: string
  candidateHash?: string
  status: KnowledgeImprovementStatus
  createdAt: string
  updatedAt: string
  validation?: ValidateKnowledgeResult
  kbQuality?: KnowledgeBaseQualityReport
  readinessBlockingMissing?: number
  evaluation?: KnowledgeImprovementMetric
  lifecycle?: readonly KnowledgeImprovementLifecycleRecord[]
  retrievalWinnerConfig?: RetrievalConfig
  answerQuality?: RagAnswerQualityResult
  promotionDecision?: RagPromotionResult
  notes?: string
}

export interface KnowledgeImprovementRunState {
  version: 1
  runId: string
  root: string
  goal: string
  status: KnowledgeImprovementStatus
  baseHash: string
  createdAt: string
  updatedAt: string
  ownerId?: string
  candidates: KnowledgeImprovementCandidateRecord[]
  promotedCandidateId?: string
  blockedReason?: string
}

export interface KnowledgeImprovementResult {
  runId: string
  runDir: string
  state: KnowledgeImprovementRunState
  candidate?: KnowledgeImprovementCandidateRecord
  lifecycle?: RunRagKnowledgeImprovementLoopResult
  promoted: boolean
  blocked: boolean
}

export interface KnowledgeImprovementRetrievalOptions
  extends Omit<RunRetrievalImprovementLoopOptions, 'index' | 'runDir'> {
  runDir?: RunRetrievalImprovementLoopOptions['runDir']
}

export interface KnowledgeImprovementUpdateInput extends RagKnowledgeUpdateInput {
  runId: string
  iteration: number
  candidateId: string
  root: string
  baselineRoot: string
  candidateRoot: string
  baseHash: string
}

export type KnowledgeImprovementUpdate = (
  input: KnowledgeImprovementUpdateInput,
) => Promise<RagKnowledgeUpdateResult> | RagKnowledgeUpdateResult

export interface KnowledgeImprovementOptions {
  root: string
  goal: string
  runId?: string
  runDir?: string
  ownerId?: string
  leaseTtlMs?: number
  resume?: boolean
  promote?: boolean
  maxCandidates?: number
  candidateResearchIterations?: number
  strict?: ValidateKnowledgeOptions['strict']
  readinessSpecs?: KnowledgeReadinessSpec[]
  readinessTaskId?: string
  readiness?: Omit<BuildEvalKnowledgeBundleOptions, 'taskId' | 'index' | 'specs'>
  kbQuality?: KnowledgeBaseQualityOptions
  step?: RunKnowledgeResearchLoopOptions['step']
  knowledgeResearch?: Omit<RagKnowledgeResearchOptions, 'root'>
  retrieval?: KnowledgeImprovementRetrievalOptions
  diagnose?: NonNullable<RunRagKnowledgeImprovementLoopOptions['diagnose']>
  acquireKnowledge?: NonNullable<RunRagKnowledgeImprovementLoopOptions['acquireKnowledge']>
  updateKnowledge?: KnowledgeImprovementUpdate
  evaluateAnswers?: NonNullable<RunRagKnowledgeImprovementLoopOptions['evaluateAnswers']>
  decidePromotion?: NonNullable<RunRagKnowledgeImprovementLoopOptions['promote']>
  enabledPhases?: readonly RagKnowledgeImprovementPhase[]
  requiredPhases?: readonly RagKnowledgeImprovementPhase[]
  evaluate?: KnowledgeImprovementEvaluator
  signal?: AbortSignal
  now?: () => Date
  onState?: (state: KnowledgeImprovementRunState) => Promise<void> | void
}

interface LeaseHandle {
  ownerId: string
  path: string
  release(): Promise<void>
}

interface LeaseFile {
  ownerId: string
  acquiredAt: string
  expiresAt: string
  pid: number
}

const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000
const UPDATE_PHASES: readonly RagKnowledgeImprovementPhase[] = [
  'knowledge-acquisition',
  'knowledge-update',
]
const EVALUATION_PHASES: readonly RagKnowledgeImprovementPhase[] = [
  'retrieval-tuning',
  'gap-diagnosis',
  'answer-quality',
  'promotion',
]

export function knowledgeImprovementRunId(root: string, goal: string): string {
  return stableId('kimpr', `${root}:${goal}`)
}

export function knowledgeImprovementRunDir(root: string, runId: string): string {
  return join(layoutFor(root).cacheDir, 'improvements', runId)
}

export async function loadKnowledgeImprovementState(
  root: string,
  runId: string,
  runDir = knowledgeImprovementRunDir(root, runId),
): Promise<KnowledgeImprovementRunState | null> {
  try {
    return JSON.parse(await readFile(statePath(runDir), 'utf8')) as KnowledgeImprovementRunState
  } catch {
    return null
  }
}

export async function improveKnowledgeBase(
  options: KnowledgeImprovementOptions,
): Promise<KnowledgeImprovementResult> {
  assertKnowledgeImprovementOptions(options)

  const now = options.now ?? (() => new Date())
  const runId = options.runId ?? knowledgeImprovementRunId(options.root, options.goal)
  const runDir = options.runDir ?? knowledgeImprovementRunDir(options.root, runId)
  await initKnowledgeBase(options.root)
  await mkdir(runDir, { recursive: true })

  const lease = await acquireRunLease(runDir, {
    ownerId: options.ownerId ?? `pid-${process.pid}`,
    ttlMs: options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
    now,
  })

  try {
    let state =
      options.resume === false
        ? null
        : await loadKnowledgeImprovementState(options.root, runId, runDir)
    if (!state) {
      const baseHash = await hashKnowledgeBase(options.root)
      state = {
        version: 1,
        runId,
        root: options.root,
        goal: options.goal,
        status: 'running',
        baseHash,
        createdAt: now().toISOString(),
        updatedAt: now().toISOString(),
        ownerId: lease.ownerId,
        candidates: [],
      }
      await saveState(runDir, state, options.onState)
      await appendLedger(runDir, { type: 'run.created', runId, baseHash })
    }

    if (state.status === 'promoted') {
      return { runId, runDir, state, promoted: true, blocked: false }
    }
    if (state.status === 'blocked') {
      return { runId, runDir, state, promoted: false, blocked: true }
    }

    const maxCandidates = Math.max(1, options.maxCandidates ?? 1)
    let candidate = findActiveCandidate(state)
    let lifecycle: RunRagKnowledgeImprovementLoopResult | undefined

    while (
      candidate?.status === 'running' ||
      (!candidate && state.candidates.length < maxCandidates)
    ) {
      if (!candidate) {
        const currentHash = await hashKnowledgeBase(options.root)
        if (currentHash !== state.baseHash) {
          state = await blockRun(
            runDir,
            state,
            `base changed before candidate creation: expected ${state.baseHash}, got ${currentHash}`,
            options.onState,
            now,
          )
          return { runId, runDir, state, promoted: false, blocked: true }
        }
        candidate = await createCandidateWorkspace(runDir, state, options.root, now)
        state.candidates.push(candidate)
        state.status = 'running'
        state.updatedAt = now().toISOString()
        await saveState(runDir, state, options.onState)
        await appendLedger(runDir, {
          type: 'candidate.created',
          runId,
          candidateId: candidate.candidateId,
          iteration: candidate.iteration,
        })
      }

      lifecycle = await runCandidateLifecycle(runDir, runId, candidate, options, now)
      candidate.status = 'candidate-ready'
      candidate.updatedAt = now().toISOString()
      state.status = 'candidate-ready'
      state.updatedAt = now().toISOString()
      await saveState(runDir, state, options.onState)
      await appendLedger(runDir, {
        type: 'candidate.ready',
        runId,
        candidateId: candidate.candidateId,
      })
    }

    if (!candidate) {
      state.status = 'rejected'
      state.updatedAt = now().toISOString()
      await saveState(runDir, state, options.onState)
      return { runId, runDir, state, promoted: false, blocked: false }
    }

    candidate = await evaluateCandidate(runDir, state, candidate, lifecycle, options, now)
    state.updatedAt = now().toISOString()
    await saveState(runDir, state, options.onState)

    if (!candidate.evaluation?.passed) {
      candidate.status = 'rejected'
      state.status = 'rejected'
      state.updatedAt = now().toISOString()
      await saveState(runDir, state, options.onState)
      await appendLedger(runDir, {
        type: 'candidate.rejected',
        runId,
        candidateId: candidate.candidateId,
      })
      return { runId, runDir, state, candidate, lifecycle, promoted: false, blocked: false }
    }

    if (options.promote === false) {
      state.status = 'candidate-ready'
      state.updatedAt = now().toISOString()
      await saveState(runDir, state, options.onState)
      return { runId, runDir, state, candidate, lifecycle, promoted: false, blocked: false }
    }

    const currentHash = await hashKnowledgeBase(options.root)
    if (currentHash !== state.baseHash) {
      state = await blockRun(
        runDir,
        state,
        `base changed before promotion: expected ${state.baseHash}, got ${currentHash}`,
        options.onState,
        now,
      )
      await appendLedger(runDir, {
        type: 'promotion.blocked',
        runId,
        candidateId: candidate.candidateId,
        reason: state.blockedReason,
      })
      return { runId, runDir, state, candidate, lifecycle, promoted: false, blocked: true }
    }

    await promoteCandidate(options.root, candidate.candidateRoot)
    candidate.status = 'promoted'
    candidate.updatedAt = now().toISOString()
    state.status = 'promoted'
    state.promotedCandidateId = candidate.candidateId
    state.updatedAt = now().toISOString()
    await saveState(runDir, state, options.onState)
    await appendLedger(runDir, {
      type: 'candidate.promoted',
      runId,
      candidateId: candidate.candidateId,
    })
    return { runId, runDir, state, candidate, lifecycle, promoted: true, blocked: false }
  } finally {
    await lease.release()
  }
}

function assertKnowledgeImprovementOptions(options: KnowledgeImprovementOptions): void {
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

async function runCandidateLifecycle(
  runDir: string,
  runId: string,
  candidate: KnowledgeImprovementCandidateRecord,
  options: KnowledgeImprovementOptions,
  now: () => Date,
): Promise<RunRagKnowledgeImprovementLoopResult | undefined> {
  const lifecycles: RunRagKnowledgeImprovementLoopResult[] = []

  if (shouldRunUpdateStage(options)) {
    const updateLifecycle = await runRagKnowledgeImprovementLoop({
      goal: options.goal,
      acquireKnowledge: options.acquireKnowledge,
      knowledgeResearch: candidateKnowledgeResearchOptions(candidate.candidateRoot, options),
      updateKnowledge: candidateUpdateHook(runId, candidate, options),
      enabledPhases: selectedStagePhases(options, UPDATE_PHASES),
      requiredPhases: selectedStageRequiredPhases(options, UPDATE_PHASES),
      signal: options.signal,
      now,
    })
    lifecycles.push(updateLifecycle)
    recordLifecycle(candidate, 'candidate-update', updateLifecycle)
  }

  if (shouldRunEvaluationStage(options)) {
    const candidateIndex = await buildKnowledgeIndex(candidate.candidateRoot)
    const evaluationLifecycle = await runRagKnowledgeImprovementLoop({
      goal: options.goal,
      retrieval: options.retrieval
        ? {
            ...options.retrieval,
            index: candidateIndex,
            runDir: options.retrieval.runDir ?? join(runDir, 'retrieval', candidate.candidateId),
          }
        : undefined,
      diagnose: options.diagnose,
      evaluateAnswers: options.evaluateAnswers,
      promote: options.decidePromotion,
      enabledPhases: selectedStagePhases(options, EVALUATION_PHASES),
      requiredPhases: selectedStageRequiredPhases(options, EVALUATION_PHASES),
      signal: options.signal,
      now,
    })
    lifecycles.push(evaluationLifecycle)
    recordLifecycle(candidate, 'candidate-evaluation', evaluationLifecycle)
  }

  return mergeLifecycleResults(options.goal, lifecycles)
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
  options: KnowledgeImprovementOptions,
): RunRagKnowledgeImprovementLoopOptions['updateKnowledge'] {
  if (!options.updateKnowledge) return undefined
  return (input) =>
    options.updateKnowledge!({
      ...input,
      runId,
      iteration: candidate.iteration,
      candidateId: candidate.candidateId,
      root: candidate.candidateRoot,
      baselineRoot: options.root,
      candidateRoot: candidate.candidateRoot,
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
    options.retrieval ||
      options.diagnose ||
      options.evaluateAnswers ||
      options.decidePromotion ||
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

function recordLifecycle(
  candidate: KnowledgeImprovementCandidateRecord,
  stage: KnowledgeImprovementLifecycleRecord['stage'],
  lifecycle: RunRagKnowledgeImprovementLoopResult,
): void {
  const record: KnowledgeImprovementLifecycleRecord = {
    stage,
    phases: lifecycle.phases,
    findingCount: lifecycle.findings.length,
    retrievalWinnerConfig: lifecycle.retrieval?.winnerConfig,
    answerQuality: lifecycle.answerQuality,
    promotionDecision: lifecycle.promotion,
  }
  candidate.lifecycle = [...(candidate.lifecycle ?? []), record]
  candidate.retrievalWinnerConfig =
    lifecycle.retrieval?.winnerConfig ?? candidate.retrievalWinnerConfig
  candidate.answerQuality = lifecycle.answerQuality ?? candidate.answerQuality
  candidate.promotionDecision = lifecycle.promotion ?? candidate.promotionDecision
}

function mergeLifecycleResults(
  goal: string,
  lifecycles: readonly RunRagKnowledgeImprovementLoopResult[],
): RunRagKnowledgeImprovementLoopResult | undefined {
  if (lifecycles.length === 0) return undefined
  return {
    goal,
    phases: lifecycles.flatMap((lifecycle) => lifecycle.phases),
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
  lifecycle: RunRagKnowledgeImprovementLoopResult | undefined,
  options: KnowledgeImprovementOptions,
  now: () => Date,
): Promise<KnowledgeImprovementCandidateRecord> {
  const [baselineIndex, candidateIndex] = await Promise.all([
    buildKnowledgeIndex(options.root),
    buildKnowledgeIndex(candidate.candidateRoot),
  ])
  const validation = validateKnowledgeIndex(candidateIndex, { strict: options.strict })
  const readiness = readinessFor(options, candidateIndex)
  const kbQuality = scoreKnowledgeBaseIndex(candidateIndex, {
    strict: options.strict,
    ...options.kbQuality,
  })
  const candidateHash = await hashKnowledgeBase(candidate.candidateRoot)
  const metric =
    options.evaluate?.({
      runId: state.runId,
      iteration: candidate.iteration,
      root: options.root,
      baselineRoot: options.root,
      candidateRoot: candidate.candidateRoot,
      baselineIndex,
      candidateIndex,
      baseHash: state.baseHash,
      candidateHash,
      validation,
      readiness,
      kbQuality,
      lifecycle,
      signal: options.signal,
    }) ??
    defaultKnowledgeImprovementMetric(
      validation,
      readiness,
      options.readinessSpecs,
      kbQuality,
      lifecycle,
    )
  candidate.validation = validation
  candidate.kbQuality = kbQuality
  candidate.readinessBlockingMissing = readiness?.report.blockingMissingRequirements.length
  candidate.evaluation = applyLifecycleFailures(normalizeMetric(await metric), lifecycle)
  candidate.candidateHash = candidateHash
  candidate.updatedAt = now().toISOString()
  await appendLedger(runDir, {
    type: 'candidate.evaluated',
    runId: state.runId,
    candidateId: candidate.candidateId,
    score: candidate.evaluation.score,
    passed: candidate.evaluation.passed,
  })
  return candidate
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
    ? average(Object.values(lifecycle.answerQuality.metrics).filter(Number.isFinite))
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
    lifecycle?.answerQuality && !lifecycle.answerQuality.passed
      ? 'answer quality failed'
      : undefined,
    lifecycle?.promotion && !lifecycle.promotion.promoted
      ? `promotion decision held: ${lifecycle.promotion.reason}`
      : undefined,
  ].filter((reason): reason is string => Boolean(reason))
  return {
    score: average(Object.values(dimensions)),
    passed: failedReasons.length === 0,
    dimensions,
    notes:
      failedReasons.length === 0 ? 'candidate passed configured checks' : failedReasons.join('; '),
  }
}

function applyLifecycleFailures(
  metric: KnowledgeImprovementMetric,
  lifecycle: RunRagKnowledgeImprovementLoopResult | undefined,
): KnowledgeImprovementMetric {
  const reasons = [
    metric.notes,
    lifecycle?.answerQuality && !lifecycle.answerQuality.passed
      ? 'answer quality failed'
      : undefined,
    lifecycle?.promotion && !lifecycle.promotion.promoted
      ? `promotion decision held: ${lifecycle.promotion.reason}`
      : undefined,
  ].filter((reason): reason is string => Boolean(reason))
  const forcedFailure =
    Boolean(lifecycle?.answerQuality && !lifecycle.answerQuality.passed) ||
    Boolean(lifecycle?.promotion && !lifecycle.promotion.promoted)
  return {
    ...metric,
    passed: metric.passed && !forcedFailure,
    notes: reasons.length > 0 ? reasons.join('; ') : metric.notes,
  }
}

function normalizeMetric(metric: KnowledgeImprovementMetric): KnowledgeImprovementMetric {
  if (!Number.isFinite(metric.score) || metric.score < 0 || metric.score > 1) {
    throw new Error(`knowledge improvement score must be in [0, 1], got ${String(metric.score)}`)
  }
  return { ...metric, passed: Boolean(metric.passed) }
}

async function createCandidateWorkspace(
  runDir: string,
  state: KnowledgeImprovementRunState,
  root: string,
  now: () => Date,
): Promise<KnowledgeImprovementCandidateRecord> {
  const iteration = state.candidates.length + 1
  const candidateId = stableId('kcand', `${state.runId}:${iteration}:${now().toISOString()}`)
  const candidateRoot = join(runDir, 'candidates', candidateId, 'workspace')
  await copyKnowledgeWorkspace(root, candidateRoot)
  const createdAt = now().toISOString()
  return {
    iteration,
    candidateId,
    candidateRoot,
    baseHash: state.baseHash,
    status: 'running',
    createdAt,
    updatedAt: createdAt,
  }
}

function findActiveCandidate(
  state: KnowledgeImprovementRunState,
): KnowledgeImprovementCandidateRecord | undefined {
  return [...state.candidates]
    .reverse()
    .find((candidate) => candidate.status === 'candidate-ready' || candidate.status === 'running')
}

async function copyKnowledgeWorkspace(sourceRoot: string, targetRoot: string): Promise<void> {
  await rm(targetRoot, { recursive: true, force: true })
  await initKnowledgeBase(targetRoot)
  await copyIfExists(join(sourceRoot, 'knowledge'), join(targetRoot, 'knowledge'))
  await copyIfExists(join(sourceRoot, 'raw'), join(targetRoot, 'raw'))
  await copyIfExists(
    join(layoutFor(sourceRoot).cacheDir, 'sources.json'),
    join(layoutFor(targetRoot).cacheDir, 'sources.json'),
  )
  await writeKnowledgeIndex(targetRoot)
}

async function promoteCandidate(root: string, candidateRoot: string): Promise<void> {
  await copyIfExists(join(candidateRoot, 'knowledge'), join(root, 'knowledge'), { replace: true })
  await copyIfExists(join(candidateRoot, 'raw'), join(root, 'raw'), { replace: true })
  await copyIfExists(
    join(layoutFor(candidateRoot).cacheDir, 'sources.json'),
    join(layoutFor(root).cacheDir, 'sources.json'),
    { replace: true },
  )
  await writeKnowledgeIndex(root)
}

async function copyIfExists(
  source: string,
  target: string,
  options: { replace?: boolean } = {},
): Promise<void> {
  try {
    await stat(source)
  } catch {
    return
  }
  if (options.replace) await rm(target, { recursive: true, force: true })
  await mkdir(dirname(target), { recursive: true })
  await cp(source, target, { recursive: true })
}

export async function hashKnowledgeBase(root: string): Promise<string> {
  const entries: Array<{ path: string; hash: string }> = []
  for (const rel of ['knowledge', 'raw']) {
    entries.push(...(await hashTreeEntries(root, rel)))
  }
  const sourceRegistry = relative(root, layoutFor(root).sourceRegistryPath).replace(/\\/g, '/')
  entries.push(...(await hashFileEntry(root, sourceRegistry)))
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return sha256(JSON.stringify(entries))
}

async function hashTreeEntries(
  root: string,
  relDir: string,
): Promise<Array<{ path: string; hash: string }>> {
  const abs = join(root, relDir)
  try {
    const s = await stat(abs)
    if (!s.isDirectory()) return []
  } catch {
    return []
  }
  const out: Array<{ path: string; hash: string }> = []
  const entries = await readdir(abs, { withFileTypes: true })
  for (const entry of entries) {
    const rel = join(relDir, entry.name).replace(/\\/g, '/')
    if (entry.isDirectory()) out.push(...(await hashTreeEntries(root, rel)))
    else if (entry.isFile()) out.push(...(await hashFileEntry(root, rel)))
  }
  return out
}

async function hashFileEntry(
  root: string,
  rel: string,
): Promise<Array<{ path: string; hash: string }>> {
  try {
    const bytes = await readFile(join(root, rel))
    return [{ path: rel, hash: sha256(bytes.toString('base64')) }]
  } catch {
    return []
  }
}

async function acquireRunLease(
  runDir: string,
  options: { ownerId: string; ttlMs: number; now: () => Date },
): Promise<LeaseHandle> {
  const path = join(runDir, 'run.lock')
  const now = options.now()
  const expiresAt = new Date(now.getTime() + options.ttlMs)
  const payload: LeaseFile = {
    ownerId: options.ownerId,
    acquiredAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    pid: process.pid,
  }
  try {
    const handle = await open(path, 'wx')
    try {
      await handle.writeFile(`${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    } finally {
      await handle.close()
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST') throw error
    const existing = await readLease(path)
    if (existing && new Date(existing.expiresAt).getTime() > now.getTime()) {
      throw new Error(
        `knowledge improvement run is locked by ${existing.ownerId} until ${existing.expiresAt}`,
      )
    }
    await rm(path, { force: true })
    return acquireRunLease(runDir, options)
  }
  return {
    ownerId: options.ownerId,
    path,
    async release() {
      const current = await readLease(path)
      if (!current || current.ownerId === options.ownerId) await rm(path, { force: true })
    },
  }
}

async function readLease(path: string): Promise<LeaseFile | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as LeaseFile
  } catch {
    return null
  }
}

async function blockRun(
  runDir: string,
  state: KnowledgeImprovementRunState,
  reason: string,
  onState: KnowledgeImprovementOptions['onState'],
  now: () => Date,
): Promise<KnowledgeImprovementRunState> {
  state.status = 'blocked'
  state.blockedReason = reason
  state.updatedAt = now().toISOString()
  await saveState(runDir, state, onState)
  return state
}

async function saveState(
  runDir: string,
  state: KnowledgeImprovementRunState,
  onState?: KnowledgeImprovementOptions['onState'],
): Promise<void> {
  await writeJsonAtomic(statePath(runDir), state)
  await onState?.(state)
}

async function appendLedger(runDir: string, value: Record<string, unknown>): Promise<void> {
  const row = { at: new Date().toISOString(), ...value }
  await mkdir(runDir, { recursive: true })
  await writeFile(join(runDir, 'events.jsonl'), `${JSON.stringify(row)}\n`, { flag: 'a' })
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

function statePath(runDir: string): string {
  return join(runDir, 'state.json')
}

function average(values: readonly number[]): number {
  const finite = values.filter(Number.isFinite)
  if (finite.length === 0) return 0
  return finite.reduce((sum, value) => sum + value, 0) / finite.length
}
