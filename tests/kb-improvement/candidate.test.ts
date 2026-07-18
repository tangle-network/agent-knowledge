import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildEvalKnowledgeBundle,
  buildKnowledgeIndex,
  evaluateKnowledgeBaseReadiness,
  hashKnowledgeBase,
  improveKnowledgeBase,
  knowledgeImprovementRunDir,
} from '../../src/index'
import {
  improveAndPromote,
  mutableCandidateRoot,
  passingMetric,
  refundProposal,
  refundSource,
  refundSpec,
  withEmptyRoot,
  withKb,
} from '../support/kb-improvement'

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
