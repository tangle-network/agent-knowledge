# Autodata live result: the causal challenger widens the gap (reproduced) — but clearing the accept bar is noisy at this n/tier (NOT robust)

Running the agentic data-creation loop (`src/autodata/`) on a real arXiv doc with real two-tier
solvers, to manufacture training examples that separate a strong solver from a weak one (the
discriminative reward of the Autodata / Agentic-Self-Instruct method).

**Honest headline (two independent runs):** the non-extractive causal challenger + the refine fold
**reliably widen the strong/weak gap by ~+0.20 vs plain generation** (reproduced in both runs — the
method's Table-1 *direction* holds). BUT **clearing the hard accept bar** (weak < 0.5 ∧ strong ≥ 0.65
∧ gap ≥ 0.2) is **noisy and marginal**: one run accepted 1–2 of 3, an **independent re-run accepted
0 of 3**. The reason is in the answers — `llama-3.1-8b` on these MoE questions sometimes flails
(0.24) and sometimes answers *competently* (0.75), straddling the 0.5 "weak must struggle" line. So:
**directionally confirmed, not a robust positive at n=3 / this tier.** This is the same small-n
mirage that bit the earlier two-agent A/B (positive at n=1, washes at power) — flagged, not buried.

## The two levers that turned the null into a positive

The earlier null ("a small model performs as well as a frontier one") had TWO compounding causes,
both fixed here:

1. **The question leaked the answer / asked for recall.** The challenger wrote lookup-style questions
   whose answer sat in the provided context, so an 8B read it out as well as a frontier model.
   Fix — the **non-extractive causal challenger**: it must author CAUSAL / COMPARATIVE / MECHANISM /
   THESIS-CONSISTENCY questions whose answer is DERIVED, the context must hold premises but not state
   the conclusion, the solver no longer sees the rubric (the mark scheme), and the judge now sees the
   context and scores a dedicated `reasoning` dimension LOW when the answer merely restates it (the
   paper's negative criterion). On reject, the fold steers per reason ("too easy" → go non-extractive
   and harder; "too hard" → ease; "not discriminative" → sharpen).

2. **The grounding doc was memorized.** The default was "Attention Is All You Need" — the most
   canonical paper in ML, which an 8B has memorized, so even reasoning questions are answerable from
   pretraining and capability cannot separate. Fix — **ground on a doc the weak solver has not
   memorized**: the new default is the Mixtral-of-Experts paper (arXiv 2401.04088, Jan 2024), which
   post-dates `llama-3.1-8b`'s knowledge cutoff, forcing it to reason from the context.

## Setup (all env-overridable)

| role | model | why |
|---|---|---|
| weak solver | `groq/llama-3.1-8b-instant` | small; cutoff predates the 2024 doc → must reason, can't recall |
| strong solver | `gemini-2.5-pro` | frontier reasoner; a real wide capability gap |
| challenger + judge | `deepseek-v4-flash` | capable, fast, reliable, a DIFFERENT family from both solvers (no judge-bias) |
| grounding doc | Mixtral-of-Experts (2401.04088) | non-memorized, reasoning-rich (MoE routing / gating) |

Accept thresholds (the paper's): strong >= 0.65, weak < 0.50, gap >= 0.20. (`glm-5.2`, the brief's
challenger/judge, was returning upstream-capacity 503s during this run; `deepseek-v4-flash` is the
live, neutral substitute. `routerChat` now retries transient 503/429/timeout with bounded backoff.)

## The judge is reliable (checked before trusting any gap)

A controlled probe scored one genuinely-strong vs one genuinely-weak answer to the same question, 3×
each: `deepseek-v4-flash` returned strong `[1.00, 1.00, 1.00]` (mean 1.00) vs weak `[0.23, 0.13,
0.17]` (mean 0.18) — a consistent **0.82** separation, ranking strong above weak every time. So a
measured gap reflects answer quality, not judge noise. (`gemini-2.5-flash` as judge threw parse
errors — `deepseek` is the better grader here.)

## The result — the gap opens, examples are accepted

**Memorized doc (Transformer paper), recall challenger — reproduces the null:** mean gap **0.117**,
**0 accepted**; the weak solver scored 0.68–0.78 (it has the content memorized — reading beats
reasoning).

