import { describe, expect, it } from 'vitest'
import { assertGradeableEvidence, UncheckableClaimError, verdictFor } from './claim-evidence'

describe('assertGradeableEvidence', () => {
  it('refuses rung 4+ without a check — a self-grade must fail at record time', () => {
    expect(() => assertGradeableEvidence({ rung: 4 })).toThrow(UncheckableClaimError)
    expect(() => assertGradeableEvidence({ rung: 5 })).toThrow(UncheckableClaimError)
  })
  it('passes rung 4+ with a check, and any rung below the threshold', () => {
    expect(assertGradeableEvidence({ rung: 4, check: 'true' }).rung).toBe(4)
    expect(assertGradeableEvidence({ rung: 3 }).rung).toBe(3)
  })
})

describe('verdictFor — the calibration cases that were graded wrong before this lattice', () => {
  it('a silent assert is not a contradiction', () => {
    // exit 0, prints nothing: the expectation can never appear, and grading this 'contradicted'
    // once flunked three TRUE claims on first contact with real data.
    expect(
      verdictFor({ rung: 4, check: 'x', expect: 'True' }, { exitCode: 0, stdout: '', stderr: '' }),
    ).toBe('silent-check')
  })
  it('a printed decisive value verifies', () => {
    expect(
      verdictFor(
        { rung: 4, check: 'x', expect: '2983' },
        { exitCode: 0, stdout: 'roots_checked=2983', stderr: '' },
      ),
    ).toBe('verified')
  })
  it('a missing input blames the environment, not the claim', () => {
    expect(
      verdictFor(
        { rung: 4, check: 'x' },
        { exitCode: 1, stdout: '', stderr: 'FileNotFoundError: k3.json' },
      ),
    ).toBe('unrunnable')
  })
  it('a passing command printing the wrong value is a real contradiction', () => {
    expect(
      verdictFor(
        { rung: 4, check: 'x', expect: '7' },
        { exitCode: 0, stdout: 'value=8', stderr: '' },
      ),
    ).toBe('contradicted')
  })
  it('rung 4+ with no check is uncheckable regardless of execution', () => {
    expect(verdictFor({ rung: 4 }, null)).toBe('uncheckable')
  })
  it('a check that could not execute at all is unrunnable', () => {
    expect(verdictFor({ rung: 4, check: 'x' }, null)).toBe('unrunnable')
  })
})
