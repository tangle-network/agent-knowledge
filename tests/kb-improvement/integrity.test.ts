import { createHash } from 'node:crypto'
import {
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
import { describe, expect, it } from 'vitest'
import {
  knowledgeImprovementCandidateRef,
  knowledgeImprovementRunDir,
  loadKnowledgeImprovementState,
  promoteKnowledgeCandidate,
  withKnowledgeImprovementCandidate,
} from '../../src/index'
import {
  improveAndPromote,
  improveTestKnowledgeBase as improveKnowledgeBase,
  passingMetric,
  refundProposal,
  refundSource,
  refundSpec,
  withEmptyRoot,
  withKb,
} from '../support/kb-improvement'

describe('improveKnowledgeBase', () => {
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

  it('rejects candidate use when persisted implementation identity differs from evidence', async () => {
    await withKb(async (root) => {
      const staged = await improveKnowledgeBase({
        root,
        goal: 'Bind approved evidence to implementation identity',
        runId: 'candidate-implementation-evidence',
        evaluate: passingMetric,
      })
      const candidate = knowledgeImprovementCandidateRef(staged)
      const runDir = knowledgeImprovementRunDir(root, staged.runId)
      const statePath = join(runDir, 'state.json')
      const state = JSON.parse(await readFile(statePath, 'utf8')) as {
        implementationRef: string
      }
      state.implementationRef =
        'sha256:3333333333333333333333333333333333333333333333333333333333333333'
      await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`)

      await expect(promoteKnowledgeCandidate({ root, candidate })).rejects.toThrow(
        'knowledge candidate evidence does not match the approved candidate',
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
})
