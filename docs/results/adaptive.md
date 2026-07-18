# Adaptive topology: spend the LLM verifier only when it pays

The cost/quality A/B (`docs/results/cost-quality.md`) found the LLM relevance
verifier's cleanliness win is dominated by **de-duplication**, which a
deterministic content-hash / canonical-URL check captures at ~none of the LLM
premium, and that an LLM check only earns its dollar on the off-scope tail. The
production move it named was: do the cheap deterministic work first, reserve the
LLM for the ambiguous tail. `createAdaptiveResearchDriver`
(`src/adaptive-driver.ts`) is that driver, and this is its measurement.

Per candidate source the adaptive driver runs three stages, cheapest first,
stopping at the first that decides:

1. **Dedup ($0).** Reject a source whose canonical URL (scheme/`www`/trailing
   slash/tracking params stripped) or normalized-text content hash matches one
   already accepted this round or in the KB.
2. **Heuristic triage ($0).** Classify a unique survivor with host/title/length
   signals only: an authoritative host (arxiv, `*.edu`, `*.gov`, official docs,
   github, …) with a substantial body is **kept**; an obvious spam/listicle
   title or a too-thin body is **dropped**; everything else is **ambiguous**.
3. **LLM escalation ($).** Only ambiguous survivors reach the shipped LLM
   relevance verifier (`createVerifyingResearchDriver`), one call each.

## Live frontier, n=5 topics (glm-5.2)

Real web-research worker fetches each topic once; the same fetched proposals
(plus one planted tracking-decorated mirror of the first source, so the dedup
stage has a real duplicate to catch) are gated through all three drivers. Cost
is the per-arm `RouterClient.usage()` diff (#36). Total spend for the run:
**$0.033**.

| topic | fetched | single admit | full-LLM admit / calls / $ | adaptive admit / LLM calls / $ |
|---|---|---|---|---|
| self-speculative decoding | 3 | 3 | 1 / 3 / $0.0027 | 2 / **0** / **$0.0000** |
| rotary position embeddings | 3 | 3 | 1 / 3 / $0.0031 | 2 / **0** / **$0.0000** |
| grouped-query attention | 7 | 7 | 3 / 7 / $0.0072 | 6 / 3 / $0.0030 |
| KV-cache quantization | 5 | 5 | 3 / 5 / $0.0052 | 4 / **0** / **$0.0000** |
| LoRA fine-tuning | 7 | 7 | 4 / 7 / $0.0079 | 6 / 3 / $0.0037 |
| **total** | **25** | **25** | **12 / 25 / $0.0261** | **20 / 6 / $0.0068** |

**Cost.** Adaptive cuts LLM verifier calls **76%** (25 → 6) and dollars **74%**
($0.0261 → $0.0068). On 3 of the 5 topics it spent **zero** LLM calls, every
unique survivor was on an authoritative host, so the $0 stages decided
everything.

## Interpretation: adaptive occupies one cost-quality point

Admitted-source counts (lower = cleaner KB): **single 25, adaptive 20,
full-LLM 12**. Adaptive sits **between** the two:

- It removes **5 of the 13 sources** the full-LLM judge rejects that the
  single-agent loop keeps (every one of them a real duplicate caught by the $0
  dedup stage, exactly the de-dup-dominated win the cost/quality result
  predicted).
- It does **NOT** match full-LLM cleanliness. The remaining 8 sources full-LLM
  rejects, adaptive keeps. The cause is structural and visible in the trace: on
  this topic set every non-duplicate survivor landed on an authoritative host
  (arxiv / github / official docs), so the heuristic **kept** it without ever
  asking the LLM, and the LLM, when full-LLM did ask it, judged several of
  those same authoritative pages not-quite-on-topic and dropped them. The host
  prior is coarser than the relevance judge.

So the frontier tradeoff is concrete: **adaptive recovers the deterministic
de-dup half of full-LLM's cleanliness for ~26% of full-LLM's dollars, and gives
up the relevance-judgment half.** Whether that is the right point depends on the
cost of a kept-but-marginal source. If a slightly-off-topic authoritative page
is cheap to carry, adaptive dominates. If every admitted source must clear a
relevance bar, the host heuristic is too permissive and you want the full LLM,
or a tightened heuristic.

## Where the heuristic is weak: stated plainly

The escalation count is the diagnostic. On 3 of 5 topics it was **zero**: the
heuristic never deferred to the LLM, so on those topics adaptive is a
**pure host/title/length rule**, and its cleanliness is exactly that rule's
cleanliness, no smarter than "trust arxiv/github, drop spam." That is fine when
the worker's sources are dominated by authoritative hosts (as here), but it
means the LLM's relevance judgment is contributing nothing on those topics, by
construction. The two topics where adaptive *did* escalate (grouped-query
attention, LoRA) are where some survivors were on unknown hosts, and there the
3 LLM calls per topic are the off-scope tail the verifier is actually for.

The heuristic would mis-route in two directions a richer worker would expose,
neither seen on this authoritative-host-heavy set:

- **False keep:** an authoritative-host page that is off-topic or low-value
  (an arxiv paper on an unrelated subject) is kept without the LLM ever seeing
  it. The host prior cannot catch this; only the relevance judge can.
- **False drop:** a genuinely good source on an unknown blog/host with a
  spam-shaped title, or under the 400-char body floor, is dropped before the LLM
  could rescue it.

## What this changes

The deployable recommendation from the cost/quality result was "deterministic
dedup first, reserve the LLM for the tail." This driver ships that and the
measurement confirms the **cost** half cleanly (76% fewer calls, 74% cheaper)
and qualifies the **quality** half accurately: adaptive captures the de-dup
cleanliness (the dominant, free win) but not the LLM's relevance cleanliness,
because the host heuristic resolves authoritative survivors without asking. For
a worker whose sources are mostly authoritative, adaptive is the right frontier
point. For one whose junk is on-topic-looking pages on unknown hosts, the
ambiguous tail grows and adaptive converges toward full-LLM cost, which is the
correct behavior: it pays for the LLM exactly when the cheap signals can't
decide.

## Run it

```
# offline (controlled wiring + escalates-only-ambiguous proof, no creds)
pnpm exec vitest run tests/loops/adaptive-ab.test.ts

# live three-topology frontier (needs TANGLE_API_KEY with glm-5.2 credits)
AGENT_KNOWLEDGE_LIVE=1 \
ADAPTIVE_LIVE_GOALS="self-speculative decoding|rotary position embeddings|grouped-query attention|KV-cache quantization|LoRA fine-tuning" \
pnpm exec vitest run tests/loops/adaptive-ab.test.ts -t "three-topology"
```

A cheap one-call glm-5.2 smoke gates the multi-topic burn (fails fast if the key
or the reasoning-token floor is broken) before any dollars are spent.
