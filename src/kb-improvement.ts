import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  canonicalJson,
  contentHash,
  type RunRecord,
  validateRunRecord,
} from '@tangle-network/agent-eval'
import { z } from 'zod'
import {
  isMissingFile,
  listRegularFilesWithinRoot,
  readRegularFileWithinRoot,
  renameDurable,
  withSafeDirectory,
  writeJsonDurableWithinRoot,
} from './durable-fs'
import type {
  BuildEvalKnowledgeBundleOptions,
  EvalKnowledgeBundleBuildResult,
  KnowledgeReadinessSpec,
} from './eval-readiness'
import {
  applyKnowledgeFileTransaction,
  assertKnowledgeMutationPath,
  finishKnowledgeFileTransaction,
  type KnowledgeFileMutation,
  type KnowledgeFileTransaction,
  type KnowledgeFileTransactionPlanEntry,
  knowledgeFileTransactionPlanHash,
  prepareKnowledgeFileTransaction,
  rollbackKnowledgeFileTransaction,
} from './file-transaction'
import { sha256, slugify, stableId } from './ids'
import { buildKnowledgeIndex, writeKnowledgeIndex } from './indexer'
import { acquireDurableFileLock, withKnowledgeMutation, withKnowledgeRead } from './mutation-lock'
import {
  type KnowledgeBaseQualityOptions,
  type KnowledgeBaseQualityReport,
  scoreKnowledgeBaseIndex,
} from './rag-eval'
import {
  type RagKnowledgeImprovementPhase,
  type RagKnowledgeResearchOptions,
  type RagKnowledgeUpdateInput,
  type RagKnowledgeUpdateResult,
  type RunRagKnowledgeImprovementLoopOptions,
  type RunRagKnowledgeImprovementLoopResult,
  runRagKnowledgeImprovementLoop,
} from './rag-improvement-loop'
import { readinessFor } from './readiness-helpers'
import type { RunKnowledgeResearchLoopOptions } from './research-loop'
import type { RunRetrievalImprovementLoopOptions } from './retrieval-eval'
import { layoutFor } from './store'
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

interface KnowledgeImprovementMetricProvenanceBase {
  evaluator: string
  version: string
}

export type KnowledgeImprovementMetricProvenance =
  | (KnowledgeImprovementMetricProvenanceBase & {
      method: 'deterministic'
    })
  | (KnowledgeImprovementMetricProvenanceBase & {
      method: 'sampled' | 'composite'
      corpusHash: string
      runRecords: RunRecord[]
    })
  | (KnowledgeImprovementMetricProvenanceBase & {
      method: 'model'
      model: string
      corpusHash: string
      runRecords: RunRecord[]
    })

export interface KnowledgeImprovementMetric {
  score: number
  passed: boolean
  dimensions?: Record<string, number>
  notes?: string
  provenance: KnowledgeImprovementMetricProvenance
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

export interface KnowledgeImprovementCandidateRecord {
  iteration: number
  candidateId: string
  baseHash: string
  candidateHash?: string
  evidenceHash?: string
  promotionPlanHash?: string
  status: KnowledgeImprovementStatus
  createdAt: string
  updatedAt: string
}

export interface KnowledgeImprovementRunState {
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
  state: KnowledgeImprovementRunState
  candidate?: KnowledgeImprovementCandidateRecord
  evaluation?: KnowledgeImprovementMetric
  lifecycle?: RunRagKnowledgeImprovementLoopResult
  promoted: boolean
  blocked: boolean
}

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const runIdSchema = z.string().min(1).max(2_048)
const safePathSegmentSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
const improvementStatusSchema = z.enum([
  'running',
  'candidate-ready',
  'promoted',
  'rejected',
  'blocked',
])
const runRecordSchema = z.custom<RunRecord>((value) => {
  try {
    validateRunRecord(value)
    return true
  } catch {
    return false
  }
}, 'invalid agent-eval RunRecord')
const deterministicMetricProvenanceSchema = z
  .object({
    evaluator: z.string().min(1),
    version: z.string().min(1),
    method: z.literal('deterministic'),
  })
  .strict()
const measuredMetricProvenanceSchema = z
  .object({
    evaluator: z.string().min(1),
    version: z.string().min(1),
    method: z.enum(['sampled', 'composite']),
    corpusHash: digestSchema,
    runRecords: z.array(runRecordSchema).min(1),
  })
  .strict()
const modelMetricProvenanceSchema = z
  .object({
    evaluator: z.string().min(1),
    version: z.string().min(1),
    method: z.literal('model'),
    model: z.string().min(1),
    corpusHash: digestSchema,
    runRecords: z.array(runRecordSchema).min(1),
  })
  .strict()
const improvementMetricSchema = z
  .object({
    score: z.number().finite().min(0).max(1),
    passed: z.boolean(),
    dimensions: z.record(z.string(), z.number().finite()).optional(),
    notes: z.string().optional(),
    provenance: z.discriminatedUnion('method', [
      deterministicMetricProvenanceSchema,
      measuredMetricProvenanceSchema,
      modelMetricProvenanceSchema,
    ]),
  })
  .strict()
  .superRefine((metric, context) => {
    if (metric.provenance.method === 'deterministic') return
    const actualCorpusHash = contentHash(metric.provenance.runRecords)
    if (actualCorpusHash !== metric.provenance.corpusHash) {
      context.addIssue({
        code: 'custom',
        path: ['provenance', 'corpusHash'],
        message: 'metric corpus hash must bind the complete RunRecord array',
      })
    }
  })
const candidateRecordSchema = z
  .object({
    iteration: z.number().int().positive(),
    candidateId: safePathSegmentSchema,
    baseHash: digestSchema,
    candidateHash: digestSchema.optional(),
    evidenceHash: digestSchema.optional(),
    promotionPlanHash: digestSchema.optional(),
    status: improvementStatusSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()

export const KnowledgeImprovementRunStateSchema = z
  .object({
    runId: runIdSchema,
    root: z.string().min(1),
    goal: z.string().min(1),
    status: improvementStatusSchema,
    baseHash: digestSchema,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    ownerId: z.string().min(1).optional(),
    candidates: z.array(candidateRecordSchema),
    promotedCandidateId: safePathSegmentSchema.optional(),
    blockedReason: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((state, context) => {
    const candidateIds = new Set<string>()
    for (const [index, candidate] of state.candidates.entries()) {
      if (candidateIds.has(candidate.candidateId)) {
        context.addIssue({
          code: 'custom',
          path: ['candidates', index, 'candidateId'],
          message: 'candidate ids must be unique within an improvement run',
        })
      }
      candidateIds.add(candidate.candidateId)
      if (candidate.baseHash !== state.baseHash) {
        context.addIssue({
          code: 'custom',
          path: ['candidates', index, 'baseHash'],
          message: 'candidate base hash must match its improvement run',
        })
      }
      if (candidate.status === 'candidate-ready') {
        if (!candidate.candidateHash || !candidate.evidenceHash || !candidate.promotionPlanHash) {
          context.addIssue({
            code: 'custom',
            path: ['candidates', index],
            message: 'ready candidates require content, evidence, and promotion-plan identities',
          })
        }
      }
      if (
        candidate.status === 'promoted' &&
        (!candidate.candidateHash || !candidate.evidenceHash || !candidate.promotionPlanHash)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['candidates', index],
          message: 'promoted candidates require content, evidence, and promotion-plan identities',
        })
      }
      if (
        candidate.status === 'promoted' &&
        Boolean(candidate.evidenceHash) !== Boolean(candidate.promotionPlanHash)
      ) {
        context.addIssue({
          code: 'custom',
          path: ['candidates', index],
          message: 'promoted candidate evidence and promotion-plan identities must appear together',
        })
      }
      if (candidate.status === 'promoted' && state.status !== 'promoted') {
        context.addIssue({
          code: 'custom',
          path: ['candidates', index, 'status'],
          message: 'only a promoted run may contain a promoted candidate',
        })
      }
    }
    if (state.status === 'promoted') {
      const promoted = state.candidates.filter(
        (candidate) => candidate.candidateId === state.promotedCandidateId,
      )
      if (promoted.length !== 1 || promoted[0]?.status !== 'promoted') {
        context.addIssue({
          code: 'custom',
          path: ['promotedCandidateId'],
          message: 'promoted state must identify exactly one promoted candidate',
        })
      }
    } else if (state.promotedCandidateId !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['promotedCandidateId'],
        message: 'only a promoted run may identify a promoted candidate',
      })
    }
    if (
      state.status === 'candidate-ready' &&
      state.candidates.filter((candidate) => candidate.status === 'candidate-ready').length !== 1
    ) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'candidate-ready state must contain exactly one ready candidate',
      })
    }
    if (state.status === 'blocked' && state.blockedReason === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['blockedReason'],
        message: 'blocked state must include a reason',
      })
    }
  })

