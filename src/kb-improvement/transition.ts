import { createHash } from 'node:crypto'
import { canonicalJson, contentHash } from '@tangle-network/agent-eval'
import type { AgentImprovementActivationResult } from '@tangle-network/agent-interface'
import { readRegularFileWithinRoot } from '../durable-fs'
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
} from '../file-transaction'
import { writeKnowledgeIndex } from '../indexer'
import { withKnowledgeMutation } from '../mutation-lock'
import type { RunRagKnowledgeImprovementLoopResult } from '../rag-improvement-loop'
import type { ResolvedKnowledgeImprovementActivationPersistence } from './activation'
import {
  loadKnowledgeActivationRecord,
  persistKnowledgeActivationResult,
  resolveKnowledgeActivationPersistence,
  sourceKnowledgeHash,
} from './activation'
import type {
  KnowledgeImprovementCandidateRecord,
  KnowledgeImprovementCandidateRef,
  KnowledgeImprovementMutationReceipt,
  KnowledgeImprovementMutationResult,
  KnowledgeImprovementOptions,
  KnowledgeImprovementRunState,
  KnowledgeImprovementTarget,
  PromoteKnowledgeCandidateOptions,
  RestoreKnowledgeCandidateBaselineOptions,
} from './contracts'
import {
  DEFAULT_LEASE_TTL_MS,
  KB_IMPROVEMENT_PAGES_DIRECTORY,
  KnowledgeImprovementCandidateRefSchema,
} from './contracts'
import {
  acquireRunLease,
  appendLedger,
  assertExactCandidatePlatform,
  blockRun,
  loadKnowledgeImprovementEventsFromRun,
  loadKnowledgeImprovementStateFromRun,
  saveState,
  withKnowledgeImprovementRun,
} from './state'
import {
  assertCandidateEvidence,
  assertStateIdentity,
  candidateIdentityFor,
  hashKnowledgeBase,
  knowledgeHashEntries,
  withBaselineSnapshot,
  withMeasuredCandidateSnapshot,
} from './workspace'

/** Promote one previously measured candidate without rerunning research or evaluation. */
export async function promoteKnowledgeCandidate(
  options: PromoteKnowledgeCandidateOptions,
): Promise<KnowledgeImprovementMutationResult> {
  return transitionKnowledgeCandidate(options, 'candidate')
}

/** Restore the frozen baseline paired with one previously measured candidate. */
export async function restoreKnowledgeCandidateBaseline(
  options: RestoreKnowledgeCandidateBaselineOptions,
): Promise<KnowledgeImprovementMutationResult> {
  return transitionKnowledgeCandidate(options, 'baseline')
}

async function transitionKnowledgeCandidate(
  options: PromoteKnowledgeCandidateOptions,
  target: KnowledgeImprovementTarget,
): Promise<KnowledgeImprovementMutationResult> {
  assertExactCandidatePlatform()
  const candidateRef = Object.freeze(
    KnowledgeImprovementCandidateRefSchema.parse(options.candidate),
  )
  const now = options.now ?? (() => new Date())
  const activation = options.activation
    ? resolveKnowledgeActivationPersistence(options.activation, candidateRef, target)
    : undefined
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
          activation,
        },
        target,
      )
    } finally {
      await lease.release()
    }
  })
}

interface KnowledgeCandidateTransitionInput {
  root: string
  runDir: string
  state: KnowledgeImprovementRunState
  candidateRef: KnowledgeImprovementCandidateRef
  activation?: ResolvedKnowledgeImprovementActivationPersistence
  leaseTtlMs: number
  assertRunOwned(): void
  now: () => Date
  onState?: KnowledgeImprovementOptions['onState']
  lifecycle?: RunRagKnowledgeImprovementLoopResult
}

