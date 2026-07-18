# Research-driving versus collection: a held-out deep-question result

*Tangle Network · `agent-knowledge`*

## Verdict

We built a research driver whose job is to push a web-research loop **deeper**:
extract each source's claims, demand a second independent source for every claim,
generate comparative / mechanism / contradiction sub-questions, and steer the
worker to chase them. The hypothesis: a KB built this way answers **more held-out
deep questions** than one built by plain collection or by a relevance/dedup
verifier.

On a **firewalled exam of 20 deep questions across 5 ML topics**, graded with a
$0 deterministic check the loop never sees, at equal compute, **the driving loop
did NOT reliably beat plain collection, and cost ~12–16× more.** The verdict
flips with the compute budget, which is the tell that it is **noise, not signal**:

| arm | answered @ B=4 | answered @ B=6 | cost (5 topics) | tokens |
|---|---|---|---|---|
| single-agent (collect) | 13/20 | **15/20** | $0.005–0.007 | ~2.4–3.0k |
| verify/dedup | **15/20** | **15/20** | $0.031–0.027 | ~21k |
| **DRIVING (deepen)** | **16/20** | 13/20 | **$0.089–0.084** | ~69–71k |

Driving "wins" at B=4 (16 > 15 > 13) and "loses" at B=6 (13 < 15), while the
single-agent arm itself swings 15→13 and driving swings 16→13 on the *same* exam.
At n=5 topics a ±1–3 question difference is within the run-to-run web variance;
the arms are not separated by topology, they are separated by **which pages the
web returned that minute**. The one thing that is stable and large is the **cost**:
driving spends an order of magnitude more for no reliable quality gain.

**Why** (the autopsy that explains it, §4): every arm finished in **one effective
round** (`passes=2` on every topic, every budget). The generic readiness gate,
"one source closes the gap", is satisfied by the first round's fetch, so the
loop *stops before the driving driver ever steers a second round*. Driving's
entire mechanism is multi-round (extract → demand corroboration → re-search). So
the headline A/B under-tests it. **We then ran a controlled test**, a
controlled probe (§5) that *forces* 3 rounds so the driver actually steers, and
it **still does not win: 8 vs 8 against a blind worker, at ~9× the cost.** The
same result remains after controlling the stopping condition.

This is a real negative result, and we report it as one.

## 1. Why a new metric

The prior A/B in this repo
([two-agent-research-ab.md](../two-agent-research-ab.md)) measured **cleanliness**
- how *few* sources a verifier admits at equal coverage. That is the right metric
for a verifier whose job is to filter. It is the **wrong** metric for the driving
driver, whose thesis is the opposite: it is not trying to admit fewer sources, it
is trying to build a KB that *answers more*. Measuring it on admitted-count would
score its whole point as a regression (it admits *more*, because it accepts every
source with an extractable claim and then chases more).

So we need a metric for research **quality**, not hygiene. We use:

> **QUALITY = how many held-out deep questions the resulting KB can answer.**

## 2. The held-out exam (the firewall)

[`tests/loops/held-out-exam.ts`](../../tests/loops/held-out-exam.ts). 5 ML topics,
4 questions each = **20 deep questions**. Each is a *depth* question by
construction, comparative, mechanism-level, or contradiction-aware, chosen so a
single web search for the topic name does **not** surface the answer:

- *speculative decoding*, the rejection-sampling acceptance rule and why output
  is lossless; how self-speculative/Medusa (no draft model) trades off vs the
  two-model scheme; what bounds the speedup; why one verify pass is ~free.
- *LoRA*, the `W = W₀ + BA` update and which matrices train; QLoRA's 4-bit
  tradeoff; why LoRA adds zero inference latency (merge); the very-low-rank claim.
- *grouped-query attention*, the MQA↔GQA↔MHA spectrum of KV heads; the real
  bottleneck (KV cache / memory bandwidth, not FLOPs); uptraining from a
  checkpoint; the MQA quality cost GQA recovers.
- *RLHF/PPO*, the KL-to-reference penalty and what it prevents; the pairwise
  preference reward model + Bradley-Terry loss; DPO's reward-model-free insight;
  PPO's clipped surrogate.
- *mixture-of-experts*, top-k routing and sparse activation; load imbalance + the
  auxiliary balancing loss; params-decoupled-from-FLOPs; the memory cost at
  inference.

