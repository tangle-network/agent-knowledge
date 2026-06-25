# Claim-grounding: the band where the verifier earns its dollar

`docs/results/cost-quality.md` found the relevance verifier's cleanliness win is
**dominated by de-duplication** — a deterministic content-hash captures most of it
at ~none of the LLM premium. So the open question was: is there an error band where
a verifier earns its cost — something a hash AND a relevance judge both miss?

**Yes: misattributed citations.** A source that is on-topic, unique, and real, but
whose cited CLAIM does not appear in the page (the LLM wrote a plausible sentence
and hung a real URL off it). De-dup passes it (it's unique). A relevance judge
passes it (the page is on-topic). Only checking the claim against the fetched text
catches it — and that check is **deterministic text presence, $0 inference**.

## The mode

Each proposed source now carries the specific claim it is cited for
(`withCitedClaim` → `metadata.citedClaim`). The verifier
(`createClaimGroundingVerifier`) runs `groundClaimInText(claim, pageText)` over the
`htmlToText` output of the page the worker actually fetched — verbatim, normalized
(punctuation/whitespace-insensitive), or a ≥70% content-word overlap close
paraphrase. A claim that isn't present is rejected as **misattributed**. The oracle
is text presence, not a model call, so it composes with the LLM relevance verifier
(reject off-topic AND misattributed) or runs alone at zero inference cost.

## Live A/B (glm-5.2, real web fetch, planted misattribution band)

Real worker (glm-5.2 query-gen → live `/v1/search` → `politeFetch` → `htmlToText`)
fetches the sources once per topic; we then plant ONE misattribution per topic (real
fetched page + a deliberately-wrong claim) and run three verifier arms over the SAME
proposals. Cost diffed per arm with the #36 `RouterClient.usage()` instrumentation.

| n=5 topics | misattributions caught | marginal $ | $/topic | per-$ caught |
|---|---|---|---|---|
| no-verifier | 0 / 5 | $0.0000 | — | — |
| relevance (LLM judge) | **4 / 5** | $0.0157 | ~$0.0031 | 254 |
| claim-grounding (text) | **5 / 5** | **$0.0000** | $0 | ∞ |

Per-topic (caught relevance / grounding): self-speculative decoding 1/1, rotary
position embeddings 1/1, grouped-query attention 1/1, **KV-cache quantization 0/1**,
LoRA 1/1. (An earlier 3-topic run missed self-speculative decoding instead — the
miss moves around; it is not a fixed topic.)

**Reading.** Claim-grounding catches every misattribution at **$0**; the relevance
judge catches most but **misses one in five at ~$0.003/topic**. The miss is the
point: the relevance verifier only ever sees the page text, never the cited claim,
so it is *structurally blind* to misattribution. It catches one only by accident —
when the fabricated claim happens to also make the page read off-topic
(e.g. a "12-billion-parameter draft transformer" claim on a rotary-embeddings page).
When the fabrication stays on-topic (the KV-cache case), the judge waves it through.

So on THIS band the verifier-per-dollar comparison inverts the cost/quality result:
there, the LLM verifier bought a dedup-shaped gain a free hash already captures —
expensive for what a cheap rule does. Here the cheap, deterministic check
**dominates** the expensive judge: it catches strictly more (5/5 vs 4/5) at strictly
less ($0 vs $0.0157). The verifier earns its dollar on misattribution; it does not on
de-duplication.

## Why this is a real correctable band (not dedup, not relevance)

- **Not de-duplication.** Every planted source has a unique URL and unique text; a
  content-hash / canonical-URL dedup keeps all of them.
- **Not generic relevance.** Every planted source is on-topic; the relevance judge
  (and the offline relevance stand-in) accept them. The error is in the *claim*, not
  the *topic*.
- **Executable ground truth.** The check is presence/close-paraphrase of the claim
  in the fetched text — deployable in production with no oracle and no model call.

The offline arm proves the floor with a controlled 4-source pool (2 grounded, 2
misattributed): claim-grounding admits **0/2** misattributions and keeps **2/2**
grounded sources, while relevance and no-verifier both admit **2/2**.

## Threats to validity

- **n=5 topics, 1 misattribution each.** The direction (grounding ≥ relevance caught,
  at ≤ cost) is asserted in the test on every run; the magnitude is small-n. The
  relevance miss-rate (1/5 here, 1/3 earlier) is an existence proof of the blind
  spot, not a calibrated rate.
- **Planted misattributions, not naturally-occurring ones.** Like the cost/quality
  offline floor, the misattribution is injected so the band is measurable. It models
  the real LLM citation-fabrication failure but does not measure its base rate in the
  wild — that needs a corpus of model-written citations checked by hand.
- **The grounding oracle is conservative.** A real paraphrase whose inflected words
  differ from the page ("drafts" vs "draft") can score below 0.7 and be rejected —
  a false-positive misattribution flag. `minOverlap` tunes this; the worker should
  cite the page's own key terms (the `createClaimDecorator` extractor is told to).

## Run it

```bash
# offline floor (no creds)
pnpm exec vitest run tests/loops/claim-grounding-ab.test.ts -t "offline"

# live A/B (creds-gated). A cheap glm-5.2 smoke runs BEFORE the multi-topic burn.
AGENT_KNOWLEDGE_LIVE=1 TANGLE_API_KEY=… \
  CLAIM_GROUNDING_LIVE_GOALS='self-speculative decoding|rotary position embeddings|grouped-query attention|KV-cache quantization|LoRA' \
  pnpm exec vitest run tests/loops/claim-grounding-ab.test.ts -t "three verifier arms"
```
