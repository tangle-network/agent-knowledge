# Autodata live result: the causal-challenger loop reliably discriminates at power — 38% accept-rate, CI [23%, 55%] (NOT a coin-flip)

Running the agentic data-creation loop (`src/autodata/`) on real arXiv docs with real two-tier
solvers, to manufacture training examples that separate a strong solver from a weak one (the
discriminative reward of the Autodata / Agentic-Self-Instruct method).

**Powered headline (32 independent slots, 2 docs, samples=4):** the loop **reliably manufactures
discriminating examples — accept-rate 38%, Wilson 95% CI [23%, 55%]** (12 of 32 slots cleared the
hard accept bar: weak < 0.5 ∧ strong ≥ 0.65 ∧ gap ≥ 0.2). The CI lower bound (23%) excludes ~0, so
this is a **real, repeatable rate, not the n=1–2 luck** that made it look like a coin-flip at n=3.
Acceptance is **doc-dependent** (mixtral 19%, deepseek-v3 56%) and gated by **whether the weak model
struggles** (it does on only 39% of attempts), but it is decisively above zero on both docs. This
**replaces** the earlier n=3 result, which was too noisy to tell "real rate" from "coin-flip ~0".

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
   pretraining and capability cannot separate. Fix — **ground on docs the weak solver has not
   memorized**: the Mixtral-of-Experts paper (arXiv 2401.04088, Jan 2024) and the DeepSeek-V3 paper
   (arXiv 2412.19437, Dec 2024), both post-dating `llama-3.1-8b`'s knowledge cutoff, forcing it to
   reason from the context.

## Setup (all env-overridable)

| role | model | why |
|---|---|---|
| weak solver | `groq/llama-3.1-8b-instant` | small; cutoff predates the 2024 docs → must reason, can't recall |
| strong solver | `gemini-2.5-pro` | frontier reasoner; a real wide capability gap |
| challenger + judge | `deepseek-v4-flash` | capable, fast, reliable, a DIFFERENT family from both solvers (no judge-bias) |
| grounding doc A | Mixtral-of-Experts (2401.04088) | non-memorized; MoE expert routing / gating (`focus=expert`) |
| grounding doc B | DeepSeek-V3 (2412.19437) | non-memorized; auxiliary-loss-free load balancing / expert specialization (`focus=auxiliary`) |

Accept thresholds (the paper's): strong ≥ 0.65, weak < 0.50, gap ≥ 0.20. (`glm-5.2`, the brief's
challenger/judge, was returning upstream-capacity 503s; `deepseek-v4-flash` is the live, neutral
substitute. `routerChat` retries transient 503/429/timeout with bounded backoff.)

The grounding chunk must be **prose, not equations**: an equation-dense chunk (e.g. DeepSeek-V3's MLA
section) breaks the challenger's strict-JSON output (LaTeX backslashes), so both `focus` terms select
the prose description of an MoE-expert mechanism. Even so, 5 of 32 slots (~16%) still hit a
LaTeX-in-JSON failure and produced no example — those count as rejects in the headline (the
conservative floor); see below.

## The judge is reliable (checked before trusting any gap)

A controlled probe scored one genuinely-strong vs one genuinely-weak answer to the same question, 3×
each: `deepseek-v4-flash` returned strong `[1.00, 1.00, 1.00]` (mean 1.00) vs weak `[0.23, 0.13,
0.17]` (mean 0.18) — a consistent **0.82** separation, ranking strong above weak every time. So a
measured gap reflects answer quality, not judge noise. (`gemini-2.5-flash` as judge threw parse
errors — `deepseek` is the better grader here.)

## The powered result — a real ~38% accept-rate

**Design (fixed-slots, not until-N-accepted):** run a fixed K = 32 independent slots (each slot = one
full challenger → refine → accept cycle), split 16 / 16 across the two docs, samples = 4 per solver
(stabilise the weak mean), maxRetries = 2 (3 challenger attempts per slot). Record each slot's
outcome (accept / reject) + best gap, so the rate is bounded-cost and unbiased. Runnable:
`src/autodata/powered.ts`; per-attempt autopsy JSONL per doc; the CIs are agent-eval's published
estimators (`wilson` for the binomial accept-rate, `pairedBootstrap` for the paired widening).

| metric | value | read |
|---|---|---|
| **accept-rate (headline)** | **38%  CI [23%, 55%]** (12 / 32) | excludes ~0 → **reliable, not a coin-flip** |
| accept-rate (producing slots) | 44%  CI [28%, 63%] (12 / 27) | excludes the 5 challenger-stage (LaTeX) failures |
| — mixtral | 19%  CI [7%, 43%]  (3 / 16) | the harder doc; still excludes 0 |
| — deepseek-v3 | 56%  CI [33%, 77%] (9 / 16) | the easier-to-discriminate doc |
| best gap / slot (n=27) | min −0.23 · median **0.42** · p90 0.80 · max 0.95 | how far each slot separated the tiers |
| plain (first-draft) gap / slot | min −0.23 · median 0.19 · p90 0.61 · max 0.95 | the un-refined baseline |
| **gap-widening Δ (plain → best-refined)** | mean **+0.103**  CI [+0.029, +0.193] (paired bootstrap, n=27) | the fold's lift; **excludes 0** (median Δ 0 — it helps a minority) |
| weak score / attempt (n=33) | min 0.05 · median **0.55** · max 1.00 | the variance source — competent ~half the time |
| strong score / attempt (n=33) | min 0.21 · median **0.99** · max 1.00 | the strong solver almost always derives |

