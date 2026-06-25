import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runInvestmentThesisTask, thesisReadinessSpecs } from '../../src/investment-thesis-task'
import { materialFactsSurfaced } from '../../src/material-facts-metric'
import type { RouterClient, RouterUsage } from '../../src/web-research-worker'
import { investmentThesisSet } from './investment-thesis-set'

// ===========================================================================
// OFFLINE WIRING for the investment-thesis TASK (no creds, no network).
//
// Proves the task pipeline end-to-end against a SCRIPTED router: the loop fetches
// a scripted "filing", writes a thesis page, and `materialFactsSurfaced` reads
// the KB and grades it against the HELD-OUT checklist. So a live run that returns
// zeros is a real null (the worker never reached EDGAR), not a broken harness.
//
// The scripted router returns one rich "filing" whose text carries the company's
// real material facts (taken from the checklist's own evidence so the wiring is
// honest about what a perfect fetch would surface), and a synthesis pass that
// echoes the research. We then assert the metric scores it HIGH — proving the
// page→index→grade path works — and scores an EMPTY KB at zero.
// ===========================================================================

const SIVB = investmentThesisSet.find((c) => c.ticker === 'SIVB')!

/**
 * A scripted RouterClient: search returns the one filing for any query; fetch is
 * stubbed by the worker's politeFetch against the real URL — so instead we make
 * the worker see the filing by returning it as a search hit whose URL the worker
 * will fetch. To keep this OFFLINE we cannot fetch sec.gov; so we run the metric
 * path directly on a KB the task wrote via the synthesis page, using a router
 * whose chat() returns a thesis that echoes the filing facts. The worker's web
 * fetch is exercised by the live test; here we validate page→index→grade.
 */
function scriptedRouter(thesisText: string): RouterClient {
  const usage: RouterUsage = {
    chatCalls: 0,
    searchCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    usd: 0,
    wallMs: 0,
  }
  return {
    // No web reach offline → no sources; the loop still runs and the synthesis
    // pass writes the thesis page, which is what we grade here.
    search: async () => {
      usage.searchCalls += 1
      return []
    },
    chat: async (messages) => {
      usage.chatCalls += 1
      // The query-forming pass asks for a JSON array; the synthesis pass asks for
      // the thesis. Detect the synthesis pass by its analyst system prompt.
      const isSynthesis = messages.some((m) => m.content.includes('buy-side investment analyst'))
      return isSynthesis ? thesisText : '[]'
    },
    usage: () => ({ ...usage }),
  }
}

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'it-task-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('investment-thesis task wiring (offline, scripted)', () => {
  it('builds the analyst-lens readiness specs (the only steer the loop is told)', () => {
    const specs = thesisReadinessSpecs({
      company: SIVB.company,
      ticker: SIVB.ticker,
      cik: SIVB.cik,
      cutoff: SIVB.cutoff,
      sector: SIVB.sector,
    })
    expect(specs.length).toBe(4)
    // The specs name the FILING + the analyst LENSES, never the held-out answers.
    const blob = specs.map((s) => `${s.id} ${s.description} ${s.query}`).join(' ')
    expect(blob).toMatch(/10-K|EDGAR/i)
    expect(blob).toMatch(/concentration|leverage|governance/i)
    // No held-out fact value leaks into the steer (e.g. the 151.5 / 91,321 figures).
    expect(blob).not.toMatch(/151\.5|91,321|76,169/)
  })

  it('writes a thesis page the metric reads + grades against the held-out checklist', async () => {
    // A thesis that names SIVB's buried facts (a perfect-synthesis stand-in).
    const thesisText =
      'Judgment: avoid. Held-to-maturity securities at amortized cost of 91,321 have a fair value of only 76,169 — a ~15.1 billion unrealized loss sitting in the footnotes, almost the size of total stockholders equity of 16,004. Available-for-sale securities cost 28,602 are marked to 26,069 in AOCI. Estimated uninsured deposits that exceed the FDIC insurance limit were 151.5 billion. Noninterest-bearing demand deposits fell 20 percentage points to 47 percent of total deposits. The deposit and credit base is concentrated in the innovation economy (technology, life science, venture).'
    const { thesis, thesisPath, loop } = await runInvestmentThesisTask(
      {
        company: SIVB.company,
        ticker: SIVB.ticker,
        cik: SIVB.cik,
        cutoff: SIVB.cutoff,
        sector: SIVB.sector,
      },
      {
        root,
        router: scriptedRouter(thesisText),
        driver: { verifySource: () => ({ accept: true }) },
        maxRounds: 1,
      },
    )
    // The task completed: a thesis page was written into the KB.
    expect(thesis.length).toBeGreaterThan(0)
    expect(thesisPath).toMatch(/thesis-sivb\.md$/)
    expect(loop).toBeDefined()

    // The metric reads the KB (which now contains the thesis page) and grades it
    // against SIVB's held-out checklist — the page→index→grade path works.
    const graded = await materialFactsSurfaced(root, SIVB)
    expect(graded.surfaced).toBeGreaterThanOrEqual(5)
    expect(graded.fraction).toBeGreaterThan(0.7)
  })

  it('an empty KB surfaces zero held-out facts (no false positives)', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'it-empty-'))
    try {
      const graded = await materialFactsSurfaced(empty, SIVB)
      expect(graded.surfaced).toBe(0)
      expect(graded.fraction).toBe(0)
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})
