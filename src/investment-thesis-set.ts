/**
 * HELD-OUT INVESTMENT-RESEARCH EVAL SET.
 *
 * The point of this file is the same FIREWALL the deep-question exam uses
 * (`tests/loops/held-out-exam.ts`): the material facts and their checkable
 * fragments are NEVER shown to a research loop. A loop is told only the company
 * + ticker + a research-as-of CUTOFF date, and asked to write an investment
 * thesis. AFTER it finishes, we grade the thesis it produced against THESE
 * facts — facts it never saw — so a high score is thesis QUALITY (it surfaced
 * the buried, material, non-obvious drivers) and not teaching-to-the-test.
 *
 * Each fact is a DEPTH fact by construction: a single ticker / company-name web
 * search does NOT surface it. They are the things buried in the filings or
 * knowable from then-available primary sources that a thorough analyst flags and
 * a one-shot search misses — customer/revenue/deposit concentration, a debt
 * maturity wall, a margin-trend reversal, a governance / related-party item, a
 * specific competitive or regulatory risk, an off-balance-sheet loss.
 *
 * THREE HARD RULES, enforced by how the data was gathered (see
 * docs/eval/investment-material-facts.md for the per-item provenance + the
 * curation-bias disclosure):
 *
 *   1. SPECIFIC + CHECKABLE. Each fact carries `expected` keyword groups — the
 *      specific number / name / phrase — so a deterministic, model-free
 *      substring grader (`gradeFactAgainstText`) can score "did the thesis
 *      surface it". $0, reproducible, and it cannot leak the answer key into a
 *      model the loop could observe.
 *
 *   2. DERIVED FROM REAL FETCHED EVIDENCE. Every fact records the primary source
 *      it came from (`sourceUrl`, an SEC EDGAR 10-K) and the literal `evidence`
 *      value read out of that document. Nothing here is invented; an item that
 *      could not be independently sourced was DROPPED, not guessed (the drop log
 *      is in the doc).
 *
 *   3. KNOWABLE AT THE CUTOFF. Every fact was disclosed in, or computable from, a
 *      document available on or before the company's `cutoff` date. Post-cutoff
 *      hindsight (the eventual bankruptcy / collapse) is NOT a checklist item —
 *      it is recorded separately as `knownOutcome`, purely for the reader, and is
 *      never graded.
 *
 * Grading mirrors the deep-question exam exactly: a fact is SURFACED when the
 * thesis text contains at least `minGroups` of its expected groups; a group is
 * satisfied when ANY of its `anyOf` fragments appears (case-insensitive
 * substring), so a faithful thesis phrased in its own words still grades as a
 * hit. `anyOf` groups model synonyms; the load-bearing tokens are the specific
 * numbers / names.
 */

/** A required answer component: satisfied when any synonym fragment is present. */
export interface ExpectedGroup {
  /** Human label for the component (for the doc / audit). */
  label: string
  /** Case-insensitive substring fragments; any one present satisfies the group. */
  anyOf: string[]
}

/** Lens the fact belongs to — so a set can be checked for category coverage. */
export type MaterialFactLens =
  | 'concentration' // customer / revenue / deposit concentration
  | 'leverage' // debt load / maturity wall / interest burden
  | 'margin-trend' // gross/operating margin reversal
  | 'liquidity' // cash burn / negative operating cash flow
  | 'capital-return' // buyback / dividend draining the balance sheet
  | 'governance' // dual-class / related-party / control item
  | 'off-balance-sheet' // unrealized losses not in earnings/equity
  | 'regulatory' // a specific regulatory / legal / recall exposure

/** One held-out material fact with a checkable expected answer + its provenance. */
export interface MaterialFact {
  /** Stable id, `ticker/fN`. */
  id: string
  /** Which analyst lens this fact exercises. For coverage + the doc. */
  lens: MaterialFactLens
  /**
   * The material fact, in plain words — for the doc/audit. NEVER shown to a loop.
   * This is the thing a thorough analyst would flag and a ticker search misses.
   */
  fact: string
  /**
   * The checkable answer as required keyword GROUPS. The thesis text must contain
   * at least `minGroups` of these groups (default: all). A group is satisfied
   * when ANY of its `anyOf` fragments appears (case-insensitive substring).
   */
  expected: ExpectedGroup[]
  /**
   * Minimum number of `expected` groups the thesis must contain to count the
   * fact SURFACED. Default = all groups (the strict bar). Lowered (and documented
   * inline) only when the fact is genuinely satisfiable by a subset.
   */
  minGroups?: number
  /**
   * PROVENANCE. The primary source URL this fact was read from — an SEC EDGAR
   * 10-K primary document, fetched live during curation.
   */
  sourceUrl: string
  /**
   * The literal value / phrase read out of `sourceUrl` that grounds the fact.
   * This is the "cite the actual filing + the value" requirement — verbatim or
   * near-verbatim from the filing, with the figure.
   */
  evidence: string
}

