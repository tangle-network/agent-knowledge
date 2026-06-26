/**
 * Build a discriminative QA dataset from a real source document with REAL two-tier solvers.
 *
 * Grounds on the document (or takes an already-grounded excerpt), runs `createDataCreationLoop` with
 * the live router roles, writes the accepted examples as JSONL, and returns the numbers the
 * calibration depends on: the per-example strong/weak gap for the LOOP-ACCEPTED (agentic) examples
 * AND for the challenger's FIRST drafts (plain), plus the cost ledger split by role.
 */

import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { CostLedger } from '@tangle-network/agent-eval'
import {
  type AttemptRecord,
  createDataCreationLoop,
  discriminativeAcceptRule,
  type ExampleEvaluation,
} from './data-creation-loop'
import { type GroundedDoc, groundDoc } from './grounding'
import { buildAutodataRoles, type ChallengerStyle, type RouterCallRecord } from './router-roles'

export interface DiscriminativeThresholds {
  minStrong?: number
  maxWeak?: number
  minGap?: number
}

export interface AutodataDatasetConfig {
  apiKey: string
  baseUrl?: string
  /** A grounded excerpt, or a spec to fetch + chunk one from a real URL. */
  source: GroundedDoc | { url: string; focus?: string; cacheDir?: string }
  /** Where to write the JSONL dataset. */
  outPath: string
  target?: number
  samples?: number
  maxRetries?: number
  thresholds?: DiscriminativeThresholds
  models?: { challenger?: string; weak?: string; strong?: string; judge?: string }
  /** Challenger prompt: 'causal' (non-extractive, default) or 'recall' (the calibration baseline). */
  style?: ChallengerStyle
  /** Where to write the per-attempt autopsy JSONL (every candidate, accepted or rejected). */
  attemptsPath?: string
  signal?: AbortSignal
}

/** One accepted, discriminating training example with its real strong/weak scores + provenance. */
export interface DatasetRow {
  context: string
  question: string
  reference: string
  rubric: readonly string[]
  weakScore: number
  strongScore: number
  gap: number
  source: { url: string; headingPath: string; chunkIndex: number }
}

export interface AutodataDatasetResult {
  source: GroundedDoc
  accepted: ExampleEvaluation[]
  rows: DatasetRow[]
  /** Mean strong−weak gap on the challenger's first-draft (plain-generation) questions. */
  plainGapMean: number | null
  /** Mean strong−weak gap on the loop-accepted (agentic) questions. */
  agenticGapMean: number | null
  /** Mean of the BEST gap the refinement reached per slot (accepted or not) — the informative
   *  comparison against `plainGapMean` even when nothing clears the accept bar. */
  refinedGapMean: number | null
  plainGaps: number[]
  agenticGaps: number[]
  refinedGaps: number[]
  /** Every evaluated candidate (accepted or rejected) with both solvers' answers — the autopsy trail. */
  attempts: AttemptRecord[]
  cost: CostLedger
  costPerExampleUsd: number | null
  /** How many router calls were priced by the router vs rate-estimated. */
  callProvenance: { router: number; estimated: number }
  outPath: string
  /** Where the per-attempt autopsy JSONL was written (null if not requested). */
  attemptsPath: string | null
}

function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length
}

function isGrounded(s: AutodataDatasetConfig['source']): s is GroundedDoc {
  return typeof (s as GroundedDoc).doc === 'string'
}

/** The causal (default) user instruction — pairs with the non-extractive challenger system prompt. */
function causalInstruction(doc: string): string {
  return (
    `SOURCE DOCUMENT EXCERPT:\n\n${doc}\n\n` +
    `Write ONE hard CAUSAL / COMPARATIVE / MECHANISM / THESIS-CONSISTENCY question grounded in this ` +
    `excerpt — never a recall / lookup / definition. The CONTEXT must give the solver the premises ` +
    `but MUST NOT state the answer; the answer has to be DERIVED. Return STRICT JSON: ` +
    `{"context": string, "question": string, "reference": string, "rubric": string[] }.`
  )
}

