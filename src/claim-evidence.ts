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
   * Required at rung 4 and above, where an exit code alone reproduces no value.
   */
  expect?: string
  /** Where the artifact backing the claim lives, for humans following the trail. */
  evidencePath?: string
}

/**
 * The refusal vocabulary, shared by both boundaries. Record time and grade time refuse the same
 * three shapes for the same reasons, so they read from one detector and one set of notes. A
 * second definition would let the two boundaries drift, and a claim the recorder admitted but the
 * grader refuses is exactly the gap this section exists to close.
 */

/** The commands that succeed unconditionally, so their exit code carries no information. */
const ALWAYS_SUCCEEDS = new Set(['true', ':'])

/** The commands that print their arguments back, so their output carries only their arguments. */
const PRINTS_ITS_ARGUMENTS = new Set(['echo', 'printf'])

/**
 * A character that makes an argument depend on something outside the command line: a pipe, a
 * command separator, a redirection from a file, a backtick or `$(` substitution, or a variable
 * reference. `$'` and `$"` are quoting sigils, not variable references.
 */
const READS_SOMETHING_ELSE = /[|;&\n<`]|\$(?!['"])/

/**
 * Whether a check emits a constant, and therefore cannot fail whatever the claim's subject does.
 *
 * The test is deliberately narrow and mechanical. It recognizes exactly two shapes: the whole
 * command is `true` or `:`, or the whole command is one `echo` or `printf` whose arguments read
 * nothing outside the command line. Anything else is treated as a real check.
 *
 * This CANNOT catch every check that cannot fail. A script that prints a hard-coded number, a
 * command whose output an author copied into `expect`, and an `echo` behind a shell alias all look
 * identical to a real check from here. Catching those is not this function's job: it needs an
 * independent party to re-derive the value, which is what rung 5 means. This function refuses only
 * the shapes that carry zero information on their face, where refusing costs the author nothing
 * but a rewrite of the command.
 */
function isConstantEmitter(check: string): boolean {
  const command = check.trim()
  if (ALWAYS_SUCCEEDS.has(command)) return true
  const argumentStart = command.search(/\s/)
  const head = argumentStart === -1 ? command : command.slice(0, argumentStart)
  if (!PRINTS_ITS_ARGUMENTS.has(head)) return false
  const argumentText = argumentStart === -1 ? '' : command.slice(argumentStart + 1)
  return !READS_SOMETHING_ELSE.test(argumentText)
}

const NO_CHECK_NOTE =
  'a claim at this rung asserts that a command reproduces a value, and no command was recorded ' +
  '— record the command that re-establishes it (evidence.check); without one the claim is a ' +
  'self-grade, which is rung 3 at most'

const NO_EXPECTATION_NOTE =
  'exit code alone cannot verify a claim at this rung — record the value the check must print'

const CONSTANT_EMITTER_NOTE =
  'the check is a constant emitter: it prints a fixed string and exits zero whatever the claim ' +
  'describes, so it can never fail — record a command that reads the artifact the claim is about'

/**
 * The evidence recorded for a claim cannot be graded at the rung it was recorded at.
 *
 * One error type for the three refused shapes, because the grader reaches one verdict for all
 * three: `uncheckable`. `note` names which shape was refused and what to record instead, in the
 * same words the grader reports, so an author reads one message wherever the claim is stopped.
 */
export class UncheckableClaimError extends Error {
  /** The rung whose evidence rule the recorded claim failed. */
  readonly rung: EvidenceRung
  /** The refused shape and the fix for it, in the grader's vocabulary. */
  readonly note: string

  constructor(rung: EvidenceRung, note: string) {
    super(`a claim at rung ${rung} cannot be recorded at that rung: ${note}`)
    this.name = 'UncheckableClaimError'
    this.rung = rung
    this.note = note
  }
}

/**
 * Refuse the evidence shapes that made self-grading possible. Call at record time, not grade
 * time: by grading it is too late — the ungradeable claim has already circulated as verified.
 *
 * At and above `CHECKABLE_RUNG_THRESHOLD` this refuses exactly what `gradeFor` grades
 * `uncheckable`, in the same order and by the same tests: no check, a check that cannot fail, and
 * a check with no expected value to print. Below the threshold nothing is refused.
 */
export function assertGradeableEvidence(evidence: ClaimEvidence): ClaimEvidence {
  if (evidence.rung < CHECKABLE_RUNG_THRESHOLD) return evidence
  if (!evidence.check) throw new UncheckableClaimError(evidence.rung, NO_CHECK_NOTE)
  if (isConstantEmitter(evidence.check)) {
    throw new UncheckableClaimError(evidence.rung, CONSTANT_EMITTER_NOTE)
  }
  if (!evidence.expect?.trim()) {
    throw new UncheckableClaimError(evidence.rung, NO_EXPECTATION_NOTE)
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
 *   uncheckable   the recorded evidence cannot decide the claim at this rung: no check, no
 *                 expectation for the check to print, or a check that cannot fail
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

/** A verdict with the reason a grader may report to the claim's author. */
export interface ClaimGrade {
  verdict: ClaimVerdict
  /** Present when the verdict is a refusal the author can fix, absent otherwise. */
  note?: string
}

/**
 * The calibrated verdict function, pure so every grader shares one semantics. Callers execute the
 * check however their environment requires and pass the observation; this function only judges.
 *
 * At and above `CHECKABLE_RUNG_THRESHOLD` a check must be able to fail. An acceptance criterion
 * that cannot fail is not one, so a constant-emitter check and a check with nothing to print are
 * `uncheckable`: the check did not decide the claim. They are not `contradicted`, because nothing
 * contradicted the claim. An execution that ran and refuted the claim still outranks both, so a
 * missing input stays `unrunnable` and a nonzero exit stays `contradicted`.
 */
export function gradeFor(
  evidence: Pick<ClaimEvidence, 'rung' | 'check' | 'expect'>,
  execution: CheckExecution | null,
): ClaimGrade {
  const mustBeCheckable = evidence.rung >= CHECKABLE_RUNG_THRESHOLD
  if (mustBeCheckable && !evidence.check) return { verdict: 'uncheckable', note: NO_CHECK_NOTE }
  if (mustBeCheckable && evidence.check && isConstantEmitter(evidence.check)) {
    return { verdict: 'uncheckable', note: CONSTANT_EMITTER_NOTE }
  }
  if (!execution) return { verdict: 'unrunnable' }
  const output = `${execution.stdout}\n${execution.stderr}`.trim()
  if (execution.exitCode !== 0) {
    return { verdict: UNRUNNABLE_SIGNATURES.test(output) ? 'unrunnable' : 'contradicted' }
  }
  if (mustBeCheckable && !evidence.expect?.trim()) {
    return { verdict: 'uncheckable', note: NO_EXPECTATION_NOTE }
  }
  if (evidence.expect && !output.includes(evidence.expect)) {
    return { verdict: output === '' ? 'silent-check' : 'contradicted' }
  }
  return { verdict: 'verified' }
}

/** The verdict alone, for graders that report a lattice member and not a reason. */
export function verdictFor(
  evidence: Pick<ClaimEvidence, 'rung' | 'check' | 'expect'>,
  execution: CheckExecution | null,
): ClaimVerdict {
  return gradeFor(evidence, execution).verdict
}
