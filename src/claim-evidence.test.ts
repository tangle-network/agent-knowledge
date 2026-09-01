import { describe, expect, it } from 'vitest'
import {
  assertGradeableEvidence,
  claimCheckKey,
  DEADLINE_EXIT_CODE,
  gradeClaims,
  gradeFor,
  UncheckableClaimError,
  verdictFor,
} from './claim-evidence'

describe('assertGradeableEvidence', () => {
  it('refuses rung 4+ without a check — a self-grade must fail at record time', () => {
    expect(() => assertGradeableEvidence({ rung: 4 })).toThrow(UncheckableClaimError)
    expect(() => assertGradeableEvidence({ rung: 5 })).toThrow(UncheckableClaimError)
  })
  it('passes rung 4+ with a check that can fail, and any rung below the threshold', () => {
    expect(
      assertGradeableEvidence({ rung: 4, check: 'grep -c root out.txt', expect: '2983' }).rung,
    ).toBe(4)
    expect(assertGradeableEvidence({ rung: 3 }).rung).toBe(3)
  })
})

describe('assertGradeableEvidence — a check that cannot fail is refused at record time', () => {
  it('refuses a check with no expectation to print', () => {
    expect(() => assertGradeableEvidence({ rung: 4, check: 'pnpm test' })).toThrow(
      UncheckableClaimError,
    )
    expect(() => assertGradeableEvidence({ rung: 4, check: 'pnpm test', expect: '  ' })).toThrow(
      UncheckableClaimError,
    )
    expect(() => assertGradeableEvidence({ rung: 5, check: 'pnpm test' })).toThrow(
      UncheckableClaimError,
    )
  })

  it('refuses a constant-emitter check', () => {
    expect(() => assertGradeableEvidence({ rung: 4, check: 'true', expect: '1' })).toThrow(
      UncheckableClaimError,
    )
    expect(() => assertGradeableEvidence({ rung: 4, check: ' : ', expect: '1' })).toThrow(
      UncheckableClaimError,
    )
    expect(() =>
      assertGradeableEvidence({
        rung: 4,
        check: "echo 'roots_checked=2983'",
        expect: 'roots_checked=2983',
      }),
    ).toThrow(UncheckableClaimError)
    expect(() =>
      assertGradeableEvidence({
        rung: 4,
        check: "printf '%s\\n' 'ratio=0.91'",
        expect: 'ratio=0.91',
      }),
    ).toThrow(UncheckableClaimError)
  })

  it('the message names the refused shape and what to record instead', () => {
    expect(() => assertGradeableEvidence({ rung: 4, check: 'pnpm test' })).toThrow(
      /exit code alone.*record the value the check must print/,
    )
    expect(() => assertGradeableEvidence({ rung: 4, check: 'true', expect: '1' })).toThrow(
      /constant emitter.*record a command that reads the artifact/,
    )
    expect(() => assertGradeableEvidence({ rung: 4 })).toThrow(
      /no command was recorded.*record the command that re-establishes it/,
    )
  })

  it('reports the rung, and the same words the grader would report', () => {
    // One vocabulary at both boundaries: a second detector here could drift from gradeFor and
    // re-open the gap between what is recorded and what can be graded.
    const refusals = [
      { rung: 4, check: 'pnpm test' },
      { rung: 4, check: 'true', expect: '1' },
      { rung: 5 },
    ] as const
    for (const evidence of refusals) {
      let raised: UncheckableClaimError | undefined
      try {
        assertGradeableEvidence(evidence)
      } catch (error) {
        raised = error as UncheckableClaimError
      }
      expect(raised).toBeInstanceOf(UncheckableClaimError)
      expect(raised?.rung).toBe(evidence.rung)
      expect(raised?.note).toBe(gradeFor(evidence, { exitCode: 0, stdout: 'ok', stderr: '' }).note)
    }
  })

  it('accepts a check that reads a value through command substitution', () => {
    expect(
      assertGradeableEvidence({
        rung: 4,
        check: 'echo "roots=$(grep -c root out.txt)"',
        expect: 'roots=2983',
      }).check,
    ).toBe('echo "roots=$(grep -c root out.txt)"')
    expect(
      assertGradeableEvidence({ rung: 4, check: 'echo $ROOTS', expect: 'roots=2983' }).rung,
    ).toBe(4)
  })

  it('below the threshold both shapes are still recordable', () => {
    expect(assertGradeableEvidence({ rung: 3, check: 'true' }).rung).toBe(3)
    expect(
      assertGradeableEvidence({ rung: 3, check: "echo 'tests pass'", expect: 'tests pass' }).rung,
    ).toBe(3)
    expect(assertGradeableEvidence({ rung: 1 }).rung).toBe(1)
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

const PASSED = { exitCode: 0, stdout: '', stderr: '' }

describe('verdictFor — a check that cannot fail is refused at the checkable rungs', () => {
  it('an exit code with no expectation decides nothing', () => {
    expect(verdictFor({ rung: 4, check: 'pnpm test' }, { ...PASSED, stdout: 'ok' })).toBe(
      'uncheckable',
    )
    expect(
      verdictFor({ rung: 4, check: 'pnpm test', expect: '  ' }, { ...PASSED, stdout: 'ok' }),
    ).toBe('uncheckable')
  })

  it('`true` and `:` as the whole check are constant emitters', () => {
    expect(verdictFor({ rung: 4, check: 'true', expect: '1' }, PASSED)).toBe('uncheckable')
    expect(verdictFor({ rung: 5, check: ' : ', expect: '1' }, PASSED)).toBe('uncheckable')
  })

  it('an echo that prints its own expectation is a constant emitter', () => {
    expect(
      verdictFor(
        { rung: 4, check: "echo 'roots_checked=2983'", expect: 'roots_checked=2983' },
        { ...PASSED, stdout: 'roots_checked=2983' },
      ),
    ).toBe('uncheckable')
  })

  it('a printf that prints its own expectation is a constant emitter', () => {
    expect(
      verdictFor(
        { rung: 4, check: "printf '%s\\n' 'ratio=0.91'", expect: 'ratio=0.91' },
        { ...PASSED, stdout: 'ratio=0.91' },
      ),
    ).toBe('uncheckable')
  })

  it('an echo that reads a value through command substitution still verifies', () => {
    expect(
      verdictFor(
        { rung: 4, check: 'echo "roots=$(grep -c root out.txt)"', expect: 'roots=2983' },
        { ...PASSED, stdout: 'roots=2983' },
      ),
    ).toBe('verified')
    expect(
      verdictFor(
        { rung: 4, check: 'echo "roots=`grep -c root out.txt`"', expect: 'roots=2983' },
        { ...PASSED, stdout: 'roots=2983' },
      ),
    ).toBe('verified')
    expect(
      verdictFor(
        { rung: 4, check: 'echo $ROOTS', expect: 'roots=2983' },
        { ...PASSED, stdout: 'roots=2983' },
      ),
    ).toBe('verified')
  })

  it('a real command that prints the decisive value keeps verifying', () => {
    expect(
      verdictFor(
        { rung: 4, check: 'grep -c root out.txt', expect: '2983' },
        { ...PASSED, stdout: '2983' },
      ),
    ).toBe('verified')
  })

  it('below the threshold nothing tightens', () => {
    expect(verdictFor({ rung: 3, check: 'true' }, PASSED)).toBe('verified')
    expect(
      verdictFor(
        { rung: 3, check: "echo 'tests pass'", expect: 'tests pass' },
        { ...PASSED, stdout: 'tests pass' },
      ),
    ).toBe('verified')
    expect(verdictFor({ rung: 1 }, PASSED)).toBe('verified')
  })

  it('an unrunnable or contradicting execution still outranks a missing expectation', () => {
    expect(
      verdictFor(
        { rung: 4, check: 'python k3.py' },
        { exitCode: 1, stdout: '', stderr: 'FileNotFoundError: k3.json' },
      ),
    ).toBe('unrunnable')
    expect(
      verdictFor(
        { rung: 4, check: 'python k3.py' },
        { exitCode: 1, stdout: 'assert failed', stderr: '' },
      ),
    ).toBe('contradicted')
  })
})

describe('gradeFor — the refusal says which shape it refused', () => {
  it('names the missing expectation', () => {
    const grade = gradeFor({ rung: 4, check: 'pnpm test' }, { ...PASSED, stdout: 'ok' })
    expect(grade.verdict).toBe('uncheckable')
    expect(grade.note).toContain('exit code alone')
  })

  it('names the constant-emitter shape', () => {
    const grade = gradeFor({ rung: 4, check: "echo 'ratio=0.91'", expect: 'ratio=0.91' }, PASSED)
    expect(grade.verdict).toBe('uncheckable')
    expect(grade.note).toContain('constant emitter')
  })

  it('carries no note when the check decided the claim', () => {
    const grade = gradeFor(
      { rung: 4, check: 'grep -c root out.txt', expect: '2983' },
      { ...PASSED, stdout: '2983' },
    )
    expect(grade).toEqual({ verdict: 'verified' })
  })
})

describe('gradeFor — a check that carries its own expectation cannot certify itself', () => {
  it('refuses the expectation authored into the check text, however the check exits', () => {
    const evidence = {
      rung: 4 as const,
      check: 'grep -c "PARETO=6" results.txt',
      expect: 'PARETO=6',
    }
    expect(gradeFor(evidence, { ...PASSED, stdout: 'PARETO=6' })).toEqual({
      verdict: 'uncheckable',
      note: expect.stringContaining('contains the expected value'),
    })
    expect(verdictFor(evidence, { exitCode: 1, stdout: '', stderr: 'boom' })).toBe('uncheckable')
    expect(verdictFor(evidence, null)).toBe('uncheckable')
  })

  it('refuses a script invocation whose arguments spell the answer', () => {
    expect(
      verdictFor(
        { rung: 4, check: './solve.sh --assert cells=8', expect: 'cells=8' },
        { ...PASSED, stdout: 'cells=8' },
      ),
    ).toBe('uncheckable')
  })

  it('refuses it at record time too, in the same words', () => {
    const evidence = {
      rung: 4 as const,
      check: 'grep -c "PARETO=6" results.txt',
      expect: 'PARETO=6',
    }
    let raised: UncheckableClaimError | undefined
    try {
      assertGradeableEvidence(evidence)
    } catch (error) {
      raised = error as UncheckableClaimError
    }
    expect(raised).toBeInstanceOf(UncheckableClaimError)
    expect(raised?.note).toBe(gradeFor(evidence, { ...PASSED, stdout: 'PARETO=6' }).note)
  })

  it('leaves a check that reads the value it prints alone', () => {
    expect(
      verdictFor(
        { rung: 4, check: 'grep -c PARETO results.txt', expect: '6' },
        { ...PASSED, stdout: '6' },
      ),
    ).toBe('verified')
    expect(
      verdictFor(
        { rung: 4, check: 'echo "cells=$(wc -l < grid.txt)"', expect: 'cells=8' },
        { ...PASSED, stdout: 'cells=8' },
      ),
    ).toBe('verified')
  })

  it('below the checkable rungs nothing is refused', () => {
    expect(
      verdictFor(
        { rung: 3, check: 'echo ok | grep ok', expect: 'ok' },
        { ...PASSED, stdout: 'ok' },
      ),
    ).toBe('verified')
  })
})

describe('gradeFor — a check that never reached its input is not a refutation', () => {
  it('downgrades a zero-exit pipeline whose output says the file is missing', () => {
    // `sha256sum missing.json | cut -d' ' -f1` exits with cut's status, which is 0, and prints
    // the error text. Comparing that to the expectation records a refutation of research that
    // was never run: 29 of 61 recorded contradictions were this shape.
    const grade = gradeFor(
      { rung: 4, check: "sha256sum out/k3.json | cut -d' ' -f1", expect: 'a91f3c' },
      { exitCode: 0, stdout: '', stderr: 'sha256sum: out/k3.json: No such file or directory' },
    )
    expect(grade.verdict).toBe('unrunnable')
    expect(grade.note).toContain('never reached what the claim is about')
  })

  it('reads the signature whatever case the tool printed it in', () => {
    for (const stderr of [
      'python: no such file or directory',
      'bash: line 1: ./solve: Permission denied',
      'mkdir: cannot create directory ‘out’: Read-only file system',
      "bash: -c: line 3: syntax error near unexpected token `fi'",
      'SyntaxError: invalid syntax',
    ]) {
      expect(
        verdictFor({ rung: 4, check: 'x', expect: 'a91f3c' }, { exitCode: 0, stdout: '', stderr }),
      ).toBe('unrunnable')
    }
  })

  it('still refutes a claim that PREDICTED the error', () => {
    // The expectation names the signature, so the guard is off for this claim and its absence
    // is a real contradiction.
    expect(
      verdictFor(
        { rung: 4, check: 'cat missing.json', expect: 'No such file or directory' },
        { exitCode: 0, stdout: 'contents', stderr: '' },
      ),
    ).toBe('contradicted')
    expect(
      verdictFor(
        { rung: 4, check: 'cat missing.json', expect: 'No such file or directory' },
        { exitCode: 1, stdout: '', stderr: 'cat: missing.json: No such file or directory' },
      ),
    ).toBe('contradicted')
  })

  it('never turns a real failure into a pass', () => {
    // The guard only ever moves `contradicted` to `unrunnable`.
    expect(
      verdictFor(
        { rung: 4, check: 'pytest -q', expect: '12 passed' },
        { exitCode: 1, stdout: 'ENOENT: conftest.py', stderr: '' },
      ),
    ).toBe('unrunnable')
    expect(
      verdictFor(
        { rung: 4, check: 'pytest -q', expect: '12 passed' },
        { ...PASSED, stdout: '12 passed\nNo such file or directory' },
      ),
    ).toBe('verified')
  })
})

describe('gradeFor — a deadline is a budget, not a verdict', () => {
  it('grades a killed check unrunnable and names the deadline', () => {
    const grade = gradeFor(
      { rung: 4, check: 'cadical problem.cnf', expect: 'UNSAT' },
      { exitCode: DEADLINE_EXIT_CODE, stdout: '', stderr: '' },
    )
    expect(grade.verdict).toBe('unrunnable')
    expect(grade.note).toContain('killed at its deadline')
  })

  it('reads the executor that says it killed the check, whatever status it reports', () => {
    expect(
      verdictFor(
        { rung: 4, check: 'cadical problem.cnf', expect: 'UNSAT' },
        { exitCode: 0, stdout: 'SAT', stderr: '', timedOut: true },
      ),
    ).toBe('unrunnable')
  })

  it('decides the deadline before the expectation, so a silent solver is not refuted', () => {
    expect(
      verdictFor(
        { rung: 4, check: 'cadical problem.cnf', expect: 'UNSAT' },
        { exitCode: DEADLINE_EXIT_CODE, stdout: 'c partial search\n', stderr: '' },
      ),
    ).toBe('unrunnable')
  })
})

describe('gradeFor — a precise expectation is the strongest one, not a refused one', () => {
  it('verifies a check whose output carries a four-token expectation', () => {
    expect(
      gradeFor(
        { rung: 4, check: 'node report.mjs', expect: 'GRID OK cells=8 WIN=1 PARETO=6 NEGATIVE=1' },
        { ...PASSED, stdout: 'GRID OK cells=8 WIN=1 PARETO=6 NEGATIVE=1\n' },
      ),
    ).toEqual({ verdict: 'verified' })
  })

  it('records it at rung 4 as well', () => {
    expect(
      assertGradeableEvidence({
        rung: 4,
        check: 'node report.mjs',
        expect: 'cells=8 WIN=1 PARETO=6',
      }).rung,
    ).toBe(4)
  })

  it('still refuses an expectation the comparison cannot use', () => {
    expect(() =>
      assertGradeableEvidence({ rung: 4, check: 'node report.mjs', expect: 'a\nb' }),
    ).toThrow(/multiple lines/)
  })
})

describe('gradeClaims — one verification counted twice is flagged, not dropped', () => {
  const shared = { check: 'node report.mjs', expect: 'PARETO=6' }
  const ran = { ...PASSED, stdout: 'PARETO=6' }

  it('flags the later claim and keeps both verdicts', () => {
    const graded = gradeClaims([
      {
        id: 'page-a',
        title: 'The grid is Pareto-optimal',
        evidence: { rung: 4, ...shared },
        execution: ran,
      },
      {
        id: 'page-b',
        title: 'the grid is pareto-optimal ',
        evidence: { rung: 4, ...shared },
        execution: ran,
      },
    ])
    expect(graded.map((row) => row.verdict)).toEqual(['verified', 'verified'])
    expect(graded[0]?.duplicateOf).toBeUndefined()
    expect(graded[1]?.duplicateOf).toBe('page-a')
  })

  it('does not flag one check shared by claims that say different things', () => {
    const graded = gradeClaims([
      {
        id: 'page-a',
        title: 'The grid is Pareto-optimal',
        evidence: { rung: 4, ...shared },
        execution: ran,
      },
      {
        id: 'page-b',
        title: 'The grid has one negative cell',
        evidence: { rung: 4, ...shared },
        execution: ran,
      },
    ])
    expect(graded.every((row) => row.duplicateOf === undefined)).toBe(true)
  })

  it('does not flag the same claim at two different verdicts', () => {
    const graded = gradeClaims([
      {
        id: 'page-a',
        title: 'The grid is Pareto-optimal',
        evidence: { rung: 4, ...shared },
        execution: ran,
      },
      {
        id: 'page-b',
        title: 'The grid is Pareto-optimal',
        evidence: { rung: 4, ...shared },
        execution: { ...PASSED, stdout: 'PARETO=5' },
      },
    ])
    expect(graded.map((row) => row.verdict)).toEqual(['verified', 'contradicted'])
    expect(graded.every((row) => row.duplicateOf === undefined)).toBe(true)
  })

  it('grades every claim exactly as gradeFor does', () => {
    const claims = [
      { id: 'a', title: 'one', evidence: { rung: 4 as const, ...shared }, execution: ran },
      { id: 'b', title: 'two', evidence: { rung: 4 as const, check: 'x' }, execution: null },
      { id: 'c', title: 'three', evidence: { rung: 4 as const, ...shared }, execution: null },
    ]
    for (const [index, graded] of gradeClaims(claims).entries()) {
      const { id, duplicateOf, ...grade } = graded
      expect(id).toBe(claims[index]?.id)
      expect(duplicateOf).toBeUndefined()
      expect(grade).toEqual(gradeFor(claims[index]!.evidence, claims[index]!.execution))
    }
  })

  it('keys nothing it cannot compare, so two unkeyable claims are not each other', () => {
    expect(claimCheckKey({ check: 'x' })).toBeUndefined()
    expect(claimCheckKey({ title: 'a claim' })).toBeUndefined()
    expect(claimCheckKey({ check: ' node x.mjs ', expect: ' 6 ', title: ' A Claim.md ' })).toBe(
      claimCheckKey({ check: 'node x.mjs', expect: '6', title: 'a claim' }),
    )
    const graded = gradeClaims([
      { id: 'a', evidence: { rung: 4, ...shared }, execution: ran },
      { id: 'b', evidence: { rung: 4, ...shared }, execution: ran },
    ])
    expect(graded.every((row) => row.duplicateOf === undefined)).toBe(true)
  })

  it('separates two claims whose fields concatenate to the same text', () => {
    expect(claimCheckKey({ check: 'ab', expect: 'c', title: 'd' })).not.toBe(
      claimCheckKey({ check: 'a', expect: 'bc', title: 'd' }),
    )
  })
})

describe('gradeFor — the self-certification guard does not refuse a correct claim', () => {
  it('ignores a short expectation that only appears inside a longer word', () => {
    // `expect: 6` appears inside `report6.mjs`. Refusing that would cost a true claim, which is
    // the failure this lattice is calibrated against.
    expect(
      verdictFor(
        { rung: 4, check: 'node report6.mjs --count', expect: '6' },
        { ...PASSED, stdout: '6' },
      ),
    ).toBe('verified')
    expect(
      verdictFor({ rung: 4, check: 'wc -l < grid8.txt', expect: '8' }, { ...PASSED, stdout: '8' }),
    ).toBe('verified')
  })

  it('still refuses the same value when the check spells it on its own', () => {
    expect(
      verdictFor(
        { rung: 4, check: 'node report6.mjs --assert 6', expect: '6' },
        { ...PASSED, stdout: '6' },
      ),
    ).toBe('uncheckable')
  })

  it('refuses an expectation that ends at the end of the check text', () => {
    expect(
      verdictFor(
        { rung: 4, check: 'grep -c PARETO=6', expect: 'PARETO=6' },
        { ...PASSED, stdout: 'PARETO=6' },
      ),
    ).toBe('uncheckable')
  })
})
