/**
 * Autodata — POWERED accept-rate measurement.
 *
 * Settles the question n=3 was too noisy to answer: does the causal-challenger loop RELIABLY
 * manufacture discriminating examples, or is acceptance a coin-flip? It runs a FIXED number of
 * independent slots (each slot = one full challenger→refine→accept cycle) split across >= 2
 * non-memorized grounding docs, and reports the ACCEPTED-RATE with a Wilson 95% CI, the per-slot
 * best-gap distribution, and the plain-vs-refined gap-widening with a paired-bootstrap CI.
 *
 * This is a FIXED-SLOTS harness, NOT until-N-accepted: it runs K slots and records each slot's
 * outcome (accept/reject) + best gap, so the rate is bounded-cost and unbiased. It reuses
 * `buildAutodataDataset` — which already runs exactly `target` independent slots — so nothing in the
 * loop is rebuilt; only the cross-slot aggregation + the two confidence intervals are added here.
 * The CIs are agent-eval's published estimators (`wilson` for the binomial accept-rate, `pairedBootstrap`
 * for the paired plain-vs-refined widening), never hand-rolled.
 *
 * The source of truth is the per-attempt autopsy JSONL each doc writes incrementally: the final
 * statistics are recomputed by re-reading those trails from disk (`analyzeTrails`), so an interrupted
 * run loses no data — re-run the analysis over the JSONL.
 *
 * Run (key never printed):
 *   dotenvx run -f /home/drew/company/devops/secrets/agent-state.env -- \
 *     pnpm tsx src/autodata/powered.ts
 *
 * Env knobs: AUTODATA_SLOTS_PER_DOC (default 14), AUTODATA_SAMPLES (default 4),
 *            AUTODATA_MAXRETRIES (default 3), AUTODATA_DOCS ("url|focus|tag,url|focus|tag" override),
 *            AUTODATA_{WEAK,STRONG,CHALLENGER,JUDGE}_MODEL, TANGLE_API_KEY (or TANGLE_ROUTER_KEY).
 */

import { readFile } from 'node:fs/promises'
import { pairedBootstrap, wilson } from '@tangle-network/agent-eval'
import { buildAutodataDataset } from './build-dataset'
import type { AttemptRecord } from './data-creation-loop'
import { groundDoc } from './grounding'
import {
  CHALLENGER_MODEL,
  JUDGE_MODEL,
  STRONG_SOLVER_MODEL,
  smokeTestModels,
  WEAK_SOLVER_MODEL,
} from './router-roles'

/** One grounding document to split slots across. */
interface DocSpec {
  url: string
  focus: string
  tag: string
}

/**
 * Two non-memorized, reasoning-rich MoE papers (both post-date `llama-3.1-8b`'s knowledge cutoff, so
 * the weak solver must REASON from the context, not recall) — the precondition for any gap to open.
 * Each `focus` selects a PROSE mechanism chunk in the same "MoE-expert reasoning" band: a chunk dense
 * with LaTeX equations (e.g. DeepSeek-V3's MLA section) breaks the challenger's strict-JSON output, so
 * both focuses target the prose description of an expert-routing mechanism, not the equations.
 *   • Mixtral-of-Experts (2401.04088, Jan 2024) — sparse MoE expert routing / gating.
 *   • DeepSeek-V3 (2412.19437, Dec 2024) — auxiliary-loss-free load balancing / expert specialization.
 */
