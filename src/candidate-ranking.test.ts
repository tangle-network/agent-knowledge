import { describe, expect, it } from 'vitest'

import { normalizeUsd, rankCandidates } from './candidate-ranking'

const base = { scoreMean: 0.5, passRate: 0.5, cellsFailed: 0, totalCostUsd: 1 }

function ordered(rows: Parameters<typeof rankCandidates>[0]): string[] {
  return rankCandidates(rows).map((row) => row.candidateId)
}

describe('rankCandidates', () => {
  it('places a candidate with a failed cell below every complete candidate', () => {
    expect(
      ordered([
        { ...base, candidateId: 'incomplete', scoreMean: 0.99, cellsFailed: 1 },
        { ...base, candidateId: 'complete', scoreMean: 0.1 },
      ]),
    ).toEqual(['complete', 'incomplete'])
  })

  it('breaks each tie in turn: score, then pass rate, then cost, then id', () => {
    expect(
      ordered([
        { ...base, candidateId: 'lower-score', scoreMean: 0.4 },
        { ...base, candidateId: 'higher-score', scoreMean: 0.6 },
      ]),
    ).toEqual(['higher-score', 'lower-score'])

    expect(
      ordered([
        { ...base, candidateId: 'lower-pass', passRate: 0.4 },
        { ...base, candidateId: 'higher-pass', passRate: 0.6 },
      ]),
    ).toEqual(['higher-pass', 'lower-pass'])

    expect(
      ordered([
        { ...base, candidateId: 'dearer', totalCostUsd: 2 },
        { ...base, candidateId: 'cheaper', totalCostUsd: 1 },
      ]),
    ).toEqual(['cheaper', 'dearer'])

    expect(
      ordered([
        { ...base, candidateId: 'b' },
        { ...base, candidateId: 'a' },
      ]),
    ).toEqual(['a', 'b'])
  })

  it('stamps ranks from one and leaves the caller rows untouched', () => {
    const rows = [
      { ...base, candidateId: 'second', scoreMean: 0.2 },
      { ...base, candidateId: 'first', scoreMean: 0.8 },
    ]
    expect(rankCandidates(rows).map((row) => row.rank)).toEqual([1, 2])
    expect(rows.map((row) => row.candidateId)).toEqual(['second', 'first'])
  })

  it('orders identically however the same results arrive', () => {
    const rows = [
      { ...base, candidateId: 'a', scoreMean: 0.5 },
      { ...base, candidateId: 'b', scoreMean: 0.5 },
      { ...base, candidateId: 'c', scoreMean: 0.9 },
    ]
    expect(ordered(rows)).toEqual(ordered([...rows].reverse()))
  })
})

describe('normalizeUsd', () => {
  it('removes the float noise that would otherwise decide a cost tie', () => {
    const accumulated = [0.1, 0.2].reduce((sum, value) => sum + value, 0)
    expect(accumulated).not.toBe(0.3)
    expect(normalizeUsd(accumulated)).toBe(normalizeUsd(0.3))
  })

  it('keeps two candidates that spent the same amount in id order', () => {
    const accumulated = [0.1, 0.2].reduce((sum, value) => sum + value, 0)
    const ranked = rankCandidates([
      { ...base, candidateId: 'b', totalCostUsd: normalizeUsd(accumulated) },
      { ...base, candidateId: 'a', totalCostUsd: normalizeUsd(0.3) },
    ])
    expect(ranked.map((row) => row.candidateId)).toEqual(['a', 'b'])
  })
})
