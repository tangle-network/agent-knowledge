# Investment-research depth eval and three-arm comparison

*Tangle Network · `agent-knowledge`*

## Verdict

We moved the research eval off ML-paper retrieval, where a **single** web search
already returns the answer, so the only thing the metric could measure was
*collection*, onto **investment research**, where the material facts are buried in
the footnotes of an SEC filing and genuinely require *investigation* to surface. On
this harder domain we (1) **calibrated** a `$0`, model-free metric and proved it
discriminates research depth, a shallow ticker summary scores **1/27 (4%)**, a
deep filings-grounded thesis scores **27/27 (100%)**, a **+96-point** gap, and then
(2) ran **three research topologies head-to-head** on the same five held-out
companies at matched compute, grading each one's knowledge base against a firewalled
checklist of **27 buried material facts** a ticker search misses.

**A/B result: the research-driving loop surfaced the most buried facts
(16/27, 59%), +5 over blind collection (11/27, 41%), but at n=5 companies that lift
is NOT statistically clean: the 95% confidence interval crosses zero (P(Δ≤0)=0.08).**
The verify/dedup loop did **not** beat collection at all (10/27, 37%, a wash,
slightly worse). No approach *significantly* beats collection here.
**driving is the only arm that even points the right way, and it points there
suggestively, not significantly.** What the reframe *did* buy is a domain and a meter
where the question is finally well-posed: the metric is no longer measuring whether a
single search ran, but whether investigation reached the buried fact.

| arm | what the coordinator does | material facts | cost (5 cos.) | chats | searches | tokens |
|---|---|---|---|---|---|---|
| **A · collection** | nothing; accepts every source (1 agent collects) | 11/27 (41%) | $0.082 | 10 | 20 | 64,248 |
| **B · verify/dedup** | LLM gates each source for relevance, rejects off-topic | 10/27 (37%) | $0.125 | 56 | 52 | 84,678 |
| **C · driving (deepen)** | extracts claims, demands corroboration, asks deep follow-ups | **16/27 (59%)** | $0.157 | 33 | 28 | 124,387 |

Cost is real provenance, not an estimate: every `$`/call/token is diffed from
`RouterClient.usage()` per company (the router's own `usage` field, priced at
glm-5.2 rates), so "driving cost 1.9× collection" is measured, not modelled.

## 1. The domain reframe: why we left ML-paper retrieval

The companion paper's depth eval (`docs/two-agent-research-ab.md` §9) measures a
research loop on **20 deep questions across 5 ML topics**. That method is sound:
its grader scores 0/20 on a one-line topic definition and 20/20 on a mechanism-rich
paragraph, so it *can* tell depth from surface. But the topology A/B on top of it
came back a clean null (driving 16/20 @ budget 4, 13/20 @ budget 6, the winner
*flips with the compute budget*, and the within-arm swing is as large as the
between-arm gap). The autopsy named the cause: **on an ML topic a single good search
already collects the answer.** Every arm finished in one effective round because the
generic "one source closes the gap" readiness was met by the *first* fetch, so the
driving driver, whose entire mechanism is steering a *second* round, never got to
act. When one search suffices, there is no investigation for a smarter coordinator to
do, and the metric can only reward collection. That is the failure-mode-in-spirit the
ML exam couldn't escape: not that the grader was loose, but that the *domain* was too
easy for topology to matter.

So we changed the domain to one where a single search **provably cannot** suffice.
**Investment research**: give a loop a company + ticker + an as-of cutoff date and ask
for a thesis; grade it on the buried, material, non-obvious drivers a thorough analyst
flags and a ticker search misses. The decisive facts here live in 10-K footnotes, an
HTM securities mark roughly equal to a bank's entire equity (SIVB), a deposit base
that is 97% uninsured, a negative per-unit gross margin, a related-party lease. A web
search for the company name returns "profitable regional bank" or "high-growth auto
e-commerce"; the filing shows the mark-to-market hole the size of capital. **The
answer is not collectable in one fetch, it has to be investigated for.** That is the
property the ML domain lacked, and it is what makes a topology A/B finally meaningful:
if a smarter coordinator can ever beat blind collection, a domain where the answer is
buried is where it has the room to.

The held-out set is **5 companies, 27 material facts**, every fact read live out of
the primary SEC EDGAR 10-K during curation, every dollar figure quoted from the
de-tagged filing text, every value knowable *at the cutoff* (the eventual collapse is
recorded for the reader only and is **never graded**). The companies skew distressed /
downside-risk, a documented curation bias, not a hidden one (full provenance, the
drop log, and the per-fact keyword groups: `docs/eval/investment-material-facts.md`):

