# Does any research topology surface MORE buried material facts than blind collection? A live 3-arm A/B

*Tangle Network · `agent-knowledge`*

## Verdict (BLUF)

We ran three research topologies head-to-head on the same five held-out companies,
at matched compute, and graded each one's knowledge base against a firewalled,
`$0`, model-free checklist of **27 buried material facts** a ticker search misses
(the duration loss, the deposit concentration, the negative unit margin, the
related party, …). The question: does a smarter coordinator — one that gates
sources, or one that drives the research deeper — surface **more** of those buried
facts than a single agent that just collects?

**The research-DRIVING loop surfaced the most facts (16/27, 59%), +5 over blind
collection (11/27, 41%) — but at n=5 companies that lift is NOT statistically
clean: the 95% confidence interval crosses zero.** The verify/dedup loop did
**not** beat collection at all (10/27, 37% — a wash, slightly worse). So the
honest read is: **driving is the only arm that even points the right way, and it
points there suggestively, not significantly.** Consistent with this project's
prior topology nulls, a promising small-n delta is reported as promising-small-n,
not as a win.

| arm | what the coordinator does | material facts | cost (5 cos.) | chats | searches | tokens |
|---|---|---|---|---|---|---|
| **A · collection** | nothing — accepts every source (1 agent collects) | 11/27 (41%) | $0.082 | 10 | 20 | 64,248 |
| **B · verify/dedup** | LLM gates each source for relevance, rejects off-topic | 10/27 (37%) | $0.125 | 56 | 52 | 84,678 |
| **C · driving (deepen)** | extracts claims, demands corroboration, asks deep follow-ups | **16/27 (59%)** | $0.157 | 33 | 28 | 124,387 |

Cost is real provenance, not an estimate: every `$`/call/token is diffed from
`RouterClient.usage()` per company (the router's own `usage` field, priced at
glm-5.2 rates), so "driving cost 1.9× collection" is measured, not modelled.

**The two findings that matter, both verified against the raw run (§3):**

1. **Driving's lift is concentrated, not broad.** It wins big on the two
   distressed banks (SIVB 5 vs 2, BBBY 5 vs 4) and ties-or-loses elsewhere (CVNA
   2 vs 3, PTON 2 vs 2, SI 2 vs 0). Per-company delta vs collection =
   `[+3, +1, −1, 0, +2]`. Mean +1.0 fact/company, **95% CI [−0.20, +2.20]**,
   P(Δ≤0)=0.08 (paired bootstrap, 10k resamples, unit=company). It leans positive;
   it does not clear the bar.
2. **Verify's strictness can BACKFIRE — a real, autopsied effect.** On SIVB and
   BBBY the verifier surfaced **0/6 and 0/5** while spending the *most* searches
   (12 each). We probed why (§3.2): the worker's web search returned third-party
   aggregators (stockanalysis.com, stocktitan.net, last10k.com), not the EDGAR
   primary filing, and the verifier **correctly rejected all of them as non-primary
   / wrong-date** — leaving the KB empty, nothing to grade. Collection and driving
   keep that imperfect-but-real aggregator data and score 4/5 and 5/5 on the same
   company. So a "primary-source-only" gate is a liability exactly when sourcing is
   imperfect: it removes the only evidence the loop had.

## 1. The setup — what's fixed, what varies

For each company the loop is told **only** `{company, ticker, cik, cutoff}` plus a
generic set of analyst-lens readiness specs (balance-sheet risk, concentration,
leverage, margins, liquidity, governance, regulatory — the *lenses* a thorough
analyst checks and where they live, the latest SEC 10-K — **not the answers**). It
researches the company *as of* the cutoff over web + SEC EDGAR (both public),
writes a thesis page, and we grade the resulting KB with `materialFactsSurfaced` —
the firewalled checklist the loop never sees.

The five companies (all distressed / downside-risk names, a documented curation
bias):