export const KnowledgeImprovementEvidenceSchema = z
  .object({
    kind: z.literal('knowledge-improvement-evidence'),
    runId: runIdSchema,
    candidateId: safePathSegmentSchema,
    iteration: z.number().int().positive(),
    goalHash: digestSchema,
    baseHash: digestSchema,
    candidateHash: digestSchema,
    promotionPlanHash: digestSchema,
    validation: z.unknown(),
    readiness: z.unknown().nullable(),
    kbQuality: z.unknown(),
    evaluation: improvementMetricSchema,
    lifecycle: z.unknown().nullable(),
  })
  .strict()

export type KnowledgeImprovementEvidence = z.infer<typeof KnowledgeImprovementEvidenceSchema>

/** Portable identity of one measured candidate. Paths and mutable run state are deliberately excluded. */
export const KnowledgeImprovementCandidateRefSchema = z
  .object({
    kind: z.literal('knowledge-improvement-candidate'),
    runId: runIdSchema,
    candidateId: safePathSegmentSchema,
    goalHash: digestSchema,
    baseHash: digestSchema,
    candidateHash: digestSchema,
    evidenceHash: digestSchema,
    promotionPlanHash: digestSchema,
  })
  .strict()

export type KnowledgeImprovementCandidateRef = z.infer<
  typeof KnowledgeImprovementCandidateRefSchema
>

export interface PromoteKnowledgeCandidateOptions {
  root: string
  candidate: KnowledgeImprovementCandidateRef
  ownerId?: string
  leaseTtlMs?: number
  now?: () => Date
  onState?: (state: KnowledgeImprovementRunState) => Promise<void> | void
}

export type RestoreKnowledgeCandidateBaselineOptions = PromoteKnowledgeCandidateOptions

export interface UseKnowledgeImprovementCandidateOptions {
  root: string
  candidate: KnowledgeImprovementCandidateRef
}

export interface ResolvedKnowledgeImprovementCandidate {
  root: string
  candidate: KnowledgeImprovementCandidateRef
  evaluation: KnowledgeImprovementMetric
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
  ownerId?: string
  leaseTtlMs?: number
  resume?: boolean
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
  assertOwned(): void
  release(): Promise<void>
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
  const parsedRunId = runIdSchema.parse(runId)
  const safeRunId = safePathSegmentSchema.safeParse(parsedRunId)
  const runSegment = safeRunId.success
    ? safeRunId.data
    : `${slugify(parsedRunId).slice(0, 72)}-${sha256(parsedRunId).slice(0, 16)}`
  const improvementsDir = join(layoutFor(root).cacheDir, 'improvements')
  const runDir = join(improvementsDir, runSegment)
  const resolvedImprovementsDir = resolve(improvementsDir)
  const resolvedRunDir = resolve(runDir)
  if (!resolvedRunDir.startsWith(`${resolvedImprovementsDir}${sep}`)) {
    throw new Error('knowledge improvement run directory escaped its root')
  }
  return runDir
}

async function withKnowledgeImprovementRun<T>(
  root: string,
  runId: string,
  create: boolean,
  use: (runDir: string) => Promise<T> | T,
): Promise<T> {
  const runDir = knowledgeImprovementRunDir(root, runId)
  const relativePath = descendantPath(root, runDir)
  if (!relativePath) throw new Error('knowledge improvement run directory escaped its root')
  return withSafeDirectory(root, relativePath, create, async (openedRunDir) => {
    const result = await use(openedRunDir)
    const openedIdentity = await stat(openedRunDir)
    const currentIdentity = await withSafeDirectory(root, relativePath, false, (currentRunDir) =>
      stat(currentRunDir),
    )
    if (openedIdentity.dev !== currentIdentity.dev || openedIdentity.ino !== currentIdentity.ino) {
      throw new Error('knowledge improvement run directory changed during use')
    }
    return result
  })
}

export async function loadKnowledgeImprovementState(
  root: string,
  runId: string,
): Promise<KnowledgeImprovementRunState | null> {
  const expectedRunId = runIdSchema.parse(runId)
  try {
    return await withKnowledgeImprovementRun(root, expectedRunId, false, (runDir) =>
      loadKnowledgeImprovementStateFromRun(root, expectedRunId, runDir),
    )
  } catch (error) {
    if (isMissingFile(error)) return null
    throw error
  }
}

async function loadKnowledgeImprovementStateFromRun(
  root: string,
  runId: string,
  runDir: string,
): Promise<KnowledgeImprovementRunState> {
  const stateFile = await readRegularFileWithinRoot(runDir, 'state.json')
  const raw = JSON.parse(stateFile.bytes.toString('utf8')) as unknown
  const state = KnowledgeImprovementRunStateSchema.parse(raw) as KnowledgeImprovementRunState
  if (state.runId !== runId) {
    throw new Error('knowledge improvement state does not match the requested run')
  }
  if (resolve(state.root) !== resolve(root)) {
    throw new Error('knowledge improvement state does not match the requested root')
  }
  for (const candidate of state.candidates) {
    if (candidate.status === 'running') await assertCandidateWorkspace(runDir, candidate)
  }
  return state
}

