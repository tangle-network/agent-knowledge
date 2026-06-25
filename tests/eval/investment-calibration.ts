/**
 * CALIBRATION FIXTURES for the `materialFactsSurfaced` metric.
 *
 * Before running ANY A/B with this metric, we must prove the metric DISCRIMINATES
 * research depth — that it measures "did the thesis surface the buried, material
 * drivers" and NOT "did it collect a lot of words". The ML deep-question exam had
 * exactly this risk (a metric that rewards collection, not research); the task
 * spec demands we rule it out here the same way: by scoring a deliberately-SHALLOW
 * thesis and a deliberately-DEEP thesis for each company and checking the metric
 * separates them cleanly (shallow LOW, deep HIGH).
 *
 * For each company:
 *  - `shallow` is a one-paragraph ticker-summary thesis — the kind a single web
 *    search for the company name returns: what the company does, a vibe on the
 *    stock, generic risks. It names NONE of the buried, filing-level facts.
 *  - `deep` is a filings-grounded analysis written the way a thorough analyst
 *    would write it: it NAMES the buried drivers (the concentration, the duration
 *    loss, the buyback drain, the negative unit margin, the related party) in
 *    plain analyst prose, with the real numbers.
 *
 * HONESTY GUARD (this is what keeps the calibration from being circular):
 *  - The deep theses are written in independent analyst prose. They are NOT copied
 *    from the checklist's `expected` fragments or `evidence` strings. They earn
 *    their score by stating the real, publicly-documented facts — the same facts a
 *    real deep research loop would have to surface — phrased independently. A test
 *    asserts the deep prose does not verbatim-embed the checklist's evidence
 *    strings, so a high deep score is the metric catching real depth, not an
 *    answer-key leak.
 *  - The shallow theses are generic on purpose. A test asserts they score LOW, so
 *    a metric that "answered" them would be over-crediting collection — the exact
 *    failure mode we are gating against.
 *
 * These fixtures are FIRWALLED the same way the checklist is: they are calibration
 * INPUTS, never shown to any research loop. They exist only to validate the meter.
 */

import { investmentThesisSet } from './investment-thesis-set'

/** A shallow + deep thesis pair for one company, keyed by ticker. */
export interface CalibrationThesis {
  ticker: string
  /** One-paragraph ticker-summary thesis — surfaces no buried facts. */
  shallow: string
  /** Filings-grounded analyst thesis — names the buried drivers in its own words. */
  deep: string
}

