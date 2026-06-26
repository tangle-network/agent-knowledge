/**
 * The Autodata / Agentic Self-Instruct INNER loop: an agent MANUFACTURES hard training examples
 * from a grounding doc and keeps only the ones that DISCRIMINATE a strong solver from a weak one.
 *
 * PROVENANCE — this loop is vendored verbatim from agent-runtime
 * `examples/agentic-data-creation/agentic-data-creation.ts` (branch
 * `examples/agentic-data-creation`). It is an EXAMPLE in agent-runtime, not a published runtime
 * export — examples are not shipped in the npm dist — so agent-knowledge cannot import it and
 * vendors it here (the "copy with a note" path). Every primitive it COMPOSES is reused from the
 * published packages, nothing is re-implemented: the judge is `llmJudge` (agent-eval), the loop
 * kernel is `runLoop` (agent-runtime/loops), the store is `InMemoryCorpus` (agent-runtime/loops),
 * the cost accounting is `CostLedger` (agent-eval). The REAL grounding (arXiv ingestion) + the REAL
 * two-tier router solvers live in the sibling files; this file stays domain- and transport-agnostic.
 *
 * The whole method is four roles + one accept rule:
 *   1. CHALLENGER  writes a candidate {context, question, reference, rubric} from the doc.
 *   2. WEAK solver and STRONG solver each attempt it, sampled N× to average out variance.
 *   3. JUDGE      scores every attempt against the rubric (one `llmJudge` call per attempt).
 *   4. ACCEPT     keeps the example ONLY IF it discriminates: strong >= hi, weak < lo, gap >= g —
 *                 plus a quality check (no context leakage, a real rubric).
 *   On reject, the CHALLENGER driver FOLDS the reject reason into its next prompt and retries.
 *   Accepted examples accrete into a `Corpus`.
 *
 * The ONE genuinely new piece is `discriminativeAcceptRule` — the paper's reward, written as a
 * small Validator-shaped accept/reject. It is a lift candidate for agent-eval (next to
 * `blendHeldout` / `HeldOutGate`) if it proves out across real domains; it lives here until then.
 */

import { CostLedger } from '@tangle-network/agent-eval'
import type { JudgeConfig, Scenario } from '@tangle-network/agent-eval/campaign'
import {
  type AgentRunSpec,
  type Corpus,
  type CorpusRecord,
  type Driver,
  InMemoryCorpus,
  type OutputAdapter,
  runLoop,
  type SandboxClient,
  type Validator,
} from '@tangle-network/agent-runtime/loops'
import type { AgentProfile, SandboxEvent } from '@tangle-network/sandbox'

// ── The four-role data shapes ─────────────────────────────────────────────────────────────

/** One manufactured training example, grounded in `context` excerpted from the doc. */
export interface DataExample {
  /** The grounding excerpt the question is answerable from. */
  readonly context: string
  readonly question: string
  /** The reference answer the rubric is graded against. */
  readonly reference: string
  /** Scoring criteria the judge applies (>= 2 for a usable example). */
  readonly rubric: readonly string[]
}

/** What the judge scores: a solver's `answer` to one `example`. */
export interface SolverArtifact {
  readonly example: DataExample
  readonly answer: string
}

/** The accept rule's verdict — keep this example, and why (or why not). */
export interface AcceptDecision {
  readonly accept: boolean
  readonly reason: string
}