| ticker | company | as-of cutoff | CIK | facts |
|---|---|---|---|---|
| SIVB | SVB Financial Group | 2023-02-24 | 719739 | 6 |
| BBBY | Bed Bath & Beyond | 2022-04-21 | 886158 | 5 |
| CVNA | Carvana | 2023-02-23 | 1690820 | 5 |
| PTON | Peloton | 2022-09-07 | 1639825 | 6 |
| SI | Silvergate | 2022-02-28 | 1312109 | 5 |

## 2. Calibration: does the metric discriminate depth? (the gate the ML exam passed only weakly)

A topology A/B is meaningless unless the metric grading it can tell a *deep* thesis
from a *shallow* one. If it can't, it is measuring word-collection, the exact failure
the reframe set out to escape, and any A/B on top of it is noise. So **before** the
A/B, we ran a calibration gate (`$0`, offline, the binding result):

For each of the 5 companies we hand-wrote two theses and scored each with the metric's
pure core (`materialFactsSurfacedInText`):

- **shallow**: a one-paragraph ticker summary: what the company does, a vibe on the
  stock, generic macro/competition risk. The kind a single name-search returns. Names
  none of the buried, filing-level facts.
- **deep**: a filings-grounded analyst memo naming the buried drivers (the duration
  loss, the buyback drain, the negative unit margin, the deposit concentration, the
  related party) in independent prose, with the real numbers.

The grader is the same `$0`, model-free, case-insensitive substring check the held-out
checklist ships (`gradeFactAgainstText`); the checklist is firewalled, read only by
the metric, never shown to a loop.

| ticker | shallow | deep | gap |
|---|---|---|---|
| SIVB | 1/6 (17%) | 6/6 (100%) | +83pp |
| BBBY | 0/5 (0%) | 5/5 (100%) | +100pp |
| CVNA | 0/5 (0%) | 5/5 (100%) | +100pp |
| PTON | 0/6 (0%) | 6/6 (100%) | +100pp |
| SI | 0/5 (0%) | 5/5 (100%) | +100pp |
| **total** | **1/27 (4%)** | **27/27 (100%)** | **+96pp** |

**Calibration result:** the metric separates a shallow ticker-summary from a deep,
filings-grounded thesis, a +96-point aggregate gap, every company clearing the bars
(shallow `< 30%`, deep `> 70%`) with wide margin. Two guards make the gap real and not
a teaching-to-the-test artifact:

- **Anti-circularity.** The gate asserts **no deep thesis verbatim-embeds any
  checklist `evidence` string**, the deep theses state the same publicly-documented
  facts in independent analyst prose. A high deep score is the meter catching real,
  independently-phrased depth, not an answer-key echo.
- **The one shallow hit.** The single shallow surface (SIVB 1/6) is SIVB/f5:
  the innovation-economy / venture-client concentration, which fires on "technology"
  / "venture" in the SVB summary. That genuinely *is* the least-buried of SVB's six
  facts (a ticker search does return "SVB banks tech and venture startups"). We kept it
  as a 4% leak rather than tighten the group, because it reflects one
  near-surface fact while the five truly buried ones (the ~$15B HTM loss, the
  equity-sized mark, the $151.5B uninsured base, the 20-point deposit-mix shift, the
  AFS/AOCI loss) stay unsurfaced. The firewall holds (17% << 30%).

Calibration also did its job as more than a rubber stamp: the first pass had the
**Silvergate shallow thesis scoring 3/5 (60%)**, blowing the bar, because three fact
groups accepted bare crypto-bank vocabulary (`crypto`, `grew rapidly`, `proprietary` /
`payment network`) that any one-line summary trips. We tightened those three to require
the *buried* signal, the deposit-**concentration** framing, the specific **$14.3B**
figure, the **SEN** (Silvergate Exchange Network) name, and dropped the generic vocab.
The deep thesis still hits all three; the shallow one no longer does. The metric found
a way it could be fooled and we closed it before any A/B depended on it.

**This is the gate the ML exam passed only in spirit.** The ML grader discriminated
0/20 vs 20/20 too, but on a domain where the deep answer was *collectable* in one
search, so the discrimination measured grammar, not investigation. Here the +96-point
gap is over facts that are *buried by construction*, so a high score is reachable only
by reaching into the filing. Same shape of result, materially harder domain.

## 3. The 3-arm A/B: what each topology surfaced, head-to-head

For each company the loop is told **only** `{company, ticker, cik, cutoff}` plus a
generic set of analyst-lens readiness specs (balance-sheet risk, concentration,
leverage, margins, liquidity, governance, regulatory, the *lenses* and where they
live, the latest SEC 10-K, **not the answers**). It researches the company *as of* the
cutoff over web + SEC EDGAR (both public), writes a thesis, and we grade the resulting
KB with `materialFactsSurfaced`, the firewalled checklist the loop never sees.

