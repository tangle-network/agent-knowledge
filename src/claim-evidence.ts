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
   *
   * An expectation naming several values at once is admitted, and is the strongest shape
   * available: a false pass on `GRID OK cells=8 WIN=1 PARETO=6` needs three independent numbers
   * to coincide, where a one-token `OK` is satisfied by any output containing those two letters.
   */
  expect?: string
  /** Where the artifact backing the claim lives, for humans following the trail. */
  evidencePath?: string
}

/**
 * The refusal vocabulary, shared by both boundaries. Record time and grade time refuse the same
 * static shapes for the same reasons, so they read from one detector and one set of notes. A
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

const MULTILINE_EXPECTATION_NOTE =
  'the expected value spans multiple lines, but the grader performs one contiguous-substring ' +
  'comparison — record one decisive single-line value per claim'

const SELF_CERTIFYING_NOTE =
  'the check text contains the expected value, so the check carries the answer it is graded ' +
  'against and prints a value the claim did not have to produce — record a command that reads ' +
  'the artifact and prints the value it finds there'

const LONG_FIRST_WORD_NOTE =
  'the check begins with a shell word longer than 200 characters; this is the escaped-newline ' +
  'failure shape where \\n text was recorded instead of real line breaks — write the script to a file ' +
  'or record a real heredoc and a short invocation'

const INVALID_SHELL_SYNTAX_NOTE =
  'the recorded check does not parse under bash and would fail independently of the claim — ' +
  'record the exact command only after bash -n accepts it'

/**
 * The evidence recorded for a claim cannot be graded at the rung it was recorded at.
 *
 * One error type for every mechanically refused shape, because the grader reaches one verdict for
 * all of them: `uncheckable`. `note` names which shape was refused and what to record instead, in
 * the same words the grader reports, so an author reads one message wherever the claim is stopped.
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
 * Refuse the evidence shapes that made self-grading and false refutation possible. Call at record
 * time, not grade time: by grading it is too late — the ungradeable claim has already circulated.
 *
 * At and above `CHECKABLE_RUNG_THRESHOLD` this refuses every statically recognizable shape that
 * `gradeFor` grades `uncheckable`: no check, a check that cannot fail, an unusable expectation,
 * or the escaped-newline command shape. Below the threshold nothing is refused.
 *
 * Three additional rules are calibrated on downstream losses, not taste: four correct claims
 * died from multiline expectations, one campaign recorded an enormous first word made of literal
 * `\\n` sequences, and a 299-run fleet autopsy reduced ten reported grader failures to checks that
 * were never executed before their authors disappeared. The dynamic half of that last rule is
 * `verifyGradeableEvidence` below.
 */
