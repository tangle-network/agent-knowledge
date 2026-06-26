/**
 * Autodata calibration: does the non-extractive CAUSAL challenger widen the strong/weak gap vs the
 * old RECALL challenger, on the SAME grounded document? This is the lever's proof — the prior null
 * was "recall question → answer leaks into context → an 8B reads it out → gap ~0". If the fix works,
 * the causal arm's mean gap (and accepted count) clears the recall arm's by a clear margin.
 *
 * Run (key never printed):
 *   dotenvx run -f /home/drew/company/devops/secrets/agent-state.env -- \
 *     pnpm tsx src/autodata/calibrate.ts
 *
 * Env knobs: AUTODATA_URL, AUTODATA_FOCUS, AUTODATA_TARGET, AUTODATA_SAMPLES, AUTODATA_MAXRETRIES,
 *            AUTODATA_{WEAK,STRONG,CHALLENGER,JUDGE}_MODEL, TANGLE_API_KEY.
 */

import { type AutodataDatasetResult, buildAutodataDataset } from './build-dataset'
import type { AttemptRecord } from './data-creation-loop'
import { DEFAULT_SOURCE_URL, groundDoc } from './grounding'
import {
  CHALLENGER_MODEL,
  type ChallengerStyle,
  JUDGE_MODEL,
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

function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length
}

function fmt(x: number | null, d = 3): string {
  return x === null ? 'n/a' : x.toFixed(d)
}

/** Mean strong/weak gap over the quality-clean attempts of one arm — the discriminating power. */
function armGap(attempts: AttemptRecord[]): number | null {
  return mean(attempts.filter((a) => a.qualityOk).map((a) => a.gap))
}

async function runArm(args: {
  apiKey: string
  source: Awaited<ReturnType<typeof groundDoc>>
  style: ChallengerStyle
  target: number
  samples: number
  maxRetries: number
}): Promise<AutodataDatasetResult> {
  return buildAutodataDataset({
    apiKey: args.apiKey,
    source: args.source,
    outPath: `data/autodata-calib-${args.style}.jsonl`,
    attemptsPath: `data/autodata-calib-${args.style}-attempts.jsonl`,
    style: args.style,
    target: args.target,
    samples: args.samples,
    maxRetries: args.maxRetries,
  })
}

async function main(): Promise<void> {
  const apiKey = process.env.TANGLE_API_KEY ?? process.env.TANGLE_ROUTER_KEY
  if (!apiKey) throw new Error('no TANGLE_API_KEY in env — run under dotenvx so the key is set')

  const url = process.env.AUTODATA_URL ?? DEFAULT_SOURCE_URL
  const focus = process.env.AUTODATA_FOCUS ?? 'attention'
  const target = envInt('AUTODATA_TARGET', 2)
  const samples = envInt('AUTODATA_SAMPLES', 2)
  const maxRetries = envInt('AUTODATA_MAXRETRIES', 2)

  console.log('Autodata calibration · recall vs causal challenger (same doc)\n')
  console.log(
    `  challenger/judge=${CHALLENGER_MODEL}/${JUDGE_MODEL}  weak=${WEAK_SOLVER_MODEL}  strong=${STRONG_SOLVER_MODEL}`,
  )

  const smoke = await smokeTestModels({
    apiKey,
    models: [CHALLENGER_MODEL, WEAK_SOLVER_MODEL, STRONG_SOLVER_MODEL],
  })
  const dead = smoke.filter((s) => !s.ok)
  if (dead.length > 0)
    throw new Error(`cost gate failed — empty from: ${dead.map((d) => d.model).join(', ')}`)
  console.log('  cost gate ok (all models returned content)\n')

  const source = await groundDoc({ url, focus })
  console.log(`Grounded on ${source.url}  section='${source.headingPath}'\n`)

  // Same doc, same budget, only the challenger prompt changes — a clean A/B on the lever.
  const recall = await runArm({ apiKey, source, style: 'recall', target, samples, maxRetries })
  const causal = await runArm({ apiKey, source, style: 'causal', target, samples, maxRetries })

  const recallGap = armGap(recall.attempts)
  const causalGap = armGap(causal.attempts)

  console.log('— Calibration result —')
  console.log(
    `  RECALL  attempts=${recall.attempts.length}  mean gap=${fmt(recallGap)}  accepted=${recall.accepted.length}`,
  )
  console.log(
    `  CAUSAL  attempts=${causal.attempts.length}  mean gap=${fmt(causalGap)}  accepted=${causal.accepted.length}`,
  )
  if (recallGap !== null && causalGap !== null) {
    const delta = causalGap - recallGap
    console.log(
      `  Δ (causal − recall) = ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}  ` +
        (delta >= 0.1
          ? '→ the causal challenger WIDENS the gap (the lever works)'
          : '→ no meaningful widening from the causal challenger (honest null)'),
    )
  }

  const totalUsd = recall.cost.summary().totalCostUsd + causal.cost.summary().totalCostUsd
  console.log(`\n  spend: $${totalUsd.toFixed(4)} (both arms)`)
  console.log(`  trails: ${recall.attemptsPath}  ${causal.attemptsPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
