/**
 * The INVESTMENT-THESIS research task.
 *
 * Given `{ company, ticker, cik, cutoff }`, drive the SAME two-agent research
 * loop the ML deep-question A/B uses (`runVerifiedResearchLoop` + the real web
 * worker) to research the company AS OF the cutoff — web + SEC EDGAR, both public
 * — and produce an investment-thesis PAGE in the knowledge base: a judgment, the
 * drivers, and the risks, grounded in what it fetched.
 *
 * This file builds NOTHING new for the loop: it composes the existing worker +
 * driver + loop, supplies the readiness specs that steer the worker toward the
 * filing-level evidence (the analyst lenses), then writes a synthesis thesis page
 * the metric (`materialFactsSurfaced`) grades against the HELD-OUT checklist.
 *
 * THE FIREWALL: the task is told ONLY company + ticker + cutoff (+ the generic
 * analyst-lens readiness specs every company gets). It is NEVER shown the
 * checklist. The checklist is read only afterward, by the metric. So a high score
 * is research depth, not teaching-to-the-test.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineReadinessSpec, type KnowledgeReadinessSpec } from './eval-readiness'
import { buildKnowledgeIndex } from './indexer'
import { kbIndexToText } from './material-facts-metric'
import { layoutFor } from './store'
import {
  type ResearchDriver,
  runVerifiedResearchLoop,
  type VerifiedResearchLoopResult,
} from './two-agent-research-loop'
import {
  createWebResearchWorker,
  type RouterClient,
  type WebResearchWorkerOptions,
} from './web-research-worker'

/** The minimal brief a thesis run is given — the firewall boundary. */
export interface ThesisTaskInput {
  /** Legal name as of the cutoff — what the loop researches. */
  company: string
  /** Ticker as of the cutoff. */
  ticker: string
  /** SEC Central Index Key (CIK), zero-stripped — the EDGAR filer id. */
  cik: string
  /** Research-as-of date (ISO). The loop must reason as if it is this date. */
  cutoff: string
  /** Sector, for the readiness query context (NOT a checklist hint). */
  sector?: string
}

/**
 * The generic analyst-lens readiness specs every company gets. They are the ONLY
 * thing the loop is told about WHAT to look for, and they name the LENSES a
 * thorough analyst checks (balance-sheet risk, concentration, leverage, margins,
 * liquidity, governance, regulatory) and where they live (the latest SEC 10-K) —
 * NOT the answers. They steer the worker's web/EDGAR search toward the filing,
 * not toward the held-out facts (which the loop never sees).
 *
 * `minSources` is set above 1 so the readiness gate stays UNMET after a single
 * fetch and the loop runs multiple rounds — the depth-driving driver needs >1
 * round to steer, exactly as the ML-exam multi-round probe established.
 */
export function thesisReadinessSpecs(input: ThesisTaskInput): KnowledgeReadinessSpec[] {
  const c = input.company
  const t = input.ticker
  const filing = `${c} ${t} SEC 10-K annual report SEC.gov EDGAR filing`
  return [
    defineReadinessSpec({
      id: 'thesis/filing',
      description: `the most recent SEC 10-K annual report for ${c} (${t}) filed on or before ${input.cutoff}, from SEC EDGAR`,
      query: filing,
      requiredFor: ['ResearchAgent'],
      importance: 'blocking',
      minSources: 2,
      minHits: 1,
    }),
    defineReadinessSpec({
      id: 'thesis/balance-sheet',
      description: `${c} balance-sheet risks: securities marked below cost, unrealized losses, leverage / total debt, debt maturities, interest expense`,
      query: `${c} ${t} 10-K balance sheet total debt unrealized losses interest expense leverage`,
      requiredFor: ['ResearchAgent'],
      importance: 'blocking',
      minSources: 2,
      minHits: 1,
    }),
    defineReadinessSpec({
      id: 'thesis/concentration-liquidity',
      description: `${c} concentration + liquidity: customer / deposit / revenue concentration, uninsured deposits, operating cash flow, net loss, inventory, equity erosion`,
      query: `${c} ${t} 10-K customer deposit concentration operating cash flow net loss inventory`,
      requiredFor: ['ResearchAgent'],
      importance: 'blocking',
      minSources: 2,
      minHits: 1,
    }),
    defineReadinessSpec({
      id: 'thesis/governance-regulatory',
      description: `${c} governance + regulatory: related-party transactions, dual-class / super-voting control, buybacks / dividends, recalls, regulatory or legal exposure, margin trends`,
      query: `${c} ${t} 10-K related party dual class share repurchase recall regulatory gross margin`,
      requiredFor: ['ResearchAgent'],
      importance: 'blocking',
      minSources: 2,
      minHits: 1,
    }),
  ]
}

