import { createHash } from 'node:crypto'
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import {
  type AgentImprovementActivation,
  type AgentImprovementActivationResult,
  canonicalCandidateDigest,
  type Sha256Digest,
} from '@tangle-network/agent-interface'
import { describe, expect, it } from 'vitest'
import {
  applyKnowledgeWriteBlocks,
  buildEvalKnowledgeBundle,
  buildKnowledgeIndex,
  defineReadinessSpec,
  evaluateKnowledgeBaseReadiness,
  hashKnowledgeBase,
  improveKnowledgeBase,
  initKnowledgeBase,
  inspectPendingKnowledgeMutation,
  type KnowledgeImprovementCandidateRef,
  type KnowledgeImprovementMutationReceipt,
  knowledgeImprovementCandidateRef,
  knowledgeImprovementRunDir,
  loadKnowledgeImprovementActivationResult,
  loadKnowledgeImprovementEvents,
  loadKnowledgeImprovementState,
  promoteKnowledgeCandidate,
  recoverPendingKnowledgeMutation,
  restoreKnowledgeCandidateBaseline,
  sha256,
  stableId,
  withKnowledgeImprovementCandidate,
  withKnowledgeImprovementComparison,
} from '../src/index'
import { withKnowledgeMutation } from '../src/mutation-lock'