/** The recall (baseline) user instruction — pairs with the extractive challenger; for calibration. */
function recallInstruction(doc: string): string {
  return (
    `SOURCE DOCUMENT EXCERPT:\n\n${doc}\n\n` +
    `Write ONE exam question grounded in this excerpt, with a short context excerpt the question is ` +
    `answerable from, a reference answer, and a 2-3 item rubric. Return STRICT JSON: ` +
    `{"context": string, "question": string, "reference": string, "rubric": string[] }.`
  )
}

function instructionFor(style: ChallengerStyle): (doc: string) => string {
  return style === 'recall' ? recallInstruction : causalInstruction
}

/** Run the full pipeline: ground → loop → JSONL. Returns the calibration numbers + cost. */
export async function buildAutodataDataset(
  config: AutodataDatasetConfig,
): Promise<AutodataDatasetResult> {
  const source = isGrounded(config.source)
    ? config.source
    : await groundDoc({
        url: config.source.url,
        focus: config.source.focus,
        cacheDir: config.source.cacheDir,
        signal: config.signal,
      })

  const provenance = { router: 0, estimated: 0 }
  const onCall = (rec: RouterCallRecord): void => {
    if (rec.costSource === 'router') provenance.router += 1
    else provenance.estimated += 1
  }

  const ledger = new CostLedger()
  const style: ChallengerStyle = config.style ?? 'causal'

  const roles = buildAutodataRoles({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    challengerModel: config.models?.challenger,
    weakModel: config.models?.weak,
    strongModel: config.models?.strong,
    judgeModel: config.models?.judge,
    challengerStyle: style,
    ledger,
    onCall,
  })

  // Per-attempt autopsy trail: every candidate (accepted or rejected) is appended as one JSONL row
  // with both solvers' answer text + scores, so a null is diagnosable from the raw answers.
  const attempts: AttemptRecord[] = []
  const attemptsPath = config.attemptsPath ?? null
  if (attemptsPath) {
    await mkdir(dirname(attemptsPath), { recursive: true })
    await rm(attemptsPath, { force: true })
  }
  const onAttempt = async (rec: AttemptRecord): Promise<void> => {
    attempts.push(rec)
    if (attemptsPath) await appendFile(attemptsPath, `${JSON.stringify({ ...rec, style })}\n`)
  }

  const result = await createDataCreationLoop({
    doc: source.doc,
    baseInstruction: instructionFor(style),
    challenger: roles.challenger,
    weakSolver: roles.weakSolver,
    strongSolver: roles.strongSolver,
    judge: roles.judge,
    accept: (i) => discriminativeAcceptRule({ ...i, ...config.thresholds }),
    target: config.target ?? 3,
    samples: config.samples ?? 3,
    maxRetries: config.maxRetries ?? 4,
    cost: ledger,
    onAttempt,
    signal: config.signal,
  })

  const rows: DatasetRow[] = result.accepted.map((ex) => ({
    context: ex.example.context,
    question: ex.example.question,
    reference: ex.example.reference,
    rubric: ex.example.rubric,
    weakScore: ex.weakScore,
    strongScore: ex.strongScore,
    gap: ex.gap,
    source: { url: source.url, headingPath: source.headingPath, chunkIndex: source.chunkIndex },
  }))

  await mkdir(dirname(config.outPath), { recursive: true })
  await writeFile(
    config.outPath,
    rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''),
  )

  return {
    source,
    accepted: result.accepted,
    rows,
    plainGapMean: mean(result.plainGaps),
    agenticGapMean: mean(result.agenticGaps),
    refinedGapMean: mean(result.refinedGaps),
    plainGaps: result.plainGaps,
    agenticGaps: result.agenticGaps,
    refinedGaps: result.refinedGaps,
    attempts,
    cost: result.cost,
    costPerExampleUsd: result.cost.costPerCompletedTask(),
    callProvenance: provenance,
    outPath: config.outPath,
    attemptsPath,
  }
}
