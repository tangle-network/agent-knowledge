# A verifier agent mostly deduplicates: a controlled A/B on two-agent web research

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
relevance filtering we expected. The off-topic rejections we hypothesized were the
minority. Most of the value is therefore recoverable with a content hash; the LLM
verifier earns its cost only on the long tail, where a source looks on-topic but
isn't.

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
more.

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
`research` pass.

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
~$0.20 to run) and also the loop's main simplification debt; see §6.

### 2.3 Equal compute

Compute is counted in agent passes. A two-agent round = 1 worker pass + 1
verify pass = 2 passes; a single-agent iteration = 1 pass. Both arms gate on the
*same* readiness criterion and stop as soon as it is met, so neither is starved.
We budget-match by passes, not rounds — the single-agent loop gets more rounds to
spend the compute the two-agent loop spends on verification. The harness asserts,
per topic, that the two-agent loop spent no more passes than the single-agent loop
and that both stayed under the ceiling; if that ever fails the comparison has
drifted to unequal compute and the result is void.

### 2.4 Topics and readiness

9 topics, each with two blocking requirements (the defining mechanism, and reported
results / trade-offs). Seven are "narrow-scope-inside-a-broad-space" (e.g.
*self-speculative decoding* inside *speculative decoding*), where we expected the
broad space to leak in; two are clean controls (*the transformer architecture*,
*gradient descent*).

## 3. Results

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

## 4. What the verifier actually does

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

## 5. Limitations

- **The verifier is also the judge.** Admitted-count is a proxy; we have no
  independent oracle for whether a dropped source was genuinely redundant. The
  verifier's stated reasons hold up on inspection, but this is the load-bearing
  caveat.
- **Deltas are conservative.** The single-agent loop stops on the same readiness
  gate, capping its admits; with more iterations it would admit even more junk, so
  the true gap is at least this large.
- **n = 2 clean controls** is too thin to compare bands with confidence.
- **glm-5.2-specific.** A weaker or stronger judge would shift rejection rates.
- **High web variance.** One run per topic; results move with what search returns.

## 6. A simpler loop

Two simplifications fall out of the above.

1. **The worker should be an `AgentProfile`, not a bespoke pipeline.** The live
   worker is ~500 lines hand-wiring query-generation, search, fetch, and proposal
   against the router directly. The repo's own pattern is to *author* a profile
   (`researcherProfile`) and run it on a harness with a web-search tool — reusable
   and harness-agnostic — rather than re-implement the agent loop. The direct
   pipeline is cheaper to run today (no harness, no creds beyond the router) but it
   is the loop's main piece of duplication.
2. **The driver doesn't need an LLM for most of its work.** Since the win is
   dominated by de-duplication, the efficient shape is a deterministic dedup
   (content hash / canonical-URL normalization) followed by a *light* LLM check only
   for the off-scope tail — not a full glm-5.2 `verifySource` call on every fetched
   source. Same cleanliness, a fraction of the calls.

Neither is built yet; they are the obvious next step if this loop graduates from
experiment to production.

## 7. Reproduce

The loop, the worker, the verifier, and this A/B are all in this repository.

```bash
git clone https://github.com/tangle-network/agent-knowledge
cd agent-knowledge && pnpm install

# offline A/B — deterministic, no credentials (a controlled lower bound that
# exercises the same harness against a planted source pool)
pnpm exec vitest run tests/loops/research-loop-equal-compute.test.ts

# the live sweep — real web search + a real glm-5.2 verifier (~$0.20 for 9 topics)
export TANGLE_API_KEY=<router key with glm-5.2 credits>
AGENT_KNOWLEDGE_LIVE=1 \
AGENT_KNOWLEDGE_LIVE_GOALS="self-speculative decoding|grouped-query attention|rotary position embeddings|KV-cache quantization|LoRA|ring attention|constitutional AI|the transformer architecture|gradient descent" \
  pnpm exec vitest run tests/loops/research-loop-equal-compute.test.ts
```

`AGENT_KNOWLEDGE_LIVE_GOALS` takes a `|`-separated topic list; the live arm runs
both loops on each at equal compute and reports the paired bootstrap.

**Source:** the loop — [`src/two-agent-research-loop.ts`](../src/two-agent-research-loop.ts);
the live worker + verifier — [`src/web-research-worker.ts`](../src/web-research-worker.ts);
the A/B harness — [`tests/loops/research-loop-equal-compute.test.ts`](../tests/loops/research-loop-equal-compute.test.ts).
