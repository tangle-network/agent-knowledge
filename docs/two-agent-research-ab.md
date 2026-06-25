# A verifier agent mostly deduplicates: a controlled A/B on two-agent web research, and what its cost buys

*Tangle Network · `agent-knowledge`*

## Abstract

We test whether adding a second "verifier" agent to a web-research loop produces a
cleaner knowledge base than a single agent doing the same work, with compute held
fixed. A *worker* agent searches the web and proposes sources for the knowledge
base's open gaps; a *driver* agent vets each proposed source before it commits,
fills gaps the worker missed, and decides when the base is complete. Over 9
machine-learning topics at equal compute, the two-agent loop admitted **2.3–2.7
fewer sources per topic at identical coverage** — 95% bootstrap intervals
[1.78, 2.89] and [2.22, 3.00] across two independent runs, both above zero. The
effect is real and reproduces. But the mechanism is not the one we set out to
test: reading the rejection logs, most of the gain is **de-duplication** — the
same paper fetched from arXiv, OpenReview, and the NeurIPS proceedings — not the
relevance filtering we expected. Pricing the verifier's calls (we added per-arm
router-usage instrumentation) shows the cleanliness costs roughly **5× the
dollars, 9× the tokens, and 3× the latency** of the single agent — and that the
original "equal passes" framing hid this, because it charged the verify step as
one pass while it is actually one LLM call per proposed source. Since the win is
de-dup-dominated, a deterministic content hash recovers most of the cleanliness at
~none of the premium. We then asked the sharper question — is there an error band
where an LLM verifier *does* earn its dollar? — and found two, on opposite sides of
the ledger. **Misattributed citations** (an on-topic, unique, real source whose
cited claim never appears in the page) are caught by a $0 deterministic
text-presence check that the LLM relevance judge misses 1 in 5 times, because the
judge structurally never sees the claim. And we built the deployable shape the
cost result implied — an **adaptive driver** that runs free dedup, then free
heuristic triage, and escalates to the LLM only on the ambiguous tail: it cuts
LLM verifier calls 76% and dollars 74%, recovering the de-dup half of the
verifier's cleanliness while honestly giving up the relevance-judgment half on a
source pool dominated by authoritative hosts. The verifier earns its dollar on
misattribution, not on de-duplication; the right production loop spends it only
where the cheap signals can't decide. Finally we ask the harder question this whole
metric can't reach — a filter agent can only make the base *carry less*, never
*answer more* — by building the opposite agent (a **driving** driver that chases
depth and corroboration instead of pruning) and the opposite metric (a firewalled
exam of 20 held-out **deep questions**, $0-graded). It is an honest null: driving
does **not** reliably beat plain collection at answering hard questions, and costs
**12–16×** more; the verdict flips with the compute budget, the signature of web
variance rather than a real topology effect, and it still ties a blind worker even
when forced to run its full multi-round mechanism (§9).

## 1. Setup

A research agent building a knowledge base accumulates sources. A single agent both
finds sources and, implicitly, decides which to keep — it grades its own work. The
hypothesis is the usual one for verification: separating the producer (find
sources) from the checker (keep the good ones) should yield a cleaner result, for
the same reason a second pair of eyes catches typos the author misses.

The trap in any "more agents help" claim is compute. Two agents that simply do more
work will of course produce more — that is a bigger budget, not a finding. So the
comparison must hold total compute fixed and ask whether the *topology* — splitting
find from check — beats spending the same compute on a single agent that just finds
more. And once topology shows an effect, the second question is what it costs: a
cleaner base bought at 5× the inference is a different product decision than one
bought for free.

## 2. Method

### 2.1 The loop

The loop has two roles (`src/two-agent-research-loop.ts`, `runTwoAgentResearchLoop`):

- **Worker** — primary research. Each round it reads the open gaps and proposes
  sources to close them (`ResearchWorker: (ctx: { gaps, steer }) => proposals`).