**Accept-rule decomposition (33 quality-clean attempts):** strong ≥ 0.65 = **88%**, weak < 0.50 =
**39%** ← the binding gate, gap ≥ 0.20 = 52%, all-three (= accept) = 36%. The strong solver derives
almost everything; the bottleneck is the weak model failing — which happens on only ~39% of
attempts, so the per-slot accept-rate is set by **how often `llama-3.1-8b` actually struggles**, not
by the challenger or judge. **Total live spend: $0.57** for the 32-slot run (~$1.0 including pilots).

## Two autopsied accepted examples (real discrimination, both answers read)

**deepseek-v3 — gap 0.93 (weak 0.07, strong 1.00):**
> **Q:** Why does using a *sequence-wise* auxiliary loss lead to a higher validation loss than a
> *batch-wise* auxiliary loss or the auxiliary-loss-free method in MoE models?

- **strong (`gemini-2.5-pro`): 1.00** — derives that the sequence-wise loss imposes a *stricter,
  less flexible* per-sequence balance constraint that *hinders the emergence of expert
  specialisation*. Correct, matches the reference.
- **weak (`llama-3.1-8b`): [0.10, 0.03, 0.10, 0.03]** — *restates the question* and never derives the
  reason. A recall-shaped non-answer; the judge's `reasoning` criterion floors it.

**mixtral — gap 0.95 (weak 0.05, strong 1.00):**
> **Q:** The text says each input is routed to 2 of 8 experts, yet the output sums `G(x)_i · E_i(x)`
> over all `n` experts. Are these consistent? If not, which should be revised?

- **strong: 1.00** — derives YES, consistent: the gating vector `G(x)` is *sparse* (nonzero only for
  the 2 selected experts), so the full-`n` sum effectively includes only those 2. Correct.
- **weak: [0.03, 0.07, 0.03, 0.07]** — concludes the statements are *inconsistent*; it never grasps
  the sparse-gating equivalence. A genuine reasoning error, not a judge artifact or leakage (the
  answer is derived, not in the context).

These are real weak-fails-strong-derives examples on both docs — the loop is manufacturing genuine
discrimination, not gaming the gap.

## The finding

The question "does the causal-challenger loop reliably manufacture discriminating examples, or is
acceptance a coin-flip ~0?" is now **settled at power: it reliably works.** Accept-rate **38%, CI
[23%, 55%]** over 32 slots — the lower bound excludes ~0, and even the harder of the two docs
(mixtral, 19% [7%, 43%]) excludes 0. The fold also **reliably widens the gap** (mean +0.103, CI
[+0.029, +0.193]), reproducing the n=3 direction at power, though most of the discrimination comes
from the first causal draft already separating (median widening 0 — the refine helps a minority of
slots).

Two honest caveats, both quantified, neither overturns the verdict:

1. **Doc-dependence.** The rate ranges 19% (mixtral) → 56% (deepseek-v3). The pooled 38% is a real
   average across two non-memorized MoE papers, not a single lucky doc — but expect the rate to move
   with the source material's difficulty for the 8B.
2. **The binding constraint is the weak model's competence, not the method.** `llama-3.1-8b` answers
   these MoE-reasoning questions competently (weak median 0.55) about as often as it flails, so
   ~39% of attempts clear the "weak must struggle" gate. A weaker weak model (or harder docs) would
   raise the rate; a stronger one would lower it. The loop's discriminative reward works as designed —
   the rate is a property of the **tier gap**, which is exactly what it should measure.

## Status

Mechanism + observability + **power**: solid. The accept-rate is measured at n=32 with a Wilson CI
that excludes ~0, the gap-widening with a paired-bootstrap CI that excludes 0, every attempt dumped
to a JSONL autopsy trail, and the two headline accepted examples read end-to-end (real
discrimination). The n=3 "coin-flip ~0?" worry is **resolved: ~38% accept-rate, not zero.**

## Reproduce

```
# Powered accept-rate + CIs (32 slots, 2 docs, samples=4) — the headline result:
dotenvx run -f <secrets>.env -- pnpm tsx src/autodata/powered.ts
#   knobs: AUTODATA_SLOTS_PER_DOC=16  AUTODATA_SAMPLES=4  AUTODATA_MAXRETRIES=2

# Single-doc builder + recall-vs-causal calibration (the lever's A/B):
dotenvx run -f <secrets>.env -- pnpm tsx src/autodata/run.ts
dotenvx run -f <secrets>.env -- pnpm tsx src/autodata/calibrate.ts
```