/** Freeze the exact knowledge bytes and measured evidence a later approval may promote. */
export function knowledgeImprovementCandidateRef(
  result: Pick<KnowledgeImprovementResult, 'runId' | 'state' | 'candidate'>,
): KnowledgeImprovementCandidateRef {
  if (!result.candidate) throw new Error('knowledge improvement result has no candidate')
  return candidateRefFor(result.runId, result.state, result.candidate)
}

/** Use one measured snapshot while its directory identity remains open and stable. */
export async function withKnowledgeImprovementCandidate<T>(
  options: UseKnowledgeImprovementCandidateOptions,
  use: (candidate: ResolvedKnowledgeImprovementCandidate) => Promise<T> | T,
): Promise<T> {
  assertExactCandidatePlatform()
  const candidateRef = KnowledgeImprovementCandidateRefSchema.parse(options.candidate)
  return withKnowledgeImprovementRun(options.root, candidateRef.runId, false, async (runDir) => {
    const state = await loadKnowledgeImprovementStateFromRun(
      options.root,
      candidateRef.runId,
      runDir,
    )
    return withMeasuredCandidateSnapshot(options.root, runDir, state, candidateRef, (resolved) =>
      withIsolatedCandidateCopy(resolved.root, candidateRef.candidateHash, (root) =>
        use({
          root,
          candidate: candidateRef,
          evaluation: resolved.evidence.evaluation,
        }),
      ),
    )
  })
}

/** Promote one previously measured candidate without rerunning research or evaluation. */
export async function promoteKnowledgeCandidate(
  options: PromoteKnowledgeCandidateOptions,
): Promise<KnowledgeImprovementResult> {
  return transitionKnowledgeCandidate(options, 'candidate')
}

/** Restore the frozen baseline paired with one previously measured candidate. */
export async function restoreKnowledgeCandidateBaseline(
  options: RestoreKnowledgeCandidateBaselineOptions,
): Promise<KnowledgeImprovementResult> {
  return transitionKnowledgeCandidate(options, 'baseline')
}

type KnowledgeCandidateTarget = 'candidate' | 'baseline'

async function transitionKnowledgeCandidate(
  options: PromoteKnowledgeCandidateOptions,
  target: KnowledgeCandidateTarget,
): Promise<KnowledgeImprovementResult> {
  assertExactCandidatePlatform()
  const candidateRef = Object.freeze(
    KnowledgeImprovementCandidateRefSchema.parse(options.candidate),
  )
  const now = options.now ?? (() => new Date())
  return withKnowledgeImprovementRun(options.root, candidateRef.runId, false, async (runDir) => {
    const lease = await acquireRunLease(runDir, {
      ownerId: options.ownerId ?? `pid-${process.pid}`,
      ttlMs: options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
    })
    try {
      lease.assertOwned()
      const state = await loadKnowledgeImprovementStateFromRun(
        options.root,
        candidateRef.runId,
        runDir,
      )
      return await applyKnowledgeCandidateTarget(
        {
          root: options.root,
          runDir,
          state,
          candidateRef,
          leaseTtlMs: options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
          assertRunOwned: lease.assertOwned,
          now,
          onState: options.onState,
        },
        target,
      )
    } finally {
      await lease.release()
    }
  })
}

export async function improveKnowledgeBase(
  options: KnowledgeImprovementOptions,
): Promise<KnowledgeImprovementResult> {
  assertExactCandidatePlatform()
  assertKnowledgeImprovementOptions(options)
  const now = options.now ?? (() => new Date())
  const runId = runIdSchema.parse(
    options.runId ?? knowledgeImprovementRunId(options.root, options.goal),
  )
  return withKnowledgeImprovementRun(options.root, runId, true, (runDir) =>
    improveKnowledgeBaseInRun(options, runId, runDir, now),
  )
}