export const calibrationTheses: CalibrationThesis[] = [
  {
    ticker: 'SIVB',
    shallow:
      'SVB Financial Group is the parent of Silicon Valley Bank, a California-based commercial bank that serves technology and venture-backed companies. It has grown quickly with the tech sector and is generally seen as a well-run, profitable bank with a strong niche franchise. As with any bank, the main risks are a slowdown in its core market, competition from larger banks, and the general macro environment of interest rates. The stock has been a long-term grower and trades as a play on the health of the innovation sector.',
    deep: "The decisive, non-obvious risk in SVB's FY2022 10-K is a duration mismatch that bank-level accounting hides. SVB parked a huge share of its deposit inflow into long-dated bonds and classified the bulk of them as held-to-maturity. The held to maturity book is carried at amortized cost of $91,321 million but its fair value is only $76,169 million — an unrealized loss of roughly $15.1 billion that, because the securities are HTM, never flows through earnings or equity and sits only in the footnotes. That below-amortized-cost gap is almost the size of the bank's entire reported capital: total SVBFG stockholders' equity is $16,004 million, so the footnote-only mark is ~95% of equity, a tangible-book wipeout the income statement does not show. The available-for-sale securities tell the visible, smaller part of the same story — AFS at a cost of $28,602 million is marked to a fair value of 26,069, a ~$2.5 billion loss that does run through AOCI. The funding side makes the duration bet fragile: estimated uninsured deposits in U.S. offices that exceed the FDIC insurance limit were $151.5 billion, a run-prone base, and the cheap noninterest-bearing demand deposits fell 20 percentage points to 47 percent of total deposits in one year as clients rotated into interest-bearing accounts, so the cost of deposits was set to climb. Underneath it all the franchise is a single-sector concentration: the deposit and credit base is the venture-backed innovation economy (technology and life science startups), so a venture-funding downturn hits deposits and loans together.",
  },
  {
    ticker: 'BBBY',
    shallow:
      'Bed Bath & Beyond is a specialty home-goods retailer known for its big-box stores and ubiquitous coupons. It has struggled against e-commerce and changing consumer habits, and a new management team has been trying to turn the business around with a private-label strategy and store closures. The stock is a speculative turnaround story; risks include weak consumer demand, execution on the turnaround plan, and competition from Amazon and big-box rivals.',
    deep: "The buried story in Bed Bath & Beyond's FY2021 10-K is that capital return, not just weak sales, hollowed out the balance sheet. The company kept aggressively repurchasing stock while losing money: it has repurchased approximately $11.685 billion of its common stock since 2004, and in fiscal 2021 alone it completed share repurchases of $574.9 million, which it describes as two years ahead of schedule. It did that in a year it posted a net loss of $559,623 thousand — so it returned more cash to shareholders than it had, let alone earned. Internally generated cash had already collapsed: net cash provided by operating activities was just 17,854 thousand, down from 268,108 and 590,941 in the two prior years. The combination ate the equity cushion — total shareholders' equity fell to 174,145 thousand from 1,276,936, an ~86% drop in a single year. And it was building inventory into falling demand: merchandise inventories rose to 1,725,410 thousand even as comparable sales declined, a markdown-and-cash-trap signal. A ticker glance shows a turnaround retailer; the filing shows a company spending borrowed and depleted cash on buybacks while its equity evaporated.",
  },
  {
    ticker: 'CVNA',
    shallow:
      'Carvana is an online used-car retailer famous for its car vending machines and a fully digital buying experience. It grew revenue rapidly during the pandemic used-car boom but has come under pressure as used-car prices and demand normalized and interest rates rose. The stock has been extremely volatile. Risks include a soft used-car market, the need to reach profitability, and broader consumer-spending weakness.',
    deep: "The non-obvious risk in Carvana's FY2022 10-K is a leverage problem that the revenue-growth narrative masks. Total debt has grown to 8,391 million from 5,447 a year earlier — a debt load far larger than the equity base — and crucially the cost of that debt is now biting: interest expense nearly tripled to 486 million from 176, so debt service was consuming cash a still-unprofitable company did not have. The leverage was made worse by timing: in May 2022 Carvana bought the physical auction business of ADESA for approximately $2.2 billion in cash, a debt-funded acquisition that stretched the balance sheet right as used-car demand turned. The income statement confirms the unit economics had not turned even at scale — the net loss for the year was 2,894 million, far wider than prior years. There is also a governance flag a quote screen never shows: Carvana leases hubs and properties from DriveTime, a related party controlled by founder-CEO Ernest Garcia III and his father Ernest Garcia II, so the controlling family sits on both sides of material recurring leases.",
  },
  {
    ticker: 'PTON',
    shallow:
      'Peloton Interactive makes connected exercise equipment — stationary bikes and treadmills — paired with a subscription fitness content service. Demand surged during the pandemic and then fell sharply as gyms reopened, leaving the company with a much lower growth rate and a turnaround to execute. The stock has fallen far from its highs. Risks include softening demand for at-home fitness, the need to cut costs, and competition in connected fitness.',
    deep: "The decisive fact in Peloton's FY2022 10-K is that the hardware was being sold below cost: Connected Fitness gross margin decreased to (11) percent, a negative gross margin meaning Peloton lost money on every bike and tread before any operating expense — the unit economics, not just the growth rate, had broken. Revenue was still large, which is exactly why a surface read misses it. The company was also carrying a glut of unsold equipment as pandemic demand normalized: inventories, net climbed to 1,104.5 million from 937, tying up cash and risking markdowns, and it was contractually locked into more: purchase commitments related to the manufacture of Peloton products were estimated to be approximately $334 million, inventory it had to take regardless of whether it could sell it. The bottom line was an order-of-magnitude wider net loss of 2,827 million. Two further items a ticker quote never shows: a dual-class structure in which the Class B common stock has 20 votes per share versus one vote for Class A concentrates control with insiders, and an open product-safety exposure — Peloton was conducting a recall on Tread+ in collaboration with the Consumer Product Safety Commission (CPSC) tied to injuries.",
  },
  {
    ticker: 'SI',
    shallow:
      'Silvergate Capital is the holding company for Silvergate Bank, a California bank that became a leading provider of banking services to the cryptocurrency sector. The stock trades as a crypto-banking play and has benefited from the growth of the digital-asset market. Risks include crypto-market volatility, an evolving regulatory environment, and competition from other banks entering the space.',
    deep: "The buried, structural fragility in Silvergate's FY2021 10-K is that essentially the entire bank is one undiversified, on-demand bet on crypto. Noninterest bearing deposits as a percentage of total deposits were 99.5% as of year end — almost all funding is non-term money that can leave on demand, an extreme run risk that low funding cost masks. Worse, that funding is correlated: deposits from digital currency exchanges represent approximately 58% of deposits, a handful of crypto counterparties whose own troubles would pull deposits out together, and the whole deposit franchise is tied to a single volatile industry, digital currency customers, so a crypto downturn is a direct, undiversified funding shock rather than a diversified one. The deposits had also ballooned as hot money: total deposits reached $14,290,628 thousand from 10,411,278 the year before, fast growth that can reverse just as fast. And the moat and the funding are the same bet: the bank's differentiator is the Silvergate Exchange Network (SEN), its proprietary payment network built exclusively for the digital currency industry, so the competitive product and the deposit magnet are a single crypto-dependent dependence, not two diversified ones.",
  },
]

/** The held-out checklist case for a calibration ticker (kept in lockstep). */
export function caseForTicker(ticker: string) {
  const company = investmentThesisSet.find((c) => c.ticker === ticker)
  if (!company) throw new Error(`no eval case for ticker ${ticker}`)
  return company
}
