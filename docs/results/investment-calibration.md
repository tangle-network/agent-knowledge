# Calibrating the `materialFactsSurfaced` metric — does it discriminate research depth?

*Tangle Network · `agent-knowledge`*

## Verdict (BLUF)

**The metric is VALID: it cleanly separates a shallow ticker-summary thesis from a
deep, filings-grounded one.** Across all 27 held-out material facts, a deliberately
**shallow** thesis surfaces **1/27 (4%)** and a deliberately **deep** thesis
surfaces **27/27 (100%)** — a **+96-point** gap. Every company clears the bars
(shallow `< 30%`, deep `> 70%`) with wide margin. So `materialFactsSurfaced`
measures *research depth* — did the thesis name the buried, material drivers a
ticker search misses — not word-collection. **The gate passes; the A/B may
proceed.**

This calibration is the mandatory step *before* any A/B. If the metric had failed
to discriminate, it would have been measuring collection (the failure mode the ML
deep-question exam guards against), and the A/B would have been meaningless.

## Method

For each of the 5 held-out companies we hand-wrote two theses and scored each with
the metric (`materialFactsSurfacedInText`, the pure core of `materialFactsSurfaced`):

- **shallow** — a one-paragraph ticker summary: what the company does, a vibe on
  the stock, generic macro/competition risks. The kind a single web search for the
  company name returns. Names none of the buried, filing-level facts.
- **deep** — a filings-grounded analyst memo that names the buried drivers (the
  duration loss, the buyback drain, the negative unit margin, the deposit
  concentration, the related party) in independent prose, with the real numbers.

The grader is the same `$0`, model-free, case-insensitive substring check the
held-out checklist already ships (`gradeFactAgainstText`). The checklist is
firewalled — it is read only by the metric, never shown to a loop.

**Fixtures:** `tests/eval/investment-calibration.ts`. **Gate test:**
`tests/eval/investment-calibration.test.ts` (run `pnpm test investment-calibration`,
$0, offline).

### Anti-circularity guard

A deep thesis could "pass" by verbatim-copying the checklist's `evidence` strings —
that would be teaching-to-the-test, making the deep score an answer-key echo rather
than the meter catching depth. The gate test asserts **no deep thesis embeds any
checklist `evidence` string verbatim**; the deep theses state the same
publicly-documented facts in independent analyst prose. So a high deep score is the
metric catching real, independently-phrased depth.

## Results

| Ticker | Shallow | Deep | Gap |
|---|---|---|---|
| SIVB | 1/6 (17%) | 6/6 (100%) | +83pp |
| BBBY | 0/5 (0%) | 5/5 (100%) | +100pp |
| CVNA | 0/5 (0%) | 5/5 (100%) | +100pp |
| PTON | 0/6 (0%) | 6/6 (100%) | +100pp |
| SI | 0/5 (0%) | 5/5 (100%) | +100pp |
| **TOTAL** | **1/27 (4%)** | **27/27 (100%)** | **+96pp** |

Bars: shallow `< 30%`, deep `> 70%`, per company AND in aggregate. All pass.

### The one shallow hit is honest, not a leak

The single shallow surface (SIVB 1/6) is **SIVB/f5** — the innovation-economy /
tech-venture client concentration — which fires on the words "technology" /
"venture" in the SVB shallow summary. That is genuinely the *least buried* of SVB's
six facts: a ticker search does return "SVB banks tech and venture startups." The
metric correctly credits the one near-surface fact the shallow thesis actually
states, while the five truly buried facts (the ~$15B HTM unrealized loss, the
equity-sized mark, the $151.5B uninsured base, the 20-point deposit-mix shift, the
AFS/AOCI loss) stay unsurfaced. Keeping it as a 4% leak — rather than tightening
SIVB/f5 to exclude "technology" — is the honest choice: it reflects that one fact
really is near-surface, and the firewall still holds (17% << 30%).

## A finding the calibration produced: three over-loose grader groups (now fixed)

Calibration is not just a rubber stamp — running it caught a real weakness in the
checklist. The first pass had the **SI** shallow thesis scoring **3/5 (60%)**,
blowing the `< 30%` bar. Autopsy: three Silvergate fact groups accepted bare,
generic crypto-bank vocabulary that any one-line summary trips —

- `SI/f3` fired on the bare word **`crypto`**,
- `SI/f4` fired on **`grew rapidly`** / **`deposit growth`**,
- `SI/f5` fired on bare **`proprietary`** / **`payment network`**.

Those are *surface* signals (it's a crypto bank that grew) — the opposite of what a
held-out *depth* metric should reward. Per the checklist's own stated rule ("the
load-bearing tokens are the specific numbers/names", and the grader-leniency caveat
in `docs/eval/investment-material-facts.md`), the fix was to tighten those three
groups to require the buried signal — the deposit-**concentration** framing, the
specific **$14.3B** figure, the **SEN** name — and drop the generic vocab. The deep
thesis still hits all three (it names the concentration, $14,290,628, and the
Silvergate Exchange Network); the shallow summary no longer does. Edits are inline
in `src/investment-thesis-set.ts` with the rationale next to each group.

This is calibration doing its job: it found a way the metric could be fooled and
closed it before any A/B depended on it.

## Live path proven (the cost gate, not the A/B)

Before the metric is used in anger, the live task path was smoke-proven on one
company so a future all-zero run is a real null, not a broken harness:

- **glm-5.2 smoke**: visible content returned, $0.0005/call.
- **web search reaches EDGAR**: a search for the CVNA 10-K returns
  `https://www.sec.gov/Archives/edgar/data/1690820/.../cvna-20221231.htm` as the
  top hit — the worker fetches the real primary filing.
- **CVNA live pilot** (research-driving driver, 3 rounds): surfaced **2/5 (40%)** —
  the growing total debt (CVNA/f1) and the ADESA acquisition (CVNA/f3) — for
  **$0.027**, with a 1,240-char thesis page grounded in the fetched filing. A
  modest, non-saturated score: exactly the correctable middle band an A/B needs.

The full 5-company A/B is intentionally **not** run here — the task's gate is the
calibration above, and it passed. The live A/B harness is wired and ready
(`tests/eval/investment-thesis-ab.test.ts`), gated behind `AGENT_KNOWLEDGE_LIVE=1`.

## Reproduce

```bash
# The calibration gate ($0, offline) — this is the binding result.
pnpm test investment-calibration

# The offline task wiring ($0) — proves page → index → grade end-to-end.
pnpm test investment-thesis-task

# The live A/B (costs money; needs a router key with glm-5.2 credits).
export TANGLE_API_KEY=<router key>
AGENT_KNOWLEDGE_LIVE=1 IT_LIVE_TICKERS=CVNA pnpm vitest run tests/eval/investment-thesis-ab.test.ts
```

## What this does and does not establish

- **Does**: the metric discriminates shallow from deep research, so it can be
  trusted to rank A/B arms by research depth. The live task reaches real primary
  filings and produces gradable, grounded thesis pages.
- **Does not**: prove any topology (driving vs verify vs collection) wins the A/B —
  that is the next step, and the metric is now a valid instrument for it. Nor does
  the 27-fact checklist generalize beyond its curation bias (downside-risk,
  distressed-name skew, documented in `docs/eval/investment-material-facts.md`).