async function applyKnowledgeCandidateTarget(
  input: KnowledgeCandidateTransitionInput,
  target: KnowledgeImprovementTarget,
): Promise<KnowledgeImprovementMutationResult> {
  const { candidateRef, runDir, state } = input
  assertStateIdentity(input.root, candidateRef, state)
  const candidate = state.candidates.find((entry) => entry.candidateId === candidateRef.candidateId)
  if (
    !candidate ||
    canonicalJson(candidateIdentityFor(candidateRef.runId, state, candidate)) !==
      canonicalJson(candidateRef)
  ) {
    throw new Error('knowledge candidate approval does not match the measured candidate')
  }
  const action = target === 'candidate' ? 'promotion' : 'restore'
  const desiredHash = target === 'candidate' ? candidateRef.candidateHash : candidateRef.baseHash
  const purpose = knowledgeCandidateTransitionPurpose(candidateRef, state.implementationRef, target)
  const recoveryOwner = input.activation
    ? `knowledge-improvement-activation:${input.activation.activation.digest}`
    : 'knowledge-improvement-candidate-transition'
  return withKnowledgeMutation(
    input.root,
    async (mutationLock) => {
      const assertOwned = () => {
        mutationLock.assertOwned()
        input.assertRunOwned()
      }
      assertOwned()
      const transactionRoot = mutationLock.transactionRoot
      const recovery =
        mutationLock.recovery?.purpose === purpose ? mutationLock.recovery : undefined
      if (!recovery) {
        await assertCandidateEvidence(runDir, candidateRef, state.implementationRef)
      }
      const existingActivation = input.activation
        ? await loadKnowledgeActivationRecord(
            runDir,
            candidateRef,
            input.activation.activation,
            target,
            input.activation.identity,
          )
        : null
      if (existingActivation) {
        if (recovery?.direction === 'rollback') {
          throw new Error('stored knowledge activation result conflicts with a pending rollback')
        }
        if (recovery) {
          const recoveredHash = await hashKnowledgeBase(input.root)
          if (recoveredHash !== existingActivation.mutation.afterHash) {
            throw new Error('stored knowledge activation result does not match the recovered files')
          }
          await finishKnowledgeFileTransaction({
            root: input.root,
            transactionRoot,
            transaction: recovery.transaction,
            assertOwned,
          })
        }
        if (existingActivation.result.outcome.status === 'conflict') {
          const reason = candidateTransitionConflictReason(
            target,
            candidateRef,
            existingActivation.mutation.afterHash,
          )
          const blocked = await blockCandidateTransition(
            input,
            candidate,
            target,
            reason,
            existingActivation.mutation.afterHash,
          )
          return { ...blocked, activationResult: existingActivation.result }
        }
        return candidateTransitionResult(
          input,
          candidate,
          target === 'candidate' && state.status === 'promoted',
          false,
          existingActivation.mutation,
          existingActivation.result,
        )
      }
      if (recovery?.direction === 'rollback') {
        await finishKnowledgeFileTransaction({
          root: input.root,
          transactionRoot,
          transaction: recovery.transaction,
          assertOwned,
        })
      }
      const recovered = recovery?.direction === 'apply' ? recovery : undefined
      let pending: KnowledgeFileTransaction | null =
        input.activation && recovered ? recovered.transaction : null
      const currentHash = await hashKnowledgeBase(input.root)
      let transactionId = recovered?.transactionId ?? null
      if (recovered && currentHash !== desiredHash) {
        throw new Error(`recovered knowledge ${action} does not match the approved target`)
      }
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
        const mutation = Object.freeze({
          target,
          beforeHash: currentHash,
          afterHash: currentHash,
          changed: false,
          transactionId: null,
          recovered: false,
        }) satisfies KnowledgeImprovementMutationReceipt
        const activationResult = input.activation
          ? await persistKnowledgeActivationResult(
              runDir,
              candidateRef,
              input.activation,
              target,
              mutation,
            )
          : undefined
        const blocked = await blockCandidateTransition(
          input,
          candidate,
          target,
          reason,
          currentHash,
        )
        return activationResult ? { ...blocked, activationResult } : blocked
      }

      if (currentHash !== desiredHash && !pending) {
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
                recoveryOwner,
                mutations: await knowledgePlanMutations(targetRoot, plan),
                includeUnchanged: true,
                now: input.now,
              })
            }),
        )
        if (!pending) {
          throw new Error(`knowledge ${action} plan unexpectedly contained no file changes`)
        }
        transactionId = pending.transactionId
        try {
          assertCandidateTransitionTransaction(pending, candidateRef, target)
        } catch (error) {
          try {
            await rollbackKnowledgeFileTransaction({
              root: input.root,
              transactionRoot,
              transaction: pending,
              beforeCommit: assertOwned,
            })
            await finishKnowledgeFileTransaction({
              root: input.root,
              transactionRoot,
              transaction: pending,
              assertOwned,
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
            beforeCommit: assertOwned,
          })
        }
        assertOwned()
        if ((await hashKnowledgeBase(input.root)) !== desiredHash) {
          throw new Error(`knowledge ${action} content does not match the approved target`)
        }
        await writeKnowledgeIndex(input.root)
      } catch (error) {
        if (!pending) throw error
        if (recovered && input.activation) throw error
        try {
          assertOwned()
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
            beforeCommit: assertOwned,
          })
          await finishKnowledgeFileTransaction({
            root: input.root,
            transactionRoot,
            transaction: pending,
            assertOwned,
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
      let finalHash = await hashKnowledgeBase(input.root)
      if (finalHash !== desiredHash) {
        throw new Error(`knowledge ${action} changed before its result was returned`)
      }
      const mutation = Object.freeze({
        target,
        beforeHash: transactionId ? sourceKnowledgeHash(candidateRef, target) : currentHash,
        afterHash: finalHash,
        changed: transactionId !== null,
        transactionId,
        recovered: recovered !== undefined,
      }) satisfies KnowledgeImprovementMutationReceipt
      const activationResult = input.activation
        ? await persistKnowledgeActivationResult(
            runDir,
            candidateRef,
            input.activation,
            target,
            mutation,
          )
        : undefined
      if ((await hashKnowledgeBase(input.root)) !== finalHash) {
        throw new Error(`knowledge ${action} changed while its result was persisted`)
      }
      if (pending) {
        await finishKnowledgeFileTransaction({
          root: input.root,
          transactionRoot,
          transaction: pending,
          assertOwned,
        })
      }
      finalHash = await hashKnowledgeBase(input.root)
      if (finalHash !== desiredHash) {
        throw new Error(`knowledge ${action} changed before its result was returned`)
      }
      return candidateTransitionResult(
        input,
        candidate,
        target === 'candidate',
        false,
        mutation,
        activationResult,
      )
    },
    {
      staleMs: input.leaseTtlMs,
      resumeTransaction: {
        purpose,
        recoveryOwner,
        validate: (transaction) =>
          assertCandidateTransitionTransaction(transaction, candidateRef, target),
        deferFinish: input.activation !== undefined,
      },
    },
  )
}