async function improveKnowledgeBaseInRun(
  options: KnowledgeImprovementOptions,
  runId: string,
  runDir: string,
  now: () => Date,
): Promise<KnowledgeImprovementResult> {
  const lease = await acquireRunLease(runDir, {
    ownerId: options.ownerId ?? `pid-${process.pid}`,
    ttlMs: options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
  })

  try {
    lease.assertOwned()
    let state =
      options.resume === false
        ? null
        : await loadKnowledgeImprovementStateFromRun(options.root, runId, runDir).catch((error) => {
            if (isMissingFile(error)) return null
            throw error
          })
    if (!state) {
      const baseHash = await hashKnowledgeBase(options.root)
      await createBaselineSnapshot(runDir, options.root, baseHash)
      state = {
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
    if (state.goal !== options.goal) {
      throw new Error('knowledge improvement state does not match the requested goal')
    }
    const promotedCandidateId = state.promotedCandidateId
    const promotedCandidate =
      state.status === 'promoted'
        ? state.candidates.find((candidate) => candidate.candidateId === promotedCandidateId)
        : undefined
    if (state.status === 'promoted' && !promotedCandidate) {
      throw new Error('promoted knowledge state has no promoted candidate')
    }
    const resumablePromotion = state.candidates.find(
      (candidate) =>
        (candidate.status === 'candidate-ready' || candidate.status === 'promoted') &&
        candidate.evidenceHash !== undefined &&
        candidate.promotionPlanHash !== undefined,
    )
    const resumableCandidateRef = resumablePromotion
      ? candidateRefFor(runId, state, resumablePromotion)
      : undefined
    await withKnowledgeMutation(options.root, () => undefined, {
      resumeTransaction: resumableCandidateRef
        ? {
            purpose: knowledgeCandidateTransitionPurpose(resumableCandidateRef, 'candidate'),
            validate: (transaction) =>
              assertCandidateTransitionTransaction(transaction, resumableCandidateRef, 'candidate'),
          }
        : undefined,
    })
    await ensureBaselineSnapshot(runDir, options.root, state.baseHash)

    if (state.status === 'promoted') {
      const promoted = promotedCandidate!
      return await applyKnowledgeCandidateTarget(
        {
          root: options.root,
          runDir,
          state,
          candidateRef: candidateRefFor(runId, state, promoted),
          leaseTtlMs: options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
          assertRunOwned: lease.assertOwned,
          now,
          onState: options.onState,
        },
        'candidate',
      )
    }
    if (state.status === 'blocked') {
      return { runId, state, promoted: false, blocked: true }
    }

    const maxCandidates = Math.max(1, options.maxCandidates ?? 1)
    let candidate = findActiveCandidate(state)
    let lastRejectedCandidate: KnowledgeImprovementCandidateRecord | undefined
    let lastRejectedEvaluation: KnowledgeImprovementMetric | undefined
    let lifecycle: RunRagKnowledgeImprovementLoopResult | undefined

    while (candidate || state.candidates.length < maxCandidates) {
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
          return { runId, state, promoted: false, blocked: true }
        }
        const activeState = state
        candidate = await withBaselineSnapshot(runDir, activeState.baseHash, (baselineRoot) =>
          createCandidateWorkspace(runDir, activeState, baselineRoot, now),
        )
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

      const measured = await measureCandidate(runId, runDir, state, candidate, options, now)
      candidate = measured.candidate
      const evaluation = measured.evaluation
      lifecycle = measured.lifecycle

      if (evaluation.passed) {
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
        break
      }

      candidate.status = 'rejected'
      state.status = 'running'
      state.updatedAt = now().toISOString()
      await saveState(runDir, state, options.onState)
      await appendLedger(runDir, {
        type: 'candidate.rejected',
        runId,
        candidateId: candidate.candidateId,
      })
      lastRejectedCandidate = candidate
      lastRejectedEvaluation = evaluation
      candidate = undefined
    }

    if (!candidate) {
      state.status = 'rejected'
      state.updatedAt = now().toISOString()
      await saveState(runDir, state, options.onState)
      return {
        runId,
        state,
        candidate: lastRejectedCandidate,
        ...(lastRejectedEvaluation ? { evaluation: lastRejectedEvaluation } : {}),
        lifecycle,
        promoted: false,
        blocked: false,
      }
    }

    const evidence = await assertCandidateEvidence(runDir, candidateRefFor(runId, state, candidate))
    return {
      runId,
      state,
      candidate,
      evaluation: evidence.evaluation,
      lifecycle,
      promoted: false,
      blocked: false,
    }
  } finally {
    await lease.release()
  }
}

interface KnowledgeCandidateTransitionInput {
  root: string
  runDir: string
  state: KnowledgeImprovementRunState
  candidateRef: KnowledgeImprovementCandidateRef
  leaseTtlMs: number
  assertRunOwned(): void
  now: () => Date
  onState?: KnowledgeImprovementOptions['onState']
  lifecycle?: RunRagKnowledgeImprovementLoopResult
}

async function applyKnowledgeCandidateTarget(
  input: KnowledgeCandidateTransitionInput,
  target: KnowledgeCandidateTarget,
): Promise<KnowledgeImprovementResult> {
  const { candidateRef, runDir, state } = input
  assertStateIdentity(input.root, candidateRef, state)
  const candidate = state.candidates.find((entry) => entry.candidateId === candidateRef.candidateId)
  if (
    !candidate ||
    canonicalJson(candidateRefFor(candidateRef.runId, state, candidate)) !==
      canonicalJson(candidateRef)
  ) {
    throw new Error('knowledge candidate approval does not match the measured candidate')
  }

  const action = target === 'candidate' ? 'promotion' : 'restore'
  const desiredHash = target === 'candidate' ? candidateRef.candidateHash : candidateRef.baseHash
  const purpose = knowledgeCandidateTransitionPurpose(candidateRef, target)
  return withKnowledgeMutation(
    input.root,
    async (mutationLock) => {
      input.assertRunOwned()
      const transactionRoot = mutationLock.transactionRoot
      let pending: KnowledgeFileTransaction | null = null
      const currentHash = await hashKnowledgeBase(input.root)
      if (state.status === 'promoted' && state.promotedCandidateId !== candidate.candidateId) {
        throw new Error(
          `knowledge run already promoted '${state.promotedCandidateId ?? 'unknown'}'`,
        )
      }
      if (
        target === 'candidate' &&
        state.status === 'promoted' &&
        currentHash !== candidateRef.candidateHash
      ) {
        throw new Error(
          `promoted knowledge base changed: expected ${candidateRef.candidateHash}, got ${currentHash}`,
        )
      }
      if (state.status !== 'promoted' && state.status !== 'candidate-ready') {
        throw new Error(
          `knowledge candidate is not ready for ${action}: run=${state.status}, candidate=${candidate.status}`,
        )
      }
      if (currentHash !== state.baseHash && currentHash !== candidateRef.candidateHash) {
        const reason =
          target === 'candidate'
            ? `base changed before promotion: expected ${state.baseHash}, got ${currentHash}`
            : `knowledge changed before restore: expected ${candidateRef.candidateHash}, got ${currentHash}`
        return await blockCandidateTransition(input, candidate, target, reason)
      }

      if (currentHash !== desiredHash) {
        pending = await withMeasuredCandidateSnapshot(
          input.root,
          runDir,
          state,
          candidateRef,
          (resolved) =>
            withBaselineSnapshot(runDir, state.baseHash, async (baselineRoot) => {
              const sourceRoot = target === 'candidate' ? baselineRoot : resolved.root
              const targetRoot = target === 'candidate' ? resolved.root : baselineRoot
              const plan = await knowledgeFilePlanEntries(sourceRoot, targetRoot)
              assertCandidateTransitionPlan(plan, candidateRef, target)
              return prepareKnowledgeFileTransaction({
                root: input.root,
                transactionRoot,
                purpose,
                mutations: await knowledgePlanMutations(targetRoot, plan),
                includeUnchanged: true,
                now: input.now,
              })
            }),
        )
        if (!pending) {
          throw new Error(`knowledge ${action} plan unexpectedly contained no file changes`)
        }
        try {
          assertCandidateTransitionTransaction(pending, candidateRef, target)
        } catch (error) {
          try {
            await rollbackKnowledgeFileTransaction({
              root: input.root,
              transactionRoot,
              transaction: pending,
              beforeCommit() {
                mutationLock.assertOwned()
                input.assertRunOwned()
              },
            })
            await finishKnowledgeFileTransaction({
              root: input.root,
              transactionRoot,
              transaction: pending,
              assertOwned() {
                mutationLock.assertOwned()
                input.assertRunOwned()
              },
            })
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              `invalid knowledge ${action} transaction could not be removed`,
            )
          }
          throw error
        }
      }
      try {
        if (pending) {
          await applyKnowledgeFileTransaction({
            root: input.root,
            transactionRoot,
            transaction: pending,
            beforeCommit() {
              mutationLock.assertOwned()
              input.assertRunOwned()
            },
          })
        }
        mutationLock.assertOwned()
        input.assertRunOwned()
        if ((await hashKnowledgeBase(input.root)) !== desiredHash) {
          throw new Error(`knowledge ${action} content does not match the approved target`)
        }
        await writeKnowledgeIndex(input.root)
      } catch (error) {
        if (!pending) throw error
        try {
          mutationLock.assertOwned()
          input.assertRunOwned()
        } catch (ownershipError) {
          throw new AggregateError(
            [error, ownershipError],
            `knowledge ${action} lost its lock and left the transaction pending`,
          )
        }
        try {
          await rollbackKnowledgeFileTransaction({
            root: input.root,
            transactionRoot,
            transaction: pending,
            beforeCommit() {
              mutationLock.assertOwned()
              input.assertRunOwned()
            },
          })
          await finishKnowledgeFileTransaction({
            root: input.root,
            transactionRoot,
            transaction: pending,
            assertOwned() {
              mutationLock.assertOwned()
              input.assertRunOwned()
            },
          })
          await writeKnowledgeIndex(input.root)
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `knowledge ${action} failed and could not restore the previous files`,
          )
        }
        throw error
      }
      candidate.status = target === 'candidate' ? 'promoted' : 'candidate-ready'
      candidate.updatedAt = input.now().toISOString()
      state.status = candidate.status
      if (target === 'candidate') state.promotedCandidateId = candidate.candidateId
      else delete state.promotedCandidateId
      delete state.blockedReason
      state.updatedAt = input.now().toISOString()
      await saveState(runDir, state, input.onState)
      await ensureCandidateTransitionEvent(runDir, candidateRef, target)
      if (pending) {
        await finishKnowledgeFileTransaction({
          root: input.root,
          transactionRoot,
          transaction: pending,
          assertOwned() {
            mutationLock.assertOwned()
            input.assertRunOwned()
          },
        })
      }
      return candidateTransitionResult(input, candidate, target === 'candidate', false)
    },
    {
      staleMs: input.leaseTtlMs,
      resumeTransaction: {
        purpose,
        validate: (transaction) =>
          assertCandidateTransitionTransaction(transaction, candidateRef, target),
      },
    },
  )
}