/** A company + the cutoff a loop researches as-of + its held-out material facts. */
export interface CompanyEvalCase {
  /** Ticker as of the cutoff. */
  ticker: string
  /** Legal name as of the cutoff (what the loop is told to research). */
  company: string
  /** SEC Central Index Key (CIK), zero-stripped — the EDGAR filer id. */
  cik: string
  /**
   * Research-as-of date (ISO). The loop must reason as if it is this date; every
   * `evidence` value was knowable on or before it. >= 18 months before this set
   * was curated, so the outcome is known but is NOT a checklist item.
   */
  cutoff: string
  /** Sector, for coverage / the curation-bias disclosure. */
  sector: string
  /**
   * The known POST-cutoff outcome — recorded for the reader ONLY, never graded.
   * Keeping it out of `facts` is what makes the set hindsight-free.
   */
  knownOutcome: string
  /** The held-out material facts for this company. */
  facts: MaterialFact[]
}

/**
 * The eval set. 5 public companies, 5-8 held-out material facts each, every fact
 * grounded in a primary SEC EDGAR 10-K filed on or before the cutoff.
 *
 * CURATION-BIAS DISCLOSURE (full version in the doc): all five are companies
 * whose buried risks later materialized, because that is where the material-vs-
 * surface distinction is sharpest AND where the figures are easy to verify after
 * the fact. This biases the set toward downside risks (two of the eight lenses,
 * concentration + leverage, dominate) and toward distressed names. A production
 * eval would balance these with companies whose buried facts were POSITIVE
 * drivers and with survivors. This set is honest about that and reports the lens
 * distribution so the bias is measurable, not hidden.
 */
