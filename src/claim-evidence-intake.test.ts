import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  assertGradeableEvidence,
  gradeFor,
  UncheckableClaimError,
  verifyGradeableEvidence,
} from './claim-evidence'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'claim-evidence-intake-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('calibrated static intake refusals', () => {
  it('refuses a multiline expectation in the same words at record and grade time', () => {
    const evidence = {
      rung: 4 as const,
      check: 'cat result.txt',
      expect: 'value=42\nstatus=verified',
    }

    let raised: UncheckableClaimError | undefined
    try {
      assertGradeableEvidence(evidence)
    } catch (error) {
      raised = error as UncheckableClaimError
    }

    expect(raised).toBeInstanceOf(UncheckableClaimError)
    expect(raised?.note).toContain('single-line value')
    expect(gradeFor(evidence, { exitCode: 0, stdout: evidence.expect, stderr: '' }).note).toBe(
      raised?.note,
    )
  })

  it('records an expectation that names several values at once', () => {
    // The strongest expectation available: a false pass needs three independent values to
    // coincide, where a one-token expectation is met by any output containing that token.
    expect(
      assertGradeableEvidence({
        rung: 4,
        check: 'python3 check.py',
        expect: 'rank=12 size=40 verified=true',
      }).expect,
    ).toBe('rank=12 size=40 verified=true')
  })

  it('refuses the escaped-newline long-first-word shape', () => {
    expect(() =>
      assertGradeableEvidence({
        rung: 5,
        check: `${'python3\\n'.repeat(30)}print(42)`,
        expect: '42',
      }),
    ).toThrow(/longer than 200 characters/)
  })

  it('does not tighten lower evidence rungs', () => {
    expect(
      assertGradeableEvidence({
        rung: 3,
        check: 'true',
        expect: 'a=1 b=2 c=3\ncontinued',
      }).rung,
    ).toBe(3)
  })
})

describe('verifyGradeableEvidence', () => {
  it('refuses a command bash cannot parse before executing it', async () => {
    await expect(
      verifyGradeableEvidence(
        { rung: 4, check: 'if then', expect: 'value=42' },
        { cwd: root, env: process.env },
      ),
    ).rejects.toThrow(/does not parse under bash/)
  })

  it('executes against the caller-supplied working directory and environment', async () => {
    await writeFile(join(root, 'result.txt'), '42\n')

    const result = await verifyGradeableEvidence(
      {
        rung: 4,
        check: 'printf "value=%s token=%s\\n" "$(cat result.txt)" "$CLAIM_TOKEN"',
        expect: 'value=42 token=bound',
        evidencePath: 'result.txt',
      },
      { cwd: root, env: { ...process.env, CLAIM_TOKEN: 'bound' } },
    )

    expect(result.execution).toMatchObject({ exitCode: 0 })
    expect(result.grade).toEqual({ verdict: 'verified' })
  })

  it('returns a claim verdict when the check parses but refutes the claim', async () => {
    await writeFile(join(root, 'result.txt'), '42\n')

    const result = await verifyGradeableEvidence(
      {
        rung: 4,
        check: 'test "$(cat result.txt)" = 7',
        expect: 'value=7',
      },
      { cwd: root, env: process.env },
    )

    expect(result.execution.exitCode).toBe(1)
    expect(result.grade).toEqual({ verdict: 'contradicted' })
  })
})