/**
 * The thesis-writer prompt. After the loop has fetched + curated the filings, we
 * ask the model to SYNTHESIZE a thesis page from the curated KB text — a
 * judgment, the key drivers, and the material risks, grounded ONLY in the fetched
 * evidence. The held-out checklist is NOT in this prompt; the model writes from
 * what the loop actually pulled, so a fact only appears if the research surfaced
 * the underlying evidence.
 */
function thesisSynthesisMessages(
  input: ThesisTaskInput,
  kbText: string,
): { role: 'system' | 'user'; content: string }[] {
  const system =
    'You are a buy-side investment analyst writing a thesis memo. You are given ' +
    'the raw research your team gathered from public filings (SEC 10-K) and the web. ' +
    'Write a thesis that a thorough analyst would write: lead with your JUDGMENT, ' +
    'then the KEY DRIVERS, then the MATERIAL RISKS. Be specific and quantitative — ' +
    'name the actual figures, balance-sheet items, concentrations, leverage, ' +
    'margin trends, governance items, and regulatory exposures that appear in the ' +
    'research. Surface the buried, non-obvious drivers a one-line ticker summary ' +
    'misses. Ground every claim in the research provided; do NOT invent figures. ' +
    'If the research does not contain a figure, do not state it.'
  const user = [
    `Company: ${input.company} (${input.ticker})`,
    `As-of date (reason as if it is this date): ${input.cutoff}`,
    input.sector ? `Sector: ${input.sector}` : '',
    '',
    'Research gathered (filings + web excerpts):',
    '"""',
    kbText.slice(0, 24000),
    '"""',
    '',
    'Write the investment thesis now. Structure:',
    '## Judgment',
    '## Key drivers',
    '## Material risks',
  ]
    .filter(Boolean)
    .join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/** Write the synthesis thesis page into the KB so the index + metric pick it up. */
async function writeThesisPage(
  root: string,
  input: ThesisTaskInput,
  thesis: string,
): Promise<string> {
  const { knowledgeDir } = layoutFor(root)
  await mkdir(knowledgeDir, { recursive: true })
  const path = join(knowledgeDir, `thesis-${input.ticker.toLowerCase()}.md`)
  const body = [
    '---',
    `title: Investment thesis — ${input.company} (${input.ticker})`,
    `ticker: ${input.ticker}`,
    `cutoff: ${input.cutoff}`,
    'kind: investment-thesis',
    '---',
    `# Investment thesis — ${input.company} (${input.ticker}), as of ${input.cutoff}`,
    '',
    thesis.trim(),
    '',
  ].join('\n')
  await writeFile(path, body, 'utf8')
  return path
}

export interface ThesisRunOptions {
  /** The KB root the loop writes into. */
  root: string
  /** Shared router client (web search + chat). Defaults to env creds. */
  router: RouterClient
  /** The driver — verify/dedup or research-driving. The loop's coordinator. */
  driver: ResearchDriver
  /** Round budget. Default 3 (the depth-driving driver needs >1). */
  maxRounds?: number
  /** Worker tuning forwarded to `createWebResearchWorker`. */
  workerOptions?: Omit<WebResearchWorkerOptions, 'router'>
  /** Max tokens for the synthesis pass. Default 1600 (above glm-5.2's reasoning floor). */
  synthesisMaxTokens?: number
  signal?: AbortSignal
}

export interface ThesisRunResult {
  loop: VerifiedResearchLoopResult
  /** The synthesized thesis text. */
  thesis: string
  /** Path of the thesis page written into the KB. */
  thesisPath: string
}

/**
 * Run the full thesis task: drive the two-agent loop to research the company AS
 * OF the cutoff, then synthesize + write the thesis page. Returns the loop result
 * + the thesis text + the page path. The caller grades the KB with
 * `materialFactsSurfaced(root, checklist)` — the checklist is never passed here.
 */
export async function runInvestmentThesisTask(
  input: ThesisTaskInput,
  options: ThesisRunOptions,
): Promise<ThesisRunResult> {
  const worker = createWebResearchWorker({ ...options.workerOptions, router: options.router })
  const goal = `${input.company} (${input.ticker}) investment thesis as of ${input.cutoff}`

  const loop = await runVerifiedResearchLoop({
    root: options.root,
    goal,
    worker,
    driver: options.driver,
    readinessSpecs: thesisReadinessSpecs(input),
    maxRounds: options.maxRounds ?? 3,
    signal: options.signal,
  })

  // Synthesize the thesis from what the loop actually curated + fetched.
  const index = await buildKnowledgeIndex(options.root)
  const kbText = kbIndexToText(index)
  const messages = thesisSynthesisMessages(input, kbText)
  const thesis = await options.router.chat(messages, options.synthesisMaxTokens ?? 1600)

  const thesisPath = await writeThesisPage(options.root, input, thesis)
  return { loop, thesis, thesisPath }
}