// ═══════════════════════════════════════════════════════════════════════════════════════════
// THE ONE NEW PIECE — the paper's discriminative reward, as a small Validator-shaped rule.
// ═══════════════════════════════════════════════════════════════════════════════════════════
//
// Autodata keeps an example ONLY IF it separates a strong solver from a weak one: the strong
// solver should mostly get it (>= minStrong), the weak solver should mostly miss it (< maxWeak),
// and the margin between them (the "gap") must clear minGap. That is the whole objective, so the
// rule is the LITERAL accept criterion, never softened. The three reject reasons map one-to-one
// onto the challenger's next-prompt fold.
export function discriminativeAcceptRule(input: {
  /** Strong solver's mean rubric score, [0,1]. */
  strongScore: number
  /** Weak solver's mean rubric score, [0,1]. */
  weakScore: number
  /** Strong must reach at least this (else the example is unfair / too hard). Default 0.65. */
  minStrong?: number
  /** Weak must stay strictly below this (else the example is too easy). Default 0.5. */
  maxWeak?: number
  /** strong − weak must be at least this (else it does not discriminate). Default 0.2. */
  minGap?: number
}): AcceptDecision {
  const { strongScore, weakScore } = input
  const minStrong = input.minStrong ?? 0.65
  const maxWeak = input.maxWeak ?? 0.5
  const minGap = input.minGap ?? 0.2
  const gap = strongScore - weakScore

  if (strongScore < minStrong) {
    return {
      accept: false,
      reason: `too hard: strong solver reached only ${pct(strongScore)} (< ${pct(minStrong)})`,
    }
  }
  if (weakScore >= maxWeak) {
    return {
      accept: false,
      reason: `too easy: weak solver reached ${pct(weakScore)} (>= ${pct(maxWeak)})`,
    }
  }
  if (gap < minGap) {
    return { accept: false, reason: `not discriminative: gap ${pct(gap)} (< ${pct(minGap)})` }
  }
  return {
    accept: true,
    reason: `discriminates: strong ${pct(strongScore)} >= ${pct(minStrong)}, weak ${pct(weakScore)} < ${pct(maxWeak)}, gap ${pct(gap)} >= ${pct(minGap)}`,
  }
}

/**
 * The quality gate the paper pairs with the gap: reject examples that LEAK the answer into the
 * context (a copy-paste solver would pass), or that ship a thin rubric. Deterministic, no LLM.
 */
export function qualityCheck(ex: DataExample): { ok: boolean; reason: string } {
  const ref = ex.reference.trim()
  if (ref.length > 0 && ex.context.includes(ref)) {
    return { ok: false, reason: 'leaked: the reference answer appears verbatim in the context' }
  }
  if (ex.rubric.length < 2) {
    return { ok: false, reason: 'thin rubric: an example needs >= 2 scoring criteria' }
  }
  return { ok: true, reason: 'clean' }
}

// ── Tasks + output adapters (the worker seam) ──────────────────────────────────────────────

/** The challenger's task: ground on `doc`, run the `prompt` the driver authored this round. */
interface ChallengerTask {
  readonly doc: string
  /** The instruction for THIS round — the refine driver rewrites it from the last reject. */
  readonly prompt: string
}

/** One solver attempt over an `example`; `sampleIndex` distinguishes the N parallel samples. */
interface SolverTask {
  readonly example: DataExample
  readonly sampleIndex: number
}

const challengerOutput: OutputAdapter<DataExample> = {
  parse(events) {
    const ex = resultPayload(events)
    if (isDataExample(ex)) return ex
    // Fail loud: a challenger that produced no parseable example is a real defect, not an empty pass.
    throw new Error('challenger produced no parseable DataExample')
  },
}

const solverOutput: OutputAdapter<{ answer: string }> = {
  parse(events) {
    const r = resultPayload(events)
    if (
      r &&
      typeof r === 'object' &&
      'answer' in r &&
      typeof (r as { answer: unknown }).answer === 'string'
    ) {
      return { answer: (r as { answer: string }).answer }
    }
    throw new Error('solver produced no answer')
  },
}

/** One solver attempt's recorded answer + judge score — the unit of the per-example autopsy dump. */
export interface SolverSample {
  readonly answer: string
  readonly score: number
  readonly notes?: string
}

/** A solver's N× sampled result: the variance-reduced mean the accept rule compares + the raw samples. */
export interface SolverEval {
  readonly mean: number
  readonly samples: readonly SolverSample[]
}