async function blockCandidateTransition(
  input: KnowledgeCandidateTransitionInput,
  candidate: KnowledgeImprovementCandidateRecord,
  target: KnowledgeCandidateTarget,
  reason: string,
): Promise<KnowledgeImprovementResult> {
  if (input.state.status === 'promoted') {
    candidate.status = 'blocked'
    candidate.updatedAt = input.now().toISOString()
    delete input.state.promotedCandidateId
  }
  await blockRun(input.runDir, input.state, reason, input.onState, input.now)
  await appendLedger(input.runDir, {
    type: target === 'candidate' ? 'promotion.blocked' : 'restore.blocked',
    runId: input.candidateRef.runId,
    candidateId: candidate.candidateId,
    reason,
  })
  return candidateTransitionResult(input, candidate, false, true)
}

function candidateTransitionResult(
  input: KnowledgeCandidateTransitionInput,
  candidate: KnowledgeImprovementCandidateRecord,
  promoted: boolean,
  blocked: boolean,
): KnowledgeImprovementResult {
  return {
    runId: input.candidateRef.runId,
    state: input.state,
    candidate,
    ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}),
    promoted,
    blocked,
  }
}

function candidateRefFor(
  runId: string,
  state: KnowledgeImprovementRunState,
  candidate: KnowledgeImprovementCandidateRecord,
): KnowledgeImprovementCandidateRef {
  if (!candidate.candidateHash) {
    throw new Error(`knowledge candidate '${candidate.candidateId}' has no content hash`)
  }
  if (!candidate.evidenceHash) {
    throw new Error(`knowledge candidate '${candidate.candidateId}' has no evidence hash`)
  }
  if (!candidate.promotionPlanHash) {
    throw new Error(`knowledge candidate '${candidate.candidateId}' has no promotion plan hash`)
  }
  if (candidate.status !== 'candidate-ready' && candidate.status !== 'promoted') {
    throw new Error(`knowledge candidate '${candidate.candidateId}' is not ready`)
  }
  return Object.freeze({
    kind: 'knowledge-improvement-candidate',
    runId,
    candidateId: candidate.candidateId,
    goalHash: sha256(state.goal),
    baseHash: candidate.baseHash,
    candidateHash: candidate.candidateHash,
    evidenceHash: candidate.evidenceHash,
    promotionPlanHash: candidate.promotionPlanHash,
  })
}

async function withMeasuredCandidateSnapshot<T>(
  liveRoot: string,
  runDir: string,
  state: KnowledgeImprovementRunState,
  candidateRef: KnowledgeImprovementCandidateRef,
  use: (snapshot: {
    root: string
    candidate: KnowledgeImprovementCandidateRecord
    evidence: KnowledgeImprovementEvidence
  }) => Promise<T> | T,
): Promise<T> {
  assertStateIdentity(liveRoot, candidateRef, state)
  const candidate = state.candidates.find((entry) => entry.candidateId === candidateRef.candidateId)
  if (!candidate) {
    throw new Error(`knowledge candidate '${candidateRef.candidateId}' does not exist`)
  }
  const expectedRef = candidateRefFor(candidateRef.runId, state, candidate)
  if (canonicalJson(expectedRef) !== canonicalJson(candidateRef)) {
    throw new Error('knowledge candidate approval does not match the measured candidate')
  }
  const evidence = await assertCandidateEvidence(runDir, candidateRef)
  const relativePath = join(
    'candidates',
    candidate.candidateId,
    'snapshots',
    candidateRef.candidateHash,
  )
  return withSafeDirectory(runDir, relativePath, false, async (root) => {
    if ((await hashKnowledgeBase(root)) !== candidateRef.candidateHash) {
      throw new Error('knowledge candidate snapshot changed after approval')
    }
    const result = await use({ root, candidate, evidence })
    if ((await hashKnowledgeBase(root)) !== candidateRef.candidateHash) {
      throw new Error('knowledge candidate snapshot changed during use')
    }
    return result
  })
}

async function withIsolatedCandidateCopy<T>(
  sourceRoot: string,
  expectedHash: string,
  use: (root: string) => Promise<T> | T,
): Promise<T> {
  const isolationRoot = await mkdtemp(join(tmpdir(), 'agent-knowledge-candidate-'))
  const candidateRoot = join(isolationRoot, 'candidate')
  try {
    await copyKnowledgeWorkspace(sourceRoot, candidateRoot)
    if ((await hashKnowledgeBase(candidateRoot)) !== expectedHash) {
      throw new Error('isolated knowledge candidate does not match its approved content')
    }
    const result = await use(candidateRoot)
    if ((await hashKnowledgeBase(candidateRoot)) !== expectedHash) {
      throw new Error('knowledge candidate snapshot changed during use')
    }
    return result
  } finally {
    await rm(isolationRoot, { recursive: true, force: true })
  }
}

async function assertCandidateEvidence(
  runDir: string,
  candidate: KnowledgeImprovementCandidateRef,
): Promise<KnowledgeImprovementEvidence> {
  const evidence = KnowledgeImprovementEvidenceSchema.parse(
    JSON.parse(
      (
        await readRegularFileWithinRoot(
          runDir,
          candidateEvidenceRelativePath(candidate.candidateId),
        )
      ).bytes.toString('utf8'),
    ),
  )
  const actualHash = contentHash(evidence)
  if (actualHash !== candidate.evidenceHash) {
    throw new Error(
      `knowledge candidate evidence changed after approval: expected ${candidate.evidenceHash}, got ${actualHash}`,
    )
  }
  if (
    evidence.runId !== candidate.runId ||
    evidence.candidateId !== candidate.candidateId ||
    evidence.goalHash !== candidate.goalHash ||
    evidence.baseHash !== candidate.baseHash ||
    evidence.candidateHash !== candidate.candidateHash ||
    evidence.promotionPlanHash !== candidate.promotionPlanHash ||
    evidence.evaluation.passed !== true
  ) {
    throw new Error('knowledge candidate evidence does not match the approved candidate')
  }
  return evidence
}

