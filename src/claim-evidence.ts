/**
 * The evidence contract for claims that machines, not authors, get to grade.
 *
 * Grown in a discovery campaign that learned each rule by paying for it. Self-reported
 * verification is a dead channel: an entire run's twenty-eight true claims scored zero because
 * nothing carried a check a grader could re-execute, and a sibling lab's cells once produced six
 * false certifications in seventeen deliveries without a single agent lying — the format betrayed
 * them. The countermeasure is mechanical: a claim above a threshold must carry the command that
 * re-establishes it, and an independent grader re-runs that command blind.
 *
 * The verdict lattice below is calibrated, not designed: its first contact with real claims
 * graded three TRUE results as refuted, because a silent assert exits zero printing nothing and
 * the expectation could never match empty output. Every distinction here exists because collapsing
 * it blamed the wrong party — a claim for its environment, or an author for their formatting.
 */

/**
 * How far up the ladder a claim's evidence actually reaches. The rungs are five different
 * statements and only the top two are verification:
 *
 *   1 — it parses / exists          3 — its tests pass         5 — independently re-derived
 *   2 — it imports / loads          4 — reproduces a claimed value
 *
 * Reporting a low rung in the vocabulary of a high one is the most expensive error available to a
 * knowledge system: it is indistinguishable from success and propagates as settled provenance.
 */
export type EvidenceRung = 1 | 2 | 3 | 4 | 5

/** The rung at and above which a claim must be machine-checkable to be recorded at that rung. */
export const CHECKABLE_RUNG_THRESHOLD = 4

export interface ClaimEvidence {
  rung: EvidenceRung
  /**
   * A shell command that re-establishes the claim when run by a grader the author cannot edit,
   * from a working directory the author must not assume. Required at rung 4 and above.
   */
  check?: string
  /**
   * A substring the check's stdout must contain — the decisive value, printed. A check that
   * exits zero but prints nothing cannot confirm a value; authors should print the number.
   */
  expect?: string
  /** Where the artifact backing the claim lives, for humans following the trail. */
  evidencePath?: string
}

export class UncheckableClaimError extends Error {
  constructor(rung: EvidenceRung) {
    super(
      `a claim at rung ${rung} asserts "a command reproduces a value" and must carry that ` +
        `command (evidence.check); without one it is a self-grade, which is rung 3 at most`,
    )
    this.name = 'UncheckableClaimError'
  }
}

/**
 * Refuse the evidence shapes that made self-grading possible. Call at record time, not grade
 * time: by grading it is too late — the ungradeable claim has already circulated as verified.
 */
export function assertGradeableEvidence(evidence: ClaimEvidence): ClaimEvidence {
  if (evidence.rung >= CHECKABLE_RUNG_THRESHOLD && !evidence.check) {
    throw new UncheckableClaimError(evidence.rung)
  }
  return evidence
}

/**
 * What a grader may conclude from re-executing a claim's check.
 *
 *   verified      exit 0, and the expectation (if any) appears in output
 *   silent-check  exit 0, expectation given, output empty — the check passed but proves nothing
 *                 about the expected value; the author should make the check PRINT it
 *   contradicted  the check ran and refuted the claim: nonzero exit, or non-empty output that
 *                 lacks the expectation
 *   unrunnable    the check itself could not execute (missing input, missing module) — an
 *                 environment verdict, never a claim verdict
 *   uncheckable   rung demanded a check and none was recorded — a self-grade, counted against
 */
export type ClaimVerdict =
  | 'verified'
  | 'silent-check'
  | 'contradicted'
  | 'unrunnable'
  | 'uncheckable'

/** The error signatures that mean the check could not run, as opposed to ran and failed. */
const UNRUNNABLE_SIGNATURES =
  /No such file|FileNotFoundError|ModuleNotFoundError|command not found|ENOENT/

export interface CheckExecution {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * The calibrated verdict function, pure so every grader shares one semantics. Callers execute the
 * check however their environment requires and pass the observation; this function only judges.
 */
export function verdictFor(
  evidence: Pick<ClaimEvidence, 'rung' | 'check' | 'expect'>,
  execution: CheckExecution | null,
): ClaimVerdict {
  if (evidence.rung >= CHECKABLE_RUNG_THRESHOLD && !evidence.check) return 'uncheckable'
  if (!execution) return 'unrunnable'
  const output = `${execution.stdout}\n${execution.stderr}`.trim()
  if (execution.exitCode !== 0) {
    return UNRUNNABLE_SIGNATURES.test(output) ? 'unrunnable' : 'contradicted'
  }
  if (evidence.expect && !output.includes(evidence.expect)) {
    return output === '' ? 'silent-check' : 'contradicted'
  }
  return 'verified'
}