// ── N× solver sampling = an inline FANOUT driver over runLoop ────────────────────────────────
//
// A "round" returns N independent solver tasks (no fold between them) → the kernel runs all N,
// the `llmJudge`-as-validator scores each against the rubric, and we AVERAGE the N scores (the
// variance-reduced estimate the accept rule compares — not argmax). runLoop already aggregated
// the N calls' cost, so we roll its total into the ledger under this solver's channel. Each sample's
// ANSWER TEXT and score are captured (not just the mean) so a null is autopsy-able per example.
async function sampleSolverScore(args: {
  solver: SandboxClient
  solverSpec: AgentRunSpec<SolverTask>
  example: DataExample
  judge: JudgeConfig<SolverArtifact>
  samples: number
  channel: string
  ledger: CostLedger
  signal?: AbortSignal
}): Promise<SolverEval> {
  const { solver, solverSpec, example, judge, samples, channel, ledger } = args

  const collected: SolverSample[] = []
  const validator: Validator<{ answer: string }> = {
    async validate(out, ctx) {
      const score = await judge.score({
        artifact: { example, answer: out.answer },
        scenario: solveScenario,
        signal: ctx.signal,
      })
      collected.push({ answer: out.answer, score: score.composite, notes: score.notes })
      return { valid: !score.failed, score: score.composite, notes: score.notes }
    },
  }

  const fanout: Driver<SolverTask, { answer: string }, 'done'> = {
    name: `${channel}/sample-x${samples}`,
    plan: async (task, history) =>
      history.length === 0
        ? Array.from({ length: samples }, (_, i) => ({ ...task, sampleIndex: i }))
        : [],
    decide: () => 'done',
  }

  const result = await runLoop<SolverTask, { answer: string }, 'done'>({
    driver: fanout,
    agentRun: solverSpec,
    output: solverOutput,
    validator,
    task: { example, sampleIndex: 0 },
    ctx: { sandboxClient: solver, signal: args.signal },
    maxIterations: samples,
    maxConcurrency: samples,
  })

  ledger.record({
    model: solverSpec.profile.name ?? channel,
    channel,
    usage: { inputTokens: result.tokenUsage.input, outputTokens: result.tokenUsage.output },
    actualCostUsd: result.costUsd,
    tags: { role: channel },
  })

  if (collected.length === 0)
    throw new Error(`${channel}: every solver sample errored — no score to average`)
  const mean = collected.reduce((a, b) => a + b.score, 0) / collected.length
  return { mean, samples: collected }
}

// ── The challenger refine driver — the FOLD ──────────────────────────────────────────────────

type ChallengerDecision = 'refine' | 'accept' | 'reject'

/**
 * The steer the fold appends per reject reason. The accept rule and this map are a matched pair:
 * "too easy" almost always means the answer leaked into the context (recall), so the steer is to go
 * non-extractive; "too hard" eases the derivation; "not discriminative" sharpens the contrast.
 */
function foldGuidance(why: string): string {
  if (/leaked/i.test(why)) {
    return (
      'The reference answer leaked into the context. Rewrite so the CONTEXT holds ONLY the premises ' +
      'and the answer must be DERIVED, never quoted.'
    )
  }
  if (/too easy/i.test(why)) {
    return (
      'The weak solver scored too high — the answer is extractable from the context (recall / ' +
      'leakage). Ask a CAUSAL or COMPARATIVE question whose answer is NOT stated in the context and ' +
      'must be derived, and delete any sentence from the context that states the conclusion.'
    )
  }
  if (/too hard/i.test(why)) {
    return (
      'Even the strong solver missed it — ease it. Keep it causal, but shorten the required ' +
      'reasoning chain and make sure EVERY premise needed to derive the answer is present in the ' +
      'context (without stating the conclusion).'
    )
  }
  if (/not discriminative/i.test(why)) {
    return (
      'Both solvers scored similarly — sharpen the contrast: the question must need a multi-step ' +
      'derivation a small model gets wrong, while keeping every premise a strong model needs in the ' +
      'context.'
    )
  }
  return 'Write a new example that fixes exactly the stated problem.'
}

function challengerDriver(
  maxRetries: number,
  baseInstruction: (doc: string) => string,
): Driver<ChallengerTask, DataExample, ChallengerDecision> {
  return {
    name: 'challenger-refine',
    async plan(task, history) {
      if (history.length === 0) return [task] // shot 0: a first draft straight from the doc
      const last = history[history.length - 1]
      if (last?.verdict?.valid) return [] // accepted → stop
      if (history.length >= maxRetries) return [] // out of budget → stop
      // THE FOLD: read WHY the last example was rejected and rewrite the instruction to target it.
      // Each accept-rule reason maps to a specific steer toward "just right".
      const why = last?.verdict?.notes ?? 'rejected'
      const prompt = `${baseInstruction(task.doc)}\n\nYour previous example was REJECTED: ${why}.\n${foldGuidance(why)}`
      return [{ ...task, prompt }]
    },
    decide(history) {
      if (history.some((it) => it.verdict?.valid)) return 'accept'
      return history.length < maxRetries ? 'refine' : 'reject'
    },
  }
}

