import type { RunRecord, RunSplitTag } from '@tangle-network/agent-eval'
import { describe, expect, it } from 'vitest'
import { knowledgeReleaseReport } from '../src/release'

/**
 * Minimal valid `RunRecord`. The release gate folds these into a
 * `ReleaseConfidenceScorecard`; every field below is required by
 * `validateRunRecord`, so an under-specified record fails closed.
 */
function run(
  overrides: Partial<RunRecord> & { runId: string; splitTag: RunSplitTag; score: number },
): RunRecord {
  const {
    score,
    scenarioId = overrides.splitTag === 'holdout' ? 'holdout-case' : 'search-case',
    ...rest
  } = overrides
  return {
    runId: rest.runId,
    experimentId: 'exp-krel',
    candidateId: 'cand-A',
    seed: 1,
    model: 'test-model@2026-01',
    promptHash: 'p'.repeat(64),
    configHash: 'c'.repeat(64),
    commitSha: 'd'.repeat(40),
    wallMs: 100,
    costUsd: 0.01,
    costProvenance: { kind: 'observed', usd: 0.01 },
    tokenUsage: { input: 10, output: 5 },
    terminalOutcome: 'succeeded',
    outcome:
      rest.splitTag === 'holdout'
        ? { holdoutScore: score, raw: {} }
        : { searchScore: score, raw: {} },
    splitTag: rest.splitTag,
    scenarioId,
    ...rest,
  }
}

describe('knowledgeReleaseReport', () => {
  it('promotes a strong, search-best candidate (status !== fail, promotedIsBest)', () => {
    const report = knowledgeReleaseReport({
      candidateId: 'cand-A',
      candidateRuns: [
        run({ runId: 'r1', splitTag: 'search', score: 0.9, candidateId: 'cand-A' }),
        run({ runId: 'r2', splitTag: 'search', score: 0.85, candidateId: 'cand-A' }),
      ],
      promotedIsBest: true,
    })
    expect(report.scorecard.status).not.toBe('fail')
    expect(report.release.promoted).toBe(true)
    // The release id is derived from the run records it folded.
    expect(report.release.runRecordIds).toEqual(['r1', 'r2'])
    expect(report.candidateRuns).toHaveLength(2)
    expect(report.baselineRuns).toHaveLength(0)
  })

  it('refuses to promote when the candidate is not search-best (promotedIsBest=false)', () => {
    const report = knowledgeReleaseReport({
      candidateId: 'cand-A',
      candidateRuns: [run({ runId: 'r1', splitTag: 'search', score: 0.9, candidateId: 'cand-A' })],
      promotedIsBest: false,
    })
    // Even a passing scorecard cannot promote a non-best candidate.
    expect(report.release.promoted).toBe(false)
  })

  it('refuses to promote a failing candidate (status === fail)', () => {
    // Below the default minMeanScore (0.7), the quality axis fails -> status fail.
    const report = knowledgeReleaseReport({
      candidateId: 'cand-A',
      candidateRuns: [
        run({ runId: 'r1', splitTag: 'search', score: 0.1, candidateId: 'cand-A' }),
        run({ runId: 'r2', splitTag: 'search', score: 0.05, candidateId: 'cand-A' }),
      ],
      promotedIsBest: true,
    })
    expect(report.scorecard.status).toBe('fail')
    expect(report.release.promoted).toBe(false)
  })

  it('hasHoldout=false lets a run-only candidate promote (the common path)', () => {
    const withoutHoldout = knowledgeReleaseReport({
      candidateId: 'cand-A',
      candidateRuns: [run({ runId: 'r1', splitTag: 'search', score: 0.9, candidateId: 'cand-A' })],
      hasHoldout: false,
      promotedIsBest: true,
    })
    expect(withoutHoldout.scorecard.status).not.toBe('fail')
    expect(withoutHoldout.release.promoted).toBe(true)
  })

  it('hasHoldout=true fails closed without a holdout scenario', () => {
    const declared = knowledgeReleaseReport({
      candidateId: 'cand-A',
      candidateRuns: [
        run({ runId: 'r1', splitTag: 'search', score: 0.9, candidateId: 'cand-A' }),
        run({ runId: 'r2', splitTag: 'holdout', score: 0.88, candidateId: 'cand-A' }),
      ],
      hasHoldout: true,
      promotedIsBest: true,
    })
    expect(declared.scorecard.metrics.holdoutRuns).toBe(1)
    expect(declared.scorecard.issues.map((i) => i.code)).toContain('missing_holdout_split')
    expect(declared.scorecard.status).toBe('fail')
    expect(declared.release.promoted).toBe(false)
  })

  it('accepts matching holdout scenarios and runs', () => {
    const declared = knowledgeReleaseReport({
      candidateId: 'cand-A',
      candidateRuns: [
        run({ runId: 'r1', splitTag: 'search', score: 0.9, candidateId: 'cand-A' }),
        run({ runId: 'r2', splitTag: 'holdout', score: 0.88, candidateId: 'cand-A' }),
      ],
      scenarios: [
        { id: 'search-case', payload: {}, split: 'train' },
        { id: 'holdout-case', payload: {}, split: 'holdout' },
      ],
      hasHoldout: true,
      promotedIsBest: true,
    })

    expect(declared.scorecard.metrics.holdoutRuns).toBe(1)
    expect(declared.scorecard.metrics.splitCounts.holdout).toBe(1)
    expect(declared.scorecard.issues.map((issue) => issue.code)).not.toContain(
      'missing_holdout_split',
    )
    expect(declared.scorecard.status).not.toBe('fail')
    expect(declared.release.promoted).toBe(true)
  })

  it('rejects a malformed run record (validateRunRecord fails closed)', () => {
    const bad = { runId: 'r1', splitTag: 'search' } as unknown as RunRecord
    expect(() => knowledgeReleaseReport({ candidateId: 'cand-A', candidateRuns: [bad] })).toThrow()
  })

  it('release id is stable per (candidateId, createdAt)', () => {
    const createdAt = '2026-06-24T00:00:00.000Z'
    const a = knowledgeReleaseReport({
      candidateId: 'cand-A',
      candidateRuns: [run({ runId: 'r1', splitTag: 'search', score: 0.9, candidateId: 'cand-A' })],
      createdAt,
    })
    const b = knowledgeReleaseReport({
      candidateId: 'cand-A',
      candidateRuns: [run({ runId: 'r9', splitTag: 'search', score: 0.7, candidateId: 'cand-A' })],
      createdAt,
    })
    expect(a.release.id).toBe(b.release.id)
    // A different createdAt yields a different id.
    const c = knowledgeReleaseReport({
      candidateId: 'cand-A',
      candidateRuns: [run({ runId: 'r1', splitTag: 'search', score: 0.9, candidateId: 'cand-A' })],
      createdAt: '2026-06-25T00:00:00.000Z',
    })
    expect(c.release.id).not.toBe(a.release.id)
  })
})
