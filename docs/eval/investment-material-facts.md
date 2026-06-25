# Held-out investment-research eval set — material facts + provenance

This is the answer key and the provenance ledger for `tests/eval/investment-thesis-set.ts`.

**What the set measures.** Give a research loop a company + ticker + an as-of
**cutoff** date and ask it to write an investment thesis. Then grade that thesis
against the held-out **material facts** below — facts the loop never saw. A high
score means the thesis surfaced the buried, material, non-obvious drivers a
thorough analyst would flag and a single ticker search would miss; it is **not**
teaching-to-the-test, because the answer key is firewalled from every loop and
the grader is a `$0`, model-free substring check (`gradeFactAgainstText`).

**Three hard rules, enforced by how the data was gathered:**

1. **Specific + checkable.** Every fact carries keyword groups (a number, a name,
   a phrase) so the deterministic grader can score "did the thesis surface it".
2. **Derived from real fetched evidence.** Every fact cites the primary SEC EDGAR
   10-K it was read from and the literal value in that document. Nothing is
   invented; an item that could not be independently sourced was **dropped**, not
   guessed (see the drop log).
3. **Knowable at the cutoff.** Every value was disclosed in, or computable from, a
   filing available on or before the cutoff. The eventual collapse is **not** a
   checklist item — it is recorded as `knownOutcome`, for the reader only, and is
   never graded.

All five primary documents were fetched live from `https://www.sec.gov/Archives/`
during curation (a `curl` with a descriptive `User-Agent`, per SEC fair-access
rules). Every dollar figure below was read directly out of the de-tagged filing
text. Provenance is verifiable: each `sourceUrl` contains the company's SEC CIK,
and `tests/eval/investment-thesis-set.test.ts` asserts that invariant.

---

## Companies + cutoffs

| Ticker | Company | CIK | Cutoff (as-of) | Sector | Primary source (10-K) |
|---|---|---|---|---|---|
| SIVB | SVB Financial Group | 719739 | 2023-02-24 | Banking | FY2022 10-K, filed 2023-02-24 |
| BBBY | Bed Bath & Beyond Inc. | 886158 | 2022-04-21 | Specialty retail | FY2021 10-K, filed 2022-04-21 |
| CVNA | Carvana Co. | 1690820 | 2023-02-23 | Auto e-commerce | FY2022 10-K, filed 2023-02-23 |
| PTON | Peloton Interactive, Inc. | 1639825 | 2022-09-07 | Consumer fitness hardware | FY2022 10-K, filed 2022-09-07 |
| SI | Silvergate Capital Corporation | 1312109 | 2022-02-28 | Banking (digital-asset) | FY2021 10-K, filed 2022-02-28 |

Each cutoff is set to the filing date of the primary 10-K, so the entire document
was public on the as-of date. All five cutoffs are **>= 18 months** before this
set was curated (June 2026); `investment-thesis-set.test.ts` asserts this.

---

## SIVB — SVB Financial Group (cutoff 2023-02-24)