| ticker | as-of cutoff | CIK | facts |
|---|---|---|---|
| SIVB (SVB Financial) | 2023-02-24 | 719739 | 6 |
| BBBY (Bed Bath & Beyond) | 2022-04-21 | 886158 | 5 |
| CVNA (Carvana) | 2023-02-23 | 1690820 | 5 |
| PTON (Peloton) | 2022-09-07 | 1639825 | 6 |
| SI (Silvergate) | 2022-02-28 | 1312109 | 5 |

**Compute is matched by construction.** All three arms run the *same* web worker,
the *same* 3-round budget, and the *same* worker config
(`resultsPerQuery: 3, queriesPerGap: 1, maxSourcesPerRound: 6`). The **only**
thing that changes between arms is the driver — the coordinator that sits between
the worker and the knowledge base:

- **A · collection** (`createCollectionResearchDriver`, new in this branch) — an
  inert rubber stamp: accepts every source, gates nothing, researches nothing,
  steers only with the loop's built-in open-gap list. One agent (the worker)
  thinks; the driver adds **zero** router calls. This is the blind-collection floor.
- **B · verify/dedup** (`createVerifyingResearchDriver`) — an LLM relevance gate:
  one chat call per candidate source to accept-or-reject for on-topic relevance and
  near-duplication. The worker ADDS; the driver GATES.
- **C · driving** (`createResearchDrivingDriver`) — extracts each source's claims,
  tracks how many *independent* sources corroborate each, and synthesizes deep
  follow-up sub-questions (comparative / mechanism / gap / contradiction) that it
  folds into the worker's next prompt to push depth and demand corroboration.

So any quality difference is attributable to topology, and the cost difference is
the price each topology pays in extra inference.

## 2. Results — the full per-company matrix

Material facts surfaced (and cost) per company, per arm:

| ticker | A · collection | B · verify | C · driving |
|---|---|---|---|
| SIVB | 2/6 · $0.017 | 0/6 · $0.019 | **5/6 · $0.017** |
| BBBY | 4/5 · $0.014 | 0/5 · $0.026 | **5/5 · $0.027** |
| CVNA | **3/5 · $0.016** | 2/5 · $0.028 | 2/5 · $0.025 |
| PTON | 2/6 · $0.019 | **4/6 · $0.026** | 2/6 · $0.054 |
| SI | 0/5 · $0.016 | **4/5 · $0.027** | 2/5 · $0.033 |
| **total** | **11/27 (41%)** | **10/27 (37%)** | **16/27 (59%)** |
| **cost** | **$0.082** | **$0.125** | **$0.157** |

No arm dominates company-by-company. Driving owns the two banks; verify owns PTON
and SI; collection owns CVNA. That spread is the whole story at n=5: the topology
that wins depends heavily on which pages the web returned for that company that
minute.

### Significance (paired bootstrap, unit = company, 10k resamples)

| comparison | total facts | per-company Δ | mean Δ/co. | 95% CI | P(Δ≤0) |
|---|---|---|---|---|---|
| driving − collection | 16 vs 11 (+19pp) | `[+3,+1,−1,0,+2]` | +1.0 | **[−0.20, +2.20]** | 0.08 |
| verify − collection | 10 vs 11 (−4pp) | `[−2,−4,−1,+2,+4]` | −0.2 | [−2.60, +2.40] | 0.60 |
| driving − verify | 16 vs 10 (+22pp) | `[+5,+5,0,−2,−2]` | +1.2 | [−1.60, +4.00] | 0.23 |

Every interval crosses zero. **Driving vs collection is the closest to clean
(P=0.08)** but does not pass at the project's significance bar. Verify vs
collection is a coin flip. This is the project's well-documented small-n mirage:
exciting deltas born at n=5 do not survive a paired bootstrap.

## 3. Autopsy — the two things worth understanding

### 3.1 Why driving wins where it wins

Driving's mechanism is multi-round: extract claims from round 1, then steer the
worker in round 2–3 to corroborate the weak ones and chase the deep questions. It
helps most where the **first** fetch lands real filing data the driver can build
on — the two banks, where SEC bank-call-report / 10-K data is dense and reachable.
SIVB jumps from 2 buried facts (collection) to 5 (driving): the duration loss, the
deposit concentration, the AFS/AOCI mark all surface once the driver demands the
balance-sheet detail a second time. Where the first fetch is thin (PTON, SI), the
driver has little to deepen and the extra rounds mostly burn searches (PTON
driving: 12 searches, 2 facts, the most expensive cell at $0.054).

