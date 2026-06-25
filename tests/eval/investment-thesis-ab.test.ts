import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createCollectionResearchDriver,
  createResearchDrivingDriver,
  createTangleRouterClient,
  createVerifyingResearchDriver,
  materialFactsSurfaced,
  type ResearchDriver,
  type RouterClient,
  runInvestmentThesisTask,
} from '../../src/index'
import { investmentThesisSet } from './investment-thesis-set'

// ===========================================================================
// THE INVESTMENT-THESIS 3-ARM A/B — the live evidence.
//
// For each held-out company the loop is told ONLY {company, ticker, cik, cutoff}
// (+ the generic analyst-lens readiness specs every company gets). It researches
// the company AS OF the cutoff over web + SEC EDGAR (both public), writes a thesis
// page, and we grade that KB against the company's HELD-OUT material-fact
// checklist with `materialFactsSurfaced` — a $0, model-free substring grader the
// loop never sees. A high score is research DEPTH (it surfaced the buried drivers
// a ticker search misses), not teaching-to-the-test.
//
// THREE ARMS, all on the SAME worker + round budget + worker config, so compute
// is matched by construction and the ONLY thing that varies is the topology — the
// driver sitting between the worker and the knowledge base:
//
//   A · collection — `createCollectionResearchDriver`: an inert rubber stamp. ONE
//       agent (the worker) collects; the driver accepts everything, gates nothing,
//       researches nothing, steers only with the loop's default open-gap list. The
//       blind-collection baseline every other arm must beat. Adds NO router calls.
//   B · verify     — `createVerifyingResearchDriver`: an LLM gate per source. The
//       worker ADDS; the driver judges relevance + near-duplication and REJECTS
//       off-topic/spam. Costs one extra chat call per candidate source.
//   C · driving    — `createResearchDrivingDriver`: extracts each source's claims,
//       tracks independent corroboration, and synthesizes DEEP follow-up questions
//       it folds into the worker's next prompt to drive depth + validation. Costs
//       the most extra inference.
//
// The QUESTION: does any topology (B or C) surface MORE buried material facts than
// blind collection (A) — i.e. does it actually research deeper — and at what cost?
//
// Skipped offline (no creds). Gate: AGENT_KNOWLEDGE_LIVE=1 + a TANGLE_API_KEY
// that can reach glm-5.2.
//   IT_LIVE_ROUNDS    — research round budget per arm (default 3; driving needs >1)
//   IT_LIVE_MODEL     — router chat model (default glm-5.2)
//   IT_LIVE_TICKERS   — `|`-separated subset of tickers (default: all 5)
//   IT_LIVE_ARMS      — `|`-separated subset of {collection,verify,driving}
//                       (default: all three)
//
// This is a MEASUREMENT, not a pass/fail gate: it asserts only that the harness
// produced a real, gradable KB for every company in every arm (at least one fact
// surfaced somewhere — an all-zero run means the worker never reached the filings,
// a FALSE null we fail loud on). The numbers go in docs/results/investment-thesis.md.
// ===========================================================================

type ArmKind = 'collection' | 'verify' | 'driving'

interface CompanyRun {
  ticker: string
  surfaced: number
  total: number
  fraction: number
  thesisChars: number
  factIds: string[]
  cost: { chatCalls: number; searchCalls: number; tokens: number; usd: number }
}

interface ArmResult {
  arm: ArmKind
  runs: CompanyRun[]
}

function makeDriver(arm: ArmKind, router: RouterClient): ResearchDriver {
  switch (arm) {
    case 'collection':
      return createCollectionResearchDriver()
    case 'verify':
      return createVerifyingResearchDriver({ router })
    case 'driving':
      return createResearchDrivingDriver({ router })
  }
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((n / d) * 100))