Source: [FY2022 10-K (`sivb-20221231.htm`)](https://www.sec.gov/Archives/edgar/data/719739/000071973923000021/sivb-20221231.htm)
**Known outcome (not graded):** FDIC receivership March 10, 2023; holding-company Chapter 11 March 17, 2023.

| ID | Lens | Material fact | Value read from the filing |
|---|---|---|---|
| SIVB/f1 | off-balance-sheet | HTM securities carried at amortized cost were far above fair value | "Held-to-maturity securities, at amortized cost ... **91,321** (fair value of $ **76,169**)" → ~**$15.15B** unrealized loss, footnote-only |
| SIVB/f2 | off-balance-sheet | That HTM loss ~= the entire equity base | "Total SVBFG stockholders' equity **16,004**" → ~$15.15B is ~95% of $16.0B equity |
| SIVB/f3 | concentration | Run-prone uninsured deposit base | "estimated uninsured deposits in U.S. offices that exceed the FDIC insurance limit were **$151.5 billion**" |
| SIVB/f4 | margin-trend | Cheap deposits fleeing → funding cost set to rise | "Noninterest-bearing demand deposits to total deposits decreased by **20 percentage points to 47 percent**" |
| SIVB/f5 | concentration | Single-client-type (innovation-economy) deposit + credit base | 10-K frames the franchise around "the innovation economy" (technology, life-science, venture) |
| SIVB/f6 | off-balance-sheet | AFS loss in AOCI — the visible, smaller tip | "Available-for-sale securities, at fair value (cost of $ **28,602**) **26,069**" → ~$2.5B AFS loss in AOCI |

The decisive, non-obvious fact is SIVB/f1+f2: an interest-rate loss roughly equal
to all of equity, sitting in the footnotes because HTM accounting keeps it out of
both earnings and book equity. A ticker search shows a profitable bank; the
filing shows a mark-to-market hole the size of its capital.

## BBBY — Bed Bath & Beyond Inc. (cutoff 2022-04-21)

Source: [FY2021 10-K (`bbby-20220226.htm`)](https://www.sec.gov/Archives/edgar/data/886158/000088615822000047/bbby-20220226.htm)
**Known outcome (not graded):** Chapter 11 on April 23, 2023; equity wiped out.

| ID | Lens | Material fact | Value read from the filing |
|---|---|---|---|
| BBBY/f1 | capital-return | Buybacks drained a loss-making balance sheet | "we have repurchased approximately **$11.685 billion**"; FY2021 alone "**$574.9 million** ... two years ahead of schedule" |
| BBBY/f2 | liquidity | Operating cash flow nearly vanished | "Net cash provided by operating activities **17,854** 268,108 590,941" ($ thousands) |
| BBBY/f3 | liquidity | Equity collapsed ~86% in one year | "Total shareholders' equity **174,145** 1,276,936" ($ thousands) |
| BBBY/f4 | liquidity | A net loss the same year it kept buying back stock | "Net loss $ (**559,623**)" ($ thousands) |
| BBBY/f5 | margin-trend | Inventory building into a demand decline | "Merchandise inventories **1,725,410** 1,671,909" ($ thousands) |

The non-obvious fact is BBBY/f1+f2+f4 together: in FY2021 the company **lost $560M,
generated only $18M of operating cash, and still spent $575M buying back stock** —
returning more cash than it had. The buyback, not the income statement alone, is
why a $1.3B equity base became $174M.

## CVNA — Carvana Co. (cutoff 2023-02-23)

Source: [FY2022 10-K (`cvna-20221231.htm`)](https://www.sec.gov/Archives/edgar/data/1690820/000169082023000052/cvna-20221231.htm)
**Known outcome (not graded):** Stock fell ~98% from its 2021 peak; a 2023 debt exchange cut and extended obligations, narrowly avoiding bankruptcy.

| ID | Lens | Material fact | Value read from the filing |
|---|---|---|---|
| CVNA/f1 | leverage | A debt load far above the equity base | "Total debt **8,391** 5,447" ($ millions) |
| CVNA/f2 | leverage | Interest expense nearly tripled in a year | "Interest expense **486** 176" ($ millions) |
| CVNA/f3 | leverage | A ~$2.2B debt-funded acquisition as demand turned | "physical auction business of ADESA US Auction, LLC for approximately **$2.2 billion** in cash" (closed 2022-05-09) |
| CVNA/f4 | governance | Recurring related-party leases with the founder's family | Related-Party note: DriveTime, controlled by "Ernest Garcia II, Ernest Garcia III, and entities controlled by one or both of them" |
| CVNA/f5 | liquidity | A wide loss showing unit economics had not turned | "Net loss $ (**2,894**)" ($ millions) |

The non-obvious facts are CVNA/f2 (interest expense up 2.8x — the debt was now
expensive, not just large) and CVNA/f4 (the controlling Garcia family on both
sides of material leases via DriveTime), neither of which a ticker quote shows.

## PTON — Peloton Interactive, Inc. (cutoff 2022-09-07)

Source: [FY2022 10-K (`pton-20220630.htm`)](https://www.sec.gov/Archives/edgar/data/1639825/000163982522000117/pton-20220630.htm)
**Known outcome (not graded):** Stock fell ~95% from its 2021 peak; founder-CEO departed; mass layoffs and a multi-year turnaround.

| ID | Lens | Material fact | Value read from the filing |
|---|---|---|---|
| PTON/f1 | margin-trend | Hardware gross margin turned **negative** | Connected Fitness "Gross Margin decreased to (**11**)" percent — losing money per unit sold |
| PTON/f2 | liquidity | Inventory glut as pandemic demand normalized | "Inventories, net **1,104.5** 937" ($ millions) |
| PTON/f3 | governance | Dual-class super-voting control | "Class B common stock has **20 votes per share** and our Class A common stock has one vote per share" |
| PTON/f4 | liquidity | An order-of-magnitude wider loss | "Net loss $ (**2,827**)" ($ millions) |
| PTON/f5 | regulatory | An open CPSC product-safety recall | "recall on **Tread+** ... in collaboration with the **Consumer Product Safety Commission ('CPSC')**" |
| PTON/f6 | leverage | Locked-in purchase commitments into falling demand | "purchase commitments related to the manufacture of Peloton products were estimated to be approximately **$334**" million |

The non-obvious fact is PTON/f1: revenue was still large, but the **hardware was
sold below cost** (−11% gross margin) — the unit economics, not just the growth
rate, had broken. PTON/f6 compounds it: the company was contractually obliged to
buy more inventory it could not sell.

## SI — Silvergate Capital Corporation (cutoff 2022-02-28)

Source: [FY2021 10-K (`si-20211231.htm`)](https://www.sec.gov/Archives/edgar/data/1312109/000131210922000051/si-20211231.htm)
**Known outcome (not graded):** After the FTX collapse triggered a deposit run, Silvergate announced a voluntary wind-down and liquidation of Silvergate Bank in March 2023.

| ID | Lens | Material fact | Value read from the filing |
|---|---|---|---|
| SI/f1 | concentration | Essentially all funding was on-demand money | "noninterest bearing deposits as a percentage of total deposits was **99.5%** as of December 31, 2021" |
| SI/f2 | concentration | Deposits dominated by crypto exchanges | "Deposits from digital currency exchanges represent approximately **58%**" |
| SI/f3 | concentration | The whole deposit base tied to one volatile industry | Strategy + risk factors center on "digital currency customers" and "the concentration of our deposits" |
| SI/f4 | liquidity | Hot-money deposit growth that could reverse fast | "Total deposits $ **14,290,628**" vs prior year "$ 10,411,278" ($ thousands) |
| SI/f5 | concentration | The moat AND the funding are the same crypto-only bet | "Silvergate Exchange Network ('SEN'), our proprietary ... payment network for participants in the digital currency industry" |

The non-obvious fact is SI/f1+f2 together: **99.5% noninterest-bearing deposits,
~58% from crypto exchanges** — a funding base with no contractual term and a
single correlated counterparty type. A ticker quote shows a fast-growing,
low-cost-funding bank; the filing shows a bank that could be emptied in days if
crypto sentiment turned.

---

## Curation-bias disclosure (read this before trusting a score on this set)

This set is **not** a representative sample of public companies, and a score on it
should not be read as a general "investment-research quality" number. The biases:

1. **Survivorship / outcome selection.** All five companies are ones whose buried
   risks later **materialized** (four failed or near-failed; one was forced into a
   multi-year turnaround). They were chosen partly because that is where the
   material-vs-surface distinction is sharpest, and partly because the figures are
   easy to verify after the fact. A set built only on known blow-ups will reward a
   loop that pattern-matches "find the downside" and will not test whether a loop
   can surface a buried **positive** driver or correctly conclude a company is
   sound. A production set must add survivors and upside cases.

2. **Lens skew toward downside risk.** The 27 facts are not evenly spread across
   the eight analyst lenses. Measured by `lensDistribution()`:

   | Lens | Facts |
   |---|---|
   | liquidity | 7 |
   | concentration | 6 |
   | leverage | 4 |
   | off-balance-sheet | 3 |
   | margin-trend | 3 |
   | governance | 2 |
   | capital-return | 1 |
   | regulatory | 1 |

   Liquidity / concentration / leverage dominate (17 of 27). Governance,
   capital-return, and regulatory are thin. The set therefore tests "can you find
   the cash/funding/debt hole" much more than "can you find the governance or
   regulatory landmine."

3. **Sector skew toward financials + distressed consumer.** Two of five are banks
   (SIVB, SI). The two banks are deliberately given **different** buried-risk
   lenses — SIVB is an interest-rate / duration / off-balance-sheet story, SI is a
   single-industry deposit-concentration story — so they are not redundant, but
   the set still over-indexes on balance-sheet fragility and under-tests, e.g.,
   technology platform risk, supply-chain concentration, or accounting-policy
   aggressiveness in a healthy grower.

4. **Grader leniency vs strictness is a knob, not a truth.** The grader counts a
   fact "surfaced" on a case-insensitive substring of any synonym in a group. This
   can **over-credit** a thesis that name-drops a number without understanding it
   (e.g. mentions "$151.5 billion" in passing), and can **under-credit** a thesis
   that explains the risk in numbers the grader did not anticipate. The synonym
   groups were written to be faithful, but they are a human artifact; treat the
   absolute score as ordinal (arm A vs arm B), not cardinal.

5. **Single-source provenance.** Every fact is sourced to the company's own 10-K.
   That makes provenance clean and checkable, but it means the set tests "did you
   read the filing", not "did you triangulate the filing against an independent
   source" (analyst reports, court filings, short-seller research). A fact that
   required a second independent source to establish was dropped (below) rather
   than sourced to the filing alone.

## Drop log — items considered and NOT included (honesty over coverage)

These were candidate facts I could not independently ground to a primary source
available at the cutoff, so I **dropped them rather than guess**:

- **First Republic Bank (FRC)** — dropped as a company entirely. First Republic
  was a state-chartered bank that filed its annual reports with the **FDIC**, not
  on SEC EDGAR, so its 10-K is not at a `sec.gov/Archives` URL and I could not give
  it the same clean, CIK-verifiable provenance as the other five. Its widely cited
  figures (~$15B HTM-style loss, ~$119.5B uninsured deposits) are real but are best
  sourced from the FDIC OIG Material Loss Review, a **post**-cutoff document — using
  it would violate rule 3. Replaced with Silvergate, whose 10-K is on EDGAR.

- **SIVB exact total unrealized-loss footnote line** — I report the HTM gap as the
  arithmetic difference of two figures printed on the balance sheet
  ($91,321M − $76,169M), which is exact and on-cutoff. I did **not** include a
  separately-quoted "$15.1B net unrealized loss" sentence because I did not locate
  that exact phrasing in the de-tagged text; quoting a number I could not point to
  verbatim would break rule 2. The computed value is conservative and checkable.

- **CVNA negative gross-profit-per-unit** — a frequently-cited Carvana red flag,
  but the per-unit figure I could find cleanly was a derived/analyst number, not a
  single line item I could quote verbatim from the 10-K at the cutoff. Dropped in
  favor of the directly-quoted total debt, interest expense, ADESA price, related
  party, and net loss.

- **PTON / SI specific debt-covenant or going-concern language** — I searched for
  explicit "substantial doubt / going concern" wording in both filings and did
  **not** find it at these cutoffs (it came later). I did not invent it. The facts
  included are the ones actually present in the cutoff-date document.

## How a loop is graded against this set

```ts
import {
  investmentThesisSet,
  gradeCompanyAgainstText,
  totalMaterialFacts,
} from '../../tests/eval/investment-thesis-set'

// For each company, the loop writes a thesis BLIND (it sees only company +
// ticker + cutoff, never the facts above). Then:
for (const company of investmentThesisSet) {
  const thesisText = /* the loop's full thesis for this company */ ''
  const { surfaced, total } = gradeCompanyAgainstText(company, thesisText)
  // surfaced / total = held-out material facts this thesis caught.
}
// totalMaterialFacts() = 27 is the denominator across the whole set.
```

The grader is deterministic and model-free, so the same thesis always scores the
same and the answer key never reaches a model the loop could observe — the same
firewall the deep-question exam (`tests/loops/held-out-exam.ts`) uses.
