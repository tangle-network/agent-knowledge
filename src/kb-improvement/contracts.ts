import { contentHash, type RunRecord, validateRunRecord } from '@tangle-network/agent-eval'
import {
  type AgentImprovementActivation,
  type AgentImprovementActivationResult,
  agentImprovementActivationResultSchema,
} from '@tangle-network/agent-interface'
import { z } from 'zod'
import type {
  BuildEvalKnowledgeBundleOptions,
  EvalKnowledgeBundleBuildResult,
  KnowledgeReadinessSpec,
} from '../eval-readiness'
import type { KnowledgeBaseQualityOptions, KnowledgeBaseQualityReport } from '../rag-eval'
import type {
  RagKnowledgeImprovementPhase,
  RagKnowledgeResearchOptions,
  RagKnowledgeUpdateInput,
  RagKnowledgeUpdateResult,
  RunRagKnowledgeImprovementLoopOptions,
  RunRagKnowledgeImprovementLoopResult,
} from '../rag-improvement-loop'
import type { RunKnowledgeResearchLoopOptions } from '../research-loop'
import type { RunRetrievalImprovementLoopOptions } from '../retrieval-eval'
import type { KnowledgeIndex } from '../types'
import type { ValidateKnowledgeOptions, ValidateKnowledgeResult } from '../validate'

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

export type KnowledgeImprovementTarget = 'candidate' | 'baseline'

export interface KnowledgeImprovementMutationReceipt {
  target: KnowledgeImprovementTarget
  beforeHash: string
  afterHash: string
  changed: boolean
  transactionId: string | null
  recovered: boolean
}

export interface KnowledgeImprovementMutationResult extends KnowledgeImprovementResult {
  candidate: KnowledgeImprovementCandidateRecord
  mutation: KnowledgeImprovementMutationReceipt
  activationResult?: AgentImprovementActivationResult
}

export interface KnowledgeImprovementActivationPersistence {
  activation: AgentImprovementActivation
  attemptedAt: string
  identity: string
  /** May run again after interruption; keep this deterministic and free of external side effects. */
  createResult(
    mutation: KnowledgeImprovementMutationReceipt,
  ): Promise<AgentImprovementActivationResult> | AgentImprovementActivationResult
}

export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)

export const runIdSchema = z.string().min(1).max(2_048)

export const safePathSegmentSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)

export const knowledgeImprovementMutationReceiptSchema = z
  .object({
    target: z.enum(['candidate', 'baseline']),
    beforeHash: digestSchema,
    afterHash: digestSchema,
    changed: z.boolean(),
    transactionId: z.string().uuid().nullable(),
    recovered: z.boolean(),
  })
  .strict()

export const knowledgeImprovementActivationRecordSchema = z
  .object({
    kind: z.literal('knowledge-improvement-activation-result'),
    candidateId: safePathSegmentSchema,
    mutation: knowledgeImprovementMutationReceiptSchema,
    result: agentImprovementActivationResultSchema,
  })
  .strict()

export type KnowledgeImprovementActivationRecord = z.infer<
  typeof knowledgeImprovementActivationRecordSchema
>

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

export const improvementMetricSchema = z
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
  activation?: KnowledgeImprovementActivationPersistence
  ownerId?: string
  leaseTtlMs?: number
  now?: () => Date
  onState?: (state: KnowledgeImprovementRunState) => Promise<void> | void
}

export type RestoreKnowledgeCandidateBaselineOptions = PromoteKnowledgeCandidateOptions

export interface LoadKnowledgeImprovementActivationResultOptions {
  root: string
  candidate: KnowledgeImprovementCandidateRef
  activation: AgentImprovementActivation
  identity: string
}

export interface UseKnowledgeImprovementCandidateOptions {
  root: string
  candidate: KnowledgeImprovementCandidateRef
}

export interface ResolvedKnowledgeImprovementComparisonSnapshot {
  root: string
  hash: string
}

export interface ResolvedKnowledgeImprovementComparison {
  reference: KnowledgeImprovementCandidateRef
  evaluation: KnowledgeImprovementMetric
  baseline: ResolvedKnowledgeImprovementComparisonSnapshot
  candidate: ResolvedKnowledgeImprovementComparisonSnapshot
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

export interface LeaseHandle {
  ownerId: string
  assertOwned(): void
  release(): Promise<void>
}

export const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000

export const UPDATE_PHASES: readonly RagKnowledgeImprovementPhase[] = [
  'knowledge-acquisition',
  'knowledge-update',
]

export const EVALUATION_PHASES: readonly RagKnowledgeImprovementPhase[] = [
  'retrieval-tuning',
  'gap-diagnosis',
  'answer-quality',
  'promotion',
]