- **Driver** — does three things (`ResearchDriver`): `verifySource` vets each
  proposed source before it commits (dedup against the base, then reject sources
  that aren't relevant); `research` runs the driver's own gap-fill pass over gaps
  the worker missed; `foldGaps` turns the still-open gaps into a `steer` string for
  the worker's next round.

A round is therefore: worker proposes → driver verifies each proposal (rejections
never reach the base) → driver gap-fills → the readiness gate checks the base →
remaining gaps are folded into the next worker prompt. The loop stops when the gate
reports no blocking gaps left.

Note what the driver→worker hand-off is and isn't: the driver *steers* the worker
by handing it the remaining readiness gaps (`foldGaps`), which is a deterministic
formatting of unmet requirements — not an LLM authoring a fresh instruction. The
driver's LLM work is in `verifySource` (one call per proposed source) and its own
`research` pass. This matters for §4.2: the verify step is N calls, not one, and
the cost framing turns on that.

The readiness gate is `scoreKnowledgeReadiness` (from `agent-eval`). It scores
*pages* (curated `knowledge/*.md`), not raw sources, and only `importance:
'blocking'` requirements gate. Coverage below is the fraction of a topic's blocking
requirements met.

### 2.2 What the agents are — an honest note

The agents in the live run are **not** `AgentProfile`s on a coding harness. The
worker is a hand-wired pipeline (`src/web-research-worker.ts`,
`createWebResearchWorker`): glm-5.2 turns the gaps into search queries → a real web
search over the Tangle router (`POST /v1/search`) → each hit is fetched with the
repo's `politeFetch` and reduced to text with `htmlToText` → citing pages are
proposed. It talks to the router directly through `createTangleRouterClient` — no
claude-code / opencode / sandbox harness, and no dynamic harness selection. The
driver (`createVerifyingResearchDriver`) is one glm-5.2 chat call per source.

The repo *does* ship a real `AgentProfile` for research (`researcherProfile`), and
the **offline** control arm uses it with a stub harness — but the live arm bypasses
it for the direct pipeline. This is a deliberate shortcut (no harness to stand up,
~$0.20 to run) and also the loop's main simplification debt; see §7.

### 2.3 Equal compute

Compute is counted in agent passes. A two-agent round = 1 worker pass + 1
verify pass = 2 passes; a single-agent iteration = 1 pass. Both arms gate on the
*same* readiness criterion and stop as soon as it is met, so neither is starved.
We budget-match by passes, not rounds — the single-agent loop gets more rounds to
spend the compute the two-agent loop spends on verification. The harness asserts,
per topic, that the two-agent loop spent no more passes than the single-agent loop
and that both stayed under the ceiling; if that ever fails the comparison has
drifted to unequal compute and the result is void.

The pass-accounting has a known soft spot, which §4.2 exposes: a "verify pass" is
not one LLM call, it is one `verifySource` call per *proposed* source that round.
Charging it as a single pass keeps the topology comparison fair on agent passes but
understates the verifier's dollar cost. We added explicit per-arm cost
instrumentation to measure that directly.

### 2.4 Cost instrumentation

The router client now records usage per call (`RouterClient.usage()`,
`src/web-research-worker.ts`): cumulative chat-completion count, prompt/completion
tokens, glm-5.2 priced cost, and wall latency. Each A/B arm reads the accumulator
before and after its run and diffs, so every reported dollar and token figure is a
measured per-arm delta, not an estimate.

### 2.5 Topics and readiness

9 topics, each with two blocking requirements (the defining mechanism, and reported
results / trade-offs). Seven are "narrow-scope-inside-a-broad-space" (e.g.
*self-speculative decoding* inside *speculative decoding*), where we expected the
broad space to leak in; two are clean controls (*the transformer architecture*,
*gradient descent*).

## 3. Result 1 — cleanliness: the verifier admits fewer sources at equal coverage

The cleanliness signal is the **admitted-source count**: on live data there is no
oracle, so "fewer sources admitted at equal coverage" is the measurable proxy for
"cleaner." Δ = single-agent admitted − two-agent admitted, per topic.

| Topic | band | Run 1 Δ | Run 2 Δ |
|---|---|---|---|
| self-speculative decoding | narrow | 3 | 3 |
| grouped-query attention | narrow | 3 | 3 |
| rotary position embeddings | narrow | 2 | 3 |
| KV-cache quantization | narrow | 1 | 1 |
| LoRA | narrow | 1 | 3 |
| ring attention | narrow | 2 | 3 |
| constitutional AI | narrow | 3 | 3 |
| the transformer architecture | clean | 3 | 3 |
| gradient descent | clean | 3 | 2 |
| **mean Δ** | | **2.33** | **2.67** |
| **95% CI** (paired bootstrap) | | **[1.78, 2.89]** | **[2.22, 3.00]** |

Coverage was **1.00 on every topic, both arms, both runs** — the verifier never
cost completeness. Both bootstrap intervals (`pairedBootstrap`, from `agent-eval`)
are above zero. The effect reproduces; its exact magnitude varies run-to-run with
what the web returns (one topic swung Δ = 0→1→3 across separate runs during
development).

A third, cost-instrumented run (the one priced in §4.2) was noisier: mean Δ **+1.56,
95% CI [0.33, 2.67]**, with two topics where the two-agent loop admitted *more* than
the single agent (KV-cache quantization −1, gradient descent −1). The interval still
clears zero, but it is the lower-bound run — a reminder that the magnitude is
web-variance-bound, while the sign is stable.

## 4. Result 2 — what the verifier does, and what it costs

### 4.1 Mostly de-duplication

We classified each rejection by the verifier's own stated reason:

| rejection reason | narrow (7) | clean (2) |
|---|---|---|
| near-duplicate (same paper, different host) | 6 | 4 |
| off-scope (broad space leaked in) | 3 | 2 |
| junk page (aggregator / marketing / explainer) | 3 | 0 |

The dominant mechanism is **de-duplication** — canonical papers mirrored across
arXiv, OpenReview, and the NeurIPS proceedings — and it fires regardless of band.
The off-scope rejection we set out to measure is real (on *self-speculative
decoding* the verifier correctly dropped three general *speculative decoding* papers
that use a *separate* draft model) but it is the minority, and it does not
concentrate on the narrow topics as hypothesized: narrow mean Δ = 2.14 vs clean
3.00. The strong form of our hypothesis — narrow-in-broad pays more — is **refuted
in magnitude, confirmed only in mechanism**.

The practical reading: most of the win is "you fetched the same PDF three times,"
which a content hash catches for free. The LLM's distinctive contribution is the
page that *looks* on-topic but isn't — the self-speculative-vs-separate-draft
distinction a string match would miss.

### 4.2 The inference premium (and what "equal passes" hid)

`docs/results/cost-quality.md`. The original A/B reported only admitted-sources at
"equal passes," which charged the verify step as one pass while it is actually N
`verifySource` LLM calls. Pricing the calls per arm (B ≤ 4 passes/arm, glm-5.2):

| per topic (mean) | two-agent | single-agent | ratio |
|---|---|---|---|
| LLM chat calls | 5.4 | 1.0 | ~5.4× |
| tokens (in+out) | ~4,900 | ~530 | ~9× |
| cost (USD) | ~$0.0072 | ~$0.0013 | ~5.5× |
| latency (wall) | ~37 s | ~11 s | ~3.4× |
| cleanliness Δ (single − two admitted) | — | — | +1.56, 95% CI [0.33, 2.67] |

The verifier buys ~1.5–2.7 fewer junk sources for roughly **5× the dollars, 9× the
tokens, and 3× the latency**. Since the cleanliness gain is de-dup-dominated
(§4.1), the honest production move is a deterministic content-hash / canonical-URL
dedup, which captures most of the cleanliness at ~none of this premium, reserving
an LLM check only for the off-scope tail. This is the cost half the "equal passes"
framing left out — and the rest of the paper is what we built once we saw it.

## 5. Result 3 — the two bands where an LLM verifier does, and doesn't, earn its dollar

If de-dup is free and dominates the win, when is the LLM verifier worth its 5×? We
found two bands, and they cut in opposite directions.

### 5.1 Misattributed citations — the cheap check beats the expensive judge

`docs/results/claim-grounding.md`. A source can be on-topic, unique, and real, yet
the cited *claim* never appears in the page — the LLM wrote a plausible sentence and
hung a real URL off it. De-dup passes it (unique). A relevance judge passes it (the
page is on-topic). Only checking the claim against the fetched text catches it — and
that check is **deterministic text presence, $0 inference**.

Each proposed source now carries the claim it is cited for (`withCitedClaim` →
`metadata.citedClaim`). The claim-grounding verifier (`createClaimGroundingVerifier`,
`src/claim-grounding.ts`) runs `groundClaimInText(claim, pageText)` over the
`htmlToText` output of the page the worker actually fetched — verbatim, normalized
(punctuation/whitespace-insensitive), or a ≥70% content-word overlap close
paraphrase. A claim that isn't present is rejected as misattributed. The oracle is
text presence, not a model call, so it composes with the LLM relevance verifier or
runs alone at zero cost.

Live A/B (glm-5.2, real web fetch, one planted misattribution per topic — a real
fetched page plus a deliberately-wrong claim — over three verifier arms on the same
proposals):

| n=5 topics | misattributions caught | marginal $ | per-$ caught |
|---|---|---|---|
| no-verifier | 0 / 5 | $0.0000 | — |
| relevance (LLM judge) | 4 / 5 | $0.0157 | 254 |
| claim-grounding (text) | **5 / 5** | **$0.0000** | ∞ |

The relevance judge catches one only by accident — when the fabricated claim also
makes the page read off-topic (a "12-billion-parameter draft transformer" claim on a
rotary-embeddings page). When the fabrication stays on-topic (the KV-cache case), the
judge waves it through, because the relevance verifier only ever sees the page text,
never the cited claim — it is **structurally blind** to misattribution. On this band
the verifier-per-dollar comparison inverts §4.2: the cheap, deterministic check
catches strictly more (5/5 vs 4/5) at strictly less ($0 vs $0.0157). The offline
floor confirms the wiring: on a controlled 4-source pool (2 grounded, 2
misattributed), claim-grounding admits **0/2** misattributions and keeps **2/2**
grounded, while relevance and no-verifier both admit **2/2**.

### 5.2 Adaptive topology — pay the LLM only on the ambiguous tail

`docs/results/adaptive.md`. The deployable shape §4.2 implied: do the free
deterministic work first, reserve the LLM for what the cheap signals can't decide.
`createAdaptiveResearchDriver` (`src/adaptive-driver.ts`) is that driver. Per
candidate source it runs three stages, cheapest first, stopping at the first that
decides:

1. **Dedup ($0).** Reject a source whose canonical URL (scheme / `www` / trailing
   slash / tracking params stripped) or normalized-text content hash matches one
   already accepted this round or in the KB.
2. **Heuristic triage ($0).** Classify a unique survivor with host/title/length
   signals only: an authoritative host (arxiv, `*.edu`, `*.gov`, official docs,
   github, …) with a substantial body is **kept**; an obvious spam/listicle title
   or a too-thin body is **dropped**; everything else is **ambiguous**.
3. **LLM escalation ($).** Only ambiguous survivors reach the shipped LLM relevance
   verifier — one call each.

Live frontier, n=5 topics, glm-5.2, same fetched proposals gated through all three
drivers (plus one planted tracking-decorated mirror of the first source, so the
dedup stage has a real duplicate to catch). Total spend $0.033:

| topic | fetched | single admit | full-LLM admit / calls / $ | adaptive admit / LLM calls / $ |
|---|---|---|---|---|
| self-speculative decoding | 3 | 3 | 1 / 3 / $0.0027 | 2 / **0** / **$0.0000** |
| rotary position embeddings | 3 | 3 | 1 / 3 / $0.0031 | 2 / **0** / **$0.0000** |
| grouped-query attention | 7 | 7 | 3 / 7 / $0.0072 | 6 / 3 / $0.0030 |
| KV-cache quantization | 5 | 5 | 3 / 5 / $0.0052 | 4 / **0** / **$0.0000** |
| LoRA fine-tuning | 7 | 7 | 4 / 7 / $0.0079 | 6 / 3 / $0.0037 |
| **total** | **25** | **25** | **12 / 25 / $0.0261** | **20 / 6 / $0.0068** |

Adaptive cuts LLM verifier calls **76%** (25 → 6) and dollars **74%** ($0.0261 →
$0.0068). On 3 of the 5 topics it spent **zero** LLM calls — every unique survivor
was on an authoritative host, so the $0 stages decided everything.

It is a frontier point, not a free lunch. Admitted counts (lower = cleaner): single
25, **adaptive 20**, full-LLM 12. Adaptive removes the 5 real duplicates the $0 dedup
catches — exactly the de-dup-dominated win — but keeps the 8 sources full-LLM rejects
on relevance, because on this authoritative-host-heavy set the heuristic resolved
every non-duplicate survivor without ever asking the LLM, and the host prior is
coarser than the relevance judge. So adaptive **recovers the deterministic de-dup
half of full-LLM's cleanliness for ~26% of its dollars, and gives up the
relevance-judgment half**. The escalation count is the diagnostic: on the 3 topics
where it was zero, adaptive *is* a pure host/title/length rule and the LLM
contributes nothing by construction; on the 2 topics with unknown-host survivors
(grouped-query attention, LoRA) it escalated 3 calls each — the off-scope tail the
verifier is actually for.

## 6. Discussion

The three results compose into one rule. The LLM verifier's headline cleanliness win
is real (§3) but **de-dup-dominated** (§4.1) and **expensive** (§4.2, ~5×/9×/3×), so
spending an LLM call on every source is the wrong default — a free content hash buys
most of it. The verifier earns its 5× exactly where the cheap signals are blind: on
**misattribution** (§5.1), where a $0 text-presence check beats the LLM judge
outright because the judge never sees the claim; and on the **off-scope tail** (§5.2),
where a page looks on-topic, is unique, and isn't fabricated, so only a relevance
judgment can settle it. The deployable loop therefore stratifies by cost: free dedup,
free claim-grounding, free heuristic triage, then an LLM call only on what survives —
which is what the adaptive driver ships.

Two cross-cutting lessons. First, **the accounting unit decides the verdict**:
charging the verify step as one pass made the topology look near-free; pricing it per
LLM call (§4.2) is what surfaced the 5× and motivated everything after it. Second,
**the same verifier inverts in value across bands** — on de-dup the LLM is expensive
for what a hash does; on misattribution a deterministic check is free for what the LLM
can't do; on the off-scope tail the LLM is the only thing that works. "Add a verifier"
is not a setting; it is a cost-stratified decision per error type.

## 7. Limitations

- **The verifier is also the judge.** Admitted-count is a proxy; we have no
  independent oracle for whether a dropped source was genuinely redundant. The
  verifier's stated reasons hold up on inspection, but this is the load-bearing
  caveat for §3–§4.
- **Deltas are conservative.** The single-agent loop stops on the same readiness
  gate, capping its admits; with more iterations it would admit even more junk, so
  the true gap is at least this large.
- **Small n.** n = 2 clean controls is too thin to compare bands; the misattribution
  and adaptive frontiers are n = 5 each. The directions are asserted in the tests on
  every run; the magnitudes are small-n and web-variance-bound (the §3 third run swung
  to +1.56 from +2.3/+2.7).
- **Planted error bands.** The misattributions (§5.1) and the adaptive duplicate
  (§5.2) are injected so the band is measurable. They model the real LLM
  citation-fabrication and mirror-host failures but do not measure their base rate in
  the wild — that needs a hand-checked corpus of model-written citations.
- **Adaptive's quality is host-prior-bound.** On an authoritative-host-heavy source
  pool the heuristic resolves everything and the LLM's relevance judgment contributes
  nothing; a richer worker (good sources on unknown hosts, junk on on-topic-looking
  pages) would grow the ambiguous tail and converge adaptive toward full-LLM cost.
- **glm-5.2-specific.** A weaker or stronger judge would shift rejection rates and the
  relevance miss-rate. The grounding oracle is also conservative: a real paraphrase
  whose inflected words differ ("drafts" vs "draft") can fall below the 0.7 overlap and
  be flagged misattributed; `minOverlap` tunes this.
- **High web variance.** One live run per topic per result; numbers move with what
  search returns.

## 8. A simpler loop — built, not deferred

The original write-up named two simplifications as future work. Both are now built and
measured; this is what changed.

1. **Deterministic dedup before the LLM, LLM only on the tail — shipped.** The
   adaptive driver (`src/adaptive-driver.ts`, §5.2) does exactly this: free
   canonical-URL / content-hash dedup, free host/title/length triage, LLM relevance
   only on the ambiguous survivors. Measured: **76% fewer LLM calls, 74% cheaper**,
   recovering the de-dup half of the verifier's cleanliness. The remaining gap to
   full-LLM is the relevance-judgment half, kept honest in §5.2 — adaptive is a
   frontier point you choose by how much a kept-but-marginal source costs you, not a
   strict improvement.
2. **A free check the LLM judge can't replicate — shipped.** Claim-grounding
   (`src/claim-grounding.ts`, §5.1) adds the one verification an LLM relevance judge is
   structurally blind to: does the cited claim actually appear in the page? It catches
   5/5 planted misattributions at **$0**, vs the judge's 4/5 at ~$0.003/topic.

What is still **not** built remains the worker: the live worker is a ~500-line
hand-wired pipeline (query-gen, search, fetch, propose) against the router directly,
where the repo's own pattern is to *author* an `AgentProfile` (`researcherProfile`)
and run it on a harness with a web-search tool — reusable and harness-agnostic. The
direct pipeline is cheaper to run today (no harness, no creds beyond the router) but it
is the loop's main remaining piece of duplication, and the obvious next step if this
loop graduates from experiment to production.

## 9. From hygiene to depth — a research-DRIVING loop, measured on held-out deep questions

Everything above measures one thing: **source hygiene** — how *few* sources a verifier
admits at equal coverage. That is the right metric for a verifier whose only job is to
filter, and it is why the win turned out to be de-duplication (§4.1): the most a
filter-only verifier can do is reject. By construction it cannot make the knowledge base
*answer more*; it can only make it *carry less*. So "the verifier mostly deduplicates" is
not a disappointing finding about *this* verifier — it is the ceiling of what *any*
admit-or-reject step can do. To ask whether a second agent can improve the research
itself, you have to change both the agent and the metric.

So we built the opposite agent and gave it the opposite metric. The **driving driver**
(`src/research-driving-driver.ts`, `createResearchDrivingDriver`) does not filter. It
extracts each fetched source's claims, demands a second independent source for every
claim, generates comparative / mechanism / contradiction sub-questions, and steers the
worker to chase them in the next round. Its thesis is that *driving the research deeper*
— not pruning it — builds a knowledge base that answers harder questions. We measure it
not on admitted-count (which would score its whole point as a regression — it admits
*more*) but on a **firewalled exam of 20 deep questions across 5 ML topics**
(`tests/loops/held-out-exam.ts`), graded with a $0 deterministic substring grader the
loop never sees. The questions are depth questions by construction — the grader scores
**0/20** on a one-line topic definition and **20/20** on a mechanism-rich paragraph, so
a high score is reachable only by depth, not by grader slack. All three arms run the
same real web worker and differ only in the driver: (A) plain collection, (B)
verify/dedup, (C) driving.

**The honest verdict: driving does NOT reliably beat plain collection, and costs
~12–16× more.** The tell is that the winner flips with the compute budget, on the same
exam:

| arm | answered @ B=4 | answered @ B=6 | cost (5 topics) | tokens |
|---|---|---|---|---|
| single-agent (collect) | 13/20 | **15/20** | $0.005–0.007 | ~2.4–3.0k |
| verify/dedup | **15/20** | **15/20** | $0.031–0.027 | ~21k |
| **driving (deepen)** | **16/20** | 13/20 | **$0.089–0.084** | ~69–71k |

Driving "wins" at B=4 (16 > 15 > 13) and "loses" at B=6 (13 < 15), while the
single-agent arm itself swings 15→13 across the two budgets. At n=5 topics a ±1–3
question difference is inside the run-to-run web variance — the **within-arm swing is as
large as the between-arm gap**, which is the signature of a null. What is stable and
large is the cost: an order of magnitude more dollars and ~24× the tokens, for the
claim-extraction LLM call driving runs on every fetched source.

The autopsy explains it: every arm finished in **one effective round**
(`passes=2` on every topic at every budget). The generic readiness gate — "one source
closes the gap" — is met by the first fetch, so the loop stops *before* the driving
driver ever steers a second round, and its entire mechanism is multi-round. So we gave
it its fairest test: a controlled probe that *forces* three rounds so the driver
actually steers. It **still ties** a blind worker that just re-searches the same gaps —
**8/12 vs 8/12, at ~9× the cost**. Driving was better on RLHF (3 vs 1 — chasing
corroboration reached a page blind search missed) and worse on speculative decoding (2
vs 4 — steering pulled the worker *off* the pages that answered the exam); the two
cancel. The null survives the fix, so it is not an artifact of a permissive gate.

The durable output is the apparatus, not the agent: a firewalled deep-question exam with
a $0 grader that can tell depth from surface, reusable for any future research-quality
claim. Full result, per-topic tables, and the probe: [`docs/results/research-driving.md`](results/research-driving.md).
The two findings compose into one rule for "should I add a second research agent?":
a **filter** agent measured on hygiene buys de-dup cleanliness you can get cheaper from a
hash (§3–§4); a **driver** agent measured on depth buys nothing reliable over plain
collection at this n and worker, for 9–16× the cost (§9). Neither earns a blanket "yes";
both earn a narrow, cost-stratified one — the verifier on misattribution and the
off-scope tail (§5), the driver only where a richer worker makes "go corroborate this"
reach a page collection can't.

### 9.1 The domain was too easy — re-running the A/B where one search is not enough

The §9 null has a structural cause, not a measurement one: **on an ML topic a single
good search already collects the answer.** Every arm finished in one effective round
because the first fetch met the readiness gate, so the driving driver — whose mechanism
is steering a *second* round — never acted. When one search suffices, there is no
investigation for a smarter coordinator to do, and the metric can only reward
collection. To ask whether topology *can ever* beat blind collection, you have to move
to a domain where the answer is buried and a single fetch provably cannot surface it.

So we did. We ported the whole apparatus — firewalled checklist, `$0` model-free
grader, matched-compute 3-arm A/B — onto **investment research**: give a loop a company
+ ticker + an as-of cutoff and grade the thesis on the buried, material 10-K-footnote
facts a ticker search misses (an HTM mark the size of a bank's equity, a 97%-uninsured
deposit base, a negative per-unit margin). First we *calibrated* the new metric and
proved it discriminates depth on this harder domain — a shallow ticker summary scores
**1/27 (4%)**, a deep filings-grounded thesis **27/27 (100%)**, a **+96-point** gap.
Then the live 3-arm A/B over 5 held-out companies: **driving surfaced the most buried
facts (16/27, 59%) vs blind collection (11/27, 41%)** for ~1.9× the cost — the lift is
real and points the right way, but at n=5 the paired-bootstrap CI still crosses zero
(P(Δ≤0)=0.08), and verify did not beat collection (10/27). So the verdict survives the
domain change: **no topology *significantly* beats collection — but on a domain where
the answer must be investigated for, driving is the only arm that even leans positive,
and it does so suggestively, not significantly.** Full reframe, calibration, and
per-company A/B: [`docs/results/investment-thesis.md`](results/investment-thesis.md).

## 10. Reproduce

The loop, the worker, the verifier, the claim-grounding mode, the adaptive driver, the
driving driver, the held-out exam, the cost instrumentation, and every A/B are all in
this repository. Each live test gates a cheap one-call glm-5.2 smoke before any
multi-topic burn.

```bash
git clone https://github.com/tangle-network/agent-knowledge
cd agent-knowledge && pnpm install

# offline A/B — deterministic, no credentials (a controlled lower bound that
# exercises the same harness against a planted source pool)
pnpm exec vitest run tests/loops/research-loop-equal-compute.test.ts

# offline claim-grounding + adaptive floors (no credentials)
pnpm exec vitest run tests/loops/claim-grounding-ab.test.ts -t "offline"
pnpm exec vitest run tests/loops/adaptive-ab.test.ts

# the live cleanliness sweep — real web search + a real glm-5.2 verifier, with
# per-arm cost reported (~$0.20 for 9 topics)
export TANGLE_API_KEY=<router key with glm-5.2 credits>
AGENT_KNOWLEDGE_LIVE=1 \
AGENT_KNOWLEDGE_LIVE_GOALS="self-speculative decoding|grouped-query attention|rotary position embeddings|KV-cache quantization|LoRA|ring attention|constitutional AI|the transformer architecture|gradient descent" \
  pnpm exec vitest run tests/loops/research-loop-equal-compute.test.ts

# live misattribution band — three verifier arms over the same proposals
AGENT_KNOWLEDGE_LIVE=1 TANGLE_API_KEY=<…> \
  CLAIM_GROUNDING_LIVE_GOALS='self-speculative decoding|rotary position embeddings|grouped-query attention|KV-cache quantization|LoRA' \
  pnpm exec vitest run tests/loops/claim-grounding-ab.test.ts -t "three verifier arms"

# live adaptive frontier — single / full-LLM / adaptive on the same fetched proposals
AGENT_KNOWLEDGE_LIVE=1 TANGLE_API_KEY=<…> \
  ADAPTIVE_LIVE_GOALS="self-speculative decoding|rotary position embeddings|grouped-query attention|KV-cache quantization|LoRA fine-tuning" \
  pnpm exec vitest run tests/loops/adaptive-ab.test.ts -t "three-topology"

# the research-DRIVING 3-arm A/B (§9) — collect / verify / drive, graded on the
# held-out deep-question exam; re-run at RQ_LIVE_BUDGET=6 to see the verdict flip
AGENT_KNOWLEDGE_LIVE=1 RQ_LIVE_BUDGET=4 TANGLE_API_KEY=<…> \
  pnpm exec vitest run tests/loops/research-driving-ab.test.ts -t "3-arm A/B"

# the controlled multi-round probe — forces 3 rounds so the driver actually steers
AGENT_KNOWLEDGE_LIVE=1 RQ_PROBE=1 RQ_PROBE_ROUNDS=3 TANGLE_API_KEY=<…> \
  pnpm exec vitest run tests/loops/research-driving-ab.test.ts -t "multi-round probe"
```

`AGENT_KNOWLEDGE_LIVE_GOALS` (and the per-result `*_LIVE_GOALS`) take a `|`-separated
topic list; the live arms run the loops on each at equal compute and report the paired
bootstrap and per-arm cost.

**Source:** the loop — [`src/two-agent-research-loop.ts`](../src/two-agent-research-loop.ts);
the live worker + verifier + cost instrumentation — [`src/web-research-worker.ts`](../src/web-research-worker.ts);
the misattribution check — [`src/claim-grounding.ts`](../src/claim-grounding.ts);
the adaptive driver — [`src/adaptive-driver.ts`](../src/adaptive-driver.ts);
the driving driver — [`src/research-driving-driver.ts`](../src/research-driving-driver.ts);
the held-out exam + $0 grader — [`tests/loops/held-out-exam.ts`](../tests/loops/held-out-exam.ts);
the A/B harnesses — [`tests/loops/`](../tests/loops/).
Per-result detail: [`docs/results/cost-quality.md`](results/cost-quality.md),
[`docs/results/claim-grounding.md`](results/claim-grounding.md),
[`docs/results/adaptive.md`](results/adaptive.md),
[`docs/results/research-driving.md`](results/research-driving.md),
[`docs/results/investment-thesis.md`](results/investment-thesis.md) (§9.1 — the domain reframe + calibration + 3-arm A/B).
</content>
</invoke>