function candidateTransitionConflictReason(
  target: KnowledgeImprovementTarget,
  candidate: KnowledgeImprovementCandidateRef,
  currentHash: string,
): string {
  return target === 'candidate'
    ? `base changed before promotion: expected ${candidate.baseHash}, got ${currentHash}`
    : `knowledge changed before restore: expected ${candidate.candidateHash}, got ${currentHash}`
}

async function blockCandidateTransition(
  input: KnowledgeCandidateTransitionInput,
  candidate: KnowledgeImprovementCandidateRecord,
  target: KnowledgeImprovementTarget,
  reason: string,
  currentHash: string,
): Promise<KnowledgeImprovementMutationResult> {
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
  return candidateTransitionResult(input, candidate, false, true, {
    target,
    beforeHash: currentHash,
    afterHash: currentHash,
    changed: false,
    transactionId: null,
    recovered: false,
  })
}

function candidateTransitionResult(
  input: KnowledgeCandidateTransitionInput,
  candidate: KnowledgeImprovementCandidateRecord,
  promoted: boolean,
  blocked: boolean,
  mutation: KnowledgeImprovementMutationReceipt,
  activationResult?: AgentImprovementActivationResult,
): KnowledgeImprovementMutationResult {
  return {
    runId: input.candidateRef.runId,
    state: input.state,
    candidate,
    ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}),
    mutation,
    ...(activationResult ? { activationResult } : {}),
    promoted,
    blocked,
  }
}

function knowledgeCandidateTransitionPurpose(
  candidate: KnowledgeImprovementCandidateRef,
  implementationRef: string,
  target: KnowledgeImprovementTarget,
): string {
  const action = target === 'candidate' ? 'promotion' : 'restore'
  return `knowledge-${action}:${contentHash({ candidate, implementationRef })}`
}

export async function knowledgeFilePlanEntries(
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
    assertKnowledgeMutationPath(path, KB_IMPROVEMENT_PAGES_DIRECTORY)
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
  target: KnowledgeImprovementTarget,
): void {
  const approvedDirection = target === 'candidate' ? plan : reverseKnowledgeFilePlan(plan)
  const actualPlanHash = knowledgeFileTransactionPlanHash(
    approvedDirection,
    KB_IMPROVEMENT_PAGES_DIRECTORY,
  )
  if (actualPlanHash !== candidate.promotionPlanHash) {
    throw new Error(
      `knowledge candidate plan changed after approval: expected ${candidate.promotionPlanHash}, got ${actualPlanHash}`,
    )
  }
}

function assertCandidateTransitionTransaction(
  transaction: KnowledgeFileTransaction,
  candidate: KnowledgeImprovementCandidateRef,
  target: KnowledgeImprovementTarget,
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
  target: KnowledgeImprovementTarget,
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
  target: KnowledgeImprovementTarget,
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