export const investmentThesisSet: CompanyEvalCase[] = [
  {
    ticker: 'SIVB',
    company: 'SVB Financial Group',
    cik: '719739',
    cutoff: '2023-02-24',
    sector: 'Banking',
    knownOutcome:
      'Failed in a deposit run and was placed in FDIC receivership on March 10, 2023; the holding company filed Chapter 11 on March 17, 2023.',
    facts: [
      {
        id: 'SIVB/f1',
        lens: 'off-balance-sheet',
        fact: 'Held-to-maturity (HTM) securities carried at $91.3B amortized cost had a fair value of only $76.2B — a ~$15.1B unrealized loss that, because the portfolio is HTM, never touched earnings or equity and sat only in the footnotes.',
        expected: [
          {
            label: 'HTM securities',
            anyOf: ['held-to-maturity', 'held to maturity', 'htm'],
          },
          {
            label: 'large unrealized loss (~$15B) / fair value gap',
            anyOf: [
              '15.1',
              '15.2',
              '$15 billion',
              '15 billion',
              '76,169',
              '76.2 billion',
              '91,321',
              'unrealized loss',
              'below amortized cost',
              'fair value',
            ],
          },
        ],
        minGroups: 2,
        sourceUrl:
          'https://www.sec.gov/Archives/edgar/data/719739/000071973923000021/sivb-20221231.htm',
        evidence:
          'Balance sheet (Dec 31, 2022): "Held-to-maturity securities, at amortized cost ... 91,321" with parenthetical "(fair value of $ 76,169 ...)". The gap = $91,321M - $76,169M = ~$15,152M unrealized loss, disclosed only in the notes.',
      },
      {
        id: 'SIVB/f2',
        lens: 'off-balance-sheet',
        fact: "The HTM unrealized loss (~$15.1B) was roughly equal to the company's entire $16.0B total stockholders' equity — a mark-to-market wipeout hidden by HTM accounting.",
        expected: [
          {
            label: 'loss near/exceeds total equity',
            anyOf: [
              'equity',
              'capital',
              'insolvent',
              'wipe out',
              'exceeds',
              'nearly all',
              'tangible book',
              '16,004',
              '16 billion',
            ],
          },
        ],
        sourceUrl:
          'https://www.sec.gov/Archives/edgar/data/719739/000071973923000021/sivb-20221231.htm',
        evidence:
          '"Total SVBFG stockholders\' equity 16,004" (Dec 31, 2022). The ~$15.15B HTM unrealized loss is ~95% of the $16.0B reported equity.',
      },
      {
        id: 'SIVB/f3',
        lens: 'concentration',
        fact: 'Estimated uninsured deposits in U.S. offices were $151.5B at year-end 2022 — the run-prone funding base; a high share of total deposits exceeded the FDIC limit.',
        expected: [
          {
            label: 'large uninsured deposit base',
            anyOf: [
              'uninsured deposit',
              'above the fdic',
              'exceed the fdic',
              'exceeds the fdic',
              '151.5',
              '$151 billion',
              'fdic insurance limit',
            ],
          },
        ],
        sourceUrl:
          'https://www.sec.gov/Archives/edgar/data/719739/000071973923000021/sivb-20221231.htm',
        evidence:
          '"As of December 31, 2022 ... the amount of estimated uninsured deposits in U.S. offices that exceed the FDIC insurance limit were $151.5 billion".',
      },
      {
        id: 'SIVB/f4',
        lens: 'margin-trend',
        fact: 'Cheap noninterest-bearing demand deposits fell 20 percentage points in one year — to 47% of total deposits from 67% — meaning funding costs were set to rise sharply as clients moved to interest-bearing accounts.',
        expected: [
          {
            label: 'deposit mix shift to costlier funding',
            anyOf: [
              'noninterest-bearing',
              'non-interest-bearing',
              'noninterest bearing',
              'deposit mix',
              'funding cost',
              'cost of deposits',
              'interest-bearing',
              '47 percent',
              '20 percentage',
            ],
          },
        ],
        sourceUrl:
          'https://www.sec.gov/Archives/edgar/data/719739/000071973923000021/sivb-20221231.htm',
        evidence:
          '"Noninterest-bearing demand deposits to total deposits decreased by 20 percentage points to 47 percent as of December 31, 2022, compared to ... 2021."',
      },
      {
        id: 'SIVB/f5',
        lens: 'concentration',
        fact: 'The deposit and loan base was concentrated in a single client type — the "innovation economy" (venture-backed technology and life-science startups) — so a downturn in venture funding would hit deposits and credit simultaneously.',
        expected: [
          {
            label: 'concentration in tech / startups / innovation economy',
            anyOf: [
              'innovation economy',
              'technology',
              'life science',
              'venture',
              'startup',
              'early-stage',
              'concentrat',
              'single industry',
              'sector concentration',
            ],
          },
        ],
        sourceUrl:
          'https://www.sec.gov/Archives/edgar/data/719739/000071973923000021/sivb-20221231.htm',
        evidence:
          'The 10-K repeatedly frames the franchise around clients in "the innovation economy" (technology, life science / healthcare, and the venture firms that back them) — a single-sector deposit + credit concentration.',
      },
      {
        id: 'SIVB/f6',
        lens: 'off-balance-sheet',
        fact: 'Available-for-sale (AFS) securities of $28.6B amortized cost were marked to a $26.1B fair value — a ~$2.5B loss that DID flow through equity (AOCI), the visible tip of a much larger unrealized-loss iceberg dominated by the footnote-only HTM book.',
        expected: [
          {
            label: 'AFS unrealized loss / AOCI',
            anyOf: [
              'available-for-sale',
              'available for sale',
              'afs',
              'aoci',
              'accumulated other comprehensive',
              '28,602',
              '26,069',
              '2.5 billion',
            ],
          },
        ],
        sourceUrl:
          'https://www.sec.gov/Archives/edgar/data/719739/000071973923000021/sivb-20221231.htm',
        evidence:
          '"Available-for-sale securities, at fair value (cost of $ 28,602 ...) 26,069" — a ~$2.5B AFS unrealized loss carried in AOCI, separate from and much smaller than the HTM gap.',
      },
    ],
  },
  {
    ticker: 'BBBY',
    company: 'Bed Bath & Beyond Inc.',
    cik: '886158',
    cutoff: '2022-04-21',
    sector: 'Specialty retail',
    knownOutcome: 'Filed for Chapter 11 bankruptcy on April 23, 2023; shareholders were wiped out.',
    facts: [
      {
        id: 'BBBY/f1',
        lens: 'capital-return',
        fact: 'The company had repurchased ~$11.685B of its own stock since 2004 — including $574.9M in fiscal 2021 alone, "two years ahead of schedule" — draining the balance sheet of a business that was losing money.',
        expected: [
          {
            label: 'massive buyback program',
            anyOf: [
              'repurchas',
              'buyback',
              'buy back',
              'share repurchase',
              '11.685',
              '$11.7 billion',
              '574.9',
              '$575 million',
            ],
          },
        ],
        sourceUrl:
          'https://www.sec.gov/Archives/edgar/data/886158/000088615822000047/bbby-20220226.htm',
        evidence:
          '"Since 2004 through the end of Fiscal 2021, we have repurchased approximately $11.685 billion of our common stock"; FY2021 alone "completed share repurchases of $574.9 million ... two years ahead of schedule."',
      },
      {
        id: 'BBBY/f2',
        lens: 'liquidity',
        fact: 'Operating cash flow collapsed to just $17.9M in FY2021, down from $268.1M and $590.9M in the two prior years — a near-total loss of internally generated cash while it kept buying back stock.',
        expected: [
          {
            label: 'operating cash flow collapse',
            anyOf: [
              'operating cash flow',
              'cash from operations',
              'cash provided by operating',
              'cash flow from operations',
              '17.9',
              '17,854',
              'declining cash flow',
              'cash generation',
            ],
          },
        ],
        sourceUrl:
          'https://www.sec.gov/Archives/edgar/data/886158/000088615822000047/bbby-20220226.htm',
        evidence:
          'Statement of cash flows: "Net cash provided by operating activities 17,854 268,108 590,941" (FY2021 / FY2020 / FY2019, $ thousands).',
      },
      {
        id: 'BBBY/f3',
        lens: 'liquidity',
        fact: "Total shareholders' equity fell ~86% in one year — from $1.277B to $174.1M — as losses plus buybacks ate the equity cushion.",
        expected: [
          {
            label: 'equity erosion',
            anyOf: [
              'shareholders’ equity',
              "shareholders' equity",
              'stockholders equity',
              'book value',
              'equity',
              'net worth',
              '174.1',
              '174,145',
              'eroded',
            ],
          },
        ],
        sourceUrl:
          'https://www.sec.gov/Archives/edgar/data/886158/000088615822000047/bbby-20220226.htm',
        evidence:
          '"Total shareholders\' equity 174,145 1,276,936" (FY2021 vs FY2020, $ thousands) — an ~86% decline in one year.',
      },
      {
        id: 'BBBY/f4',
        lens: 'liquidity',
        fact: 'The company posted a $559.6M net loss in FY2021 — yet spent $574.9M on buybacks the same year, i.e. it returned more cash to shareholders than it had, let alone earned.',
        expected: [
          {
            label: 'net loss FY2021',
            anyOf: [
              'net loss',
              'unprofitable',
              'lost money',
              'losing money',
              '559.6',
              '559,623',
              '$560 million',
            ],
          },
        ],
        sourceUrl:
          'https://www.sec.gov/Archives/edgar/data/886158/000088615822000047/bbby-20220226.htm',
        evidence: '"Net loss $ ( 559,623 )" for fiscal 2021 ($ thousands).',
      },
      {
        id: 'BBBY/f5',
        lens: 'margin-trend',
        fact: 'Merchandise inventories rose to $1.725B even as sales fell — inventory building into a demand decline, a classic markdown-risk and cash-trap signal.',
        expected: [
          {
            label: 'inventory building into falling demand',
            anyOf: [
              'inventor',
              'merchandise inventories',
              'overstock',
              'markdown',
              '1,725',
              '1.7 billion',
              'stockpile',
            ],
          },
        ],
        sourceUrl:
          'https://www.sec.gov/Archives/edgar/data/886158/000088615822000047/bbby-20220226.htm',
        evidence:
          '"Merchandise inventories 1,725,410 1,671,909" ($ thousands) — inventory grew year over year while comparable sales declined.',
      },
    ],
  },
  {
    ticker: 'CVNA',
    company: 'Carvana Co.',
    cik: '1690820',
    cutoff: '2023-02-23',
    sector: 'Auto e-commerce',
    knownOutcome:
      'The stock fell ~98% from its 2021 peak; the company narrowly avoided bankruptcy via a 2023 debt-exchange that cut and extended its obligations.',
    facts: [
      {
        id: 'CVNA/f1',
        lens: 'leverage',
        fact: 'Total debt had grown to $8.39B by year-end 2022 (from $5.45B) — a debt load far larger than the equity base, built up funding growth and the ADESA deal.',
        expected: [
          {
            label: 'large/growing debt load',
            anyOf: [
              'total debt',
              'long-term debt',
              'leverage',
              'highly leveraged',
              'debt load',
              '8,391',
              '8.4 billion',
              '$8.4 billion',
            ],
          },
        ],
        sourceUrl:
          'https://www.sec.gov/Archives/edgar/data/1690820/000169082023000052/cvna-20221231.htm',
        evidence: '"Total debt 8,391 5,447" (Dec 31, 2022 vs 2021, $ millions).',
      },
      {
        id: 'CVNA/f2',
        lens: 'leverage',
        fact: 'Interest expense nearly tripled to $486M in 2022 (from $176M) — debt-service was consuming cash a still-unprofitable company did not have.',
        expected: [
          {
            label: 'rising interest burden',
            anyOf: [
              'interest expense',
              'interest cost',
              'debt service',
              'cost of debt',
              '486',
              'interest burden',
            ],
          },
        ],
        sourceUrl:
          'https://www.sec.gov/Archives/edgar/data/1690820/000169082023000052/cvna-20221231.htm',
        evidence: '"Interest expense 486 176" (FY2022 vs FY2021, $ millions).',
      },
      {
        id: 'CVNA/f3',
        lens: 'leverage',
        fact: "In May 2022 Carvana bought ADESA's U.S. physical auction business for ~$2.2B in cash — a debt-funded acquisition that stretched the balance sheet right as used-car demand turned.",
        expected: [
          {
            label: 'ADESA acquisition ~$2.2B',
            anyOf: ['adesa', '2.2 billion', '$2.2 billion', 'physical auction', 'acquisition'],
          },
        ],
        sourceUrl:
          'https://www.sec.gov/Archives/edgar/data/1690820/000169082023000052/cvna-20221231.htm',
        evidence:
          '"physical auction business of ADESA US Auction, LLC for approximately $2.2 billion in cash (the \'ADESA Acquisition\')", closed 2022-05-09.',
      },
      {
        id: 'CVNA/f4',
        lens: 'governance',
        fact: 'Carvana leases hubs and properties from DriveTime — a company controlled by founder/CEO Ernest Garcia III and his father Ernest Garcia II — a recurring related-party arrangement with the controlling family.',
        expected: [
          {
            label: 'related-party with founder family / DriveTime',
            anyOf: [
              'related party',
              'related-party',
              'drivetime',
              'garcia',
              'controlled by',
              'affiliate of',
              'conflict of interest',
            ],
          },
        ],
        sourceUrl:
          'https://www.sec.gov/Archives/edgar/data/1690820/000169082023000052/cvna-20221231.htm',
        evidence:
          'Related Party Transactions note: lease agreements with "DriveTime Automotive Group", a related party "due to Ernest Garcia II, Ernest Garcia III, and entities controlled by one or both of them".',
      },
      {
        id: 'CVNA/f5',
        lens: 'liquidity',
        fact: 'The 2022 net loss was $2.894B — a loss far wider than prior years, showing the unit economics had not turned even at scale.',
        expected: [
          {
            label: 'large net loss FY2022',
            anyOf: [
              'net loss',
              'unprofitable',
              'losing money',
              'cash burn',
              '2,894',
              '2.9 billion',
              '$2.9 billion',
            ],
          },
        ],
        sourceUrl:
          'https://www.sec.gov/Archives/edgar/data/1690820/000169082023000052/cvna-20221231.htm',
        evidence: '"Net loss $ (2,894 ..." for fiscal 2022 ($ millions).',
      },
    ],
  },
  {
    ticker: 'PTON',
    company: 'Peloton Interactive, Inc.',
    cik: '1639825',
    cutoff: '2022-09-07',
    sector: 'Consumer fitness hardware',
    knownOutcome:
      'The stock fell ~95% from its 2021 peak; the founder-CEO departed, the company underwent mass layoffs and a multi-year turnaround through fiscal 2024.',
    facts: [
      {
        id: 'PTON/f1',
        lens: 'margin-trend',
        fact: 'Connected Fitness (hardware) gross margin turned NEGATIVE — to (11)% in FY2022 — meaning Peloton lost money on every bike/tread it sold before any operating cost; revenue growth was masking a broken unit economics.',
        expected: [
          {
            label: 'negative / collapsing hardware gross margin',
            anyOf: [
              'gross margin',
              'negative margin',
              'gross profit',
              'margin compression',
              'losing money on each',
              'below cost',
              '(11)',
              '-11',
              'negative gross',
            ],
          },
        ],
        sourceUrl:
          'https://www.sec.gov/Archives/edgar/data/1639825/000163982522000117/pton-20220630.htm',
        evidence:
          'MD&A "Gross Profit, and Gross Margin" table: Connected Fitness "Gross Margin decreased to (11)" percent in fiscal 2022 — a negative hardware gross margin.',
      },
      {
        id: 'PTON/f2',
        lens: 'liquidity',
        fact: 'Inventories climbed to $1.105B as pandemic demand normalized — a glut of unsold equipment that tied up cash and risked markdowns.',
        expected: [
          {
            label: 'inventory glut',
            anyOf: [
              'inventor',
              'overstock',
              'excess inventory',
              'glut',
              'markdown',
              'unsold',
              '1,104',
              '1.1 billion',
            ],
          },
        ],
        sourceUrl:
          'https://www.sec.gov/Archives/edgar/data/1639825/000163982522000117/pton-20220630.htm',
        evidence: '"Inventories, net 1,104.5 937" (FY2022 vs FY2021, $ millions).',
      },
      {
        id: 'PTON/f3',
        lens: 'governance',
        fact: "A dual-class structure gives Class B holders 20 votes per share vs 1 for Class A — concentrating control with insiders/founders and limiting public shareholders' say.",
        expected: [
          {
            label: 'dual-class super-voting control',
            anyOf: [
              'dual-class',
              'dual class',
              'class b',
              '20 votes',
              'super-voting',
              'supervoting',
              'voting control',
              'multiple votes per share',
            ],
          },
        ],
        sourceUrl:
          'https://www.sec.gov/Archives/edgar/data/1639825/000163982522000117/pton-20220630.htm',
        evidence:
          '"Class B common stock has 20 votes per share and our Class A common stock has one vote per share."',
      },
      {
        id: 'PTON/f4',
        lens: 'liquidity',
        fact: 'Peloton reported a $2.827B net loss in FY2022 — an order-of-magnitude wider loss than the prior year, signaling the demand normalization had broken the model, not just dented it.',
        expected: [
          {
            label: 'large net loss FY2022',
            anyOf: [
              'net loss',
              'unprofitable',
              'losing money',
              'cash burn',
              '2,827',
              '2.8 billion',
              '$2.8 billion',
            ],
          },
        ],
        sourceUrl:
          'https://www.sec.gov/Archives/edgar/data/1639825/000163982522000117/pton-20220630.htm',
        evidence: '"Net loss $ (2,827 ..." for fiscal 2022 ($ millions).',
      },
      {
        id: 'PTON/f5',
        lens: 'regulatory',
        fact: 'Peloton was running a CPSC recall of its Tread+ treadmill (tied to injuries and a child death) — an open product-safety and legal exposure beyond the demand story.',
        expected: [
          {
            label: 'Tread+ / CPSC recall exposure',
            anyOf: [
              'recall',
              'cpsc',
              'consumer product safety',
              'tread+',
              'tread plus',
              'product safety',
              'injuries',
              'safety',
            ],
          },
        ],
        sourceUrl:
          'https://www.sec.gov/Archives/edgar/data/1639825/000163982522000117/pton-20220630.htm',
        evidence:
          '"recall on Tread+, which we are conducting in collaboration with the Consumer Product Safety Commission (\'CPSC\')"; the Tread product recalls "in the fourth quarter of fiscal 2021 continued to impact" results.',
      },
      {
        id: 'PTON/f6',
        lens: 'leverage',
        fact: 'Peloton was locked into ~$334M of manufacturing purchase commitments even as demand fell — contractual inventory it had to take on regardless of whether it could sell it.',
        expected: [
          {
            label: 'locked-in purchase commitments',
            anyOf: [
              'purchase commitment',
              'purchase obligation',
              'minimum purchase',
              'take-or-pay',
              'committed to purchase',
              '334',
              'manufacturing commitment',
            ],
          },
        ],
        sourceUrl:
          'https://www.sec.gov/Archives/edgar/data/1639825/000163982522000117/pton-20220630.htm',
        evidence:
          '"purchase commitments related to the manufacture of Peloton products were estimated to be approximately $334" million.',
      },
    ],
  },
  {
    ticker: 'SI',
    company: 'Silvergate Capital Corporation',
    cik: '1312109',
    cutoff: '2022-02-28',
    sector: 'Banking (digital-asset)',
    knownOutcome:
      'After the FTX collapse triggered a deposit run, Silvergate announced a voluntary wind-down of Silvergate Bank and liquidation in March 2023.',
    facts: [
      {
        id: 'SI/f1',
        lens: 'concentration',
        fact: 'About 99.5% of total deposits were noninterest-bearing — essentially all funding was non-term money that could leave on demand, an extreme run-risk masked by very low funding cost.',
        expected: [
          {
            label: 'almost all deposits noninterest-bearing / on-demand',
            anyOf: [
              'noninterest bearing',
              'noninterest-bearing',
              'non-interest-bearing',
              'demand deposit',
              'no term',
              'on demand',
              '99.5',
              '99 percent',
              'leave at any time',
            ],
          },
        ],
        sourceUrl:
          'https://www.sec.gov/Archives/edgar/data/1312109/000131210922000051/si-20211231.htm',
        evidence:
          '"noninterest bearing deposits as a percentage of total deposits was 99.5% as of December 31, 2021."',
      },
      {
        id: 'SI/f2',
        lens: 'concentration',
        fact: 'Roughly 58% of deposits came from digital-currency EXCHANGES alone — a handful of correlated crypto counterparties whose own troubles would pull deposits out together.',
        expected: [
          {
            label: 'deposits concentrated in crypto exchanges',
            anyOf: [
              'digital currency exchange',
              'crypto exchange',
              'exchanges represent',
              'counterpart',
              'concentrat',
              '58%',
              '58 percent',
              'approximately 58',
            ],
          },
        ],
        sourceUrl:
          'https://www.sec.gov/Archives/edgar/data/1312109/000131210922000051/si-20211231.htm',
        evidence:
          '"Deposits from digital currency exchanges represent approximately 58%" of deposits.',
      },
      {
        id: 'SI/f3',
        lens: 'concentration',
        fact: 'The entire deposit franchise was tied to a single, volatile industry — digital-currency (crypto) customers — so a crypto downturn was a direct, undiversified funding shock.',
        expected: [
          {
            // The buried, depth signal is the CONCENTRATION framing — that the
            // whole deposit base is one undiversified industry bet — NOT the bare
            // fact that it banks crypto (a one-line ticker summary has that). So
            // bare "crypto" / "digital asset" are excluded; the load-bearing
            // tokens are the concentration / single-industry / undiversified
            // characterization or the filing's own "digital currency customers".
            label: 'single-industry deposit CONCENTRATION (not just "it banks crypto")',
            anyOf: [
              'digital currency customers',
              'single industry',
              'one industry',
              'single volatile industry',
              'sector concentration',
              'undiversified',
              'concentrat',
            ],
          },
        ],
        sourceUrl:
          'https://www.sec.gov/Archives/edgar/data/1312109/000131210922000051/si-20211231.htm',
        evidence:
          'The 10-K\'s strategy and risk factors center the bank on "digital currency customers" and "the concentration of our deposits" in that single industry.',
      },
      {
        id: 'SI/f4',
        lens: 'liquidity',
        fact: 'Total deposits had ballooned to $14.3B (from $10.4B) — fast, hot-money growth from the crypto boom that could reverse just as fast.',
        expected: [
          {
            // The depth signal is the SIZE/character of the deposit base — the
            // specific $14.3B figure or the explicit hot-money / volatile-deposit
            // characterization — NOT bare "total deposits" / "grew rapidly", which
            // any growth-story summary trips. Those generic phrases are excluded.
            label: 'specific hot-money deposit base ($14.3B / volatile)',
            anyOf: [
              'hot money',
              'hot-money',
              'volatile deposit',
              'could reverse',
              '14.3 billion',
              '14,290',
              '$14.3b',
              '$14 billion',
            ],
          },
        ],
        sourceUrl:
          'https://www.sec.gov/Archives/edgar/data/1312109/000131210922000051/si-20211231.htm',
        evidence: '"Total deposits $ 14,290,628" ... prior year "$ 10,411,278" ($ thousands).',
      },
      {
        id: 'SI/f5',
        lens: 'concentration',
        fact: 'The franchise hinged on a single proprietary product — the Silvergate Exchange Network (SEN), a payment network built exclusively for the digital-currency industry — so its competitive moat and its deposit base were the SAME crypto-dependent bet, not two diversified ones.',
        expected: [
          {
            // The depth signal is naming the SPECIFIC proprietary product (the
            // Silvergate Exchange Network / SEN) and that the moat and the deposit
            // base are the same single bet — NOT bare "proprietary" / "payment
            // network", which a generic crypto-bank summary mentions. Those bare
            // terms are excluded; the SEN name or the single-product framing is
            // load-bearing.
            label: 'names the SEN single-product dependence (not generic "payment network")',
            anyOf: [
              'silvergate exchange network',
              'the sen',
              'sen)',
              "sen'",
              'single product',
              'single-product',
              'core product',
              'one product',
              'same bet',
            ],
          },
        ],
        sourceUrl:
          'https://www.sec.gov/Archives/edgar/data/1312109/000131210922000051/si-20211231.htm',
        evidence:
          "\"Silvergate Exchange Network ('SEN'), our proprietary, virtually instantaneous payment network for participants in the digital currency industry\" — the bank's differentiator and its deposit magnet are the same crypto-only product.",
      },
    ],
  },
]

