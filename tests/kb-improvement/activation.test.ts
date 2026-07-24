import { readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  applyKnowledgeWriteBlocks,
  hashKnowledgeBase,
  inspectPendingKnowledgeMutation,
  type KnowledgeImprovementMutationReceipt,
  knowledgeImprovementCandidateRef,
  knowledgeImprovementRunDir,
  loadKnowledgeImprovementActivationResult,
  loadKnowledgeImprovementEvents,
  promoteKnowledgeCandidate,
  recoverPendingKnowledgeMutation,
  restoreKnowledgeCandidateBaseline,
} from '../../src/index'
import { withKnowledgeMutation } from '../../src/mutation-lock'
import {
  improveTestKnowledgeBase as improveKnowledgeBase,
  knowledgeActivation,
  knowledgeActivationResult,
  passingMetric,
  refundProposal,
  refundSource,
  refundSpec,
  withKb,
} from '../support/kb-improvement'

describe('improveKnowledgeBase', () => {
  it('promotes one exact approved candidate without rerunning candidate work', async () => {
    await withKb(async (root) => {
      const source = refundSource()
      let updateCalls = 0
      const staged = await improveKnowledgeBase({
        root,
        goal: 'Build billing support refund-policy knowledge',
        runId: 'approved-candidate',
        readinessSpecs: [refundSpec],
        strict: true,
        step: () => {
          updateCalls += 1
          return {
            done: true,
            sourceTexts: [{ uri: source.uri, text: source.text, title: source.title }],
            proposalText: refundProposal(source.id),
          }
        },
      })
      const candidate = knowledgeImprovementCandidateRef(staged)

      const promoted = await promoteKnowledgeCandidate({ root, candidate })
      expect(promoted.promoted).toBe(true)
      expect(promoted.state.promotedCandidateId).toBe(candidate.candidateId)
      expect(updateCalls).toBe(1)
      await expect(
        readFile(join(root, 'knowledge', 'support', 'refund-policy.md'), 'utf8'),
      ).resolves.toContain('refund within 30 days')

      const repeated = await promoteKnowledgeCandidate({ root, candidate })
      expect(repeated.promoted).toBe(true)
      expect(repeated.state.promotedCandidateId).toBe(candidate.candidateId)
      expect(repeated.mutation).toEqual({
        target: 'candidate',
        beforeHash: candidate.candidateHash,
        afterHash: candidate.candidateHash,
        changed: false,
        transactionId: null,
        recovered: false,
      })
      expect(updateCalls).toBe(1)
    })
  })

  it('finishes an interrupted restore without repeating the mutation', async () => {
    await withKb(async (root) => {
      const staged = await improveKnowledgeBase({
        root,
        goal: 'Create knowledge that can be restored after interruption',
        runId: 'interrupted-restore',
        updateKnowledge: async ({ candidateRoot }) => {
          await writeFile(join(candidateRoot, 'knowledge', 'candidate.md'), '# Candidate\n')
          return { applied: true, summary: 'created measured knowledge' }
        },
        evaluate: passingMetric,
      })
      const candidate = knowledgeImprovementCandidateRef(staged)
      await promoteKnowledgeCandidate({ root, candidate })

      await expect(
        restoreKnowledgeCandidateBaseline({
          root,
          candidate,
          onState() {
            throw new Error('operator stopped after restore state persistence')
          },
        }),
      ).rejects.toThrow(/operator stopped/)

      const recovered = await restoreKnowledgeCandidateBaseline({ root, candidate })
      expect(recovered).toMatchObject({
        promoted: false,
        blocked: false,
        state: { status: 'candidate-ready' },
        mutation: {
          target: 'baseline',
          beforeHash: candidate.candidateHash,
          afterHash: candidate.baseHash,
          changed: true,
          transactionId: expect.any(String),
          recovered: true,
        },
      })
      expect(await hashKnowledgeBase(root)).toBe(candidate.baseHash)
      const events = await loadKnowledgeImprovementEvents(root, candidate.runId)
      expect(events.filter((event) => event.type === 'candidate.restored')).toHaveLength(1)
      const transactions = await readdir(join(root, '.agent-knowledge', 'file-transactions'))
      expect(transactions.filter((entry) => entry.startsWith('active-'))).toEqual([])

      await expect(restoreKnowledgeCandidateBaseline({ root, candidate })).resolves.toMatchObject({
        promoted: false,
        blocked: false,
      })
      const repeatedEvents = await loadKnowledgeImprovementEvents(root, candidate.runId)
      expect(repeatedEvents.filter((event) => event.type === 'candidate.restored')).toHaveLength(1)
    })
  })

  it('finishes an interrupted approved promotion without rerunning candidate work', async () => {
    await withKb(async (root) => {
      const source = refundSource()
      let updateCalls = 0
      const staged = await improveKnowledgeBase({
        root,
        goal: 'Build billing support refund-policy knowledge',
        runId: 'interrupted-promotion',
        readinessSpecs: [refundSpec],
        strict: true,
        step: () => {
          updateCalls += 1
          return {
            done: true,
            sourceTexts: [{ uri: source.uri, text: source.text, title: source.title }],
            proposalText: refundProposal(source.id),
          }
        },
      })
      const candidate = knowledgeImprovementCandidateRef(staged)

      await expect(
        promoteKnowledgeCandidate({
          root,
          candidate,
          onState() {
            throw new Error('operator stopped after state persistence')
          },
        }),
      ).rejects.toThrow(/operator stopped/)

      const runDir = knowledgeImprovementRunDir(root, candidate.runId)
      await rm(join(runDir, 'candidates', candidate.candidateId, 'snapshots'), {
        recursive: true,
        force: true,
      })
      await rm(join(runDir, 'candidates', candidate.candidateId, 'evidence.json'), {
        force: true,
      })
      await expect(
        applyKnowledgeWriteBlocks(
          root,
          ['---FILE: knowledge/unapproved.md---', '# Unapproved', '---END FILE---'].join('\n'),
        ),
      ).rejects.toThrow(/requires its owner to resume/)
      const recovered = await promoteKnowledgeCandidate({ root, candidate })

      expect(recovered.promoted).toBe(true)
      expect(recovered.mutation).toEqual({
        target: 'candidate',
        beforeHash: candidate.baseHash,
        afterHash: candidate.candidateHash,
        changed: true,
        transactionId: expect.any(String),
        recovered: true,
      })
      expect(updateCalls).toBe(1)
      const events = await loadKnowledgeImprovementEvents(root, candidate.runId)
      expect(events.filter((event) => event.type === 'candidate.promoted')).toHaveLength(1)
      const transactionEntries = await readdir(join(root, '.agent-knowledge', 'file-transactions'))
      expect(transactionEntries.filter((entry) => entry.startsWith('active-'))).toEqual([])
    })
  })

  it('persists an approved result before closing its file transaction and never reapplies it', async () => {
    await withKb(async (root) => {
      const staged = await improveKnowledgeBase({
        root,
        goal: 'Keep approval results recoverable with their knowledge mutation',
        runId: 'protected-activation-recovery',
        updateKnowledge: async ({ candidateRoot }) => {
          await writeFile(join(candidateRoot, 'knowledge', 'candidate.md'), '# Candidate\n')
          return { applied: true, summary: 'created measured knowledge' }
        },
        evaluate: passingMetric,
      })
      const candidate = knowledgeImprovementCandidateRef(staged)
      const activation = knowledgeActivation(candidate, 'activate-candidate')
      const attemptedAt = '2026-07-17T12:00:00.000Z'
      const transactionRoot = join(root, '.agent-knowledge', 'file-transactions')
      let interruptedMutation: KnowledgeImprovementMutationReceipt | undefined

      await expect(
        promoteKnowledgeCandidate({
          root,
          candidate,
          activation: {
            activation,
            attemptedAt,
            identity: 'knowledge:test',
            createResult(mutation) {
              interruptedMutation = mutation
              throw new Error('activation result store unavailable')
            },
          },
        }),
      ).rejects.toThrow(/activation result store unavailable/)
      expect(interruptedMutation).toMatchObject({
        target: 'candidate',
        beforeHash: candidate.baseHash,
        afterHash: candidate.candidateHash,
        changed: true,
        transactionId: expect.any(String),
        recovered: false,
      })
      await expect(hashKnowledgeBase(root)).rejects.toThrow(/requires its owner to resume/)
      await expect(readFile(join(root, 'knowledge', 'candidate.md'), 'utf8')).resolves.toBe(
        '# Candidate\n',
      )
      expect(
        (await readdir(transactionRoot)).filter((entry) => entry.startsWith('active-')),
      ).toHaveLength(1)
      const pending = await inspectPendingKnowledgeMutation(root)
      expect(pending).toMatchObject({
        transactionId: interruptedMutation?.transactionId,
        recoveryOwner: `knowledge-improvement-activation:${activation.digest}`,
      })
      await expect(
        recoverPendingKnowledgeMutation(root, {
          transactionId: pending!.transactionId,
          action: 'apply',
        }),
      ).rejects.toThrow(/must be resumed by 'knowledge-improvement-activation:sha256:/)
      await expect(promoteKnowledgeCandidate({ root, candidate })).rejects.toThrow(
        /must be resumed by 'knowledge-improvement-activation:sha256:/,
      )
      await expect(
        loadKnowledgeImprovementActivationResult({
          root,
          candidate,
          activation,
          identity: 'knowledge:test',
        }),
      ).resolves.toBeNull()
      await expect(
        improveKnowledgeBase({
          root,
          goal: 'Keep approval results recoverable with their knowledge mutation',
          runId: 'protected-activation-recovery',
        }),
      ).rejects.toThrow(/requires its owner to resume/)

      const recovered = await promoteKnowledgeCandidate({
        root,
        candidate,
        activation: {
          activation,
          attemptedAt,
          identity: 'knowledge:test',
          createResult: (mutation) =>
            knowledgeActivationResult(activation, candidate, mutation, attemptedAt),
        },
      })
      expect(recovered.mutation).toEqual({
        ...interruptedMutation,
        recovered: true,
      })
      expect(recovered.activationResult?.outcome.status).toBe('applied')
      expect(
        (await readdir(transactionRoot)).filter((entry) => entry.startsWith('active-')),
      ).toEqual([])
      await expect(
        loadKnowledgeImprovementActivationResult({
          root,
          candidate,
          activation,
          identity: 'knowledge:test',
        }),
      ).resolves.toEqual(recovered.activationResult)

      await restoreKnowledgeCandidateBaseline({ root, candidate })
      await expect(hashKnowledgeBase(root)).resolves.toBe(candidate.baseHash)
      const retried = await promoteKnowledgeCandidate({
        root,
        candidate,
        activation: {
          activation,
          attemptedAt,
          identity: 'knowledge:test',
          createResult() {
            throw new Error('durable activation must not be recomputed')
          },
        },
      })
      expect(retried.activationResult).toEqual(recovered.activationResult)
      await expect(hashKnowledgeBase(root)).resolves.toBe(candidate.baseHash)
    })
  })

  it('repairs blocked run state and its event from a durable conflict result', async () => {
    await withKb(async (root) => {
      const staged = await improveKnowledgeBase({
        root,
        goal: 'Keep conflict results and run state consistent',
        runId: 'activation-conflict-recovery',
        updateKnowledge: async ({ candidateRoot }) => {
          await writeFile(join(candidateRoot, 'knowledge', 'candidate.md'), '# Candidate\n')
          return { applied: true, summary: 'created measured knowledge' }
        },
        evaluate: passingMetric,
      })
      const candidate = knowledgeImprovementCandidateRef(staged)
      await promoteKnowledgeCandidate({ root, candidate })
      await writeFile(join(root, 'knowledge', 'candidate.md'), '# Concurrent change\n')
      const activation = knowledgeActivation(candidate, 'restore-baseline')
      const attemptedAt = '2026-07-17T12:00:00.000Z'

      await expect(
        restoreKnowledgeCandidateBaseline({
          root,
          candidate,
          activation: {
            activation,
            attemptedAt,
            identity: 'knowledge:test',
            createResult: (mutation) =>
              knowledgeActivationResult(activation, candidate, mutation, attemptedAt),
          },
          onState() {
            throw new Error('operator stopped before conflict event persistence')
          },
        }),
      ).rejects.toThrow(/operator stopped before conflict event persistence/)
      const stored = await loadKnowledgeImprovementActivationResult({
        root,
        candidate,
        activation,
        identity: 'knowledge:test',
      })
      expect(stored?.outcome.status).toBe('conflict')
      expect(
        (await loadKnowledgeImprovementEvents(root, candidate.runId)).filter(
          (event) => event.type === 'restore.blocked',
        ),
      ).toHaveLength(0)

      const recovered = await restoreKnowledgeCandidateBaseline({
        root,
        candidate,
        activation: {
          activation,
          attemptedAt,
          identity: 'knowledge:test',
          createResult() {
            throw new Error('durable conflict result must not be recomputed')
          },
        },
      })
      expect(recovered).toMatchObject({
        promoted: false,
        blocked: true,
        state: { status: 'blocked' },
        candidate: { status: 'blocked' },
      })
      expect(recovered.activationResult).toEqual(stored)
      await restoreKnowledgeCandidateBaseline({
        root,
        candidate,
        activation: {
          activation,
          attemptedAt,
          identity: 'knowledge:test',
          createResult() {
            throw new Error('durable conflict result must not be recomputed')
          },
        },
      })
      expect(
        (await loadKnowledgeImprovementEvents(root, candidate.runId)).filter(
          (event) => event.type === 'restore.blocked',
        ),
      ).toHaveLength(1)
    })
  })

  it('binds already-applied promotion and baseline restore to their exact activation', async () => {
    await withKb(async (root) => {
      const staged = await improveKnowledgeBase({
        root,
        goal: 'Record exact no-op and restore activation outcomes',
        runId: 'activation-already-and-restore',
        updateKnowledge: async ({ candidateRoot }) => {
          await writeFile(join(candidateRoot, 'knowledge', 'candidate.md'), '# Candidate\n')
          return { applied: true, summary: 'created measured knowledge' }
        },
        evaluate: passingMetric,
      })
      const candidate = knowledgeImprovementCandidateRef(staged)
      await promoteKnowledgeCandidate({ root, candidate })
      const attemptedAt = '2026-07-17T12:00:00.000Z'
      const promoteActivation = knowledgeActivation(candidate, 'activate-candidate')

      const already = await promoteKnowledgeCandidate({
        root,
        candidate,
        activation: {
          activation: promoteActivation,
          attemptedAt,
          identity: 'knowledge:test',
          createResult: (mutation) =>
            knowledgeActivationResult(promoteActivation, candidate, mutation, attemptedAt),
        },
      })
      expect(already.mutation).toEqual({
        target: 'candidate',
        beforeHash: candidate.candidateHash,
        afterHash: candidate.candidateHash,
        changed: false,
        transactionId: null,
        recovered: false,
      })
      expect(already.activationResult?.outcome.status).toBe('already-applied')
      await expect(
        loadKnowledgeImprovementActivationResult({
          root,
          candidate,
          activation: promoteActivation,
          identity: 'knowledge:test',
        }),
      ).resolves.toEqual(already.activationResult)

      const restoreActivation = knowledgeActivation(candidate, 'restore-baseline')
      const restored = await restoreKnowledgeCandidateBaseline({
        root,
        candidate,
        activation: {
          activation: restoreActivation,
          attemptedAt,
          identity: 'knowledge:test',
          createResult: (mutation) =>
            knowledgeActivationResult(restoreActivation, candidate, mutation, attemptedAt),
        },
      })
      expect(restored.mutation).toMatchObject({
        target: 'baseline',
        beforeHash: candidate.candidateHash,
        afterHash: candidate.baseHash,
        changed: true,
        transactionId: expect.any(String),
        recovered: false,
      })
      expect(restored.activationResult?.outcome.status).toBe('applied')
      await expect(
        loadKnowledgeImprovementActivationResult({
          root,
          candidate,
          activation: restoreActivation,
          identity: 'knowledge:test',
        }),
      ).resolves.toEqual(restored.activationResult)
      await expect(hashKnowledgeBase(root)).resolves.toBe(candidate.baseHash)
    })
  })

  it('does not return a successful mutation receipt when a state callback changes knowledge', async () => {
    await withKb(async (root) => {
      const staged = await improveKnowledgeBase({
        root,
        goal: 'Reject post-commit knowledge changes',
        runId: 'post-commit-change',
        updateKnowledge: async ({ candidateRoot }) => {
          await writeFile(join(candidateRoot, 'knowledge', 'candidate.md'), '# Candidate\n')
          return { applied: true, summary: 'created measured knowledge' }
        },
        evaluate: passingMetric,
      })
      const candidate = knowledgeImprovementCandidateRef(staged)

      await expect(
        promoteKnowledgeCandidate({
          root,
          candidate,
          async onState() {
            await writeFile(join(root, 'knowledge', 'unmeasured.md'), '# Unmeasured\n')
          },
        }),
      ).rejects.toThrow(/changed before its result was returned/)
      await expect(hashKnowledgeBase(root)).rejects.toThrow(/requires its owner to resume/)
      await expect(readFile(join(root, 'knowledge', 'unmeasured.md'), 'utf8')).resolves.toBe(
        '# Unmeasured\n',
      )
    })
  })

  it('fails fast when another active operator owns the run lease', async () => {
    await withKb(async (root) => {
      let releaseStep!: () => void
      let markStarted!: () => void
      const started = new Promise<void>((resolve) => {
        markStarted = resolve
      })
      const released = new Promise<void>((resolve) => {
        releaseStep = resolve
      })
      const first = improveKnowledgeBase({
        root,
        goal: 'Locked run',
        runId: 'locked',
        updateKnowledge: async () => {
          markStarted()
          await released
          return { applied: true, summary: 'finished' }
        },
        evaluate: passingMetric,
      })
      await started

      await expect(
        improveKnowledgeBase({
          root,
          goal: 'Locked run',
          runId: 'locked',
          readinessSpecs: [refundSpec],
        }),
      ).rejects.toThrow(/Lock file is already being held/)
      releaseStep()
      await first
    })
  })

  it('serializes package writers against approved promotion', async () => {
    await withKb(async (root) => {
      const staged = await improveKnowledgeBase({
        root,
        goal: 'Create measured knowledge',
        runId: 'writer-race',
        updateKnowledge: async ({ candidateRoot }) => {
          await writeFile(join(candidateRoot, 'knowledge', 'measured.md'), '# Measured\n')
          return { applied: true, summary: 'created measured knowledge' }
        },
        evaluate: passingMetric,
      })
      const candidate = knowledgeImprovementCandidateRef(staged)
      let releaseWriter!: () => void
      let markStarted!: () => void
      const started = new Promise<void>((resolve) => {
        markStarted = resolve
      })
      const released = new Promise<void>((resolve) => {
        releaseWriter = resolve
      })
      const writer = withKnowledgeMutation(root, async () => {
        markStarted()
        await released
        await applyKnowledgeWriteBlocks(
          root,
          ['---FILE: knowledge/concurrent.md---', '# Concurrent', '---END FILE---'].join('\n'),
        )
      })
      await started

      const promotion = promoteKnowledgeCandidate({ root, candidate })
      const beforeRelease = await Promise.race([
        promotion.then(
          () => 'settled',
          () => 'settled',
        ),
        new Promise<'waiting'>((resolve) => setTimeout(() => resolve('waiting'), 50)),
      ])
      expect(beforeRelease).toBe('waiting')
      releaseWriter()
      await writer
      await expect(promotion).resolves.toMatchObject({ promoted: false, blocked: true })
      await expect(readFile(join(root, 'knowledge', 'concurrent.md'), 'utf8')).resolves.toContain(
        'Concurrent',
      )
      await expect(readFile(join(root, 'knowledge', 'measured.md'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
    })
  })
})