### 3.2 Why verify scored ZERO on SIVB and BBBY (a real effect, not a bug)

This was the surprising result, so we probed it directly (a 2-round live replay of
the BBBY verify arm with round-level accept/reject logging). The verifier rejected
**every** source both rounds, accepting nothing, writing no KB pages:

```
ROUND 1: accepted=0 rejected=3 writtenPages=0
  REJECT stockanalysis.com/stocks/bbby/financials  :: Third-party aggregator, not the SEC EDGAR 10-K primary source…
  REJECT stocktitan.net/financials/BBBY            :: Third-party financial data aggregator, not the authoritative SEC 10-K…
  REJECT last10k.com/sec-filings/bbby              :: Third-party aggregator showing a 2025/2026 10-K, well after the 2022-04-21 research date…
ROUND 2: accepted=0 rejected=2 writtenPages=0
```

The verifier was **correct on the merits** — those are aggregators, not the
primary filing, and last10k showed a post-cutoff filing. But the worker never
surfaced the EDGAR primary for BBBY, so a strict primary-only gate left the KB
**empty**. Collection accepts the same aggregator pages and scores 4/5 on BBBY;
driving accepts them and scores 5/5. **The gate's strictness is a liability when
the worker's sourcing is imperfect:** it throws away the only evidence the loop
had. This is a genuine topology trade-off worth naming, not a harness break — the
verify arm surfaced facts fine on CVNA (2), PTON (4), SI (4), so the harness works.

### 3.3 The empty-thesis caveat (honest)

Some runs show `thesis=0ch` (empty synthesis) yet still score facts. That is
expected: `materialFactsSurfaced` grades the **whole KB** (the worker's fetched
`knowledge/*.md` pages), not only the final thesis page. glm-5.2 occasionally
spends its entire output budget on hidden reasoning and returns empty visible
content on the synthesis call — a known reasoning-model behavior we floor at 1200
tokens but can't fully eliminate. The score still reflects what the loop fetched,
so an empty thesis does not invalidate a run; it just means the synthesis prose was
lost while the curated evidence was not.

## 4. What this does and does not establish

- **Does**: at matched compute on this 5-company held-out set, the
  research-driving topology surfaced the most buried material facts (16/27 vs 11/27
  for blind collection), a +5-fact / +18pp lift, for ~1.9× the cost. The
  verify/dedup topology did not beat collection, and on two companies its strict
  primary-source gate actively zeroed the KB. The cost of every arm is real,
  per-call provenance from `RouterClient.usage()`.
- **Does NOT**: prove driving *significantly* beats collection. At n=5 the
  paired-bootstrap CI for the driving lift crosses zero (P(Δ≤0)=0.08). The verdict
  is "promising, under-powered," consistent with the project's prior topology
  nulls, not "driving wins." Nor does the 27-fact checklist generalize beyond its
  documented curation bias (downside-risk, distressed-name skew — see
  `docs/eval/investment-material-facts.md`).
- **The next rung** (to turn the P=0.08 lean into a verdict): expand the held-out
  set well past 5 companies (the checklist is the constraint, not the harness),
  and re-run at n≥24 so a +1-fact/company effect can clear a paired bootstrap. The
  driving arm is the one worth funding that test on; verify is not.

## 5. Reproduce

```bash
# The calibration gate that must pass FIRST ($0, offline) — the metric is valid.
pnpm test investment-calibration

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
(default 3 — driving needs > 1). The smoke (one cheap glm-5.2 call) runs once
before any arm, so a bad key fails fast, before the burn.

---

*Run provenance: 5 companies × 3 arms × 3 rounds = 15 live company-runs, glm-5.2
over the Tangle router, ~37.5 min wall, $0.36 total. Grader: `materialFactsSurfaced`
(firewalled, $0, model-free substring check). Numbers transcribed verbatim from the
test's `[IT 3-ARM TOTALS]` console output; statistics from a paired bootstrap over
the per-company fact deltas.*