**Compute is matched by construction.** All three arms run the *same* web worker, the
*same* 3-round budget, the *same* worker config (`resultsPerQuery: 3, queriesPerGap: 1,
maxSourcesPerRound: 6`). The **only** thing that varies is the driver, the coordinator
between the worker and the knowledge base:

- **A · collection** (`createCollectionResearchDriver`), an inert rubber stamp:
  accepts every source, gates nothing, steers only with the loop's built-in open-gap
  list. The driver adds **zero** router calls. This is the blind-collection floor.
- **B · verify/dedup** (`createVerifyingResearchDriver`), an LLM relevance gate: one
  chat call per candidate source to accept-or-reject for on-topic relevance and
  near-duplication. The worker ADDS; the driver GATES.
- **C · driving** (`createResearchDrivingDriver`), extracts each source's claims,
  tracks how many *independent* sources corroborate each, and synthesizes deep
  follow-up sub-questions (comparative / mechanism / gap / contradiction) it folds into
  the worker's next prompt to push depth and demand corroboration.

So any quality difference is attributable to topology, and any cost difference is the
price each topology pays in extra inference.

### Per-company matrix

| ticker | A · collection | B · verify | C · driving |
|---|---|---|---|
| SIVB | 2/6 · $0.017 | 0/6 · $0.019 | **5/6 · $0.017** |
| BBBY | 4/5 · $0.014 | 0/5 · $0.026 | **5/5 · $0.027** |
| CVNA | **3/5 · $0.016** | 2/5 · $0.028 | 2/5 · $0.025 |
| PTON | 2/6 · $0.019 | **4/6 · $0.026** | 2/6 · $0.054 |
| SI | 0/5 · $0.016 | **4/5 · $0.027** | 2/5 · $0.033 |
| **total** | **11/27 (41%)** | **10/27 (37%)** | **16/27 (59%)** |
| **cost** | **$0.082** | **$0.125** | **$0.157** |

No arm dominates company-by-company. Driving owns the two banks; verify owns PTON and
SI; collection owns CVNA. That spread is the whole story at n=5: the topology that wins
depends heavily on which pages the web returned for that company that minute.

### Significance (paired bootstrap, unit = company, 10k resamples)

| comparison | total facts | per-company Δ | mean Δ/co. | 95% CI | P(Δ≤0) |
|---|---|---|---|---|---|
| driving − collection | 16 vs 11 (+19pp) | `[+3,+1,−1,0,+2]` | +1.0 | **[−0.20, +2.20]** | 0.08 |
| verify − collection | 10 vs 11 (−4pp) | `[−2,−4,−1,+2,+4]` | −0.2 | [−2.60, +2.40] | 0.60 |
| driving − verify | 16 vs 10 (+22pp) | `[+5,+5,0,−2,−2]` | +1.2 | [−1.60, +4.00] | 0.23 |

Every interval crosses zero. **Driving vs collection is the closest to clean
(P=0.08)** but does not pass the project's significance bar. Verify vs collection is a
coin flip. This is the project's well-documented small-n mirage: exciting deltas born
at n=5 do not survive a paired bootstrap.

## 4. Autopsy: the two things worth understanding

### 4.1 Why driving wins where it wins

Driving's mechanism is multi-round: extract claims from round 1, then steer the worker
in rounds 2–3 to corroborate the weak ones and chase the deep questions. It helps most
where the **first** fetch lands real filing data the driver can build on, the two
banks, where SEC bank-call-report / 10-K data is dense and reachable. SIVB jumps from 2
buried facts (collection) to 5 (driving): the duration loss, the deposit concentration,
the AFS/AOCI mark all surface once the driver demands the balance-sheet detail a second
time. Where the first fetch is thin (PTON, SI), the driver has little to deepen and the
extra rounds mostly burn searches (PTON driving: 12 searches, 2 facts, the most
expensive cell at $0.054). This is the reframe paying off mechanically: it is exactly
the *second-round investigation* the ML domain never reached, and it is the only thing
that moved the number.

### 4.2 Why verify scored ZERO on SIVB and BBBY (a real effect, not a bug)

This was the surprising result, so we probed it directly (a 2-round live replay of the
BBBY verify arm with round-level accept/reject logging). The verifier rejected **every**
source both rounds, accepting nothing, writing no KB pages:

```
ROUND 1: accepted=0 rejected=3 writtenPages=0
  REJECT stockanalysis.com/stocks/bbby/financials  :: Third-party aggregator, not the SEC EDGAR 10-K primary source…
  REJECT stocktitan.net/financials/BBBY            :: Third-party financial data aggregator, not the authoritative SEC 10-K…
  REJECT last10k.com/sec-filings/bbby              :: Third-party aggregator showing a 2025/2026 10-K, well after the 2022-04-21 research date…
ROUND 2: accepted=0 rejected=2 writtenPages=0
```

