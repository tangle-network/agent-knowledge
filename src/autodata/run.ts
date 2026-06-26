/**
 * Autodata — the LIVE runnable: cost-gate the three models, ground on a REAL arXiv document, run the
 * agentic data-creation loop with the real two-tier solvers, and report the empirical strong/weak
 * gap (plain first-draft vs loop-accepted), the cost split by role, and the JSONL dataset path.
 *
 * Run (key never printed):
 *   dotenvx run -f /home/drew/company/devops/secrets/agent-state.env -- \
 *     pnpm tsx src/autodata/run.ts
 *
 * Env knobs: AUTODATA_URL, AUTODATA_FOCUS, AUTODATA_TARGET, AUTODATA_SAMPLES, AUTODATA_MAXRETRIES,
 *            AUTODATA_OUT, AUTODATA_ATTEMPTS (per-attempt autopsy JSONL),
 *            AUTODATA_{WEAK,STRONG,CHALLENGER,JUDGE}_MODEL, TANGLE_API_KEY (or TANGLE_ROUTER_KEY).
 */

import { buildAutodataDataset } from './build-dataset'
import { DEFAULT_SOURCE_URL, groundDoc } from './grounding'
import {
  CHALLENGER_MODEL,
  STRONG_SOLVER_MODEL,
  smokeTestModels,
  WEAK_SOLVER_MODEL,
} from './router-roles'

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name}='${raw}' is not a positive integer`)
  return n
}

function fmt(x: number | null, digits = 3): string {
  return x === null ? 'n/a' : x.toFixed(digits)
}

async function main(): Promise<void> {
  const apiKey = process.env.TANGLE_API_KEY ?? process.env.TANGLE_ROUTER_KEY
  if (!apiKey) throw new Error('no TANGLE_API_KEY in env — run under dotenvx so the key is set')

  const url = process.env.AUTODATA_URL ?? DEFAULT_SOURCE_URL
  const focus = process.env.AUTODATA_FOCUS ?? 'attention'
  const target = envInt('AUTODATA_TARGET', 3)
  const samples = envInt('AUTODATA_SAMPLES', 3)
  const maxRetries = envInt('AUTODATA_MAXRETRIES', 4)
  const outPath = process.env.AUTODATA_OUT ?? 'data/autodata-dataset.jsonl'
  const attemptsPath = process.env.AUTODATA_ATTEMPTS ?? 'data/autodata-attempts.jsonl'

  // ── 1. COST GATE: one cheap call per model, all must return non-empty content before the burn ──
  console.log('Autodata · cost gate (one call per model)\n')
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

  // ── 2. Ground on a REAL document ──
  const grounded = await groundDoc({ url, focus })
  console.log(
    `\nGrounded on ${grounded.url}\n  section='${grounded.headingPath}' chunk=${grounded.chunkIndex}/${grounded.totalChunks} ` +
      `(${grounded.doc.length} chars, updated ${grounded.sourceUpdatedAt})`,
  )
  console.log(`  excerpt: ${grounded.doc.slice(0, 200).replace(/\s+/g, ' ')}...`)

  // ── 3. Run the loop with real two-tier solvers ──
  console.log(
    `\nManufacturing up to ${target} discriminating example(s) · samples=${samples} maxRetries=${maxRetries}\n` +
      `  challenger/judge=${CHALLENGER_MODEL}  weak=${WEAK_SOLVER_MODEL}  strong=${STRONG_SOLVER_MODEL}`,
  )
  const result = await buildAutodataDataset({
    apiKey,
    source: grounded,
    outPath,
    attemptsPath,
    target,
    samples,
    maxRetries,
  })

  // ── 4. The accepted set ──
  console.log(`\n— Accepted examples (${result.accepted.length}/${target}) —`)
  for (const [i, ex] of result.accepted.entries()) {
    console.log(`\n  [${i}] Q: ${ex.example.question}`)
    console.log(
      `      weak=${ex.weakScore.toFixed(2)}  strong=${ex.strongScore.toFixed(2)}  gap=${ex.gap.toFixed(2)}`,
    )
    console.log(`      ${ex.decision.reason}`)
  }

  // ── 4b. Autopsy: the single widest-gap attempt, with BOTH solvers' actual answers ──
  // A gap number is only a finding if you can read why it opened. Show the strongest discrimination
  // we saw (highest gap, accepted or not) so a human can confirm it is real reasoning, not an
  // artifact: the weak model should genuinely fail the reasoning and the strong model get it.
  const best = result.attempts.filter((a) => a.qualityOk).sort((a, b) => b.gap - a.gap)[0]
  if (best) {
    const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim()
    console.log('\n— Autopsy: widest-gap attempt (read the answers, confirm real discrimination) —')
    console.log(`  Q: ${oneLine(best.example.question)}`)
    console.log(`  reference: ${oneLine(best.example.reference).slice(0, 240)}`)
    console.log(
      `  gap=${best.gap.toFixed(2)}  (${best.decision.accept ? 'ACCEPTED' : 'rejected'}: ${best.decision.reason})`,
    )
    console.log(`  WEAK   mean=${best.weak.mean.toFixed(2)}`)
    for (const [i, s] of best.weak.samples.entries())
      console.log(`    [w${i} score=${s.score.toFixed(2)}] ${oneLine(s.answer).slice(0, 220)}`)
    console.log(`  STRONG mean=${best.strong.mean.toFixed(2)}`)
    for (const [i, s] of best.strong.samples.entries())
      console.log(`    [s${i} score=${s.score.toFixed(2)}] ${oneLine(s.answer).slice(0, 220)}`)
  }

  // ── 5. The empirical calibration (paper Table 1) ──
  console.log('\n— Calibration: plain first-draft gap vs agentic loop-accepted gap —')
  console.log(
    `  plain   (first-draft questions, n=${result.plainGaps.length})  mean gap = ${fmt(result.plainGapMean)}`,
  )
  console.log(
    `  agentic (loop-accepted questions, n=${result.agenticGaps.length}) mean gap = ${fmt(result.agenticGapMean)}`,
  )
  console.log(
    `  refined (best gap reached per slot, n=${result.refinedGaps.length}) mean gap = ${fmt(result.refinedGapMean)}`,
  )
  // The honest comparison: plain first-draft gap vs the best the refinement reached. Acceptance is
  // strict (gap >= 0.20); refined-vs-plain shows whether the fold widened the gap at all.
  if (result.plainGapMean !== null && result.refinedGapMean !== null) {
    const delta = result.refinedGapMean - result.plainGapMean
    console.log(
      `  Δ (refined − plain) = ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}  ` +
        (delta >= 0.1
          ? '→ the loop WIDENS the strong/weak gap (empirical Table-1 direction)'
          : '→ NO meaningful widening on these real models (honest null)'),
    )
  } else {
    console.log('  (insufficient data to compare — see accepted count)')
  }
  if (result.accepted.length === 0) {
    console.log(
      `  NOTE: 0 examples cleared the discriminative accept bar — ${WEAK_SOLVER_MODEL} and ` +
        `${STRONG_SOLVER_MODEL} did not separate on these questions (see the autopsy trail).`,
    )
  }

  // ── 6. Cost split by role ──
  const summary = result.cost.summary()
  console.log('\n— Cost (CostLedger, by role) —')
  console.log(
    `  total: $${summary.totalCostUsd.toFixed(4)} over ${summary.totalCalls} recorded loops/calls` +
      (summary.fullyPriced
        ? ' (fully priced)'
        : ` (unpriced models: ${summary.unpricedModels.join(', ')})`),
  )
  for (const ch of summary.byChannel) {
    console.log(`    ${ch.channel.padEnd(14)} $${ch.costUsd.toFixed(4)}  (${ch.calls} loops/calls)`)
  }
  if (result.costPerExampleUsd !== null) {
    console.log(`  cost per accepted example: $${result.costPerExampleUsd.toFixed(4)}`)
  }
  console.log(
    `  call provenance: ${result.callProvenance.router} router-priced, ${result.callProvenance.estimated} rate-estimated`,
  )

  console.log(`\n— Dataset — ${result.rows.length} row(s) written to ${result.outPath}`)
  if (result.attemptsPath) {
    console.log(
      `— Autopsy trail — ${result.attempts.length} attempt(s) (accepted + rejected) at ${result.attemptsPath}`,
    )
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
