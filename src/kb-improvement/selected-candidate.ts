import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { canonicalJson, contentHash } from '@tangle-network/agent-eval'
import type { AgentCandidateJsonValue as JsonValue } from '@tangle-network/agent-interface'
import { z } from 'zod'
import { isMissingFile, readRegularFileWithinRoot, writeJsonDurableWithinRoot } from '../durable-fs'
import {
  applyKnowledgeFileTransaction,
  assertKnowledgeMutationPath,
  finishKnowledgeFileTransaction,
  type KnowledgeFileMutation,
  type KnowledgeFileTransaction,
  type KnowledgeFileTransactionPlanEntry,
  knowledgeFileTransactionPlanHash,
  prepareKnowledgeFileTransaction,
} from '../file-transaction'
import { stableId } from '../ids'
import { writeKnowledgeIndex } from '../indexer'
import { withKnowledgeMutation } from '../mutation-lock'
import type { RagKnowledgeImprovementPhase } from '../rag-improvement-loop'
import type {
  KnowledgeImprovementCandidateRef,
  KnowledgeImprovementOptions,
  KnowledgeImprovementResult,
} from './contracts'
import {
  EVALUATION_PHASES,
  immutableRefSchema,
  KnowledgeImprovementCandidateRefSchema,
  safePathSegmentSchema,
} from './contracts'
import { improveKnowledgeBase } from './run'
import { knowledgeImprovementRunDir } from './state'
import { knowledgeFilePlanEntries } from './transition'
import { hashKnowledgeBase, withKnowledgeImprovementComparison } from './workspace'

const DERIVED_KNOWLEDGE_PATHS = new Set(['knowledge/index.md'])
const selectionPathSchema = z
  .string()
  .min(1)
  .transform((path, context) => {
    try {
      return assertKnowledgeMutationPath(path)
    } catch (error) {
      context.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : String(error),
      })
      return z.NEVER
    }
  })
