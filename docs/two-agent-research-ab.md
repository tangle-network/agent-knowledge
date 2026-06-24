# Two-agent research loop: does a verifying second agent build a cleaner knowledge base?

A small, honest A/B. We ran two research loops side by side at **equal compute** and
measured what each one wrote into the knowledge base. The two-agent loop admitted
**2.33 fewer sources per topic at identical coverage** — but most of that win is
cheap de-duplication, not the LLM verifier earning its keep. The numbers and the
caveats are below.

## What it is

A **two-agent research loop** that grows one knowledge base:

- A **worker** turns each open knowledge-gap into web search queries, runs a real
  web search, fetches the top results, and proposes them as sources. It only *adds*.
- A **verifying driver** — a *second* agent — judges each fetched source **before**
  it is saved: is it on-topic for the goal, and is it a near-duplicate of something
  already accepted this round? It rejects the rest. It only *gates*.
- Both loops stop on the same **readiness spec** (a checklist of what the knowledge
  base must cover). The driver never gets free compute — every verify pass is
  charged against the same budget the single-agent loop is free to spend on extra
  fetches.

We compare this against a **single-agent loop** that does the same research but just
accumulates every source it finds, with no second agent gating what gets saved.

The real code:

- The loop — [`runTwoAgentResearchLoop`](../src/two-agent-research-loop.ts)
  (`src/two-agent-research-loop.ts`)
- The worker + verifying driver — [`createWebResearchWorker` and
  `createVerifyingResearchDriver`](../src/web-research-worker.ts)
  (`src/web-research-worker.ts`)
- The A/B harness — [`tests/loops/research-loop-equal-compute.test.ts`](../tests/loops/research-loop-equal-compute.test.ts)

## The result

Real run: **n = 9 ML topics**, equal compute, `glm-5.2` as both worker and verifier.

The metric is **admitted sources per topic** at equal coverage. Fewer admitted
sources at the *same* coverage = a cleaner knowledge base (the same facts, less
redundant clutter). Coverage was a perfect **1.00 for both arms on every topic**, so
the comparison is apples-to-apples: same coverage, fewer sources kept.

**The two-agent loop admitted 2.33 fewer sources per topic.**
95% confidence interval **[1.78, 2.89]** (paired bootstrap via agent-eval's
`pairedBootstrap`). The interval is well above zero, so the gap is not noise.

Per-topic delta (single-agent admitted − two-agent admitted):

| Topic | Fewer sources with the verifier (Δ) |
| --- | --- |
| Self-speculative decoding | 3 |
| Grouped-query attention | 3 |
| Constitutional AI | 3 |
| Transformer architecture | 3 |
| Gradient descent | 3 |
| Rotary position embeddings | 2 |
| Ring attention | 2 |
| KV-cache quantization | 1 |
| LoRA | 1 |

Mean Δ = 2.33. Every topic moved in the same direction.

## The honest nuance

**The win is mostly de-duplication, not relevance filtering.**

When you web-search an ML topic, the same canonical paper comes back mirrored across
arxiv, OpenReview, the NeurIPS proceedings, a lab's blog, and so on. The verifier's
biggest job, in practice, is spotting *"this is the same paper I already accepted"* —
a near-duplicate rejection that fires on **every** topic regardless of how hard the
topic is. Genuine off-topic rejection (spam, a marketing page, a tangential result)
is real, but it's the minority of what the verifier catches.

The blunt implication: **a cheap content-hash or canonical-URL dedup would capture
most of this value without an LLM verifier at all.** The LLM verifier earns its keep
only on the off-topic minority — the cases a hash can't see. If you're deciding
whether to pay for a second agent, that's the honest trade: you're mostly paying for
de-dup you could do for free, plus a smaller slice of judgement you can't.

## Threats to validity

Read these before quoting the headline number.

- **The verifier is also the judge.** Admitted-source count is a *proxy* for
  cleanliness. There is no independent oracle saying which sources a knowledge base
  *should* have kept — so "fewer admitted at equal coverage" is the best signal we
  have, not ground truth.
- **The deltas are conservative.** The single-agent loop stops early when readiness
  is met, so it often doesn't even spend its full budget — meaning the real gap under
  a fixed budget could be larger than what we measured here.
- **n = 2 clean controls is thin.** The offline, deterministic version of this A/B
  (the one that runs with no credentials) uses a planted source pool with just two
  clean control sources. It proves the harness wiring and a controlled lower bound,
  not real-world magnitude. The live 9-topic sweep is the real evidence.
- **It's `glm-5.2`-specific.** Both the worker and the verifier are `glm-5.2`. A
  different model could be a sharper or a sloppier judge.
- **Web research is high-variance.** Run-to-run, the same topic can swing — one topic
  produced Δ of 0, then 1, then 3 across repeats, because the live web returns
  different result sets each time. The interval above accounts for between-topic
  spread, not this within-topic search noise.

## How to run

### Offline A/B (deterministic, no credentials)

This proves the harness and the controlled lower bound — no network, no keys. It runs
both loops on a planted source pool (clean sources plus planted spam) and asserts the
verifying driver admits no more junk than the single-agent loop at equal compute.

```bash
pnpm install
pnpm exec vitest run tests/loops/research-loop-equal-compute.test.ts
```

The test logs the A/B line, e.g.:

```
[A/B @ B<=6 passes] two-agent: passes=2 junk=0 coverage=1.00 | single-agent: passes=2 junk=2 coverage=1.00
```

— same coverage, the two-agent loop keeps the junk out. The live arm in the same file
is skipped offline.

### Live sweep (the real evidence)

The live arm runs both loops on real topics with the real web-research worker
(`glm-5.2` query-gen → live web search → fetch → readable text) and a real `glm-5.2`
verifying driver, then reports the paired comparison via `pairedBootstrap`. It's gated
on credentials so it never runs by accident.

Set the credentials and the topic list, then run the same test file:

```bash
AGENT_KNOWLEDGE_LIVE=1 \
TANGLE_API_KEY=sk-...                     # a Tangle router key with glm-5.2 credits \
AGENT_KNOWLEDGE_LIVE_GOALS="self-speculative decoding|grouped-query attention|rotary position embeddings|KV-cache quantization|LoRA|ring attention|constitutional AI|transformer architecture|gradient descent" \
pnpm exec vitest run tests/loops/research-loop-equal-compute.test.ts
```

Knobs (all optional):

- `AGENT_KNOWLEDGE_LIVE_GOALS` — `|`-separated topics. The live arm already supports a
  list and runs the `pairedBootstrap` across them. Default: a single topic.
- `AGENT_KNOWLEDGE_LIVE_BUDGET` — agent-pass ceiling per arm (default `4`).
- `AGENT_KNOWLEDGE_LIVE_MODEL` — router chat model (default `glm-5.2`).

The full 9-topic sweep above costs roughly **$0.20** in router spend.