**The firewall.** The questions and their expected answers are **never shown to
any loop.** A loop is told only the topic name and the *same generic readiness
specs* every arm gets ("what X is and how it works" / "results, mechanisms,
trade-offs"). It researches blind. **After** it finishes, we grade the KB it built
against the held-out questions with a **$0 deterministic substring grader** (no
LLM, so the exam cannot leak into a model the loop observes), where each question
carries the specific load-bearing answer tokens as keyword groups (a number, a
name, a mechanism phrase), with synonym groups so a faithful page in its own words
still grades as answered.

**The exam discriminates depth, not surface facts** (calibration, run offline):

| graded against | held-out answered |
|---|---|
| a one-line topic-definition snippet (what a single search returns) | **0 / 20** |
| a deep, mechanism-rich paragraph | **20 / 20** |

So a high score is only reachable by depth, the firewall is real, and the gap
between arms (if any) would be real depth, not grader slack.

## 3. The three arms, at equal compute

[`tests/loops/research-driving-ab.test.ts`](../../tests/loops/research-driving-ab.test.ts).
All three arms run the **same** real web worker
([`createWebResearchWorker`](../../src/web-research-worker.ts), glm-5.2 query-gen
→ live `/v1/search` → `politeFetch` → `htmlToText`). They differ **only** in the
driver:

- **(A) single-agent collection**: the worker alone, no driver. It collects.
- **(B) verify/dedup**: [`createVerifyingResearchDriver`](../../src/web-research-worker.ts):
  a second glm-5.2 pass filters each source for relevance / near-duplicates.
- **(C) DRIVING**: [`createResearchDrivingDriver`](../../src/research-driving-driver.ts):
  the driver extracts each source's claims (glm-5.2), tracks independent-source
  support + contradictions, and folds comparative / mechanism / gap /
  contradiction sub-questions into the worker's next prompt.

**Equal compute** is counted in agent passes (same unit as the prior A/B): a
single-agent iteration is 1 worker pass; a two-agent round is 1 worker + 1 driver
pass = 2. Each arm gets the same pass ceiling B; the single-agent arm gets more
iterations to spend the budget the two-agent arms burn on their driver. Cost is
read per-arm from `RouterClient.usage()`, measured dollars/tokens/calls, not
estimates.

## 4. Result: driving does not reliably win, and the verdict flips with budget

Per-topic held-out questions answered (out of 4 each), at both budgets:

| topic | single B4 / B6 | verify B4 / B6 | driving B4 / B6 |
|---|---|---|---|
| speculative decoding | 1 / 2 | 2 / 2 | 2 / 1 |
| LoRA | 2 / 3 | 2 / 3 | 3 / 3 |
| grouped-query attention | 4 / 4 | 4 / 4 | 4 / 4 |
| RLHF / PPO | 2 / 2 | 3 / 3 | 3 / 2 |
| mixture-of-experts | 4 / 4 | 4 / 3 | 4 / 3 |
| **total /20** | **13 / 15** | **15 / 15** | **16 / 13** |

The driving arm answers **16** at B=4 and **13** at B=6, a 3-question swing on
the *same* exam, the same arm, just a different compute ceiling and a different
minute of web results. Single swings 13→15; verify is flat 15→15. **The within-arm
swing is as large as the between-arm gap**, which is the signature of a null:
whatever separates a "win" from a "loss" here is web variance, not the driver.

The **cost**, by contrast, is stable and large. Driving spends **~$0.084–0.089**
across 5 topics vs **~$0.005–0.007** for single-agent, **12–16× the dollars** and
**~24× the tokens** (~70k vs ~2.5k), because it runs a claim-extraction LLM call
on every fetched source. For that 12–16× it buys no reliable held-out-question
gain over plain collection.

### Why every arm stopped after one round

The decisive diagnostic is `passes=2` on **every** topic at **every** budget: the
two-agent loop ran exactly **one** worker round before the readiness gate reported
done, even with B=6 budget for three rounds. The generic specs require one source
to close a gap, and the worker's first-round fetch closes them, so the loop stops
before round 2. The driving driver's mechanism is *multi-round*: round 1 extracts
claims and flags the weakly-supported ones; round 2+ is where it steers the worker
to corroborate and go deeper. **It never got a round 2.** So in this setting
driving's only active effect was a one-round claim-extraction tax with no chance to
use what it extracted, which is exactly what the numbers show: same answers as
collection, much higher cost.

That makes the equal-compute/generic-gate A/B a test of the wrong thing for the
driving thesis. The fair test has to *force* multiple rounds.

## 5. Controlled multi-round probe

To isolate "does depth-steering help **when it actually runs**?", we raise the
readiness bar so the gate stays unmet and the loop runs the full round budget,
forcing the driving driver to steer each round. Same real worker, same number of
rounds; the only difference is whether the driver **steers** (driving) or the
worker **re-searches the same gaps blind** (a no-op driver that accepts every
source and never steers). If driving's steering has any value, this is where it
shows.

**Result, 3 rounds, 3 topics, driving steers vs blind re-search:**

| topic | driving (steered) answered / cost | blind (no steer) answered / cost |
|---|---|---|
| speculative decoding | 2/4; $0.032 | **4/4; $0.004** |
| LoRA | 3/4; $0.028 | 3/4; $0.003 |
| RLHF / PPO | **3/4**; $0.033 | 1/4; $0.003 |
| **total /12** | **8/12; $0.093** | **8/12; $0.010** |

**Steering does not help: 8 vs 8, at ~9× the cost.** In the controlled test, the
full multi-round regime its mechanism was designed for, the driving driver ties a
blind worker that just re-searches the same gaps three times. It is **better on
RLHF** (3 vs 1, the one topic where chasing corroboration found a page blind
re-search missed) and **worse on speculative decoding** (2 vs 4, steering pulled
the worker *off* the pages that answered the exam and toward corroborating a
narrower claim set). Those cancel. So the depth-steering does change *what* gets
fetched, but not *how many* held-out questions get answered, and it pays ~9× the
dollars for the privilege. The headline null (§4) is therefore **not** merely a
gate artifact: even forced to run, driving does not beat blind collection on
research quality at this n.

## 6. Threats to validity

- **Small n, high web variance.** n = 5 topics; one live run per arm per budget.
  The §4 budget-flip is itself the evidence that the per-run magnitudes are
  variance-bound. We did not run a paired bootstrap because the within-arm swing
  already exceeds the between-arm gap, the supported conclusion is "no separation," and a
  significance test on a known-null at n=5 would dress it up, not clarify it.
- **The gate, not the driver, ended the headline loop (§4), but the probe
  controls for it.** The headline A/B's generic one-source readiness gate closed
  every loop after one round, so on its own it would only show "driving adds a
  one-round extraction tax." The §5 probe removes that confound by forcing 3
  rounds, and driving still ties blind (8 vs 8), so the null survives the fix,
  it is not an artifact of the permissive gate.
- **The worker is shared and shallow.** All arms use the same ~500-line direct
  pipeline (query-gen → search → fetch), not an `AgentProfile` on a harness. A
  richer worker that follows citations or reads PDFs might give depth-steering more
  to work with.
- **glm-5.2-specific.** A stronger extractor/judge would change both the cost and
  the per-round depth. The grader is conservative (substring/synonym presence); a
  faithful paraphrase using none of the listed synonyms would read as unanswered.
- **Depth-components is a proxy.** "Distinct expected-answer groups present" tracks
  the binary answered-count closely here; it is a finer-grained view, not an
  independent oracle.

## 7. What this says, plainly

Adding a "drive it deeper" agent did **not** make the research measurably better at
answering hard, held-out questions, at equal compute (§4) *and* forced to run its
full multi-round mechanism (§5), on this worker, at n=5, and it cost 9–16× more.
The steering changes *what* gets fetched (it helped on RLHF, hurt on speculative
decoding) but not *how many* held-out questions get answered. The most durable
thing the experiment produced is the **measurement method**: a firewalled
deep-question exam with a $0 deterministic grader that *can* tell depth from
surface (0/20 vs 20/20), reusable for any future research-quality claim in this
repo. The driving thesis, that pursuing depth + corroboration beats plain
collection, is, on the evidence here, **not supported**; the cheaper paths
(collect, or dedup) match it. Where it might still earn its cost: a worker rich
enough that "go corroborate this claim" reaches a page blind re-search can't
(the RLHF case), measured at an n large enough to separate that from variance.

## 8. Reproduce

```bash
git clone https://github.com/tangle-network/agent-knowledge
cd agent-knowledge && pnpm install

# offline: the exam wiring + the $0 grader (no credentials)
pnpm exec vitest run tests/loops/research-driving-ab.test.ts

# the live 3-arm A/B: real web search + glm-5.2, per-arm cost reported
export TANGLE_API_KEY=<router key with glm-5.2 credits>
AGENT_KNOWLEDGE_LIVE=1 RQ_LIVE_BUDGET=4 \
  pnpm exec vitest run tests/loops/research-driving-ab.test.ts -t "3-arm A/B"
# re-run at RQ_LIVE_BUDGET=6 to see the verdict flip (the §4 variance point)

# the controlled multi-round probe: forces N rounds so driving actually steers
AGENT_KNOWLEDGE_LIVE=1 RQ_PROBE=1 RQ_PROBE_ROUNDS=3 TANGLE_API_KEY=<…> \
  pnpm exec vitest run tests/loops/research-driving-ab.test.ts -t "multi-round probe"
# (~$0.10 for the 5-topic A/B at one budget; ~$0.10 for the 3-topic probe)
```

`RQ_LIVE_TOPICS` takes a `|`-separated subset of the exam topic names to run a
cheaper slice. The exam is held out by construction, no flag shows it to a loop.

**Source:** the exam and grader:
[`tests/loops/held-out-exam.ts`](../../tests/loops/held-out-exam.ts);
the 3-arm A/B and multi-round probe:
[`tests/loops/research-driving-ab.test.ts`](../../tests/loops/research-driving-ab.test.ts);
the driving driver under test:
[`src/research-driving-driver.ts`](../../src/research-driving-driver.ts).
