import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createResearchDrivingDriver,
  createTangleRouterClient,
  createVerifyingResearchDriver,
  materialFactsSurfaced,
  type RouterClient,
  runInvestmentThesisTask,
} from '../../src/index'
import { investmentThesisSet } from './investment-thesis-set'

// ===========================================================================
// THE INVESTMENT-THESIS A/B — the live evidence.
//
// For each held-out company the loop is told ONLY {company, ticker, cik, cutoff}
// (+ the generic analyst-lens readiness specs every company gets). It researches
// the company AS OF the cutoff over web + SEC EDGAR (both public), writes a thesis
// page, and we grade that KB against the company's HELD-OUT material-fact
// checklist with `materialFactsSurfaced` — a $0, model-free substring grader the
// loop never sees. A high score is research DEPTH (it surfaced the buried drivers
// a ticker search misses), not teaching-to-the-test.
//
// Skipped offline (no creds). Gate: AGENT_KNOWLEDGE_LIVE=1 + a TANGLE_API_KEY
// that can reach glm-5.2.
//   IT_LIVE_ROUNDS    — research round budget per arm (default 3; driving needs >1)
//   IT_LIVE_MODEL     — router chat model (default glm-5.2)
//   IT_LIVE_TICKERS   — `|`-separated subset of tickers (default: all 5)
//   IT_LIVE_DRIVER    — 'driving' | 'verify' (default 'driving')
//
// This is a MEASUREMENT, not a pass/fail gate: it asserts only that the harness
// produced a real, gradable KB for every company (at least one fact surfaced
// somewhere — an all-zero run means the worker never reached the filings, a FALSE
// null we fail loud on). The numbers go in docs/results/investment-thesis-ab.md.
// ===========================================================================

interface CompanyRun {
  ticker: string
  surfaced: number
  total: number
  fraction: number
  thesisChars: number
  cost: { chatCalls: number; searchCalls: number; tokens: number; usd: number }
}

describe.skipIf(!process.env.AGENT_KNOWLEDGE_LIVE)('live: investment-thesis A/B', () => {
  it('researches each held-out company and surfaces its material facts', async () => {
    const rounds = Number(process.env.IT_LIVE_ROUNDS ?? 3)
    const model = process.env.IT_LIVE_MODEL ?? 'glm-5.2'
    const driverKind = (process.env.IT_LIVE_DRIVER ?? 'driving') as 'driving' | 'verify'
    const tickerFilter = (process.env.IT_LIVE_TICKERS ?? '')
      .split('|')
      .map((s) => s.trim())
      .filter(Boolean)
    const companies = tickerFilter.length
      ? investmentThesisSet.filter((c) => tickerFilter.includes(c.ticker))
      : investmentThesisSet
    expect(companies.length).toBeGreaterThan(0)

    // ONE shared router for the run; usage() is cumulative, diffed per company.
    const router: RouterClient = createTangleRouterClient({ model })

    // COST GATE: a cheap glm-5.2 smoke BEFORE the multi-company burn. Proves the
    // key works + the reasoning-token floor returns visible content. Fail fast.
    const smoke = await router.chat(
      [
        { role: 'system', content: 'Reply with exactly the word: OK' },
        { role: 'user', content: 'Say OK.' },
      ],
      1200,
    )
    console.log(`[IT smoke] ${model} visible content length=${smoke.trim().length}`)
    expect(smoke.trim().length).toBeGreaterThan(0)

    const makeDriver = () =>
      driverKind === 'verify'
        ? createVerifyingResearchDriver({ router })
        : createResearchDrivingDriver({ router })

    const runs: CompanyRun[] = []
    for (const company of companies) {
      const root = await mkdtemp(join(tmpdir(), `it-${company.ticker}-`))
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
            driver: makeDriver(),
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
          `[IT ${company.ticker}] surfaced ${graded.surfaced}/${graded.total} ` +
            `(${Math.round(graded.fraction * 100)}%) thesis=${thesis.trim().length}ch ` +
            `$${(after.usd - before.usd).toFixed(4)} ` +
            `(${after.searchCalls - before.searchCalls} searches, ${after.chatCalls - before.chatCalls} chats) ` +
            `facts: ${graded.perFact
              .filter((f) => f.surfaced)
              .map((f) => f.id)
              .join(', ')}`,
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }

    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
    const totalSurfaced = sum(runs.map((r) => r.surfaced))
    const totalFacts = sum(runs.map((r) => r.total))
    const totalUsd = sum(runs.map((r) => r.cost.usd))
    console.log(
      `\n[IT TOTALS — driver=${driverKind}, ${rounds} rounds, ${runs.length} companies]\n` +
        `  material facts surfaced: ${totalSurfaced}/${totalFacts} (${Math.round((totalSurfaced / totalFacts) * 100)}%)\n` +
        `  cost: $${totalUsd.toFixed(4)}\n` +
        runs
          .map(
            (r) =>
              `  ${r.ticker}: ${r.surfaced}/${r.total} (${Math.round(r.fraction * 100)}%) $${r.cost.usd.toFixed(4)}`,
          )
          .join('\n'),
    )

    // The run is only evidence if the loop reached the filings for at least one
    // company. All-zero = the worker never reached the web/EDGAR — a FALSE null.
    expect(totalSurfaced).toBeGreaterThan(0)
    // Every company produced a non-empty thesis page (the task completed).
    for (const r of runs) expect(r.thesisChars).toBeGreaterThan(0)
  }, 1_800_000)
})

let _root: string
beforeEach(async () => {
  _root = await mkdtemp(join(tmpdir(), 'it-ab-'))
})
afterEach(async () => {
  await rm(_root, { recursive: true, force: true })
})