// ── One example's full evaluation (used for both the accept loop and calibration) ─────────────

export interface ExampleEvaluation {
  readonly example: DataExample
  readonly weakScore: number
  readonly strongScore: number
  readonly gap: number
  readonly decision: AcceptDecision
}

/**
 * One fully-evaluated challenger attempt — emitted to `onAttempt` for EVERY candidate, accepted or
 * rejected. The whole point is diagnosability: a null is only a finding if you can read the actual
 * answers and see WHY the gap didn't open (weak read it out of the context, judge couldn't separate,
 * strong erred, …). This carries the answer text both solvers produced, not just the scalar scores.
 */
export interface AttemptRecord {
  /** Which target slot (outer loop index). */
  readonly slotIndex: number
  /** Which refine iteration within the slot (0 = first draft / plain). */
  readonly iteration: number
  readonly example: DataExample
  readonly weak: SolverEval
  readonly strong: SolverEval
  readonly gap: number
  readonly decision: AcceptDecision
  /** Whether the deterministic quality gate (no leak, real rubric) passed before solving. */
  readonly qualityOk: boolean
}

// ── The loop ────────────────────────────────────────────────────────────────────────────────

export interface DataCreationConfig {
  /** The grounding document the challenger writes examples from. */
  readonly doc: string
  /** The challenger worker (prompt → DataExample). The driver authors each round's prompt. */
  readonly challenger: SandboxClient
  /** The weak + strong solver workers (rendered example → answer). */
  readonly weakSolver: SandboxClient
  readonly strongSolver: SandboxClient
  /** The rubric judge — an `llmJudge` `JudgeConfig`. */
  readonly judge: JudgeConfig<SolverArtifact>
  /** The challenger's base instruction over the doc (the un-folded prompt). */
  readonly baseInstruction: (doc: string) => string
  /** How a solver sees one example. Default: context + question + numbered rubric + sample tag. */
  readonly renderSolverPrompt?: (example: DataExample, sampleIndex: number) => string
  /** Profiles materialized for each worker (names surface in traces + the cost ledger). */
  readonly challengerProfile?: AgentProfile
  readonly weakSolverProfile?: AgentProfile
  readonly strongSolverProfile?: AgentProfile
  /** The accept rule. Defaults to `discriminativeAcceptRule` at its paper thresholds. */
  readonly accept?: (input: { strongScore: number; weakScore: number }) => AcceptDecision
  /** How many accepted examples to manufacture. Default 3. */
  readonly target?: number
  /** Solver samples per example (variance reduction). Default 3. */
  readonly samples?: number
  /** Refine budget per example. Default 4. */
  readonly maxRetries?: number
  /** Where accepted examples accrete. Default a fresh `InMemoryCorpus`. */
  readonly corpus?: Corpus
  /** Cost ledger to record into. Default a fresh `CostLedger`. */
  readonly cost?: CostLedger
  /**
   * Observability hook: fired once per evaluated candidate (accepted OR rejected) with both solvers'
   * answer text + scores. Wire a JSONL writer here so every null is autopsy-able. Errors are not
   * swallowed — a throwing observer fails the run loud.
   */
  readonly onAttempt?: (rec: AttemptRecord) => void | Promise<void>
  readonly signal?: AbortSignal
}

/**
 * Default solver prompt: the premises + the question — never the rubric. The rubric is the grading
 * key; showing it to the solver hands the weak model the mark scheme and closes the very gap the
 * discriminative reward is trying to open. The answer is not stated in the context (the challenger
 * withholds the conclusion), so the prompt tells the solver to DERIVE it.
 */