/**
 * Grade ONE material fact against an investment thesis's full text. Returns
 * whether the thesis SURFACED it plus which expected groups were found. The
 * check is a deterministic case-insensitive substring scan — $0, model-free,
 * reproducible — so the eval never leaks into a model the loop could observe.
 */
export function gradeFactAgainstText(
  fact: MaterialFact,
  thesisText: string,
): { surfaced: boolean; groupsFound: number; groupsTotal: number; foundLabels: string[] } {
  const haystack = thesisText.toLowerCase()
  const found = fact.expected.filter((group) =>
    group.anyOf.some((fragment) => haystack.includes(fragment.toLowerCase())),
  )
  const minGroups = fact.minGroups ?? fact.expected.length
  return {
    surfaced: found.length >= minGroups,
    groupsFound: found.length,
    groupsTotal: fact.expected.length,
    foundLabels: found.map((group) => group.label),
  }
}

/** Grade a whole company's thesis text: how many of its held-out facts it surfaces. */
export function gradeCompanyAgainstText(
  company: CompanyEvalCase,
  thesisText: string,
): { surfaced: number; total: number; perFact: ReturnType<typeof gradeFactAgainstText>[] } {
  const perFact = company.facts.map((fact) => gradeFactAgainstText(fact, thesisText))
  return {
    surfaced: perFact.filter((result) => result.surfaced).length,
    total: company.facts.length,
    perFact,
  }
}

/** Total held-out facts across the set (the denominator the doc reports). */
export function totalMaterialFacts(set: CompanyEvalCase[] = investmentThesisSet): number {
  return set.reduce((sum, company) => sum + company.facts.length, 0)
}

/** Count facts per lens across the set — used to report (and bound) curation bias. */
export function lensDistribution(
  set: CompanyEvalCase[] = investmentThesisSet,
): Record<MaterialFactLens, number> {
  const dist = {} as Record<MaterialFactLens, number>
  for (const company of set) {
    for (const fact of company.facts) {
      dist[fact.lens] = (dist[fact.lens] ?? 0) + 1
    }
  }
  return dist
}
