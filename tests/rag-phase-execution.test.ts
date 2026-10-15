import { describe, expect, it, vi } from 'vitest'
import type {
  RagKnowledgeImprovementPhase,
  RagKnowledgeImprovementPhaseResult,
  RunRagKnowledgeImprovementLoopOptions,
  RunRagKnowledgeImprovementLoopResult,
} from '../src/rag-improvement-loop'
import { runRagKnowledgeImprovementLoop } from '../src/rag-improvement-loop'
import { runRagKnowledgeImprovementPhases } from '../src/rag-improvement-phases'
import { testExecutionRef } from './support/optimization'

const timestamp = '2026-10-14T00:00:00.000Z'
const phases: RagKnowledgeImprovementPhase[] = [
  'gap-diagnosis',
  'knowledge-acquisition',
  'knowledge-update',
  'rag-optimization',
  'retrieval-tuning',
  'answer-quality',
  'promotion',
]

describe('shared RAG phase executor', () => {
  it.each([false, true])(
    'preserves default skips and opt-in optimization records: %s',
    async (explicit) => {
      const now = vi.fn(() => new Date(timestamp))
      const result = await runRagKnowledgeImprovementLoop({
        goal: 'inspect phases',
        now,
        ...(explicit ? { enabledPhases: phases } : {}),
      })
      const expected = explicit ? phases : phases.filter((phase) => phase !== 'rag-optimization')
      expect(result.phases.map(({ phase }) => phase)).toEqual(expected)
      expect(now).toHaveBeenCalledTimes(expected.length)
      for (const phase of result.phases)
        expect(phase).toMatchObject({
          status: 'skipped',
          startedAt: timestamp,
          finishedAt: timestamp,
        })
    },
  )

  it('retains previous results when phases are disabled or missing without duplicating findings', async () => {
    const previous: RunRagKnowledgeImprovementLoopResult = {
      goal: 'before',
      phases: [],
      findings: [{ id: 'prior', kind: 'unknown', severity: 'info', message: 'prior evidence' }],
      acquisition: { done: true },
      knowledgeUpdate: { applied: false, summary: 'prior update' },
      answerQuality: {
        passed: true,
        metrics: { correctness: 1 },
        finalScenarioIds: ['one', 'two'],
        datasetRef: 'sha256:dataset',
        evaluatorRef: 'sha256:evaluator',
        cost: { totalCostUsd: 0, accountingComplete: true, incompleteReasons: [] },
        findings: [
          { id: 'answer', kind: 'unknown', severity: 'info', message: 'already observed' },
        ],
      },
      promotion: { promoted: false, reason: 'prior hold' },
    }
    const now = vi.fn(() => new Date(timestamp))
    const diagnose = vi.fn(() => [])
    const disabled = await runRagKnowledgeImprovementPhases(
      { goal: 'after', enabledPhases: [], diagnose, now },
      previous,
    )
    expect(disabled).toEqual({ ...previous, goal: 'after' })
    expect(disabled.acquisition).toBe(previous.acquisition)
    expect(disabled.answerQuality).toBe(previous.answerQuality)
    expect(diagnose).not.toHaveBeenCalled()
    expect(now).not.toHaveBeenCalled()
    const skipped = await runRagKnowledgeImprovementPhases({ goal: 'after', now }, previous)
    expect(skipped.findings).toEqual(previous.findings)
    expect(skipped.answerQuality).toBe(previous.answerQuality)
    expect(skipped.phases).toHaveLength(6)
    expect(previous.phases).toEqual([])
  })

  it('records cancellation on the next configured phase before invoking its callback', async () => {
    const controller = new AbortController()
    let observed: readonly RagKnowledgeImprovementPhaseResult[] = []
    const acquireKnowledge = vi.fn(() => ({ done: true }))
    const later = vi.fn(() => ({ applied: false, summary: 'unused' }))
    await expect(
      runRagKnowledgeImprovementLoop({
        goal: 'cancel',
        signal: controller.signal,
        now: () => new Date(timestamp),
        diagnose({ phases: current }) {
          observed = current
          controller.abort()
          return []
        },
        acquireKnowledge,
        updateKnowledge: later,
      }),
    ).rejects.toThrow('RAG knowledge improvement loop aborted')
    expect(observed).toEqual([
      {
        phase: 'gap-diagnosis',
        status: 'completed',
        summary: '0 finding(s)',
        startedAt: timestamp,
        finishedAt: timestamp,
      },
      {
        phase: 'knowledge-acquisition',
        status: 'failed',
        summary: 'RAG knowledge improvement loop aborted',
        startedAt: timestamp,
        finishedAt: timestamp,
      },
    ])
    expect(acquireKnowledge).not.toHaveBeenCalled()
    expect(later).not.toHaveBeenCalled()
  })

  it('preserves callback errors and does not run later phases', async () => {
    const error = new Error('acquisition failed')
    let observed: readonly RagKnowledgeImprovementPhaseResult[] = []
    const updateKnowledge = vi.fn(() => ({ applied: false, summary: 'unused' }))
    await expect(
      runRagKnowledgeImprovementLoop({
        goal: 'fail',
        now: () => new Date(timestamp),
        diagnose({ phases: current }) {
          observed = current
          return []
        },
        acquireKnowledge() {
          throw error
        },
        updateKnowledge,
      }),
    ).rejects.toBe(error)
    expect(observed.at(-1)).toMatchObject({
      phase: 'knowledge-acquisition',
      status: 'failed',
      summary: error.message,
    })
    expect(updateKnowledge).not.toHaveBeenCalled()
  })

  it('keeps completed answer findings when a callback changes the later phase configuration', async () => {
    const finding = {
      id: 'answer',
      kind: 'unknown',
      severity: 'info',
      message: 'observed',
    } as const
    const options: RunRagKnowledgeImprovementLoopOptions = {
      goal: 'answer',
      enabledPhases: ['answer-quality'],
      evaluateAnswers() {
        options.enabledPhases = []
        options.evaluateAnswers = undefined
        return {
          passed: true,
          metrics: { correctness: 1 },
          finalScenarioIds: ['one', 'two'],
          datasetRef: testExecutionRef('dataset'),
          evaluatorRef: testExecutionRef('evaluator'),
          cost: { totalCostUsd: 0, accountingComplete: true, incompleteReasons: [] },
          findings: [finding],
        }
      },
    }
    const result = await runRagKnowledgeImprovementLoop(options)
    expect(result.phases).toHaveLength(1)
    expect(result.phases[0]).toMatchObject({ phase: 'answer-quality', status: 'completed' })
    expect(result.findings).toEqual([finding])
  })

  it.each(phases)('rejects a missing required %s before any earlier callback', async (phase) => {
    const now = vi.fn(() => new Date(timestamp))
    await expect(
      runRagKnowledgeImprovementLoop({ goal: 'require phase', requiredPhases: [phase], now }),
    ).rejects.toThrow(`required phase ${phase} requires`)
    expect(now).not.toHaveBeenCalled()
  })
})
