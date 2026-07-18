import { isMissingFile } from '../durable-fs'
import { withKnowledgeMutation } from '../mutation-lock'
import type { RunRagKnowledgeImprovementLoopResult } from '../rag-improvement-loop'
import type {
  KnowledgeImprovementCandidateRecord,
  KnowledgeImprovementMetric,
  KnowledgeImprovementOptions,
  KnowledgeImprovementResult,
} from './contracts'
import { DEFAULT_LEASE_TTL_MS, runIdSchema } from './contracts'
import { assertKnowledgeImprovementOptions, measureCandidate } from './evaluation'
import {
  acquireRunLease,
  appendLedger,
  assertExactCandidatePlatform,
  blockRun,
  findActiveCandidate,
  knowledgeImprovementRunId,
  loadKnowledgeImprovementStateFromRun,
  saveState,
  withKnowledgeImprovementRun,
} from './state'
import {
  assertCandidateEvidence,
  candidateRefFor,
  createBaselineSnapshot,
  createCandidateWorkspace,
  ensureBaselineSnapshot,
  hashKnowledgeBase,
  withBaselineSnapshot,
} from './workspace'

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
    if (state.status === 'promoted') {
      const promoted = promotedCandidate!
      const promotedState = state
      return withKnowledgeMutation(options.root, async () => {
        const currentHash = await hashKnowledgeBase(options.root)
        if (currentHash !== promoted.candidateHash) {
          throw new Error(
            `promoted knowledge base changed: expected ${promoted.candidateHash}, got ${currentHash}`,
          )
        }
        const evidence = await assertCandidateEvidence(
          runDir,
          candidateRefFor(runId, promotedState, promoted),
        )
        return {
          runId,
          state: promotedState,
          candidate: promoted,
          evaluation: evidence.evaluation,
          promoted: true,
          blocked: false,
        }
      })
    }
    await withKnowledgeMutation(options.root, () => undefined)
    await ensureBaselineSnapshot(runDir, options.root, state.baseHash)

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