function assertStateIdentity(
  root: string,
  candidateRef: KnowledgeImprovementCandidateRef,
  state: KnowledgeImprovementRunState,
): void {
  if (state.runId !== candidateRef.runId) {
    throw new Error('knowledge candidate run identity does not match persisted state')
  }
  if (resolve(state.root) !== resolve(root)) {
    throw new Error('knowledge candidate root does not match persisted state')
  }
  if (sha256(state.goal) !== candidateRef.goalHash) {
    throw new Error('knowledge candidate goal does not match persisted state')
  }
  if (state.baseHash !== candidateRef.baseHash) {
    throw new Error('knowledge candidate base does not match persisted state')
  }
}

async function assertCandidateWorkspace(
  runDir: string,
  candidate: Pick<KnowledgeImprovementCandidateRecord, 'candidateId'>,
): Promise<void> {
  await withCandidateWorkspace(runDir, candidate, () => undefined)
}

async function withCandidateWorkspace<T>(
  runDir: string,
  candidate: Pick<KnowledgeImprovementCandidateRecord, 'candidateId'>,
  use: (candidateRoot: string) => Promise<T> | T,
): Promise<T> {
  return withSafeDirectory(
    runDir,
    join('candidates', safePathSegmentSchema.parse(candidate.candidateId), 'workspace'),
    false,
    use,
  )
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

async function measureCandidate(
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
      )
      return { candidate, evaluation: evidence.evaluation }
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
      const evaluationLifecycle = await runCandidateEvaluationLifecycle(
        runDir,
        candidate,
        snapshot.root,
        options,
        now,
      )
      if (evaluationLifecycle) lifecycles.push(evaluationLifecycle)
      const lifecycle = mergeLifecycleResults(options.goal, lifecycles)
      const measured = await evaluateCandidate(
        runDir,
        state,
        candidate,
        snapshot,
        lifecycle,
        options,
        now,
      )
      return { ...measured, ...(lifecycle ? { lifecycle } : {}) }
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
  runDir: string,
  candidate: KnowledgeImprovementCandidateRecord,
  candidateRoot: string,
  options: KnowledgeImprovementOptions,
  now: () => Date,
): Promise<RunRagKnowledgeImprovementLoopResult | undefined> {
  if (!shouldRunEvaluationStage(options)) return undefined
  const candidateIndex = await buildKnowledgeIndex(candidateRoot)
  const lifecycle = await runRagKnowledgeImprovementLoop({
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
  return lifecycle
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
  snapshot: { root: string; hash: string },
  lifecycle: RunRagKnowledgeImprovementLoopResult | undefined,
  options: KnowledgeImprovementOptions,
  now: () => Date,
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
    const metric =
      options.evaluate?.({
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
      }) ??
      defaultKnowledgeImprovementMetric(
        validation,
        readiness,
        options.readinessSpecs,
        kbQuality,
        lifecycle,
      )
    const evaluation = applyLifecycleFailures(normalizeMetric(await metric), lifecycle)
    const measuredHash = await hashKnowledgeBase(snapshot.root)
    if (measuredHash !== candidateHash) {
      throw new Error(
        `knowledge candidate changed during evaluation: expected ${candidateHash}, got ${measuredHash}`,
      )
    }
    candidate.candidateHash = candidateHash
    candidate.promotionPlanHash = knowledgeFileTransactionPlanHash(
      await knowledgeFilePlanEntries(baselineRoot, snapshot.root),
    )
    const evidence = KnowledgeImprovementEvidenceSchema.parse(
      JSON.parse(
        JSON.stringify({
          kind: 'knowledge-improvement-evidence',
          runId: state.runId,
          candidateId: candidate.candidateId,
          iteration: candidate.iteration,
          goalHash: sha256(state.goal),
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
  ].filter((reason): reason is string => Boolean(reason))
  return {
    score: average(Object.values(dimensions)),
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
  return improvementMetricSchema.parse(metric)
}

async function createCandidateWorkspace(
  runDir: string,
  state: KnowledgeImprovementRunState,
  root: string,
  now: () => Date,
): Promise<KnowledgeImprovementCandidateRecord> {
  const iteration = state.candidates.length + 1
  const candidateId = stableId('kcand', `${state.runId}:${iteration}:${now().toISOString()}`)
  const candidateRoot = candidateWorkspacePath(runDir, candidateId)
  await copyKnowledgeWorkspace(root, candidateRoot)
  const createdAt = now().toISOString()
  return {
    iteration,
    candidateId,
    baseHash: state.baseHash,
    status: 'running',
    createdAt,
    updatedAt: createdAt,
  }
}

function candidateWorkspacePath(runDir: string, candidateId: string): string {
  return join(runDir, 'candidates', safePathSegmentSchema.parse(candidateId), 'workspace')
}

function baselineSnapshotPath(runDir: string): string {
  return join(runDir, 'baseline')
}

async function createBaselineSnapshot(
  runDir: string,
  root: string,
  expectedHash: string,
): Promise<void> {
  const target = baselineSnapshotPath(runDir)
  try {
    await assertBaselineSnapshot(runDir, expectedHash)
    return
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
  const preparation = await mkdtemp(join(runDir, 'baseline-prepare-'))
  let activated = false
  try {
    await copyKnowledgeWorkspace(root, preparation)
    const actualHash = await hashKnowledgeBase(preparation)
    if (actualHash !== expectedHash) {
      throw new Error(
        `knowledge base changed while baseline was frozen: expected ${expectedHash}, got ${actualHash}`,
      )
    }
    await renameDurable(preparation, target)
    activated = true
  } finally {
    if (!activated) await rm(preparation, { recursive: true, force: true })
  }
}

async function ensureBaselineSnapshot(
  runDir: string,
  root: string,
  expectedHash: string,
): Promise<void> {
  try {
    await assertBaselineSnapshot(runDir, expectedHash)
  } catch (error) {
    if (!isMissingFile(error)) throw error
    const liveHash = await hashKnowledgeBase(root)
    if (liveHash !== expectedHash) {
      throw new Error(
        'knowledge improvement baseline snapshot is missing and cannot be reconstructed',
      )
    }
    await createBaselineSnapshot(runDir, root, expectedHash)
  }
}

async function assertBaselineSnapshot(runDir: string, expectedHash: string): Promise<void> {
  await withBaselineSnapshot(runDir, expectedHash, () => undefined)
}

async function withBaselineSnapshot<T>(
  runDir: string,
  expectedHash: string,
  use: (baselineRoot: string) => Promise<T> | T,
): Promise<T> {
  return withSafeDirectory(runDir, 'baseline', false, async (baselineRoot) => {
    const actualHash = await hashKnowledgeBase(baselineRoot)
    if (actualHash !== expectedHash) {
      throw new Error(
        `knowledge improvement baseline changed: expected ${expectedHash}, got ${actualHash}`,
      )
    }
    return use(baselineRoot)
  })
}

async function withFrozenCandidateWorkspace<T>(
  runDir: string,
  candidate: KnowledgeImprovementCandidateRecord,
  candidateRoot: string,
  use: (snapshot: { root: string; hash: string }) => Promise<T> | T,
): Promise<T> {
  const snapshotsPath = join(
    'candidates',
    safePathSegmentSchema.parse(candidate.candidateId),
    'snapshots',
  )
  return withSafeDirectory(runDir, snapshotsPath, true, async (snapshotsDir) => {
    const preparation = await mkdtemp(join(snapshotsDir, 'prepare-'))
    let activated = false
    try {
      await copyKnowledgeWorkspace(candidateRoot, preparation)
      const hash = await hashKnowledgeBase(preparation)
      try {
        const result = await withSafeDirectory(snapshotsDir, hash, false, async (existing) => {
          if ((await hashKnowledgeBase(existing)) !== hash) {
            throw new Error('knowledge candidate snapshot does not match its content identity')
          }
          return use({ root: existing, hash })
        })
        await rm(preparation, { recursive: true, force: true })
        activated = true
        return result
      } catch (error) {
        if (!isMissingFile(error)) throw error
      }
      await renameDurable(preparation, join(snapshotsDir, hash))
      activated = true
      return withSafeDirectory(snapshotsDir, hash, false, (root) => use({ root, hash }))
    } finally {
      if (!activated) await rm(preparation, { recursive: true, force: true })
    }
  })
}

function clearCandidateMeasurement(candidate: KnowledgeImprovementCandidateRecord): void {
  delete candidate.candidateHash
  delete candidate.evidenceHash
  delete candidate.promotionPlanHash
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
  await mkdir(join(targetRoot, 'knowledge'), { recursive: true })
  await mkdir(join(targetRoot, 'raw', 'sources'), { recursive: true })
  await copyIfExists(join(sourceRoot, 'knowledge'), join(targetRoot, 'knowledge'))
  await copyIfExists(join(sourceRoot, 'raw'), join(targetRoot, 'raw'))
  await copyIfExists(
    join(layoutFor(sourceRoot).cacheDir, 'sources.json'),
    join(layoutFor(targetRoot).cacheDir, 'sources.json'),
  )
  await writeKnowledgeIndex(targetRoot)
}

function knowledgeCandidateTransitionPurpose(
  candidate: KnowledgeImprovementCandidateRef,
  target: KnowledgeCandidateTarget,
): string {
  const action = target === 'candidate' ? 'promotion' : 'restore'
  return `knowledge-${action}:${contentHash(candidate)}`
}

async function knowledgeFilePlanEntries(
  sourceRoot: string,
  targetRoot: string,
): Promise<KnowledgeFileTransactionPlanEntry[]> {
  const [before, after] = await Promise.all([
    knowledgeHashEntries(sourceRoot),
    knowledgeHashEntries(targetRoot),
  ])
  const beforeByPath = new Map(before.map((entry) => [entry.path, entry]))
  const afterByPath = new Map(after.map((entry) => [entry.path, entry]))
  const paths = [
    ...new Set([...before.map((entry) => entry.path), ...after.map((entry) => entry.path)]),
  ].sort((left, right) => left.localeCompare(right))
  return paths.map((path) => {
    assertKnowledgeMutationPath(path)
    const beforeEntry = beforeByPath.get(path)
    const afterEntry = afterByPath.get(path)
    return {
      path,
      beforeHash: beforeEntry?.transactionHash ?? null,
      afterHash: afterEntry?.transactionHash ?? null,
      ...(beforeEntry ? { beforeMode: beforeEntry.mode } : {}),
      ...(afterEntry ? { afterMode: afterEntry.mode } : {}),
    }
  })
}

async function knowledgePlanMutations(
  targetRoot: string,
  plan: readonly KnowledgeFileTransactionPlanEntry[],
): Promise<KnowledgeFileMutation[]> {
  return Promise.all(
    plan.map(async (entry) => {
      if (entry.afterHash === null) return { path: entry.path, content: null }
      const file = await readRegularFileWithinRoot(targetRoot, entry.path)
      const actualHash = createHash('sha256').update(file.bytes).digest('hex')
      if (actualHash !== entry.afterHash || file.mode !== entry.afterMode) {
        throw new Error(`knowledge target file changed before activation: ${entry.path}`)
      }
      return { path: entry.path, content: file.bytes, mode: file.mode }
    }),
  )
}

function assertCandidateTransitionPlan(
  plan: readonly KnowledgeFileTransactionPlanEntry[],
  candidate: KnowledgeImprovementCandidateRef,
  target: KnowledgeCandidateTarget,
): void {
  const approvedDirection = target === 'candidate' ? plan : reverseKnowledgeFilePlan(plan)
  const actualPlanHash = knowledgeFileTransactionPlanHash(approvedDirection)
  if (actualPlanHash !== candidate.promotionPlanHash) {
    throw new Error(
      `knowledge candidate plan changed after approval: expected ${candidate.promotionPlanHash}, got ${actualPlanHash}`,
    )
  }
}

function assertCandidateTransitionTransaction(
  transaction: KnowledgeFileTransaction,
  candidate: KnowledgeImprovementCandidateRef,
  target: KnowledgeCandidateTarget,
): void {
  assertCandidateTransitionPlan(transaction.entries, candidate, target)
}

function reverseKnowledgeFilePlan(
  plan: readonly KnowledgeFileTransactionPlanEntry[],
): KnowledgeFileTransactionPlanEntry[] {
  return plan.map((entry) => ({
    path: entry.path,
    beforeHash: entry.afterHash,
    afterHash: entry.beforeHash,
    ...(entry.afterMode === undefined ? {} : { beforeMode: entry.afterMode }),
    ...(entry.beforeMode === undefined ? {} : { afterMode: entry.beforeMode }),
  }))
}

async function ensureCandidateTransitionEvent(
  runDir: string,
  candidateRef: KnowledgeImprovementCandidateRef,
  target: KnowledgeCandidateTarget,
): Promise<void> {
  if (await hasCandidateTransitionEvent(runDir, candidateRef, target)) return
  await appendLedger(runDir, {
    type: target === 'candidate' ? 'candidate.promoted' : 'candidate.restored',
    runId: candidateRef.runId,
    candidateId: candidateRef.candidateId,
    candidateHash: candidateRef.candidateHash,
    evidenceHash: candidateRef.evidenceHash,
    promotionPlanHash: candidateRef.promotionPlanHash,
  })
}

async function hasCandidateTransitionEvent(
  runDir: string,
  candidateRef: KnowledgeImprovementCandidateRef,
  target: KnowledgeCandidateTarget,
): Promise<boolean> {
  const eventType = target === 'candidate' ? 'candidate.promoted' : 'candidate.restored'
  let matched = false
  for (const row of await loadKnowledgeImprovementEventsFromRun(runDir)) {
    if (row.type !== eventType || row.candidateId !== candidateRef.candidateId) continue
    if (
      row.runId !== candidateRef.runId ||
      row.candidateHash !== candidateRef.candidateHash ||
      row.evidenceHash !== candidateRef.evidenceHash ||
      row.promotionPlanHash !== candidateRef.promotionPlanHash
    ) {
      throw new Error('persisted knowledge activation event conflicts with the approved candidate')
    }
    matched = true
  }
  return matched
}

export interface KnowledgeImprovementEvent extends Record<string, unknown> {
  at: string
  type: string
}

export async function loadKnowledgeImprovementEvents(
  root: string,
  runId: string,
): Promise<KnowledgeImprovementEvent[]> {
  const parsedRunId = runIdSchema.parse(runId)
  try {
    return await withKnowledgeImprovementRun(root, parsedRunId, false, (runDir) =>
      loadKnowledgeImprovementEventsFromRun(runDir),
    )
  } catch (error) {
    if (isMissingFile(error)) return []
    throw error
  }
}

async function loadKnowledgeImprovementEventsFromRun(
  runDir: string,
): Promise<KnowledgeImprovementEvent[]> {
  const events: KnowledgeImprovementEvent[] = []
  try {
    for (const file of await listRegularFilesWithinRoot(runDir, 'events')) {
      const name = file.path.slice('events/'.length)
      if (name.includes('/') || !name.endsWith('.json')) {
        throw new Error(`knowledge event store contains an unsupported entry: ${name}`)
      }
      events.push(parseKnowledgeImprovementEvent(JSON.parse(file.bytes.toString('utf8'))))
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }

  const unique = new Map<string, KnowledgeImprovementEvent>()
  for (const event of events) {
    const { at: _at, ...semantic } = event
    unique.set(contentHash(semantic), event)
  }
  return [...unique.values()].sort((left, right) => left.at.localeCompare(right.at))
}

function parseKnowledgeImprovementEvent(value: unknown): KnowledgeImprovementEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('knowledge improvement event is not an object')
  }
  const event = value as Record<string, unknown>
  if (typeof event.at !== 'string' || typeof event.type !== 'string') {
    throw new Error('knowledge improvement event is missing at or type')
  }
  return event as KnowledgeImprovementEvent
}

async function copyIfExists(source: string, target: string): Promise<void> {
  let sourceStat: Awaited<ReturnType<typeof lstat>>
  try {
    sourceStat = await lstat(source)
  } catch (error) {
    if (isMissingFile(error)) return
    throw error
  }
  if (!sourceStat.isDirectory() && !sourceStat.isFile()) {
    throw new Error(`knowledge surface contains an unsupported filesystem entry: ${source}`)
  }
  await mkdir(dirname(target), { recursive: true })
  await cp(source, target, { recursive: sourceStat.isDirectory(), dereference: false })
}

export async function hashKnowledgeBase(root: string): Promise<string> {
  return withKnowledgeRead(root, () => hashKnowledgeBaseUnlocked(root))
}

async function hashKnowledgeBaseUnlocked(root: string): Promise<string> {
  const entries = await knowledgeHashEntries(root)
  return sha256(JSON.stringify(entries.map(({ path, hash, mode }) => ({ path, hash, mode }))))
}

interface KnowledgeFileIdentity {
  path: string
  hash: string
  transactionHash: string
  mode: number
}

async function knowledgeHashEntries(root: string): Promise<KnowledgeFileIdentity[]> {
  const entries: KnowledgeFileIdentity[] = []
  for (const rel of ['knowledge', 'raw']) {
    try {
      for (const file of await listRegularFilesWithinRoot(root, rel)) {
        entries.push(knowledgeFileIdentity(file.path, file.bytes, file.mode))
      }
    } catch (error) {
      if (!isMissingFile(error)) throw error
    }
  }
  const sourceRegistry = relative(root, layoutFor(root).sourceRegistryPath).replace(/\\/g, '/')
  try {
    const file = await readRegularFileWithinRoot(root, sourceRegistry)
    entries.push(knowledgeFileIdentity(sourceRegistry, file.bytes, file.mode))
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
  entries.sort((a, b) => a.path.localeCompare(b.path))
  return entries
}

function knowledgeFileIdentity(path: string, bytes: Buffer, mode: number): KnowledgeFileIdentity {
  return {
    path,
    hash: sha256(bytes.toString('base64')),
    transactionHash: createHash('sha256').update(bytes).digest('hex'),
    mode,
  }
}

async function acquireRunLease(
  runDir: string,
  options: { ownerId: string; ttlMs: number },
): Promise<LeaseHandle> {
  const path = join(runDir, 'run.lock.durable')
  const acquired = await acquireDurableFileLock(runDir, {
    lockfilePath: path,
    staleMs: options.ttlMs,
  })
  return {
    ownerId: options.ownerId,
    assertOwned: acquired.assertOwned,
    release: acquired.release,
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
  await writeJsonDurableWithinRoot(
    runDir,
    'state.json',
    KnowledgeImprovementRunStateSchema.parse(state),
  )
  await onState?.(state)
}

async function appendLedger(runDir: string, value: Record<string, unknown>): Promise<void> {
  const type = value.type
  if (typeof type !== 'string' || type.length === 0) {
    throw new Error('knowledge improvement event requires a type')
  }
  const relativePath = join('events', `${contentHash(value)}.json`).replace(/\\/g, '/')
  try {
    const file = await readRegularFileWithinRoot(runDir, relativePath)
    const existing = parseKnowledgeImprovementEvent(JSON.parse(file.bytes.toString('utf8')))
    const { at: _at, ...semantic } = existing
    if (canonicalJson(semantic) !== canonicalJson(value)) {
      throw new Error('knowledge improvement event identity conflicts with durable content')
    }
    return
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
  await writeJsonDurableWithinRoot(runDir, relativePath, {
    at: new Date().toISOString(),
    ...value,
  })
}

function candidateEvidenceRelativePath(candidateId: string): string {
  return join('candidates', safePathSegmentSchema.parse(candidateId), 'evidence.json').replace(
    /\\/g,
    '/',
  )
}

function descendantPath(root: string, path: string): string | undefined {
  const value = relative(resolve(root), resolve(path)).replace(/\\/g, '/')
  if (value === '' || value === '..' || value.startsWith('../') || isAbsolute(value))
    return undefined
  return value
}

function assertExactCandidatePlatform(): void {
  if (process.platform !== 'linux') {
    throw new Error('exact knowledge candidate workflows require Linux directory descriptors')
  }
}

function average(values: readonly number[]): number {
  const finite = values.filter(Number.isFinite)
  if (finite.length === 0) return 0
  return finite.reduce((sum, value) => sum + value, 0) / finite.length
}