export function assertGradeableEvidence(evidence: ClaimEvidence): ClaimEvidence {
  if (evidence.rung < CHECKABLE_RUNG_THRESHOLD) return evidence
  const note =
    checkRefusalNote(evidence.check) ??
    selfCertifyingNote(evidence) ??
    expectationRefusalNote(evidence.expect)
  if (note) throw new UncheckableClaimError(evidence.rung, note)
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
 *   unrunnable    the check itself could not execute (missing input, missing module), or its
 *                 deadline killed it — an environment verdict, never a claim verdict
 *   uncheckable   the recorded evidence cannot decide the claim at this rung
 */
export type ClaimVerdict =
  | 'verified'
  | 'silent-check'
  | 'contradicted'
  | 'unrunnable'
  | 'uncheckable'

/**
 * The output signatures that mean the check never reached what the claim is about.
 *
 * Matched case-insensitively, because a tool that prints its own diagnostic chooses its own case,
 * and read from the OUTPUT rather than from the exit status. A shell pipeline exits with the
 * status of its last stage, so `sha256sum <missing path> | cut -d' ' -f1` prints
 * "No such file or directory" and exits 0; reading only the status calls that a refutation of
 * research that was never run. Swept over 272 grade files, 29 of 61 recorded refutations were
 * this shape: 7 a malformed check body, 7 a shell that could not parse the check, 6 a solver that
 * could not open its problem file, 5 `Permission denied`, 4 `cannot create directory`.
 */
const UNRUNNABLE_SIGNATURES =
  /No such file|FileNotFoundError|ModuleNotFoundError|command not found|ENOENT|AbortError|timed out|ERR_CHILD_PROCESS_STDIO_MAXBUFFER|Permission denied|EACCES|cannot create directory|cannot open|SyntaxError|unexpected EOF while looking for matching|syntax error near unexpected token/i

/**
 * The exit status a deadline kill reports: `timeout(1)`'s status, and the one a bounded process
 * runner forces so a killed child that closes with 0 cannot read as a pass. A grader that has
 * only an exit status reports this one; a grader that knows it killed the process sets
 * `CheckExecution.timedOut` instead, which is unambiguous.
 */
export const DEADLINE_EXIT_CODE = 124

const DEADLINE_NOTE =
  'the check was killed at its deadline, so it never tested the claim — a deadline is a budget, ' +
  'not a verdict; raise the budget or record a check that decides within it'

const UNREACHED_INPUT_NOTE =
  'the check never reached what the claim is about, so this is a verdict on the environment ' +
  'and not on the claim'

export interface CheckExecution {
  exitCode: number
  stdout: string
  stderr: string
  /**
   * True when the executor killed the check at its deadline. The deadline is a budget, not a
   * verdict: a check that ran out of time never tested the claim.
   */
  timedOut?: boolean
}

/** A verdict with the reason a grader may report to the claim's author. */
export interface ClaimGrade {
  verdict: ClaimVerdict
  /** Present when the verdict is a refusal the author can fix, absent otherwise. */
  note?: string
  /**
   * The id of the earlier claim in the same grading pass that carries this claim's check,
   * expectation, title and verdict. Present only on the later claim, and it does not change the
   * verdict: N claims sharing one check are one verification counted N times, which is a
   * check-quality defect for a reader to see rather than a result to drop.
   */
  duplicateOf?: string
}

/**
 * The calibrated verdict function, pure so every grader shares one semantics. Callers execute the
 * check however their environment requires and pass the observation; this function only judges.
 *
 * Three rules decide a verdict before the expectation is compared, and each one exists because
 * comparing first blamed the claim for something the claim did not do:
 *
 *   - a check that carries its own expected value is refused, because its output is authored
 *     rather than measured;
 *   - a check killed at its deadline is `unrunnable`, because a budget is not a verdict;
 *   - a check whose output says it never reached its input is `unrunnable` whatever its exit
 *     status, because a pipeline hides the failing stage's status behind its last stage.
 */
export function gradeFor(
  evidence: Pick<ClaimEvidence, 'rung' | 'check' | 'expect'>,
  execution: CheckExecution | null,
): ClaimGrade {
  const mustBeCheckable = evidence.rung >= CHECKABLE_RUNG_THRESHOLD
  if (mustBeCheckable) {
    const note = checkRefusalNote(evidence.check) ?? selfCertifyingNote(evidence)
    if (note) return { verdict: 'uncheckable', note }
  }
  if (!execution) return { verdict: 'unrunnable' }
  const output = `${execution.stdout}\n${execution.stderr}`.trim()
  if (execution.timedOut || execution.exitCode === DEADLINE_EXIT_CODE) {
    return { verdict: 'unrunnable', note: DEADLINE_NOTE }
  }
  if (execution.exitCode !== 0) return refutation(output, evidence.expect)
  if (mustBeCheckable) {
    const note = expectationRefusalNote(evidence.expect)
    if (note) return { verdict: 'uncheckable', note }
  }
  if (evidence.expect && !output.includes(evidence.expect)) {
    if (output === '') return { verdict: 'silent-check' }
    return refutation(output, evidence.expect)
  }
  return { verdict: 'verified' }
}

/**
 * Decide between a claim verdict and an environment verdict for output that failed to establish
 * the claim. The signature list only ever downgrades a refutation to `unrunnable`: it can turn a
 * measurement that did not happen into an honest "not measured", and it can never turn a real
 * failure into a pass.
 *
 * The expectation is consulted first. A claim that PREDICTED the error is genuinely contradicted
 * when the error does not appear, so an expectation naming a signature switches this guard off
 * for that claim rather than letting it hide the one case it would grade backwards.
 */
function refutation(output: string, expect: string | undefined): ClaimGrade {
  if (expect && UNRUNNABLE_SIGNATURES.test(expect)) return { verdict: 'contradicted' }
  const hit = UNRUNNABLE_SIGNATURES.exec(output)
  if (!hit) return { verdict: 'contradicted' }
  return { verdict: 'unrunnable', note: `${UNREACHED_INPUT_NOTE} (${hit[0]})` }
}

/** A claim and the observation a grader made of it, as one grading pass sees them. */
export interface GradeableClaim {
  /** Stable identity a duplicate flag can point back to, such as the page or claim id. */
  id: string
  /** The claim's own sentence. Two claims that share a check but say different things differ. */
  title?: string
  evidence: Pick<ClaimEvidence, 'rung' | 'check' | 'expect'>
  execution: CheckExecution | null
}

/** A grade with the claim it belongs to, in the order the claims were supplied. */
export interface GradedClaim extends ClaimGrade {
  id: string
}

/**
 * Grade one pass of claims and flag the repeats within it.
 *
 * `gradeFor` judges one claim and cannot see a second claim carrying the same check, so a run
 * that recorded one verification under several titles reports as several independent
 * verifications. This function grades each claim exactly as `gradeFor` does and marks the later
 * claim with `duplicateOf`, leaving the verdict and the count untouched: the flag is for a reader
 * deciding how much evidence a run really produced.
 */
export function gradeClaims(claims: readonly GradeableClaim[]): GradedClaim[] {
  const firstSeen = new Map<string, string>()
  return claims.map((claim) => {
    const grade = gradeFor(claim.evidence, claim.execution)
    const key = claimCheckKey({ ...claim.evidence, title: claim.title })
    if (!key) return { id: claim.id, ...grade }
    const seenAt = `${key}\u0000${grade.verdict}`
    const canonical = firstSeen.get(seenAt)
    if (canonical === undefined) {
      firstSeen.set(seenAt, claim.id)
      return { id: claim.id, ...grade }
    }
    return { id: claim.id, ...grade, duplicateOf: canonical }
  })
}

/**
 * The identity two claims must share to be one verification counted twice: the same command, the
 * same expectation, and the same sentence. A check shared across claims that say different things
 * is one instrument used several times, which is not a duplicate.
 *
 * Returns `undefined` when the claim cannot be keyed at all — no check, or no title to compare —
 * so an unkeyable claim is never flagged as a repeat of another unkeyable one. The key is JSON
 * rather than a joined string, so no separator can collide with text inside a check.
 */
export function claimCheckKey(claim: {
  check?: string
  expect?: string
  title?: string
}): string | undefined {
  const check = claim.check?.trim()
  if (!check) return undefined
  const title = claim.title?.trim().replace(/\s+/g, ' ').toLowerCase().replace(/\.md$/, '')
  if (!title) return undefined
  return JSON.stringify([check, claim.expect?.trim() ?? '', title])
}

/** The verdict alone, for graders that report a lattice member and not a reason. */
export function verdictFor(
  evidence: Pick<ClaimEvidence, 'rung' | 'check' | 'expect'>,
  execution: CheckExecution | null,
): ClaimVerdict {
  return gradeFor(evidence, execution).verdict
}

export interface VerifyGradeableEvidenceOptions {
  /** Directory in which the later grader will execute the command. Required to avoid ambient cwd. */
  cwd: string
  /** Exact environment visible to the command. Omitted variables are genuinely absent. */
  env?: NodeJS.ProcessEnv
  /** Bash-compatible executable. Defaults to `bash`. */
  bashPath?: string
  /** Per syntax or execution process timeout. Defaults to 30 seconds. */
  timeoutMs?: number
  /** Combined stdout/stderr buffer ceiling. Defaults to 1 MiB. */
  maxBufferBytes?: number
  signal?: AbortSignal
}

export interface VerifiedGradeableEvidence {
  evidence: ClaimEvidence
  execution: CheckExecution
  grade: ClaimGrade
}

/**
 * Parse, execute, and grade evidence at intake using the same cwd and environment the blind grader
 * will use later.
 *
 * This function executes `evidence.check` verbatim. It is intentionally opt-in, Node-only at call
 * time, and dynamically imports `node:child_process` so edge consumers that never invoke it remain
 * importable. Callers must apply their own sandbox and capability policy before passing untrusted
 * commands here.
 */
export async function verifyGradeableEvidence(
  evidence: ClaimEvidence,
  options: VerifyGradeableEvidenceOptions,
): Promise<VerifiedGradeableEvidence> {
  const accepted = assertGradeableEvidence(evidence)
  const check = accepted.check as string
  const syntax = await runBash(['-n', '-c', check], options)
  if (syntax.exitCode !== 0) {
    const detail = `${syntax.stdout}\n${syntax.stderr}`.trim()
    const note = detail ? `${INVALID_SHELL_SYNTAX_NOTE}: ${detail}` : INVALID_SHELL_SYNTAX_NOTE
    throw new UncheckableClaimError(accepted.rung, note)
  }
  const execution = await runBash(['-c', check], options)
  return {
    evidence: accepted,
    execution,
    grade: gradeFor(accepted, execution),
  }
}

const WORD_CHARACTER = /[A-Za-z0-9_]/

/**
 * Whether the check text carries the value it is graded against.
 *
 * A check that contains its own expectation prints a value the claim's subject did not have to
 * produce, so the comparison that follows tests the author's typing rather than the artifact.
 * The test is the whole trimmed expectation appearing verbatim in the command, which is narrow
 * on purpose: it costs an author only a rewrite of the command, and it catches the shape
 * `isConstantEmitter` cannot, where a real command's arguments already spell the answer.
 *
 * An occurrence glued to a word character on a side where the expectation is itself a word
 * character does not count. Without that, a short expectation refuses the check that reads it:
 * `expect: 6` appears inside `node report6.mjs`, and refusing a correct claim is the cost this
 * file's rules are calibrated to avoid.
 */
function selfCertifyingNote(evidence: Pick<ClaimEvidence, 'check' | 'expect'>): string | undefined {
  const wanted = evidence.expect?.trim()
  const check = evidence.check
  if (!check || !wanted) return undefined
  const startsInsideWord = WORD_CHARACTER.test(wanted[0] as string)
  const endsInsideWord = WORD_CHARACTER.test(wanted[wanted.length - 1] as string)
  for (let at = check.indexOf(wanted); at !== -1; at = check.indexOf(wanted, at + 1)) {
    const before = check[at - 1]
    const after = check[at + wanted.length]
    if (startsInsideWord && before !== undefined && WORD_CHARACTER.test(before)) continue
    if (endsInsideWord && after !== undefined && WORD_CHARACTER.test(after)) continue
    return SELF_CERTIFYING_NOTE
  }
  return undefined
}

function checkRefusalNote(check: string | undefined): string | undefined {
  if (!check) return NO_CHECK_NOTE
  if (isConstantEmitter(check)) return CONSTANT_EMITTER_NOTE
  const firstWord = check.trimStart().split(/\s/, 1)[0] ?? ''
  if (firstWord.length > 200) return LONG_FIRST_WORD_NOTE
  return undefined
}

function expectationRefusalNote(expect: string | undefined): string | undefined {
  if (!expect?.trim()) return NO_EXPECTATION_NOTE
  if (expect.includes('\n') || expect.includes('\r')) return MULTILINE_EXPECTATION_NOTE
  return undefined
}

async function runBash(
  args: string[],
  options: VerifyGradeableEvidenceOptions,
): Promise<CheckExecution> {
  const { execFile } = await import('node:child_process')
  return new Promise((resolve) => {
    execFile(
      options.bashPath ?? 'bash',
      args,
      {
        cwd: options.cwd,
        env: options.env ?? {},
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: options.maxBufferBytes ?? 1024 * 1024,
        signal: options.signal,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const diagnostic = error && typeof error.code !== 'number' ? `${stderr}\n${error}` : stderr
        resolve({
          exitCode: typeof error?.code === 'number' ? error.code : error ? 127 : 0,
          stdout: String(stdout ?? ''),
          stderr: String(diagnostic ?? ''),
        })
      },
    )
  })
}