function defaultRenderSolverPrompt(example: DataExample, sampleIndex: number): string {
  return (
    `Answer the QUESTION by reasoning from the CONTEXT. The answer is NOT stated verbatim in the ` +
    `context — you must derive it.\n\n` +
    `CONTEXT:\n${example.context}\n\n` +
    `QUESTION:\n${example.question}\n` +
    `[sample ${sampleIndex}]`
  )
}

export interface DataCreationResult {
  /** The accepted, discriminating examples (the manufactured training set). */
  readonly accepted: ExampleEvaluation[]
  /** The `gap` of each accepted example — large by construction (the agentic arm). */
  readonly agenticGaps: number[]
  /** The `gap` of each FIRST (un-refined) draft — the plain-generation baseline for calibration. */
  readonly plainGaps: number[]
  /** Per slot, the BEST gap the refinement reached (max over the budget), accepted or not. Lets the
   *  plain-vs-refined calibration stay informative even when no example clears the accept bar. */
  readonly refinedGaps: number[]
  readonly corpus: Corpus
  readonly cost: CostLedger
}

/**
 * Run the Autodata inner loop: manufacture `target` discriminating examples from `doc`, refining
 * each via the challenger fold until it is accepted (or its retry budget runs out). Returns the
 * accepted set, the per-example gap for the accepted (agentic) AND the first-draft (plain) examples
 * for calibration, the corpus they accreted into, and the cost ledger.
 */
