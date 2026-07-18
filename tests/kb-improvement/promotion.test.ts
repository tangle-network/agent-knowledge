import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  hashKnowledgeBase,
  improveKnowledgeBase,
  knowledgeImprovementCandidateRef,
  knowledgeImprovementRunDir,
  loadKnowledgeImprovementEvents,
  promoteKnowledgeCandidate,
  restoreKnowledgeCandidateBaseline,
  withKnowledgeImprovementCandidate,
  withKnowledgeImprovementComparison,
} from '../../src/index'
import {
  mutableCandidateRoot,
  passingMetric,
  refundProposal,
  refundSource,
  refundSpec,
  withEmptyRoot,
  withKb,
} from '../support/kb-improvement'

describe('improveKnowledgeBase', () => {
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
})
