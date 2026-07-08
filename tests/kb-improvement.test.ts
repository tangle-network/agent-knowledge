import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildEvalKnowledgeBundle,
  buildKnowledgeIndex,
  defineReadinessSpec,
  evaluateKnowledgeBaseReadiness,
  hashKnowledgeBase,
  improveKnowledgeBase,
  initKnowledgeBase,
  knowledgeImprovementRunDir,
  sha256,
  stableId,
} from '../src/index'

async function withKb(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agent-knowledge-improve-'))
  try {
    await initKnowledgeBase(root)
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
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

describe('improveKnowledgeBase', () => {
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
      const improved = await improveKnowledgeBase({
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
      const result = await improveKnowledgeBase({
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
      expect(result.candidate?.evaluation?.score).toBe(1)
      expect(
        result.candidate?.lifecycle?.some((record) =>
          record.phases.some(
            (phase) => phase.phase === 'knowledge-update' && phase.status === 'completed',
          ),
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
        promote: false,
        step: () => ({
          done: true,
          sourceTexts: [{ uri: source.uri, text: source.text, title: source.title }],
          proposalText: refundProposal(source.id),
        }),
      })

      expect(first.promoted).toBe(false)
      expect(first.state.status).toBe('candidate-ready')
      const candidateRoot = first.candidate?.candidateRoot
      expect(candidateRoot).toBeDefined()

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

      const resumed = await improveKnowledgeBase({
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

      const resumed = await improveKnowledgeBase({
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
        promote: false,
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
        evaluate: () => ({ score: 1, passed: true }),
      })

      expect(result.state.status).toBe('candidate-ready')
      expect(seen).toHaveLength(1)
      expect(seen[0]).toMatchObject({
        root: result.candidate?.candidateRoot,
        baselineRoot: root,
        candidateRoot: result.candidate?.candidateRoot,
        runId: 'candidate-update-root',
        iteration: 1,
      })
      await expect(
        readFile(join(root, 'knowledge', 'runtime-supervisor.md'), 'utf8'),
      ).rejects.toThrow()
      await expect(
        readFile(
          join(result.candidate!.candidateRoot, 'knowledge', 'runtime-supervisor.md'),
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
        promote: false,
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

      const blocked = await improveKnowledgeBase({
        root,
        goal: 'Build billing support refund-policy knowledge',
        runId: 'conflict',
        readinessSpecs: [refundSpec],
        strict: true,
      })

      expect(blocked.blocked).toBe(true)
      expect(blocked.state.status).toBe('blocked')
      expect(blocked.state.blockedReason).toMatch(/base changed before promotion/)
      expect(await readFile(concurrentPage, 'utf8')).toContain('different agent')
    })
  })

  it('fails fast when another active operator owns the run lease', async () => {
    await withKb(async (root) => {
      const runDir = knowledgeImprovementRunDir(root, 'locked')
      await mkdir(runDir, { recursive: true })
      await writeFile(
        join(runDir, 'run.lock'),
        `${JSON.stringify({
          ownerId: 'agent-a',
          acquiredAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2999-01-01T00:00:00.000Z',
          pid: 123,
        })}\n`,
      )

      await expect(
        improveKnowledgeBase({
          root,
          goal: 'Locked run',
          runId: 'locked',
          readinessSpecs: [refundSpec],
        }),
      ).rejects.toThrow(/locked by agent-a/)
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
        promote: false,
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

      expect(result.candidate?.retrievalWinnerConfig).toMatchObject({ k: 2 })
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
      expect(result.candidate?.evaluation?.passed).toBe(false)
      expect(result.candidate?.evaluation?.notes).toContain('answer quality failed')
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
