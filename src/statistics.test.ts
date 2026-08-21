import { describe, expect, it } from 'vitest'
import { rankCandidates } from './candidate-ranking'
import { mean } from './statistics'

describe('mean', () => {
  it('averages the measurements it was given', () => {
    expect(mean([1, 2, 3])).toBe(2)
    expect(mean([0.25, 0.75])).toBe(0.5)
  })

  it('leaves out a measurement that is not a finite number', () => {
    expect(mean([1, Number.NaN, 3])).toBe(2)
    expect(mean([1, Number.POSITIVE_INFINITY, 3])).toBe(2)
  })

  it('keeps a ranked candidate placed by what it scored, not by its name', () => {
    // A non-finite scoreMean fails every numeric comparison in the ranking
    // comparator, so the candidate carrying it falls through to the identifier
    // tie-break: 'broken' would outrank two candidates with real scores purely
    // because of where its name sorts.
    const base = { passRate: 0.5, cellsFailed: 0, totalCostUsd: 1 }
    const ranked = rankCandidates([
      { ...base, candidateId: 'alpha', scoreMean: mean([0.9]) },
      { ...base, candidateId: 'broken', scoreMean: mean([Number.NaN, 0.2]) },
      { ...base, candidateId: 'gamma', scoreMean: mean([0.1]) },
      { ...base, candidateId: 'delta', scoreMean: mean([0.5]) },
    ])
    expect(ranked.map((row) => row.candidateId)).toEqual(['alpha', 'delta', 'broken', 'gamma'])
  })
})