describe.skipIf(!process.env.AGENT_KNOWLEDGE_LIVE)('live: investment-thesis 3-arm A/B', () => {
  it('runs collection vs verify vs driving over the held-out companies at equal compute', async () => {
    const rounds = Number(process.env.IT_LIVE_ROUNDS ?? 3)
    const model = process.env.IT_LIVE_MODEL ?? 'glm-5.2'
    const tickerFilter = (process.env.IT_LIVE_TICKERS ?? '')
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean)
    const armFilter = (process.env.IT_LIVE_ARMS ?? '')
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean) as ArmKind[]
    const arms: ArmKind[] = (
      armFilter.length ? armFilter : (['collection', 'verify', 'driving'] as ArmKind[])
    ).filter((a): a is ArmKind => ['collection', 'verify', 'driving'].includes(a))
    const companies = tickerFilter.length
      ? investmentThesisSet.filter((c) => tickerFilter.includes(c.ticker))
      : investmentThesisSet
    expect(companies.length).toBeGreaterThan(0)
    expect(arms.length).toBeGreaterThan(0)

    // ONE shared router for the whole run; usage() is cumulative, diffed per
    // (arm, company) so the cost is real per-arm provenance, not an estimate.
    const router: RouterClient = createTangleRouterClient({ model })

    // COST GATE: a cheap glm-5.2 smoke BEFORE the multi-company burn. Proves the
    // key works + the reasoning-token floor returns visible content. Fail fast,
    // ONCE, before any arm runs.
    const smoke = await router.chat(
      [
        { role: 'system', content: 'Reply with exactly the word: OK' },
        { role: 'user', content: 'Say OK.' },
      ],
      1200,
    )
    console.log(`[IT smoke] ${model} visible content length=${smoke.trim().length}`)
    expect(smoke.trim().length).toBeGreaterThan(0)

    const armResults: ArmResult[] = []
    for (const arm of arms) {
      const runs: CompanyRun[] = []
      for (const company of companies) {
        const root = await mkdtemp(join(tmpdir(), `it-${arm}-${company.ticker}-`))
        try {
          const before = router.usage()
          const { thesis } = await runInvestmentThesisTask(
            {
              company: company.company,
              ticker: company.ticker,
              cik: company.cik,
              cutoff: company.cutoff,
              sector: company.sector,
            },
            {
              root,
              router,
              driver: makeDriver(arm, router),
              maxRounds: rounds,
              workerOptions: { resultsPerQuery: 3, queriesPerGap: 1, maxSourcesPerRound: 6 },
            },
          )
          const after = router.usage()
          // Grade the KB against the HELD-OUT checklist — read only here, never
          // handed to the loop.
          const graded = await materialFactsSurfaced(root, company)
          runs.push({
            ticker: company.ticker,
            surfaced: graded.surfaced,
            total: graded.total,
            fraction: graded.fraction,
            thesisChars: thesis.trim().length,
            factIds: graded.perFact.filter((f) => f.surfaced).map((f) => f.id),
            cost: {
              chatCalls: after.chatCalls - before.chatCalls,
              searchCalls: after.searchCalls - before.searchCalls,
              tokens:
                after.promptTokens +
                after.completionTokens -
                before.promptTokens -
                before.completionTokens,
              usd: after.usd - before.usd,
            },
          })
          console.log(
            `[IT ${arm} ${company.ticker}] surfaced ${graded.surfaced}/${graded.total} ` +
              `(${pct(graded.surfaced, graded.total)}%) thesis=${thesis.trim().length}ch ` +
              `$${(after.usd - before.usd).toFixed(4)} ` +
              `(${after.searchCalls - before.searchCalls} searches, ${after.chatCalls - before.chatCalls} chats) ` +
              `facts: ${runs[runs.length - 1].factIds.join(', ')}`,
          )
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      }
      armResults.push({ arm, runs })
    }

    // Per-arm totals + a side-by-side comparison the result doc consumes verbatim.
    const lines: string[] = ['', '[IT 3-ARM TOTALS]']
    for (const { arm, runs } of armResults) {
      const surfaced = sum(runs.map((r) => r.surfaced))
      const facts = sum(runs.map((r) => r.total))
      const usd = sum(runs.map((r) => r.cost.usd))
      const chats = sum(runs.map((r) => r.cost.chatCalls))
      const searches = sum(runs.map((r) => r.cost.searchCalls))
      const tokens = sum(runs.map((r) => r.cost.tokens))
      lines.push(
        `  ${arm.padEnd(11)} facts ${surfaced}/${facts} (${pct(surfaced, facts)}%)  ` +
          `$${usd.toFixed(4)}  ${chats} chats  ${searches} searches  ${tokens} tok`,
      )
      for (const r of runs) {
        lines.push(
          `      ${r.ticker.padEnd(5)} ${r.surfaced}/${r.total} (${pct(r.surfaced, r.total)}%) ` +
            `$${r.cost.usd.toFixed(4)}  [${r.factIds.join(', ')}]`,
        )
      }
    }
    console.log(lines.join('\n'))

    // The run is only evidence if each arm reached the filings for at least one
    // company. All-zero in an arm = the worker never reached the web/EDGAR — a
    // FALSE null we fail loud on. Every company produced a non-empty thesis page.
    for (const { arm, runs } of armResults) {
      const surfaced = sum(runs.map((r) => r.surfaced))
      expect(surfaced, `arm ${arm} surfaced nothing — false null`).toBeGreaterThan(0)
      for (const r of runs)
        expect(r.thesisChars, `${arm}/${r.ticker} empty thesis`).toBeGreaterThan(0)
    }
  }, 3_600_000)
})

let _root: string
beforeEach(async () => {
  _root = await mkdtemp(join(tmpdir(), 'it-ab-'))
})
afterEach(async () => {
  await rm(_root, { recursive: true, force: true })
})