const selectionMetadataSchema = z.record(z.string(), z.json())
const measuredSelectionLifecycleSchema = z
  .object({
    kind: z.literal('measured-knowledge-change-selection'),
    version: z.literal(1),
    selectionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    sourceCandidateId: z.string().min(1),
    sourceEvidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    sourcePlanHash: z.string().regex(/^[a-f0-9]{64}$/),
    selectedPaths: z.array(selectionPathSchema),
    selectedCandidateHash: z.string().regex(/^[a-f0-9]{64}$/),
    selectedPlanHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
const measuredSelectionReceiptSchema = z
  .object({
    kind: z.literal('measured-knowledge-change-selection-receipt'),
    version: z.literal(1),
    receiptHash: z.string().regex(/^[a-f0-9]{64}$/),
    selectionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    sourceCandidate: KnowledgeImprovementCandidateRefSchema,
    sourcePlanHash: z.string().regex(/^[a-f0-9]{64}$/),
    selectedPaths: z.array(selectionPathSchema),
    derivedImplementationRef: immutableRefSchema,
    runId: z.string().min(1),
    derivedCandidateId: z.string().min(1),
    derivedCandidateStatus: z.string().min(1),
    selectedCandidateHash: z.string().regex(/^[a-f0-9]{64}$/),
    selectedPlanHash: z.string().regex(/^[a-f0-9]{64}$/),
    selectedEvidenceHash: z.string().regex(/^[a-f0-9]{64}$/),
    rationale: z.string().trim().min(1).optional(),
    metadata: selectionMetadataSchema.optional(),
  })
  .strict()

export type KnowledgeEvaluationPhase = Exclude<
  RagKnowledgeImprovementPhase,
  'knowledge-acquisition' | 'knowledge-update'
>

export interface ImproveSelectedKnowledgeCandidateOptions
  extends Omit<
    KnowledgeImprovementOptions,
    | 'root'
    | 'goal'
    | 'implementationRef'
    | 'runId'
    | 'step'
    | 'knowledgeResearch'
    | 'acquireKnowledge'
    | 'updateKnowledge'
    | 'enabledPhases'
    | 'requiredPhases'
  > {
  root: string
  goal: string
  /** Identity of the helper, policy, or human procedure choosing the subset. */
  implementationRef: string
  /** Previously measured whole candidate from which the subset is derived. */
  sourceCandidate: KnowledgeImprovementCandidateRef
  /** Exact changed file paths to carry into the derived candidate. */
  selectedPaths: readonly string[]
  /** Optional explicit run identity. The default includes the selection digest. */
  runId?: string
  /** Human-readable reason for selecting this subset. */
  rationale?: string
  /** JSON-safe policy output retained in the selection receipt. */
  selectionMetadata?: Record<string, JsonValue>
  /** Evaluation-only phases. `knowledge-update` is inserted by this helper. */
  enabledEvaluationPhases?: readonly KnowledgeEvaluationPhase[]
  /** Evaluation-only phases that must complete. `knowledge-update` is always required. */
  requiredEvaluationPhases?: readonly KnowledgeEvaluationPhase[]
}

export type MeasuredKnowledgeSelectionReceipt = z.infer<typeof measuredSelectionReceiptSchema>

export interface ImproveSelectedKnowledgeCandidateResult extends KnowledgeImprovementResult {
  selection: MeasuredKnowledgeSelectionReceipt
}

/**
 * Derive a subset from an already measured candidate, then measure the subset as
 * a new candidate before it can be promoted.
 *
 * Directly filtering an activation plan is unsafe: a whole candidate can pass
 * while one page subset breaks links, removes supporting sources, or changes a
 * readiness score. This helper instead applies the chosen changed paths to an
 * isolated baseline, recomputes the index, runs the ordinary improvement
 * evaluator, and returns the ordinary candidate reference. Promotion therefore
 * remains one path and can never admit an unmeasured hybrid.
 */
export async function improveSelectedKnowledgeCandidate(
  options: ImproveSelectedKnowledgeCandidateOptions,
): Promise<ImproveSelectedKnowledgeCandidateResult> {
  const sourceCandidate = Object.freeze(
    KnowledgeImprovementCandidateRefSchema.parse(options.sourceCandidate),
  )
  const requestedImplementationRef = immutableRefSchema.parse(options.implementationRef)
  const enabledEvaluationPhases = normalizeEvaluationPhases(
    options.enabledEvaluationPhases ?? EVALUATION_PHASES,
    'enabledEvaluationPhases',
  )
  const requiredEvaluationPhases = normalizeEvaluationPhases(
    options.requiredEvaluationPhases ?? [],
    'requiredEvaluationPhases',
  )
  const metadata = options.selectionMetadata
    ? selectionMetadataSchema.parse(structuredClone(options.selectionMetadata))
    : undefined

  return withKnowledgeImprovementComparison(
    { root: options.root, candidate: sourceCandidate },
    async (source) => {
      const sourcePlan = await knowledgeFilePlanEntries(source.baseline.root, source.candidate.root)
      const sourcePlanHash = knowledgeFileTransactionPlanHash(sourcePlan)
      if (sourcePlanHash !== sourceCandidate.promotionPlanHash) {
        throw new Error('source knowledge candidate plan no longer matches its measured identity')
      }
      const changedSourcePlan = sourcePlan.filter(planEntryChanged).filter(notDerivedPath)
      const selectedPaths = normalizeSelectedPaths(options.selectedPaths, changedSourcePlan)
      const selectionMaterial = immutableJson({
        kind: 'measured-knowledge-change-selection' as const,
        version: 1 as const,
        sourceCandidate,
        sourcePlanHash,
        selectedPaths,
        ...(options.rationale?.trim() ? { rationale: options.rationale.trim() } : {}),
        ...(metadata ? { metadata } : {}),
      })
      const selectionDigest = contentHash(selectionMaterial)
      const derivedImplementationRef = immutableRefSchema.parse(
        `sha256:${contentHash({
          engine: 'agent-knowledge/measured-selection-v1',
          implementationRef: requestedImplementationRef,
          selectionDigest,
        })}`,
      )
      const runId =
        options.runId ??
        stableId(
          'kimpsel',
          canonicalJson({
            root: options.root,
            goal: options.goal,
            derivedImplementationRef,
            selectionDigest,
          }),
        )
      const selectedEntries = selectedPaths.map((path) => {
        const entry = changedSourcePlan.find((candidate) => candidate.path === path)
        if (!entry) throw new Error(`selected knowledge path disappeared: ${path}`)
        return entry
      })
      const selectionMutationPlanHash = knowledgeFileTransactionPlanHash(selectedEntries)
      let lifecycleSelection: z.infer<typeof measuredSelectionLifecycleSchema> | undefined

      const result = await improveKnowledgeBase({
        ...improvementOptions(options),
        root: options.root,
        goal: options.goal,
        implementationRef: derivedImplementationRef,
        runId,
        enabledPhases: ['knowledge-update', ...enabledEvaluationPhases],
        requiredPhases: ['knowledge-update', ...requiredEvaluationPhases],
        async updateKnowledge(input) {
          const purpose = `knowledge-selected-candidate:${selectionDigest}`
          const recoveryOwner = `knowledge-selected-candidate:${sourceCandidate.candidateId}`
          await withKnowledgeMutation(
            input.candidateRoot,
            async (lock) => {
              lock.assertOwned()
              if (!lock.recovery && selectedEntries.length > 0) {
                const transaction = await prepareKnowledgeFileTransaction({
                  root: input.candidateRoot,
                  transactionRoot: lock.transactionRoot,
                  purpose,
                  recoveryOwner,
                  mutations: await selectionMutations(source.candidate.root, selectedEntries),
                  now: options.now,
                })
                if (transaction) {
                  assertSelectionTransaction(transaction, selectionMutationPlanHash)
                  await applyKnowledgeFileTransaction({
                    root: input.candidateRoot,
                    transactionRoot: lock.transactionRoot,
                    transaction,
                    beforeCommit: lock.assertOwned,
                  })
                  await finishKnowledgeFileTransaction({
                    root: input.candidateRoot,
                    transactionRoot: lock.transactionRoot,
                    transaction,
                    assertOwned: lock.assertOwned,
                  })
                }
              }
              await writeKnowledgeIndex(input.candidateRoot)
              lock.assertOwned()
            },
            {
              resumeTransaction: {
                purpose,
                recoveryOwner,
                validate: (transaction) =>
                  assertSelectionTransaction(transaction, selectionMutationPlanHash),
              },
            },
          )

          const selectedPlan = await knowledgeFilePlanEntries(
            source.baseline.root,
            input.candidateRoot,
          )
          assertExactSelectedChanges(selectedPlan, selectedPaths)
          const selectedPlanHash = knowledgeFileTransactionPlanHash(selectedPlan)
          const selectedCandidateHash = await hashKnowledgeBase(input.candidateRoot)
          lifecycleSelection = measuredSelectionLifecycleSchema.parse({
            kind: 'measured-knowledge-change-selection',
            version: 1,
            selectionDigest,
            sourceCandidateId: sourceCandidate.candidateId,
            sourceEvidenceHash: sourceCandidate.evidenceHash,
            sourcePlanHash,
            selectedPaths,
            selectedCandidateHash,
            selectedPlanHash,
          })
          return {
            applied: selectedPaths.length > 0,
            summary:
              selectedPaths.length > 0
                ? `Applied ${selectedPaths.length} selected measured change(s).`
                : 'Selected no changes; measuring the exact baseline as a null candidate.',
            metadata: { selection: lifecycleSelection },
          }
        },
      })

      const candidate = result.candidate
      if (!candidate?.candidateHash || !candidate.promotionPlanHash || !candidate.evidenceHash) {
        throw new Error('selected knowledge candidate did not produce measured candidate evidence')
      }
      const recordedSelection = measuredSelectionLifecycleSchema.parse(
        result.lifecycle?.knowledgeUpdate?.metadata?.selection ?? lifecycleSelection,
      )
      if (
        recordedSelection.selectionDigest !== selectionDigest ||
        recordedSelection.selectedCandidateHash !== candidate.candidateHash ||
        recordedSelection.selectedPlanHash !== candidate.promotionPlanHash ||
        canonicalJson(recordedSelection.selectedPaths) !== canonicalJson(selectedPaths)
      ) {
        throw new Error('selected knowledge candidate evidence does not bind the measured subset')
      }

      const receiptWithoutHash = immutableJson({
        kind: 'measured-knowledge-change-selection-receipt' as const,
        version: 1 as const,
        selectionDigest,
        sourceCandidate,
        sourcePlanHash,
        selectedPaths,
        derivedImplementationRef,
        runId: result.runId,
        derivedCandidateId: candidate.candidateId,
        derivedCandidateStatus: candidate.status,
        selectedCandidateHash: candidate.candidateHash,
        selectedPlanHash: candidate.promotionPlanHash,
        selectedEvidenceHash: candidate.evidenceHash,
        ...(options.rationale?.trim() ? { rationale: options.rationale.trim() } : {}),
        ...(metadata ? { metadata } : {}),
      })
      const receipt = measuredSelectionReceiptSchema.parse({
        ...receiptWithoutHash,
        receiptHash: contentHash(receiptWithoutHash),
      })
      await persistSelectionReceipt(options.root, receipt)
      return { ...result, selection: receipt }
    },
  )
}

function improvementOptions(
  options: ImproveSelectedKnowledgeCandidateOptions,
): Omit<
  KnowledgeImprovementOptions,
  | 'root'
  | 'goal'
  | 'implementationRef'
  | 'runId'
  | 'step'
  | 'knowledgeResearch'
  | 'acquireKnowledge'
  | 'updateKnowledge'
  | 'enabledPhases'
  | 'requiredPhases'
> {
  const {
    root: _root,
    goal: _goal,
    implementationRef: _implementationRef,
    sourceCandidate: _sourceCandidate,
    selectedPaths: _selectedPaths,
    runId: _runId,
    rationale: _rationale,
    selectionMetadata: _selectionMetadata,
    enabledEvaluationPhases: _enabledEvaluationPhases,
    requiredEvaluationPhases: _requiredEvaluationPhases,
    ...rest
  } = options
  return rest
}

function normalizeEvaluationPhases(
  phases: readonly RagKnowledgeImprovementPhase[],
  field: string,
): KnowledgeEvaluationPhase[] {
  const unique = [...new Set(phases)]
  for (const phase of unique) {
    if (phase === 'knowledge-acquisition' || phase === 'knowledge-update') {
      throw new Error(`${field} cannot contain the selection-owned phase '${phase}'`)
    }
  }
  return unique as KnowledgeEvaluationPhase[]
}

function normalizeSelectedPaths(
  paths: readonly string[],
  changedPlan: readonly KnowledgeFileTransactionPlanEntry[],
): string[] {
  const available = new Set(changedPlan.map((entry) => entry.path))
  const selected: string[] = []
  const seen = new Set<string>()
  for (const input of paths) {
    const path = selectionPathSchema.parse(input)
    if (DERIVED_KNOWLEDGE_PATHS.has(path)) {
      throw new Error(`derived knowledge path cannot be selected directly: ${path}`)
    }
    if (seen.has(path)) throw new Error(`selected knowledge path is repeated: ${path}`)
    if (!available.has(path)) {
      throw new Error(`selected knowledge path is not a changed source-candidate file: ${path}`)
    }
    seen.add(path)
    selected.push(path)
  }
  return selected.sort((left, right) => left.localeCompare(right))
}

function planEntryChanged(entry: KnowledgeFileTransactionPlanEntry): boolean {
  return (
    entry.beforeHash !== entry.afterHash ||
    (entry.beforeHash !== null && entry.afterHash !== null && entry.beforeMode !== entry.afterMode)
  )
}

function notDerivedPath(entry: KnowledgeFileTransactionPlanEntry): boolean {
  return !DERIVED_KNOWLEDGE_PATHS.has(entry.path)
}

async function selectionMutations(
  sourceCandidateRoot: string,
  entries: readonly KnowledgeFileTransactionPlanEntry[],
): Promise<KnowledgeFileMutation[]> {
  return Promise.all(
    entries.map(async (entry) => {
      if (entry.afterHash === null) return { path: entry.path, content: null }
      const file = await readRegularFileWithinRoot(sourceCandidateRoot, entry.path)
      const actualHash = createHash('sha256').update(file.bytes).digest('hex')
      if (actualHash !== entry.afterHash || file.mode !== entry.afterMode) {
        throw new Error(`source candidate changed before subset materialization: ${entry.path}`)
      }
      return { path: entry.path, content: file.bytes, mode: file.mode }
    }),
  )
}

function assertSelectionTransaction(
  transaction: KnowledgeFileTransaction,
  expectedPlanHash: string,
): void {
  if (knowledgeFileTransactionPlanHash(transaction.entries) !== expectedPlanHash) {
    throw new Error('selected knowledge transaction does not match its approved path set')
  }
}

function assertExactSelectedChanges(
  plan: readonly KnowledgeFileTransactionPlanEntry[],
  selectedPaths: readonly string[],
): void {
  const actual = plan
    .filter(planEntryChanged)
    .filter(notDerivedPath)
    .map((entry) => entry.path)
    .sort((left, right) => left.localeCompare(right))
  if (canonicalJson(actual) !== canonicalJson(selectedPaths)) {
    throw new Error(
      `selected knowledge candidate changed the wrong files: expected ${selectedPaths.join(', ') || '(none)'}, got ${actual.join(', ') || '(none)'}`,
    )
  }
}

async function persistSelectionReceipt(
  root: string,
  receipt: MeasuredKnowledgeSelectionReceipt,
): Promise<void> {
  const runDir = knowledgeImprovementRunDir(root, receipt.runId)
  const relativePath = join(
    'candidates',
    safePathSegmentSchema.parse(receipt.derivedCandidateId),
    'selection.json',
  ).replace(/\\/g, '/')
  try {
    const existing = measuredSelectionReceiptSchema.parse(
      JSON.parse((await readRegularFileWithinRoot(runDir, relativePath)).bytes.toString('utf8')),
    )
    if (canonicalJson(existing) !== canonicalJson(receipt)) {
      throw new Error('measured knowledge selection receipt conflicts with durable content')
    }
    return
  } catch (error) {
    if (!isMissingFile(error)) throw error
  }
  await writeJsonDurableWithinRoot(runDir, relativePath, receipt)
}

function immutableJson<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  const children: readonly unknown[] = Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>)
  for (const child of children) immutableJson(child)
  return Object.freeze(value)
}