The verifier was **correct on the merits**, those are aggregators, not the primary
filing, and last10k showed a post-cutoff filing. But the worker never surfaced the
EDGAR primary for BBBY, so a strict primary-only gate left the KB **empty**. Collection
accepts the same aggregator pages and scores 4/5 on BBBY; driving accepts them and
scores 5/5. **The gate's strictness is a liability when the worker's sourcing is
imperfect:** it throws away the only evidence the loop had. This is a real coordination
trade-off. The verify arm still surfaced facts on CVNA (2), PTON (4), and SI (4),
which rules out a general execution failure.

### 4.3 The empty-thesis caveat

Some runs show `thesis=0ch` (empty synthesis) yet still score facts. That is expected:
`materialFactsSurfaced` grades the **whole KB**, including the worker's fetched
`knowledge/*.md` pages and the final thesis page. glm-5.2 occasionally spends its entire output
budget on hidden reasoning and returns empty visible content on the synthesis call, a
known reasoning-model behavior we floor at 1200 tokens but can't fully eliminate. The
score still reflects what the loop fetched, so an empty thesis does not invalidate a
run; it just means the synthesis prose was lost while the curated evidence was not.

## 5. What this does and does not establish

- **Does**: the metric *discriminates depth on a domain where one search is not
  enough* (calibration: 1/27 shallow vs 27/27 deep, +96pp), so the topology A/B on top
  of it is finally well-posed, unlike the ML retrieval exam where one search already
  collected the answer. At matched compute on the 5-company held-out set, the
  research-driving topology surfaced the most buried material facts (16/27 vs 11/27 for
  blind collection), a +5-fact / +18pp lift, for ~1.9× the cost. Every dollar is real,
  per-call provenance from `RouterClient.usage()`.
- **Does NOT**: prove driving *significantly* beats collection. At n=5 the
  paired-bootstrap CI for the driving lift crosses zero (P(Δ≤0)=0.08). The verdict is
  "promising, under-powered," consistent with the project's prior topology nulls (the
  ML exam, depth-vs-breadth, native-skills), not "driving wins." No topology cleared the
  bar. Nor does the 27-fact checklist generalize beyond its documented curation bias
  (downside-risk, distressed-name skew).
- **The next rung** (to turn the P=0.08 lean into a verdict): expand the held-out set
  well past 5 companies (the checklist is the constraint, not the harness) and re-run at
  n≥24 so a +1-fact/company effect can clear a paired bootstrap. The driving arm is the
  one worth funding that test on; verify is not.

## 6. Reproduce

```bash
# The calibration gate that must pass FIRST ($0, offline): the metric is valid.
pnpm test investment-calibration

# The offline task wiring ($0): proves page → index → grade end-to-end.
pnpm test investment-thesis-task

# The full live 3-arm A/B (costs ~$0.36 total at 5 companies × 3 arms × 3 rounds).
# Needs a router key that can reach glm-5.2.
export TANGLE_API_KEY=<router key>
AGENT_KNOWLEDGE_LIVE=1 IT_LIVE_ROUNDS=3 \
  npx vitest run tests/eval/investment-thesis-ab.test.ts --reporter=basic

# A single arm / single company (cheap smoke before the full burn):
AGENT_KNOWLEDGE_LIVE=1 IT_LIVE_TICKERS=CVNA IT_LIVE_ARMS=collection \
  npx vitest run tests/eval/investment-thesis-ab.test.ts --reporter=basic
```

`IT_LIVE_ARMS` (`|`-separated subset of `collection|verify|driving`) and
`IT_LIVE_TICKERS` scope the run; `IT_LIVE_ROUNDS` sets the per-arm round budget
(default 3, driving needs > 1). The smoke (one cheap glm-5.2 call) runs once before any
arm, so a bad key fails fast, before the burn.

---

*Run provenance. Calibration: `$0`, offline, reproducible, numbers from
`tests/eval/investment-calibration.test.ts` (shallow `< 30%`, deep `> 70%`,
gap `> 40pp` per company and aggregate; all pass). A/B: 5 companies × 3 arms × 3 rounds
= 15 live company-runs, glm-5.2 over the Tangle router, ~37.5 min wall, $0.36 total;
grader `materialFactsSurfaced` (firewalled, `$0`, model-free substring check); numbers
transcribed verbatim from the test's `[IT 3-ARM TOTALS]` console output and recorded in
commit `338bc54`; statistics from a paired bootstrap over the per-company fact deltas.
Held-out set + per-fact provenance: `docs/eval/investment-material-facts.md`.*