async function withKb(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agent-knowledge-improve-'))
  try {
    await initKnowledgeBase(root)
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function withEmptyRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agent-knowledge-improve-empty-'))
  try {
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function mutableCandidateRoot(
  root: string,
  result: { runId: string; candidate?: { candidateId: string } },
): string {
  if (!result.candidate) throw new Error('knowledge improvement result has no candidate')
  return join(
    knowledgeImprovementRunDir(root, result.runId),
    'candidates',
    result.candidate.candidateId,
    'workspace',
  )
}

const refundSpec = defineReadinessSpec({
  id: 'refund-policy',
  description: 'Refund policy support knowledge',
  query: 'refund policy customer billing refund',
  requiredFor: ['support-agent'],
  importance: 'blocking',
  minHits: 1,
  minSources: 1,
})

function refundSource() {
  const text = 'The billing support refund policy allows refunds within 30 days with receipt proof.'
  const uri = 'research://refund-policy'
  return {
    uri,
    text,
    title: 'Refund Policy Source',
    id: stableId('src', `${sha256(text)}:${uri}`),
  }
}

function refundProposal(sourceId: string, extra = ''): string {
  return [
    '---FILE: knowledge/support/refund-policy.md---',
    '---',
    'id: refund-policy',
    'title: Refund Policy',
    'sources:',
    `  - ${sourceId}`,
    '---',
    '# Refund Policy',
    'Billing support can grant a customer refund within 30 days when receipt proof is present.',
    extra,
    '---END FILE---',
  ].join('\n')
}

function passingMetric() {
  return {
    score: 1,
    passed: true,
    provenance: {
      evaluator: 'agent-knowledge-test',
      version: '1',
      method: 'deterministic' as const,
    },
  }
}

function candidateDigest(seed: string): Sha256Digest {
  return canonicalCandidateDigest({ seed })
}

function canonicalDocument<T extends Record<string, unknown>>(
  material: T,
): T & { digest: Sha256Digest } {
  return { ...material, digest: canonicalCandidateDigest(material) }
}

function knowledgeActivation(
  candidate: KnowledgeImprovementCandidateRef,
  intent: AgentImprovementActivation['intent'],
  identity = 'knowledge:test',
): AgentImprovementActivation {
  const expectedBaseHash =
    intent === 'activate-candidate' ? candidate.baseHash : candidate.candidateHash
  return canonicalDocument({
    kind: 'agent-improvement-activation' as const,
    proposalDigest: candidateDigest('proposal'),
    reviewDigest: candidateDigest('review'),
    experimentDigest: candidateDigest('experiment'),
    candidateBundleDigest: candidateDigest('candidate-bundle'),
    intent,
    targets: [
      {
        surface: 'knowledge' as const,
        identity,
        expectedBaseDigest: `sha256:${expectedBaseHash}` as Sha256Digest,
      },
    ] as AgentImprovementActivation['targets'],
    fundingOwner: 'tenant:test',
    authorizedBy: 'reviewer:test',
    authorizedAt: '2026-07-17T00:00:00.000Z',
    expiresAt: '2026-07-18T00:00:00.000Z',
  })
}

function knowledgeActivationResult(
  activation: AgentImprovementActivation,
  candidate: KnowledgeImprovementCandidateRef,
  mutation: KnowledgeImprovementMutationReceipt,
  attemptedAt: string,
  identity = 'knowledge:test',
): AgentImprovementActivationResult {
  const desiredHash =
    activation.intent === 'activate-candidate' ? candidate.candidateHash : candidate.baseHash
  const outcome: AgentImprovementActivationResult['outcome'] = mutation.changed
    ? {
        status: 'applied',
        transactionId: mutation.transactionId!,
        targets: [
          {
            surface: 'knowledge',
            identity,
            beforeDigest: `sha256:${mutation.beforeHash}`,
            afterDigest: `sha256:${mutation.afterHash}`,
          },
        ],
      }
    : mutation.afterHash === desiredHash
      ? {
          status: 'already-applied',
          targets: [
            {
              surface: 'knowledge',
              identity,
              currentDigest: `sha256:${mutation.afterHash}`,
            },
          ],
        }
      : {
          status: 'conflict',
          targets: [
            {
              surface: 'knowledge',
              identity,
              currentDigest: `sha256:${mutation.afterHash}`,
            },
          ],
        }
  return canonicalDocument({
    kind: 'agent-improvement-activation-result' as const,
    idempotencyKey: activation.digest,
    attemptedAt,
    completedAt: attemptedAt,
    outcome,
  })
}

async function improveAndPromote(options: Parameters<typeof improveKnowledgeBase>[0]) {
  const staged = await improveKnowledgeBase(options)
  const promoted = await promoteKnowledgeCandidate({
    root: options.root,
    candidate: knowledgeImprovementCandidateRef(staged),
  })
  return { ...promoted, evaluation: staged.evaluation, lifecycle: staged.lifecycle }
}

describe('improveKnowledgeBase', () => {
  it('leaves the live knowledge base unchanged unless promotion is explicit', async () => {
    await withEmptyRoot(async (root) => {
      const before = await hashKnowledgeBase(root)
      await expect(stat(join(root, '.agent-knowledge'))).rejects.toMatchObject({ code: 'ENOENT' })
      const result = await improveKnowledgeBase({
        root,
        goal: 'Create a measured candidate without applying it',
        runId: 'propose-only-default',
        updateKnowledge: async ({ candidateRoot }) => {
          await writeFile(join(candidateRoot, 'knowledge', 'candidate.md'), '# Candidate\n')
          return { applied: true, summary: 'created candidate' }
        },
        evaluate: passingMetric,
      })

      expect(result.promoted).toBe(false)
      expect(result.state.status).toBe('candidate-ready')
      expect(result.candidate?.candidateHash).not.toBe(before)
      await expect(hashKnowledgeBase(root)).resolves.toBe(before)
      await expect(readFile(join(root, 'knowledge', 'candidate.md'), 'utf8')).rejects.toMatchObject(
        {
          code: 'ENOENT',
        },
      )
      await expect(stat(join(root, 'knowledge'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(stat(join(root, 'raw'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(
        readFile(join(root, '.agent-knowledge', 'sources.json'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('does not reapply a promoted candidate when the improvement run is reopened', async () => {
    await withEmptyRoot(async (root) => {
      const options = {
        root,
        goal: 'Keep candidate generation separate from activation',
        runId: 'reopen-promoted-run',
        updateKnowledge: async ({ candidateRoot }: { candidateRoot: string }) => {
          await writeFile(join(candidateRoot, 'knowledge', 'candidate.md'), '# Candidate\n')
          return { applied: true, summary: 'created candidate' }
        },
        evaluate: passingMetric,
      }
      const staged = await improveKnowledgeBase(options)
      const candidate = knowledgeImprovementCandidateRef(staged)
      await promoteKnowledgeCandidate({ root, candidate })
      await rm(join(root, 'knowledge', 'candidate.md'))
      const liveBeforeReopen = await hashKnowledgeBase(root)

      await expect(improveKnowledgeBase(options)).rejects.toThrow(/promoted knowledge base changed/)
      expect(await hashKnowledgeBase(root)).toBe(liveBeforeReopen)
      await expect(readFile(join(root, 'knowledge', 'candidate.md'), 'utf8')).rejects.toMatchObject(
        { code: 'ENOENT' },
      )
    })
  })

  it('rejects evaluator results without provenance', async () => {
    await withKb(async (root) => {
      await expect(
        improveKnowledgeBase({
          root,
          goal: 'Reject an anonymous evaluation',
          runId: 'anonymous-evaluator',
          updateKnowledge: async ({ candidateRoot }) => {
            await writeFile(join(candidateRoot, 'knowledge', 'candidate.md'), '# Candidate\n')
            return { applied: true, summary: 'created candidate' }
          },
          evaluate: (() => ({ score: 1, passed: true })) as never,
        }),
      ).rejects.toThrow(/provenance/)
    })
  })

  it('does not create improvement state through a symbolic-link metadata directory', async () => {
    await withEmptyRoot(async (root) => {
      const outside = await mkdtemp(join(tmpdir(), 'agent-knowledge-improvement-outside-'))
      try {
        await symlink(outside, join(root, '.agent-knowledge'))
        await expect(
          improveKnowledgeBase({
            root,
            goal: 'Reject redirected improvement state',
            runId: 'redirected-state',
          }),
        ).rejects.toThrow(/unsafe directory/)
        await expect(stat(join(outside, 'improvements'))).rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    })
  })

  it.skipIf(process.platform !== 'linux')(
    'rejects a run directory swapped while candidate work is active',
    async () => {
      await withKb(async (root) => {
        const outside = await mkdtemp(join(tmpdir(), 'agent-knowledge-run-outside-'))
        const runId = 'run-directory-swap'
        const runDir = knowledgeImprovementRunDir(root, runId)
        try {
          await expect(
            improveKnowledgeBase({
              root,
              goal: 'Reject redirected run state',
              runId,
              async updateKnowledge({ candidateRoot }) {
                await writeFile(join(candidateRoot, 'knowledge', 'candidate.md'), '# Candidate\n')
                await rename(runDir, `${runDir}-original`)
                await symlink(outside, runDir)
                return { applied: true, summary: 'candidate written before redirect' }
              },
              evaluate: passingMetric,
            }),
          ).rejects.toThrow(/unsafe directory|changed during use/)
          await expect(readFile(join(outside, 'state.json'), 'utf8')).rejects.toMatchObject({
            code: 'ENOENT',
          })
        } finally {
          await rm(outside, { recursive: true, force: true })
        }
      })
    },
  )

  it('evaluates root-level KB readiness without running an improvement loop', async () => {
    await withKb(async (root) => {
      const empty = await evaluateKnowledgeBaseReadiness({
        root,
        goal: 'Build billing support refund-policy knowledge',
        readinessSpecs: [refundSpec],
        strict: true,
      })

      expect(empty.ready).toBe(false)
      expect(empty.dimensions.blocking_readiness).toBe(0)
      expect(empty.summary).toContain('blocking readiness requirement')

      const source = refundSource()
      const improved = await improveAndPromote({
        root,
        goal: 'Build billing support refund-policy knowledge',
        runId: 'readiness-evaluator',
        readinessSpecs: [refundSpec],
        strict: true,
        step: () => ({
          done: true,
          sourceTexts: [{ uri: source.uri, text: source.text, title: source.title }],
          proposalText: refundProposal(source.id),
        }),
      })
      expect(improved.promoted).toBe(true)

      const ready = await evaluateKnowledgeBaseReadiness({
        root,
        goal: 'Build billing support refund-policy knowledge',
        readinessSpecs: [refundSpec],
        strict: true,
      })

      expect(ready.ready).toBe(true)
      expect(ready.summary).toBe('knowledge base passed readiness checks')
      expect(ready.dimensions).toMatchObject({
        validation: 1,
        kb_quality: 1,
        blocking_readiness: 1,
      })
    })
  })

  it('promotes a candidate KB after readiness separates weak from strong', async () => {
    await withKb(async (root) => {
      const emptyIndex = await buildKnowledgeIndex(root)
      const emptyReadiness = buildEvalKnowledgeBundle({
        taskId: 'support-agent',
        index: emptyIndex,
        specs: [refundSpec],
      })
      expect(emptyReadiness.report.blockingMissingRequirements).toHaveLength(1)

      const source = refundSource()
      const result = await improveAndPromote({
        root,
        goal: 'Build billing support refund-policy knowledge',
        runId: 'refund-improvement',
        readinessSpecs: [refundSpec],
        strict: true,
        step: () => ({
          done: true,
          sourceTexts: [{ uri: source.uri, text: source.text, title: source.title }],
          proposalText: refundProposal(source.id),
        }),
      })

      expect(result.promoted).toBe(true)
      expect(result.state.status).toBe('promoted')
      expect(result.evaluation?.score).toBe(1)
      expect(
        result.lifecycle?.phases.some(
          (phase) => phase.phase === 'knowledge-update' && phase.status === 'completed',
        ),
      ).toBe(true)

      const promotedIndex = await buildKnowledgeIndex(root)
      expect(promotedIndex.pages.map((page) => page.id)).toContain('refund-policy')
      const promotedReadiness = buildEvalKnowledgeBundle({
        taskId: 'support-agent',
        index: promotedIndex,
        specs: [refundSpec],
      })
      expect(promotedReadiness.report.blockingMissingRequirements).toHaveLength(0)
    })
  })

  it('resumes a candidate workspace after an external edit and promotes the edited artifact', async () => {
    await withKb(async (root) => {
      const source = refundSource()
      const first = await improveKnowledgeBase({
        root,
        goal: 'Build billing support refund-policy knowledge',
        runId: 'resume-edit',
        readinessSpecs: [refundSpec],
        strict: true,
        step: () => ({
          done: true,
          sourceTexts: [{ uri: source.uri, text: source.text, title: source.title }],
          proposalText: refundProposal(source.id),
        }),
      })

      expect(first.promoted).toBe(false)
      expect(first.state.status).toBe('candidate-ready')
      const candidateRoot = mutableCandidateRoot(root, first)

      const editedPage = join(candidateRoot!, 'knowledge', 'support', 'refund-escalation.md')
      await mkdir(dirname(editedPage), { recursive: true })
      await writeFile(
        editedPage,
        [
          '---',
          'id: refund-escalation',
          'title: Refund Escalation',
          'sources:',
          `  - ${source.id}`,
          '---',
          '# Refund Escalation',
          'Escalate refund requests that lack receipt proof.',
        ].join('\n'),
      )

      const resumed = await improveAndPromote({
        root,
        goal: 'Build billing support refund-policy knowledge',
        runId: 'resume-edit',
        readinessSpecs: [refundSpec],
        strict: true,
      })

      expect(resumed.promoted).toBe(true)
      const promoted = await readFile(
        join(root, 'knowledge', 'support', 'refund-escalation.md'),
        'utf8',
      )
      expect(promoted).toContain('Escalate refund requests')
    })
  })

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

  it('restores the exact frozen baseline and can apply the same candidate again', async () => {
    await withKb(async (root) => {
      const originalPage = join(root, 'knowledge', 'original.md')
      const originalSource = join(root, 'raw', 'sources', 'original.txt')
      await writeFile(originalPage, '# Original\n')
      await writeFile(originalSource, 'original evidence\n')
      const baseHash = await hashKnowledgeBase(root)
      const staged = await improveKnowledgeBase({
        root,
        goal: 'Replace the original knowledge with a measured candidate',
        runId: 'restore-baseline',
        updateKnowledge: async ({ candidateRoot }) => {
          await writeFile(join(candidateRoot, 'knowledge', 'original.md'), '# Changed\n')
          await writeFile(join(candidateRoot, 'knowledge', 'candidate.md'), '# Candidate\n')
          await rm(join(candidateRoot, 'raw', 'sources', 'original.txt'))
          return { applied: true, summary: 'changed, added, and deleted measured files' }
        },
        evaluate: passingMetric,
      })
      const candidate = knowledgeImprovementCandidateRef(staged)

      const promoted = await promoteKnowledgeCandidate({ root, candidate })
      expect(promoted).toMatchObject({
        promoted: true,
        blocked: false,
      })
      expect(promoted.mutation).toEqual({
        target: 'candidate',
        beforeHash: baseHash,
        afterHash: candidate.candidateHash,
        changed: true,
        transactionId: expect.any(String),
        recovered: false,
      })
      expect(await hashKnowledgeBase(root)).toBe(candidate.candidateHash)

      const restored = await restoreKnowledgeCandidateBaseline({ root, candidate })
      expect(restored).toMatchObject({
        promoted: false,
        blocked: false,
        state: { status: 'candidate-ready' },
        candidate: { status: 'candidate-ready' },
      })
      expect(restored.mutation).toEqual({
        target: 'baseline',
        beforeHash: candidate.candidateHash,
        afterHash: baseHash,
        changed: true,
        transactionId: expect.any(String),
        recovered: false,
      })
      expect(restored.state.promotedCandidateId).toBeUndefined()
      expect(await hashKnowledgeBase(root)).toBe(baseHash)
      await expect(readFile(originalPage, 'utf8')).resolves.toBe('# Original\n')
      await expect(readFile(originalSource, 'utf8')).resolves.toBe('original evidence\n')
      await expect(readFile(join(root, 'knowledge', 'candidate.md'), 'utf8')).rejects.toMatchObject(
        {
          code: 'ENOENT',
        },
      )

      await expect(promoteKnowledgeCandidate({ root, candidate })).resolves.toMatchObject({
        promoted: true,
        blocked: false,
      })
      expect(await hashKnowledgeBase(root)).toBe(candidate.candidateHash)
      const events = await loadKnowledgeImprovementEvents(root, candidate.runId)
      expect(events.filter((event) => event.type === 'candidate.promoted')).toHaveLength(1)
      expect(events.filter((event) => event.type === 'candidate.restored')).toHaveLength(1)
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

  it('blocks restore without overwriting knowledge changed after promotion', async () => {
    await withKb(async (root) => {
      const page = join(root, 'knowledge', 'candidate.md')
      const staged = await improveKnowledgeBase({
        root,
        goal: 'Preserve concurrent edits during restore',
        runId: 'restore-conflict',
        updateKnowledge: async ({ candidateRoot }) => {
          await writeFile(join(candidateRoot, 'knowledge', 'candidate.md'), '# Candidate\n')
          return { applied: true, summary: 'created measured knowledge' }
        },
        evaluate: passingMetric,
      })
      const candidate = knowledgeImprovementCandidateRef(staged)
      await promoteKnowledgeCandidate({ root, candidate })
      await writeFile(page, '# Concurrent change\n')

      const restored = await restoreKnowledgeCandidateBaseline({ root, candidate })

      expect(restored).toMatchObject({
        promoted: false,
        blocked: true,
        state: { status: 'blocked' },
        candidate: { status: 'blocked' },
      })
      expect(restored.state.promotedCandidateId).toBeUndefined()
      await expect(readFile(page, 'utf8')).resolves.toBe('# Concurrent change\n')
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

  it('rejects a forged promotion journal entry outside the measured knowledge files', async () => {
    await withKb(async (root) => {
      const packagePath = join(root, 'package.json')
      const originalPackage = '{"private":true}\n'
      const forgedPackage = '{"scripts":{"postinstall":"malicious"}}\n'
      await writeFile(packagePath, originalPackage)
      const staged = await improveKnowledgeBase({
        root,
        goal: 'Prepare an exact knowledge-only candidate',
        runId: 'forged-promotion-journal',
        updateKnowledge: async ({ candidateRoot }) => {
          await writeFile(join(candidateRoot, 'knowledge', 'candidate.md'), '# Candidate\n')
          return { applied: true, summary: 'created candidate' }
        },
        evaluate: passingMetric,
      })
      const candidate = knowledgeImprovementCandidateRef(staged)
      await expect(
        promoteKnowledgeCandidate({
          root,
          candidate,
          onState() {
            throw new Error('leave promotion pending')
          },
        }),
      ).rejects.toThrow(/leave promotion pending/)

      const transactionRoot = join(root, '.agent-knowledge', 'file-transactions')
      const activeTransactions = (await readdir(transactionRoot)).filter((entry) =>
        entry.startsWith('active-'),
      )
      expect(activeTransactions).toHaveLength(1)
      const transactionDir = join(transactionRoot, activeTransactions[0]!)
      const transactionPath = join(transactionDir, 'transaction.json')
      const transaction = JSON.parse(await readFile(transactionPath, 'utf8')) as {
        entries: Array<{
          index: number
          path: string
          beforeHash: string | null
          afterHash: string | null
          beforeMode?: number
          afterMode?: number
        }>
      }
      const index = Math.max(...transaction.entries.map((entry) => entry.index)) + 1
      transaction.entries.push({
        index,
        path: 'package.json',
        beforeHash: createHash('sha256').update(originalPackage).digest('hex'),
        afterHash: createHash('sha256').update(forgedPackage).digest('hex'),
        beforeMode: 0o644,
        afterMode: 0o644,
      })
      await mkdir(join(transactionDir, 'after'), { recursive: true })
      await writeFile(join(transactionDir, 'after', `${index}.bin`), forgedPackage)
      await writeFile(transactionPath, `${JSON.stringify(transaction, null, 2)}\n`)

      await expect(promoteKnowledgeCandidate({ root, candidate })).rejects.toThrow(
        /unsupported path: package.json/,
      )
      await expect(readFile(packagePath, 'utf8')).resolves.toBe(originalPackage)
    })
  })

  it('promotes frozen measured bytes when the mutable workspace changes after approval', async () => {
    await withKb(async (root) => {
      const source = refundSource()
      const staged = await improveKnowledgeBase({
        root,
        goal: 'Build billing support refund-policy knowledge',
        runId: 'changed-after-approval',
        readinessSpecs: [refundSpec],
        strict: true,
        step: () => ({
          done: true,
          sourceTexts: [{ uri: source.uri, text: source.text, title: source.title }],
          proposalText: refundProposal(source.id),
        }),
      })
      const candidate = knowledgeImprovementCandidateRef(staged)
      await writeFile(
        join(mutableCandidateRoot(root, staged), 'knowledge', 'support', 'refund-policy.md'),
        '# changed after approval\n',
      )

      await expect(promoteKnowledgeCandidate({ root, candidate })).resolves.toMatchObject({
        promoted: true,
      })
      await expect(
        readFile(join(root, 'knowledge', 'support', 'refund-policy.md'), 'utf8'),
      ).resolves.toContain('refund within 30 days')
      await expect(
        readFile(join(root, 'knowledge', 'support', 'refund-policy.md'), 'utf8'),
      ).resolves.not.toContain('changed after approval')
    })
  })

  it('resolves and promotes the measured snapshot after mutable workspace removal', async () => {
    await withKb(async (root) => {
      const staged = await improveKnowledgeBase({
        root,
        goal: 'Keep the measured candidate independent from scratch files',
        runId: 'removed-mutable-workspace',
        updateKnowledge: async ({ candidateRoot }) => {
          await writeFile(join(candidateRoot, 'knowledge', 'measured.md'), '# Measured\n')
          return { applied: true, summary: 'created measured knowledge' }
        },
        evaluate: passingMetric,
      })
      const candidate = knowledgeImprovementCandidateRef(staged)
      await rm(mutableCandidateRoot(root, staged), { recursive: true, force: true })
      const runDir = knowledgeImprovementRunDir(root, candidate.runId)
      let isolatedRoot = ''

      await withKnowledgeImprovementCandidate({ root, candidate }, async (resolved) => {
        isolatedRoot = resolved.root
        expect(relative(runDir, resolved.root)).toMatch(/^\.\./)
        await expect(
          readFile(join(resolved.root, 'knowledge', 'measured.md'), 'utf8'),
        ).resolves.toBe('# Measured\n')
      })
      await expect(stat(isolatedRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(promoteKnowledgeCandidate({ root, candidate })).resolves.toMatchObject({
        promoted: true,
      })
    })
  })

  it('resolves the exact frozen baseline and candidate from one measured comparison', async () => {
    await withKb(async (root) => {
      const liveBefore = await hashKnowledgeBase(root)
      const staged = await improveKnowledgeBase({
        root,
        goal: 'Compare the frozen baseline and candidate bytes',
        runId: 'paired-frozen-snapshots',
        updateKnowledge: async ({ candidateRoot }) => {
          await writeFile(join(candidateRoot, 'knowledge', 'measured.md'), '# Measured\n')
          return { applied: true, summary: 'created measured knowledge' }
        },
        evaluate: () => ({ ...passingMetric(), dimensions: { quality: 1 } }),
      })
      const candidate = knowledgeImprovementCandidateRef(staged)
      const isolatedRoots: string[] = []

      await withKnowledgeImprovementComparison({ root, candidate }, async (comparison) => {
        isolatedRoots.push(comparison.baseline.root, comparison.candidate.root)
        expect(Object.isFrozen(comparison)).toBe(true)
        expect(Object.isFrozen(comparison.baseline)).toBe(true)
        expect(Object.isFrozen(comparison.candidate)).toBe(true)
        expect(Object.isFrozen(comparison.evaluation)).toBe(true)
        expect(Object.isFrozen(comparison.evaluation.provenance)).toBe(true)
        expect(Object.isFrozen(comparison.evaluation.dimensions)).toBe(true)
        expect(comparison.reference).toEqual(candidate)
        expect(comparison.baseline.hash).toBe(candidate.baseHash)
        expect(comparison.candidate.hash).toBe(candidate.candidateHash)
        await expect(hashKnowledgeBase(comparison.baseline.root)).resolves.toBe(candidate.baseHash)
        await expect(hashKnowledgeBase(comparison.candidate.root)).resolves.toBe(
          candidate.candidateHash,
        )
        await expect(
          readFile(join(comparison.baseline.root, 'knowledge', 'measured.md'), 'utf8'),
        ).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(
          readFile(join(comparison.candidate.root, 'knowledge', 'measured.md'), 'utf8'),
        ).resolves.toBe('# Measured\n')
      })
      await expect(
        withKnowledgeImprovementComparison({ root, candidate }, ({ baseline }) =>
          writeFile(join(baseline.root, 'knowledge', 'changed.md'), '# Changed\n'),
        ),
      ).rejects.toThrow(/baseline snapshot changed during use/)

      await expect(hashKnowledgeBase(root)).resolves.toBe(liveBefore)
      for (const isolatedRoot of isolatedRoots) {
        await expect(stat(isolatedRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      }
    })
  })

  it('rejects a measured snapshot changed while an approved candidate is in use', async () => {
    await withKb(async (root) => {
      const staged = await improveKnowledgeBase({
        root,
        goal: 'Keep approved candidate execution immutable',
        runId: 'changed-during-candidate-use',
        updateKnowledge: async ({ candidateRoot }) => {
          await writeFile(join(candidateRoot, 'knowledge', 'measured.md'), '# Measured\n')
          return { applied: true, summary: 'created measured knowledge' }
        },
        evaluate: passingMetric,
      })
      const candidate = knowledgeImprovementCandidateRef(staged)

      await expect(
        withKnowledgeImprovementCandidate({ root, candidate }, async (resolved) => {
          await writeFile(join(resolved.root, 'knowledge', 'measured.md'), '# Changed\n')
        }),
      ).rejects.toThrow(/snapshot changed during use/)
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

  it('rejects a frozen measured copy changed after approval', async () => {
    await withKb(async (root) => {
      const source = refundSource()
      const staged = await improveKnowledgeBase({
        root,
        goal: 'Build billing support refund-policy knowledge',
        runId: 'changed-frozen-candidate',
        readinessSpecs: [refundSpec],
        strict: true,
        step: () => ({
          done: true,
          sourceTexts: [{ uri: source.uri, text: source.text, title: source.title }],
          proposalText: refundProposal(source.id),
        }),
      })
      const candidate = knowledgeImprovementCandidateRef(staged)
      const snapshotRoot = join(
        knowledgeImprovementRunDir(root, candidate.runId),
        'candidates',
        candidate.candidateId,
        'snapshots',
        candidate.candidateHash,
      )
      await writeFile(
        join(snapshotRoot, 'knowledge', 'support', 'refund-policy.md'),
        '# tampered measured copy\n',
      )

      await expect(promoteKnowledgeCandidate({ root, candidate })).rejects.toThrow(
        /snapshot changed after approval/,
      )
      await expect(
        readFile(join(root, 'knowledge', 'support', 'refund-policy.md'), 'utf8'),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    })
  })

  it('promotes candidate deletions exactly', async () => {
    await withKb(async (root) => {
      const obsoletePage = join(root, 'knowledge', 'obsolete.md')
      const obsoleteRaw = join(root, 'raw', 'sources', 'obsolete.txt')
      await writeFile(obsoletePage, '# Obsolete\n')
      await writeFile(obsoleteRaw, 'obsolete source\n')
      const staged = await improveKnowledgeBase({
        root,
        goal: 'Remove obsolete knowledge',
        runId: 'approved-deletions',
        updateKnowledge: async ({ candidateRoot }) => {
          await rm(join(candidateRoot, 'knowledge', 'obsolete.md'))
          await rm(join(candidateRoot, 'raw', 'sources', 'obsolete.txt'))
          return { applied: true, summary: 'removed obsolete knowledge' }
        },
        evaluate: passingMetric,
      })
      const candidate = knowledgeImprovementCandidateRef(staged)

      await promoteKnowledgeCandidate({ root, candidate })

      await expect(readFile(obsoletePage, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(obsoleteRaw, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(hashKnowledgeBase(root)).resolves.toBe(candidate.candidateHash)
    })
  })

  it.skipIf(process.platform !== 'linux')('promotes a mode-only candidate exactly', async () => {
    await withKb(async (root) => {
      const page = join(root, 'knowledge', 'mode-only.md')
      await writeFile(page, '# Same bytes\n')
      await chmod(page, 0o600)
      const staged = await improveKnowledgeBase({
        root,
        goal: 'Make the measured page executable',
        runId: 'mode-only-promotion',
        updateKnowledge: async ({ candidateRoot }) => {
          await chmod(join(candidateRoot, 'knowledge', 'mode-only.md'), 0o700)
          return { applied: true, summary: 'changed the measured file mode' }
        },
        evaluate: passingMetric,
      })
      const candidate = knowledgeImprovementCandidateRef(staged)

      expect(candidate.candidateHash).not.toBe(candidate.baseHash)
      await expect(promoteKnowledgeCandidate({ root, candidate })).resolves.toMatchObject({
        promoted: true,
      })
      expect(await readFile(page, 'utf8')).toBe('# Same bytes\n')
      expect((await stat(page)).mode & 0o777).toBe(0o700)
    })
  })

  it('promotes only measured files when the mutable workspace gains an unmeasured entry', async () => {
    await withKb(async (root) => {
      const staged = await improveKnowledgeBase({
        root,
        goal: 'Create one measured page',
        runId: 'unsupported-entry',
        updateKnowledge: async ({ candidateRoot }) => {
          await writeFile(join(candidateRoot, 'knowledge', 'measured.md'), '# Measured\n')
          return { applied: true, summary: 'created measured page' }
        },
        evaluate: passingMetric,
      })
      const candidate = knowledgeImprovementCandidateRef(staged)
      await symlink(
        join(mutableCandidateRoot(root, staged), 'knowledge', 'measured.md'),
        join(mutableCandidateRoot(root, staged), 'knowledge', 'unmeasured.md'),
      )

      await expect(promoteKnowledgeCandidate({ root, candidate })).resolves.toMatchObject({
        promoted: true,
      })
      await expect(readFile(join(root, 'knowledge', 'measured.md'), 'utf8')).resolves.toBe(
        '# Measured\n',
      )
      await expect(
        readFile(join(root, 'knowledge', 'unmeasured.md'), 'utf8'),
      ).rejects.toMatchObject({
        code: 'ENOENT',
      })
    })
  })

  it('rejects an approval whose measured evidence identity was changed', async () => {
    await withKb(async (root) => {
      const staged = await improveKnowledgeBase({
        root,
        goal: 'Create one measured page',
        runId: 'changed-evidence',
        updateKnowledge: async (input) => {
          const page = join(input.candidateRoot, 'knowledge', 'measured.md')
          await mkdir(dirname(page), { recursive: true })
          await writeFile(page, '# Measured\n')
          return { applied: true, summary: 'created measured page' }
        },
        evaluate: passingMetric,
      })
      const candidate = knowledgeImprovementCandidateRef(staged)
      const changed = { ...candidate, evidenceHash: '0'.repeat(64) }

      await expect(promoteKnowledgeCandidate({ root, candidate: changed })).rejects.toThrow(
        /does not match the measured candidate/,
      )
    })
  })

  it('binds approval to the full measured lifecycle evidence', async () => {
    await withKb(async (root) => {
      const source = refundSource()
      const staged = await improveKnowledgeBase({
        root,
        goal: 'Build billing support refund-policy knowledge',
        runId: 'full-evidence',
        readinessSpecs: [refundSpec],
        strict: true,
        step: () => ({
          done: true,
          sourceTexts: [{ uri: source.uri, text: source.text, title: source.title }],
          proposalText: refundProposal(source.id),
        }),
      })
      const candidate = knowledgeImprovementCandidateRef(staged)
      const evidencePath = join(
        knowledgeImprovementRunDir(root, candidate.runId),
        'candidates',
        candidate.candidateId,
        'evidence.json',
      )
      const evidence = JSON.parse(await readFile(evidencePath, 'utf8')) as {
        lifecycle: { knowledgeUpdate: { summary: string } }
      }
      evidence.lifecycle.knowledgeUpdate.summary = 'different measured evidence'
      await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)

      await expect(promoteKnowledgeCandidate({ root, candidate })).rejects.toThrow(
        /evidence changed after approval/,
      )
    })
  })

  it('fails loudly when persisted improvement state is malformed', async () => {
    await withKb(async (root) => {
      const runDir = knowledgeImprovementRunDir(root, 'malformed-state')
      await mkdir(runDir, { recursive: true })
      await writeFile(join(runDir, 'state.json'), '{broken')

      await expect(loadKnowledgeImprovementState(root, 'malformed-state')).rejects.toThrow()
      await writeFile(join(runDir, 'state.json'), '{}')
      await expect(loadKnowledgeImprovementState(root, 'malformed-state')).rejects.toThrow()
    })
  })

  it('rejects evaluation copied into mutable run state', async () => {
    await withKb(async (root) => {
      const staged = await improveKnowledgeBase({
        root,
        goal: 'Keep evaluation in immutable evidence only',
        runId: 'mutable-evaluation-copy',
        evaluate: passingMetric,
      })
      const runDir = knowledgeImprovementRunDir(root, staged.runId)
      const statePath = join(runDir, 'state.json')
      const state = JSON.parse(await readFile(statePath, 'utf8')) as {
        candidates: Array<Record<string, unknown>>
      }
      state.candidates[0]!.evaluation = passingMetric()
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`)

      await expect(loadKnowledgeImprovementState(root, staged.runId)).rejects.toThrow()
      await expect(
        withKnowledgeImprovementCandidate(
          { root, candidate: knowledgeImprovementCandidateRef(staged) },
          () => undefined,
        ),
      ).rejects.toThrow()
    })
  })

  it('rejects missing promotion evidence in a native current state', async () => {
    await withKb(async (root) => {
      const options = {
        root,
        goal: 'Reject corrupted current promotion state',
        runId: 'native-promoted-state',
        updateKnowledge: async ({ candidateRoot }: { candidateRoot: string }) => {
          await writeFile(join(candidateRoot, 'knowledge', 'current.md'), '# Current\n')
          return { applied: true, summary: 'created current page' }
        },
        evaluate: passingMetric,
      }
      const promoted = await improveAndPromote(options)
      const runDir = knowledgeImprovementRunDir(root, promoted.runId)
      const statePath = join(runDir, 'state.json')
      const current = JSON.parse(await readFile(statePath, 'utf8')) as {
        candidates: Array<Record<string, unknown>>
      }
      delete current.candidates[0]?.evidenceHash
      delete current.candidates[0]?.promotionPlanHash
      await writeFile(statePath, `${JSON.stringify(current, null, 2)}\n`)

      await expect(improveKnowledgeBase(options)).rejects.toThrow(
        /promoted candidates require content, evidence, and promotion-plan identities/,
      )
    })
  })

  it('encodes external run ids without allowing them to escape the improvement directory', async () => {
    await withKb(async (root) => {
      const runId = '../../victim'
      const improvementsDir = join(root, '.agent-knowledge', 'improvements')
      const runDir = knowledgeImprovementRunDir(root, runId)
      expect(relative(improvementsDir, runDir)).not.toMatch(/^\.\.(?:\/|$)/)
      await expect(
        improveKnowledgeBase({ root, goal: 'External run identity', runId }),
      ).resolves.toMatchObject({ runId })
    })
  })

  it('retries a running candidate after a crashed operator run', async () => {
    await withKb(async (root) => {
      const source = refundSource()
      await expect(
        improveKnowledgeBase({
          root,
          goal: 'Build billing support refund-policy knowledge',
          runId: 'crash-resume',
          readinessSpecs: [refundSpec],
          strict: true,
          step: () => {
            throw new Error('research worker crashed')
          },
        }),
      ).rejects.toThrow(/research worker crashed/)

      const resumed = await improveAndPromote({
        root,
        goal: 'Build billing support refund-policy knowledge',
        runId: 'crash-resume',
        readinessSpecs: [refundSpec],
        strict: true,
        step: () => ({
          done: true,
          sourceTexts: [{ uri: source.uri, text: source.text, title: source.title }],
          proposalText: refundProposal(source.id),
        }),
      })

      expect(resumed.promoted).toBe(true)
      expect(resumed.state.candidates).toHaveLength(1)
      expect(resumed.candidate?.iteration).toBe(1)
    })
  })

  it('passes the candidate KB root into updateKnowledge callbacks', async () => {
    await withKb(async (root) => {
      const seen: Array<{
        root: string
        baselineRoot: string
        candidateRoot: string
        runId: string
        iteration: number
      }> = []

      const result = await improveKnowledgeBase({
        root,
        goal: 'Let a runtime supervisor update the candidate KB',
        runId: 'candidate-update-root',
        async updateKnowledge(input) {
          seen.push({
            root: input.root,
            baselineRoot: input.baselineRoot,
            candidateRoot: input.candidateRoot,
            runId: input.runId,
            iteration: input.iteration,
          })
          const page = join(input.candidateRoot, 'knowledge', 'runtime-supervisor.md')
          await mkdir(dirname(page), { recursive: true })
          await writeFile(
            page,
            [
              '---',
              'id: runtime-supervisor',
              'title: Runtime Supervisor',
              '---',
              '# Runtime Supervisor',
              'The runtime supervisor writes to the candidate workspace only.',
            ].join('\n'),
          )
          return { applied: true, summary: 'candidate workspace updated' }
        },
        evaluate: passingMetric,
      })

      expect(result.state.status).toBe('candidate-ready')
      expect(seen).toHaveLength(1)
      expect(seen[0]!.root).toBe(seen[0]!.candidateRoot)
      expect(seen[0]).toMatchObject({
        baselineRoot: root,
        runId: 'candidate-update-root',
        iteration: 1,
      })
      await expect(
        readFile(join(root, 'knowledge', 'runtime-supervisor.md'), 'utf8'),
      ).rejects.toThrow()
      await expect(
        readFile(
          join(mutableCandidateRoot(root, result), 'knowledge', 'runtime-supervisor.md'),
          'utf8',
        ),
      ).resolves.toContain('candidate workspace only')
    })
  })

  it('blocks promotion when the live KB changed after candidate creation', async () => {
    await withKb(async (root) => {
      const source = refundSource()
      const first = await improveKnowledgeBase({
        root,
        goal: 'Build billing support refund-policy knowledge',
        runId: 'conflict',
        readinessSpecs: [refundSpec],
        strict: true,
        step: () => ({
          done: true,
          sourceTexts: [{ uri: source.uri, text: source.text, title: source.title }],
          proposalText: refundProposal(source.id),
        }),
      })
      expect(first.state.status).toBe('candidate-ready')

      const concurrentPage = join(root, 'knowledge', 'support', 'concurrent.md')
      await mkdir(dirname(concurrentPage), { recursive: true })
      await writeFile(
        concurrentPage,
        [
          '---',
          'id: concurrent',
          'title: Concurrent Edit',
          '---',
          '# Concurrent Edit',
          'A different agent edited the live KB.',
        ].join('\n'),
      )

      const blocked = await promoteKnowledgeCandidate({
        root,
        candidate: knowledgeImprovementCandidateRef(first),
      })

      expect(blocked.blocked).toBe(true)
      expect(blocked.state.status).toBe('blocked')
      expect(blocked.state.blockedReason).toMatch(/base changed before promotion/)
      expect(await readFile(concurrentPage, 'utf8')).toContain('different agent')
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

  it('runs retrieval tuning against the updated candidate KB', async () => {
    await withKb(async (root) => {
      const source = refundSource()
      const result = await improveKnowledgeBase({
        root,
        goal: 'Build billing support refund-policy knowledge',
        runId: 'retrieval',
        readinessSpecs: [refundSpec],
        strict: true,
        step: () => ({
          done: true,
          sourceTexts: [{ uri: source.uri, text: source.text, title: source.title }],
          proposalText: refundProposal(source.id),
        }),
        retrieval: {
          baseline: { k: 1 },
          scenarios: [
            {
              id: 'q-train',
              kind: 'retrieval-eval',
              query: 'refund policy',
              expected: { kind: 'page', pageId: 'refund-policy' },
            },
          ],
          holdoutScenarios: [
            {
              id: 'q-holdout',
              kind: 'retrieval-eval',
              query: 'billing refund',
              expected: { kind: 'page', pageId: 'refund-policy' },
            },
          ],
          searchSpace: { k: [1, 2] },
          retrieve: async ({ k }) => ({
            hits: [
              { pageId: 'distractor', path: 'knowledge/distractor.md', rank: 1 },
              ...(k >= 2
                ? [{ pageId: 'refund-policy', path: 'knowledge/support/refund-policy.md', rank: 2 }]
                : []),
            ],
          }),
          targetRecall: 1,
          deltaThreshold: 0.01,
          populationSize: 1,
          maxGenerations: 1,
          expectUsage: 'off',
        },
      })

      expect(result.lifecycle?.retrieval?.winnerConfig).toMatchObject({ k: 2 })
      expect(result.lifecycle?.phases.map((phase) => `${phase.phase}:${phase.status}`)).toContain(
        'retrieval-tuning:completed',
      )
    })
  })

  it('rejects a candidate when answer quality fails', async () => {
    await withKb(async (root) => {
      const source = refundSource()
      const result = await improveKnowledgeBase({
        root,
        goal: 'Build billing support refund-policy knowledge',
        runId: 'answer-quality-failure',
        readinessSpecs: [refundSpec],
        strict: true,
        step: () => ({
          done: true,
          sourceTexts: [{ uri: source.uri, text: source.text, title: source.title }],
          proposalText: refundProposal(source.id),
        }),
        evaluateAnswers: () => ({
          passed: false,
          metrics: { faithfulness: 0, answer_relevance: 0.8 },
          findings: [
            {
              id: 'refund-answer:faithfulness',
              kind: 'generator-unsupported-claim',
              severity: 'error',
              message: 'The answer made an unsupported claim.',
            },
          ],
        }),
      })

      expect(result.promoted).toBe(false)
      expect(result.state.status).toBe('rejected')
      expect(result.evaluation?.passed).toBe(false)
      expect(result.evaluation?.notes).toContain('answer quality failed')
    })
  })

  it('hashes only promoted KB surfaces, not improvement run scratch space', async () => {
    await withKb(async (root) => {
      const before = await hashKnowledgeBase(root)
      const runDir = knowledgeImprovementRunDir(root, 'scratch')
      await mkdir(runDir, { recursive: true })
      await writeFile(join(runDir, 'scratch.txt'), 'scratch state')
      await expect(hashKnowledgeBase(root)).resolves.toBe(before)
    })
  })
})