const defaultDocs: DocSpec[] = [
  { url: 'https://ar5iv.labs.arxiv.org/html/2401.04088', focus: 'expert', tag: 'mixtral' },
  { url: 'https://ar5iv.labs.arxiv.org/html/2412.19437', focus: 'auxiliary', tag: 'deepseek-v3' },
]

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name}='${raw}' is not a positive integer`)
  return n
}

function parseDocsEnv(): DocSpec[] {
  const raw = process.env.AUTODATA_DOCS
  if (!raw) return defaultDocs
  return raw.split(',').map((entry) => {
    const [url, focus, tag] = entry.split('|').map((s) => s.trim())
    if (!url || !focus || !tag)
      throw new Error(`AUTODATA_DOCS entry '${entry}' is not url|focus|tag`)
    return { url, focus, tag }
  })
}

// ── Descriptive distribution helpers (NOT inferential — those reuse agent-eval) ────────────────

/** Linear-interpolated quantile of a sorted-or-unsorted numeric sample. */
function quantile(xs: number[], q: number): number {
  if (xs.length === 0) return Number.NaN
  const s = [...xs].sort((a, b) => a - b)
  if (s.length === 1) return s[0] as number
  const pos = (s.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  const frac = pos - lo
  return (s[lo] as number) * (1 - frac) + (s[hi] as number) * frac
}

function mean(xs: number[]): number {
  return xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length
}

interface Distribution {
  n: number
  min: number
  median: number
  p90: number
  max: number
  mean: number
}

function describe(xs: number[]): Distribution {
  return {
    n: xs.length,
    min: xs.length ? Math.min(...xs) : Number.NaN,
    median: quantile(xs, 0.5),
    p90: quantile(xs, 0.9),
    max: xs.length ? Math.max(...xs) : Number.NaN,
    mean: mean(xs),
  }
}

// ── The aggregation: per-attempt JSONL trail → per-slot outcomes → CIs ─────────────────────────

/** One JSONL row from a per-attempt trail: an `AttemptRecord` plus the challenger style tag. */
type TrailRow = AttemptRecord & { style?: string }

/** One doc's trail + the number of slots it was asked to run (the accept-rate denominator). */
export interface DocTrail {
  tag: string
  url: string
  /** Slots requested for this doc — the denominator (a slot whose drafts all errored counts as a
   *  reject, so the denominator is the requested count, not the number of slots that left a trail). */
  target: number
  rows: TrailRow[]
}

export interface PoweredStats {
  totalSlots: number
  acceptedSlots: number
  /** Slots that produced >= 1 attempt (the challenger authored a parseable example at least once). */
  slotsWithAttempts: number
  /** Slots where the challenger threw on every refine (0 attempts) — an infra/parse failure, NOT a
   *  discrimination reject. Surfaced so it can be flagged as a threat to validity. */
  challengerFailedSlots: number
  /** Wilson 95% CI on the accept-rate (binomial: a slot accepts or it does not). */
  acceptRate: { estimate: number; lower: number; upper: number }
  /** Wilson 95% CI on the accept-rate among only the slots that produced >= 1 attempt (excludes the
   *  challenger-stage failures) — the rate if every slot had at least authored an example. */
  acceptRateAmongProducing: { estimate: number; lower: number; upper: number }
  /** Per-slot BEST gap (max gap over the slot's quality-clean attempts) — the discriminating power
   *  each slot reached, accepted or not. */
  bestGapPerSlot: Distribution
  /** Plain (first-draft) gap per slot. */
  plainGap: Distribution
  /** Paired plain→best-refined gap-widening with a bootstrap CI on the mean delta. */
  widening: { n: number; meanDelta: number; medianDelta: number; lower: number; upper: number }
  /** Weak solver mean-score distribution over quality-clean attempts (the coin-flip's source). */
  weakScore: Distribution
  /** Strong solver mean-score distribution over quality-clean attempts. */
  strongScore: Distribution
  /** Per-attempt pass fractions for each sub-condition of the accept rule (decomposes the rate). */
  conditions: {
    nAttempts: number
    strongHi: number // fraction with strong >= 0.65
    weakLo: number // fraction with weak < 0.50  (the "weak must struggle" gate)
    gapWide: number // fraction with gap >= 0.20
    all: number // fraction passing all three (== accept)
  }
  perDoc: { tag: string; target: number; accepted: number; meanBestGap: number }[]
}

const minStrong = 0.65
const maxWeak = 0.5
const minGap = 0.2

/**
 * Compute the powered statistics from the per-doc attempt trails. Pure + deterministic (seeded
 * bootstrap), so it can be re-run standalone over the on-disk JSONL after an interrupted run.
 */
export function analyzeTrails(trails: DocTrail[], opts?: { bootstrapSeed?: number }): PoweredStats {
  const seed = opts?.bootstrapSeed ?? 0xc0ffee

  let totalSlots = 0
  let acceptedSlots = 0
  let slotsWithAttempts = 0
  const bestGapPerSlotAll: number[] = []
  const plainGapsPaired: number[] = []
  const refinedGapsPaired: number[] = []
  const weakScores: number[] = []
  const strongScores: number[] = []
  let nAttempts = 0
  let strongHi = 0
  let weakLo = 0
  let gapWide = 0
  let acceptAll = 0
  const perDoc: PoweredStats['perDoc'] = []

  for (const trail of trails) {
    totalSlots += trail.target

    // Group this doc's attempts by slot index.
    const bySlot = new Map<number, TrailRow[]>()
    for (const row of trail.rows) {
      const arr = bySlot.get(row.slotIndex) ?? []
      arr.push(row)
      bySlot.set(row.slotIndex, arr)
    }

    slotsWithAttempts += bySlot.size
    let docAccepted = 0
    const docBestGaps: number[] = []
    for (const [, rows] of bySlot) {
      // A slot is ACCEPTED iff any of its attempts cleared the accept rule.
      const accepted = rows.some((r) => r.decision.accept)
      if (accepted) {
        acceptedSlots += 1
        docAccepted += 1
      }
      // Best gap the slot reached over its quality-clean attempts (a leaky/thin draft has gap 0).
      const cleanGaps = rows.filter((r) => r.qualityOk).map((r) => r.gap)
      const bestGap = cleanGaps.length ? Math.max(...cleanGaps) : 0
      bestGapPerSlotAll.push(bestGap)
      docBestGaps.push(bestGap)

      // Paired plain→refined: plain = the earliest iteration's gap, refined = the slot's best gap.
      const earliest = [...rows].sort((a, b) => a.iteration - b.iteration)[0]
      if (earliest) {
        plainGapsPaired.push(earliest.gap)
        refinedGapsPaired.push(bestGap)
      }

      // Per-attempt condition decomposition (quality-clean attempts only — a leaky draft never
      // reached the solvers, so its 0/0 scores would falsely depress every sub-condition).
      for (const r of rows) {
        if (!r.qualityOk) continue
        nAttempts += 1
        weakScores.push(r.weak.mean)
        strongScores.push(r.strong.mean)
        if (r.strong.mean >= minStrong) strongHi += 1
        if (r.weak.mean < maxWeak) weakLo += 1
        if (r.gap >= minGap) gapWide += 1
        if (r.strong.mean >= minStrong && r.weak.mean < maxWeak && r.gap >= minGap) acceptAll += 1
      }
    }
    perDoc.push({
      tag: trail.tag,
      target: trail.target,
      accepted: docAccepted,
      meanBestGap: mean(docBestGaps),
    })
  }

  const accept = wilson(acceptedSlots, totalSlots, 0.95)
  const acceptProducing = wilson(acceptedSlots, slotsWithAttempts, 0.95)
  const boot = pairedBootstrap(plainGapsPaired, refinedGapsPaired, {
    confidence: 0.95,
    statistic: 'mean',
    seed,
    resamples: 5000,
  })

  return {
    totalSlots,
    acceptedSlots,
    slotsWithAttempts,
    challengerFailedSlots: totalSlots - slotsWithAttempts,
    acceptRate: { estimate: accept.estimate, lower: accept.lower, upper: accept.upper },
    acceptRateAmongProducing: {
      estimate: acceptProducing.estimate,
      lower: acceptProducing.lower,
      upper: acceptProducing.upper,
    },
    bestGapPerSlot: describe(bestGapPerSlotAll),
    plainGap: describe(plainGapsPaired),
    widening: {
      n: boot.n,
      meanDelta: boot.mean,
      medianDelta: boot.median,
      lower: boot.low,
      upper: boot.high,
    },
    weakScore: describe(weakScores),
    strongScore: describe(strongScores),
    conditions: {
      nAttempts,
      strongHi: nAttempts ? strongHi / nAttempts : Number.NaN,
      weakLo: nAttempts ? weakLo / nAttempts : Number.NaN,
      gapWide: nAttempts ? gapWide / nAttempts : Number.NaN,
      all: nAttempts ? acceptAll / nAttempts : Number.NaN,
    },
    perDoc,
  }
}

async function readTrail(path: string): Promise<TrailRow[]> {
  // A slot whose every challenger draft errored produces no attempt → no trail file is written.
  // That is a legitimate all-reject outcome (the loop failed to manufacture an example), not a
  // crash: return an empty trail so those slots still count against the accept-rate denominator.
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as TrailRow)
}

function pctCI(x: { estimate: number; lower: number; upper: number }): string {
  return `${(x.estimate * 100).toFixed(0)}%  CI[${(x.lower * 100).toFixed(0)}%, ${(x.upper * 100).toFixed(0)}%]`
}

function dist(d: Distribution): string {
  return `n=${d.n}  min=${d.min.toFixed(2)} median=${d.median.toFixed(2)} p90=${d.p90.toFixed(2)} max=${d.max.toFixed(2)} (mean=${d.mean.toFixed(2)})`
}

function printReport(stats: PoweredStats, spendUsd: number): void {
  console.log('\n══════════════════════════════════════════════════════════════════════════')
  console.log(' POWERED ACCEPT-RATE — does the causal-challenger loop reliably discriminate?')
  console.log('══════════════════════════════════════════════════════════════════════════\n')
  console.log(`  slots run            : ${stats.totalSlots}  (${stats.acceptedSlots} accepted)`)
  console.log(`  ACCEPTED-RATE        : ${pctCI(stats.acceptRate)}   ← the headline (Wilson 95%)`)
  if (stats.challengerFailedSlots > 0) {
    console.log(
      `  challenger-failed    : ${stats.challengerFailedSlots} slot(s) produced 0 attempts (infra/parse, not a discrimination reject)`,
    )
    console.log(
      `  accept-rate (producing): ${pctCI(stats.acceptRateAmongProducing)}  (excl. challenger-failed slots)`,
    )
  }
  console.log('')
  console.log(`  best gap / slot      : ${dist(stats.bestGapPerSlot)}`)
  console.log(`  plain gap / slot     : ${dist(stats.plainGap)}`)
  console.log(
    `  gap-widening Δ       : mean ${stats.widening.meanDelta >= 0 ? '+' : ''}${stats.widening.meanDelta.toFixed(
      3,
    )}  median ${stats.widening.medianDelta >= 0 ? '+' : ''}${stats.widening.medianDelta.toFixed(3)}  ` +
      `CI[${stats.widening.lower.toFixed(3)}, ${stats.widening.upper.toFixed(3)}]  (paired bootstrap, n=${stats.widening.n})`,
  )
  console.log('')
  console.log(`  weak score / attempt : ${dist(stats.weakScore)}`)
  console.log(`  strong score / attempt: ${dist(stats.strongScore)}`)
  console.log('')
  const c = stats.conditions
  console.log(`  accept-rule decomposition over ${c.nAttempts} quality-clean attempts:`)
  console.log(`    strong >= 0.65  : ${(c.strongHi * 100).toFixed(0)}%`)
  console.log(
    `    weak   <  0.50  : ${(c.weakLo * 100).toFixed(0)}%   ← the binding gate (weak must struggle)`,
  )
  console.log(`    gap    >= 0.20  : ${(c.gapWide * 100).toFixed(0)}%`)
  console.log(`    all three (accept): ${(c.all * 100).toFixed(0)}%`)
  console.log('')
  console.log('  per-doc:')
  for (const d of stats.perDoc) {
    console.log(
      `    ${d.tag.padEnd(14)} accepted ${d.accepted}/${d.target}  mean best-gap ${d.meanBestGap.toFixed(3)}`,
    )
  }
  console.log(`\n  total live spend     : $${spendUsd.toFixed(4)}`)
  const lo = stats.acceptRate.lower
  const verdict =
    lo > 0.15
      ? `WORKS AT POWER — accept-rate CI lower bound ${(lo * 100).toFixed(0)}% excludes ~0`
      : stats.acceptRate.upper < 0.2
        ? 'COIN-FLIP / DOES NOT RELIABLY WORK — accept-rate CI sits near 0'
        : 'UNDER-POWERED / MARGINAL — accept-rate CI still includes near-0; not settled'
  console.log(`\n  VERDICT: ${verdict}\n`)
}

async function main(): Promise<void> {
  const apiKey = process.env.TANGLE_API_KEY ?? process.env.TANGLE_ROUTER_KEY
  if (!apiKey) throw new Error('no TANGLE_API_KEY in env — run under dotenvx so the key is set')

  const docs = parseDocsEnv()
  const slotsPerDoc = envInt('AUTODATA_SLOTS_PER_DOC', 14)
  const samples = envInt('AUTODATA_SAMPLES', 4)
  const maxRetries = envInt('AUTODATA_MAXRETRIES', 3)

  console.log('Autodata · POWERED accept-rate measurement')
  console.log(
    `  challenger/judge=${CHALLENGER_MODEL}/${JUDGE_MODEL}  weak=${WEAK_SOLVER_MODEL}  strong=${STRONG_SOLVER_MODEL}`,
  )
  console.log(
    `  ${docs.length} docs × ${slotsPerDoc} slots = ${docs.length * slotsPerDoc} slots · samples=${samples} maxRetries=${maxRetries}\n`,
  )

  // ── COST GATE: one cheap call per model, all must return non-empty content before the burn ──
  const smoke = await smokeTestModels({
    apiKey,
    models: [CHALLENGER_MODEL, WEAK_SOLVER_MODEL, STRONG_SOLVER_MODEL],
  })
  for (const s of smoke) {
    console.log(
      `  ${s.ok ? 'ok ' : 'DEAD'} ${s.model.padEnd(28)} chars=${String(s.contentChars).padStart(4)}  ` +
        `finish=${s.finishReason ?? '?'}  cost=$${s.costUsd.toFixed(5)} (${s.costSource})`,
    )
  }
  const dead = smoke.filter((s) => !s.ok)
  if (dead.length > 0) {
    throw new Error(`cost gate failed — empty content from: ${dead.map((d) => d.model).join(', ')}`)
  }

  // ── Run K slots per doc (each doc writes its own incremental autopsy trail). ──
  const trails: DocTrail[] = []
  let spendUsd = 0
  for (const doc of docs) {
    const grounded = await groundDoc({ url: doc.url, focus: doc.focus })
    console.log(
      `\n[${doc.tag}] grounded ${grounded.url}  chunk=${grounded.chunkIndex}/${grounded.totalChunks} (${grounded.doc.length} chars)`,
    )
    const attemptsPath = `data/powered-${doc.tag}-attempts.jsonl`
    const result = await buildAutodataDataset({
      apiKey,
      source: grounded,
      outPath: `data/powered-${doc.tag}.jsonl`,
      attemptsPath,
      target: slotsPerDoc,
      samples,
      maxRetries,
    })
    const docSpend = result.cost.summary().totalCostUsd
    spendUsd += docSpend
    console.log(
      `[${doc.tag}] done · ${result.accepted.length}/${slotsPerDoc} accepted · ${result.attempts.length} attempts · $${docSpend.toFixed(4)}`,
    )
    trails.push({
      tag: doc.tag,
      url: doc.url,
      target: slotsPerDoc,
      rows: await readTrail(attemptsPath),
    })
  }

  // ── Recompute everything from the on-disk trails (durable source of truth). ──
  const stats = analyzeTrails(trails)
  printReport(stats, spendUsd)

  // Emit the machine-readable result alongside the prose, for the doc + any re-analysis.
  console.log('RESULT_JSON ' + JSON.stringify({ ...stats, spendUsd }))
}

// Only auto-run when invoked directly (keeps `analyzeTrails` importable + unit-testable).
if (process.argv[1] && process.argv[1].endsWith('powered.ts')) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
