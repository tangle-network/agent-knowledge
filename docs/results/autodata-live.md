# Autodata live result: a false null, autopsied, then a real (clean) null

Running the agentic data-creation loop (`src/autodata/`) on a real arXiv doc with real two-tier
solver models, to manufacture training examples that separate a strong solver from a weak one
(the discriminative reward). The headline is a null — but the path to it is the result.

## What happened, in order

1. **First runs looked like a null with a *negative* gap.** Across two tier pairs —
   `glm-4.5-air` vs `glm-5.2`, then `groq/llama-3.1-8b-instant` vs `gemini-2.5-pro` — every run
   reported 0 accepted and a strong−weak gap *below zero* (plain −0.47, then −1.00). A frontier
   model scoring *below* an 8B on reasoning questions is not credible.

2. **Autopsy (a direct probe on the real judge) found an artifact, not a finding.** At the solver's
   `maxTokens: 1024`, the strong **reasoning** model (`gemini-2.5-pro`, and `glm-5.2` before it)
   spent its whole budget on hidden reasoning and returned **empty visible content** on hard
   prompts — which the judge scored 0. So "strong" was being scored 0 for *answering nothing*,
   manufacturing a false negative gap. The trivial cost-gate smoke ("reply ok") didn't trigger it,
   so it slipped through. (Confirmed: the same prompt at `maxTokens: 8000` → gemini answers in
   956 chars and scores 1.00.)

3. **Fix (this PR).** The solver now uses a reasoning-safe `maxTokens` (8000) **and fails loud on
   empty content** — an empty answer is a measurement failure, never a silent 0 that corrupts the
   gap (the repo's no-silent-zeros rule). The model tier is now an env knob
   (`AUTODATA_WEAK_MODEL` / `AUTODATA_STRONG_MODEL` / `…_CHALLENGER_MODEL` / `…_JUDGE_MODEL`), and
   the price table covers the wide tier.

4. **The clean result.** Re-run with the fix, `llama-3.1-8b` vs `gemini-2.5-pro`:

   | metric | value |
   |---|---|
   | accepted (discriminating) examples | **0 / 3** |
   | plain gap (n=1) | 0.000 |
   | refined best-gap per slot (n=3) | 0.006 |
   | Δ (refined − plain) | **+0.006 — no meaningful widening** |
   | spend | $0.09 |

   The gap is now **~0, not negative** — `gemini-2.5-pro` and `llama-3.1-8b` score about **equally**.

## The finding

On these auto-generated, doc-grounded questions a small model performs as well as a frontier one,
because **the answer is extractable from the provided context** — reading beats reasoning, so model
capability does not separate and no example clears the discriminative bar. This is *not* a
model-tier problem (we used a genuine 8B-vs-frontier gap); it is a **question-difficulty** problem.

The lever is therefore the **challenger**, not the model tier: to open a real gap the challenger must
generate **non-extractive, reasoning-heavy** questions (multi-step derivations, numerical claims that
require following the paper's argument) — which is exactly the move the Autodata paper relies on
("the agent's initial attempt was usually a high-level summary question… subsequent rounds moved the
questions toward specific algorithmic steps the paper's actual argument required"). Our challenger,
on a single section, mostly produces extractable questions. Making it harder is the next experiment.

## Status

Mechanism: proven end-to-end on real frontier models, cost-tracked, fail-loud. Empirical
discrimination: a clean null on extractive questions. The harness is now trustworthy (no empty-→0
artifact); the open lever is challenger difficulty.