export async function createDataCreationLoop(
  config: DataCreationConfig,
): Promise<DataCreationResult> {
  const corpus = config.corpus ?? new InMemoryCorpus()
  const cost = config.cost ?? new CostLedger()
  const accept = config.accept ?? ((i) => discriminativeAcceptRule(i))
  const target = config.target ?? 3
  const samples = config.samples ?? 3
  const maxRetries = config.maxRetries ?? 4
  const renderSolverPrompt = config.renderSolverPrompt ?? defaultRenderSolverPrompt

  // Build the three worker specs once (task → prompt + the profile the substrate materializes).
  const challengerSpec: AgentRunSpec<ChallengerTask> = {
    profile: config.challengerProfile ?? ({ name: 'challenger' } as AgentProfile),
    taskToPrompt: (t) => t.prompt,
  }
  const weakSolverSpec: AgentRunSpec<SolverTask> = {
    profile: config.weakSolverProfile ?? ({ name: 'weak-solver' } as AgentProfile),
    taskToPrompt: (t) => renderSolverPrompt(t.example, t.sampleIndex),
  }
  const strongSolverSpec: AgentRunSpec<SolverTask> = {
    profile: config.strongSolverProfile ?? ({ name: 'strong-solver' } as AgentProfile),
    taskToPrompt: (t) => renderSolverPrompt(t.example, t.sampleIndex),
  }

  const accepted: ExampleEvaluation[] = []
  const agenticGaps: number[] = []
  const plainGaps: number[] = []
  const refinedGaps: number[] = []

  for (let i = 0; i < target; i++) {
    // The challenger validator evaluates a candidate example: sample both solvers, judge each, then
    // apply the accept rule. It stashes each iteration's evaluation so the loop can read back the
    // ACCEPTED one (the agentic arm) and the FIRST draft (the plain calibration baseline).
    const evaluations = new Map<number, ExampleEvaluation>()
    const emptyEval: SolverEval = { mean: 0, samples: [] }
    const validator: Validator<DataExample> = {
      async validate(example, ctx) {
        const quality = qualityCheck(example)
        const weak = quality.ok
          ? await sampleSolverScore({
              solver: config.weakSolver,
              solverSpec: weakSolverSpec,
              example,
              judge: config.judge,
              samples,
              channel: 'weak-solver',
              ledger: cost,
              signal: ctx.signal,
            })
          : emptyEval
        const strong = quality.ok
          ? await sampleSolverScore({
              solver: config.strongSolver,
              solverSpec: strongSolverSpec,
              example,
              judge: config.judge,
              samples,
              channel: 'strong-solver',
              ledger: cost,
              signal: ctx.signal,
            })
          : emptyEval
        const weakScore = weak.mean
        const strongScore = strong.mean
        const decision = quality.ok
          ? accept({ strongScore, weakScore })
          : { accept: false, reason: quality.reason }
        const gap = strongScore - weakScore
        evaluations.set(ctx.iteration, { example, weakScore, strongScore, gap, decision })
        // Emit the full attempt (accept OR reject) so the null is diagnosable from the raw answers.
        if (config.onAttempt) {
          await config.onAttempt({
            slotIndex: i,
            iteration: ctx.iteration,
            example,
            weak,
            strong,
            gap,
            decision,
            qualityOk: quality.ok,
          })
        }
        return { valid: decision.accept, score: gap, notes: decision.reason }
      },
    }

    const result = await runLoop<ChallengerTask, DataExample, ChallengerDecision>({
      driver: challengerDriver(maxRetries, config.baseInstruction),
      agentRun: challengerSpec,
      output: challengerOutput,
      validator,
      task: { doc: config.doc, prompt: config.baseInstruction(config.doc) },
      ctx: { sandboxClient: config.challenger, signal: config.signal },
      maxIterations: maxRetries + 1,
    })

    cost.record({
      model: challengerSpec.profile.name ?? 'challenger',
      channel: 'challenger',
      usage: { inputTokens: result.tokenUsage.input, outputTokens: result.tokenUsage.output },
      actualCostUsd: result.costUsd,
      tags: { role: 'challenger' },
    })

    // The "plain" (un-refined) baseline is the FIRST candidate that was actually evaluated — the
    // earliest recorded iteration. Reading a hardcoded index 0 silently drops the baseline whenever
    // the first challenger draft errored (e.g. unparseable JSON), which is exactly when the slot's
    // first SUCCESSFUL draft sits at a later index. Take the min recorded iteration instead.
    const firstIteration = [...evaluations.keys()].sort((a, b) => a - b)[0]
    const plain = firstIteration === undefined ? undefined : evaluations.get(firstIteration)
    if (plain) plainGaps.push(plain.gap)

    const slotGaps = [...evaluations.values()].map((e) => e.gap)
    if (slotGaps.length > 0) refinedGaps.push(Math.max(...slotGaps))

    // ONLY a genuinely-accepted winner counts. `defaultSelectWinner` falls back to the best-scoring
    // iteration when none is valid, so `result.winner` is set even when the accept rule rejected
    // every candidate — with real solvers that frequently happens (no question separated the tiers
    // inside the budget). Gate on `verdict.valid` so the manufactured set never includes a rejected
    // example; a target slot that never produced a discriminating example is simply left unfilled.
    if (result.winner?.verdict?.valid) {
      const winnerEval = evaluations.get(result.winner.iterationIndex)
      if (!winnerEval) throw new Error('internal: accepted iteration has no recorded evaluation')
      const append = await corpus.append(toCorpusRecord(winnerEval, i))
      if (!append.succeeded) throw new Error(`corpus append failed: ${append.error}`)
      accepted.push(winnerEval)
      agenticGaps.push(winnerEval.gap)
      cost.markCompleted()
    }
  }

  return { accepted, agenticGaps, plainGaps, refinedGaps, corpus, cost }
}

// ── Helpers ───────────────────────────────────────────────────────────────────────────────

const solveScenario: Scenario = { id: 'agentic-data-creation', kind: 'solve' }

function toCorpusRecord(evalRec: ExampleEvaluation, index: number): CorpusRecord {
  return {
    schemaVersion: '1.0.0',
    id: `example-${index}`,
    runId: 'agentic-data-creation',
    producedAt: new Date().toISOString(),
    area: 'training-data',
    claim: JSON.stringify(evalRec.example),
    rationale: evalRec.decision.reason,
    tags: ['discriminative', `gap:${evalRec.gap.toFixed(2)}`],
    // The gap is the producing run's confidence this example is hard — clamped into [0,1].
    confidence: Math.min(1, Math.max(0, evalRec.gap)),
  }
}

function resultPayload(events: SandboxEvent[]): unknown {
  for (const ev of events) {
    if (ev.type === 'result') return (ev as { data?: { result?: unknown } }).data?.result
  }
  return undefined
}

function isDataExample(value: unknown): value is DataExample {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.context === 'string' &&
    typeof v.question === 'string' &&
    typeof v.reference === 'string' &&
    Array.isArray(v.rubric)
  )
}

function pct(x: number): string {
  return x.toFixed(2)
}