**Non-memorized doc (Mixtral), non-extractive causal challenger — three runs, NOT consistent:**

| run | accepted | gap widening (plain → refined) | note |
|---|---|---|---|
| target=3, samples=2, maxRetries=3 | **1 / 3** | 0.306 → 0.508 (Δ +0.202) | fold steered a too-easy draft (weak 0.78) to an accepted one (weak 0.24) |
| target=1, samples=3, maxRetries=4 | **1 / 1** | — | first causal draft already separated |
| **target=3 — independent re-run** | **0 / 3** | 0.052 → 0.246 (Δ +0.194) | gap widened the same, but **no slot cleared the bar**; weak scored **0.75** on a near-miss — a competent, correct answer, not a struggle |

**What reproduces:** the +0.19–0.20 gap-widening from the fold (both runs). **What does not:** the
accepted count (0 to 2 of 3). The accept bar requires the weak model to *struggle* (< 0.5), and on
these MoE-reasoning questions `llama-3.1-8b` is too often competent (0.75) to fall below it — so
acceptance is close to a coin-flip at n=3. Total live spend ≈ **$0.25** across all runs.

## An autopsied accepted example (real discrimination, both answers read)

> **Q:** Walk through how the MoE layer processes a single token. If the router's gating network were
> broken and always output uniform weights (G(x)_i = 1/8 for all 8 experts), how would the layer's
> output differ from the intended behavior, and why is this failure mode problematic?

- **strong (`gemini-2.5-pro`): [1.00, 1.00, 1.00]** — walks through top-2 routing, then derives that
  uniform weights make the layer average ALL 8 experts (dense, no specialization/sparsity), losing
  the point of the MoE. Correct.
- **weak (`llama-3.1-8b`): [0.21, 0.27], mean 0.24** — restates the routing steps but does NOT derive
  the failure consequence; it never reaches "all experts averaged → specialization lost."

When the gap *does* open, it is real discrimination — not a judge artifact (judge verified above) or
leakage (the answer is not in the context). **But it does not open reliably.** In the independent
re-run, the analogous near-miss question drew a *competent* weak answer (0.75): `llama-3.1-8b`
correctly explained that high positional locality routes consecutive tokens to the same expert →
over-subscription, and that uniform routing would balance the load. On that draw the 8B reasoned
fine, so weak ≮ 0.5 and nothing was accepted. The weak model's competence on these questions is the
variance that makes acceptance a coin-flip.

## The finding

The two levers are **directionally confirmed and necessary**: a non-extractive causal challenger
(no leakage) AND a grounding doc the weak solver hasn't memorized — drop either and it nulls hard
(recall challenger leaks; the memorized Transformer paper lets the 8B recall). With both, the fold
**reliably widens the strong/weak gap by ~+0.20** (reproduced in both runs).

But "the discriminative reward works" is **NOT** established. Clearing the accept bar (weak must
*struggle*, < 0.5) is noisy: 0–2 accepted of 3 across runs, because `llama-3.1-8b` answers these
MoE-reasoning questions competently (0.75) about as often as it flails (0.24). At n=3 that is a
coin-flip, not a result. Honest verdict: **promising, directionally right, under-powered** — the
exact small-n shape that has repeatedly looked positive here and washed out at power.

## Status

Mechanism + observability: solid (gap-widening reproduced, judge reliability checked, every attempt
dumped to a JSONL autopsy trail via `AUTODATA_ATTEMPTS` — which is how the over-claim was caught).
Empirical positive: **not yet** — acceptance is too noisy at n=3. To actually settle it: raise
`samples` (stabilize the weak mean per question), raise the slot count to n≥24, and report the
*accepted-rate* with a confidence interval — not a single lucky run. Until then this is a confirmed
direction, not a confirmed win.

## Reproduce

```
dotenvx run -f <secrets>.env -- pnpm tsx src/autodata/run.ts        # causal, default Mixtral doc
dotenvx run -f <secrets>.env -- pnpm tsx src/autodata/calibrate.ts  # recall-vs-causal A/B, same doc
```
