# Supervisor prompt + agent-profile ideas

Four `AgentProfile` sketches for the research/knowledge domain — a **researcher worker**, a
**verifier driver**, a **research supervisor**, and a thin **dedup-first verifier** — plus a port
plan for the existing `~/code/supervisor-lab`.

This is a *design doc*, not shipped code. Each sketch names the real primitive it composes (in
`agent-knowledge` or `supervisor-lab`) so building it is "assemble", not "invent". Where a primitive
already exists, the sketch says so and points at it — we extend, we do not fork.

## What we borrowed from emilkowalski/skills

[`emilkowalski/skills`](https://github.com/emilkowalski/skills) is a small pack of Claude skills for
design engineering (`emil-design-eng`, `review-animations`). It is not about agents, but its *skill
shape* is worth copying, and one structural choice maps directly onto our verifier:

- **Tight frontmatter, two fields.** `name` + a one-paragraph `description` that says *when* to
  invoke. Nothing else. Our profiles' `description` should read the same way: a trigger, not a
  feature list.
- **Terse non-negotiable rules over prose.** `review-animations` is "The Ten Non-Negotiable
  Standards" — numbered, imperative, absolute ("Animate `transform` and `opacity` only").
  A worker system prompt is more legible as a short numbered contract than as paragraphs.
- **"Default to flagging; approval is earned."** The review skill is *adversarial by posture* — it
  exists to reject, and its output is a findings table + a verdict. This is exactly the right posture
  for a verifier, and it informs the dedup point below.
- **`disable-model-invocation: true` on the reviewer.** The review skill is not auto-invoked by the
  model; it is routed in deliberately. Our verifier is the same: a driver *calls* it at a gate, the
  worker never invokes it on a whim.
- **Cheap because narrow.** Each skill does one thing. The review skill carries no design *generation*
  ability — it only judges. That separation (generate vs. judge) is the whole reason the judge can be
  thin.

### The dedup insight (why the verifier is a thin profile, not a heavy one)

`review-animations` is mostly a deduplicated rule set: the craft knowledge lives in `emil-design-eng`,
and the reviewer is a thin lens that *applies the same rules* to a diff. It does not re-derive taste;
it checks against a list.

Our verifier is the same. In this repo the "rules" are already deterministic code:

- `createResearcherValidator` (`src/profiles/researcher.ts:235`) — citation-density floor + namespace
  check, **no LLM**.
- the `lint` / `validate --strict` CLI path — citation, link, and schema checks over markdown, **no
  LLM** (`docs/architecture.md`, "The CLI ... does not call an LLM").
- `assessAuthoredProfile` / `profileRichnessFinding` in supervisor-lab's bench — a deterministic
  "is this profile a stub" gate.

So the verifier profile should be **thin and cheap**: it mostly *calls the deterministic checker and
reports the verdict*, escalating to an LLM judge **only** for the residual a deterministic check can't
cover (does the cited source actually support the claim — a semantic check). A heavy verifier that
re-reasons every claim from scratch is wasted spend: the dedup already happened in the validator.
**Spend the model budget on the worker (generation is hard); keep the verifier a cheap lens (judging
against a list is easy).**

---

## Sketch 1 — `grounded-researcher` (leaf worker)

**Status: already exists, twice.** `agent-knowledge` ships `researcherProfile()`
(`src/profiles/researcher.ts:130`) — `tools: { web_search, fs, shell }`, propose-don't-apply, with a
matching `createResearcherValidator`. `supervisor-lab` ships
`profiles/research/grounded-researcher.ts` (web-search MCP, search→cite→synthesize). This sketch is
the **canonical shape both converge on** — build new only if you need a variant; otherwise
`mergeAgentProfiles` over the existing one.

**When to use:** one self-contained research question, spawned one-per-sub-topic by a driver. The
leaf — it does not spawn.

**Tools / resources:** `web_search` (the `tcloud mcp` stdio server, or the `web_search: true` tool),
`fs` for writing the cited dossier, `shell` for `agent-knowledge index/lint`.

**System prompt (the contract):**

```
You are a grounded research WORKER. You answer ONE question, and every load-bearing
claim is traceable to a real source you actually retrieved.

THE LOOP — search → cite → synthesize:
1. SEARCH   issue multiple focused web_search queries; never stop at the first hit.
2. CITE     attach every load-bearing claim to its source (title + url/identifier).
            A claim you cannot cite is a claim you do NOT make. Never invent a source.
3. SYNTH    lead with the answer; note where sources agree, conflict, or leave a gap.

NON-NEGOTIABLE:
- Honest "the evidence is thin / conflicting" beats a confident hallucination.
- Citation density floor is enforced downstream — under-citing is a hard fail, not a warning.
- You are the LEAF. You do not spawn sub-workers.

Return your cited synthesis as the settled output (a structured object if a schema was passed).
```

**Why this shape:** the validator (`createResearcherValidator`) checks citation density and namespace
*deterministically*, so the prompt's job is only to make the worker *produce* citable output — the
checking is not the worker's job. That split is what keeps the verifier cheap (Sketch 4).

---

## Sketch 2 — `verifier-driver` (the gate, NOT the judge)

**Status: composes existing primitives.** This is `agent-runtime`'s `verify({ implement, verifier })`
combinator (`src/runtime/personify/combinators.ts:333`) wired to a research worker + a thin checker.
**Do not write a new verify-loop** — the 2-node implement→gate already exists.

**When to use:** when "did the worker actually deliver" must be proven before the result counts —
i.e. always, on a graded run. A driver that runs ONE worker behind ONE gate.

**Tools:** the coordination verbs (`spawn_agent`, `await_event`, `steer_agent`) over a `Scope`, plus
the ability to call the deterministic checker (`agent-knowledge lint` / `createResearcherValidator`).

**System prompt (the contract):**

```
You are a VERIFIER-DRIVER. You spawn ONE research worker, then you GATE its output —
you never accept the worker's own say-so.

THE GATE — generate → check → decide:
1. SPAWN     author a grounded-researcher worker for the question and spawn it.
2. AWAIT     pull its settled output (await_event). Read the REAL output, not a summary.
3. CHECK     run the DETERMINISTIC checker first (citation density, namespace, lint,
             schema). This is cheap and catches most failures. Only if it PASSES do you
             escalate to the one semantic question a checker can't answer:
             "does each cited source actually support the claim it's attached to?"
4. DECIDE    PASS → settle. FAIL → steer_agent with the SPECIFIC gap named
             ("claim X cites source Y but Y does not say X"), or respawn a sharper worker.

NON-NEGOTIABLE:
- selector != judge. You GATE (pass/fail against a contract); you do not re-rank or
  rewrite the worker's content yourself.
- "Settled a file" is not delivery. The deterministic check passing is delivery.
- Default to FAILING. A pass is earned by surviving the checker, not by looking plausible.
```

**Why this shape:** the driver's intelligence is *deciding what to check and how to steer on a
fail*, not re-doing the research. The expensive judgment (does the source support the claim) is gated
behind the cheap deterministic checker, so on most runs the LLM-judge step never fires.

---

## Sketch 3 — `research-supervisor` (fan-out → fuse → recurse)

**Status: exists as `research-then-build-driver` + `parallel-fanout-supervisor` in supervisor-lab.**
This sketch is the **research-specialized merge** of those two — build new only as a thin overlay via
`mergeAgentProfiles`; the orchestration body is identical.

**When to use:** a research question too broad for one worker — needs decomposition into disjoint
sub-topics, parallel grounded workers, and a fused cited synthesis. The top of a research tree.

**Tools / resources:** coordination MCP (`spawn_agent` / `await_event` / `steer_agent` /
`answer_question` / `stop`) over a `Scope`; `web_search` to *ground the decomposition itself*; skills
`dynamic-workflows`, `orchestrating-workers`, `authoring-agent-profiles` (all already in
`supervisor-lab/skills/`).

**System prompt (the contract):**

```
You are a research SUPERVISOR. You do NOT research the topic yourself — you ground the
decomposition, fan out grounded-researcher workers, gate them, and FUSE their cited findings.

THE SHAPE — ground → fan-out → gate → fan-in:
1. GROUND     web_search FIRST to see what actually exists. Let the real landscape, not
              your priors, define the sub-topics. Cite what you find.
2. DECOMPOSE  split into DISJOINT sub-questions — non-overlapping ownership.
3. FAN OUT    author a grounded-researcher profile per sub-question; spawn ALL of them in
              ONE wave before awaiting any. Vary their angles. Never spawn-await-spawn.
4. GATE       drain await_event. For each settled worker, run the deterministic checker
              (Sketch 4). REJECT uncited or unsupported claims — a finding without a
              source is not a finding. Steer or respawn on a fail.
5. FAN IN     author a FINAL synthesis worker that fuses ONLY the gated findings into one
              cited answer. Never paste raw worker dumps. Check each result for failure first.
6. RECURSE    if a sub-question is itself large, spawn a SUB-supervisor (this profile +
              the coordination MCP) to own it.

NON-NEGOTIABLE:
- Author EACH worker as a FULL profile (name, description, prompt, model, tools, skills).
  A 2-sentence prompt with no tools is a stub, not a worker — the richness gate will flag it.
- Never go blind: keep pulling until every spawned worker is terminal.
- Settle only on gated, cited output. Budget is conserved and depth is bounded by the Scope.
```

**Why this shape:** the supervisor's only real lever is *the quality of the profiles it authors* —
that is the capability `supervisor-lab` measures (`thinProfileRatio`,
`bench/supervise-topology.ts`). The gate (step 4) reuses the cheap verifier so the supervisor doesn't
burn its budget re-judging.

---

## Sketch 4 — `dedup-verifier` (thin, cheap, mostly deterministic)

**This is the emilkowalski dedup lesson made into a profile.** It is deliberately *thin* — the
"taste" lives in the deterministic validator, the profile is just the lens that applies it and
escalates only the residual.

**When to use:** called by a driver/supervisor at a gate (Sketch 2 step 3, Sketch 3 step 4). Never
auto-invoked — the verifier equivalent of `disable-model-invocation: true`.

**Tools:** `shell` (to run `agent-knowledge lint` / `validate --strict`), the
`createResearcherValidator` call, and an LLM *only* for the one semantic check. **No `web_search`, no
`fs` write, no generation tools** — a verifier that can edit content is a verifier that can cheat.

**System prompt (the whole thing — it's short on purpose):**

```
You are a VERIFIER. You judge ONE research output against a fixed contract. You default
to FAILING; a pass is earned. You never edit, research, or rewrite — you only judge.

ORDER (cheapest check first, stop at the first hard fail):
1. DETERMINISTIC   run the validator/lint: citation density >= floor, namespace match,
                   links resolve, schema valid. If any fails → FAIL with the rule name.
                   ~90% of failures die here, at zero LLM cost.
2. SEMANTIC        ONLY if (1) passes: for each cited claim, does the cited source
                   actually support it? This is the one thing a checker can't do. Be terse.

OUTPUT: a findings table (claim | source | supported? | why) + a verdict (PASS / FAIL),
grouped by severity. No prose. A violation is a finding.

You carry NO generation ability by design. If you find yourself wanting to fix the
output, STOP — that is the worker's job, not yours.
```

**Why thin beats heavy here:** the dedup already happened in `createResearcherValidator` and the lint
path. A heavy verifier that re-reasons every claim with an LLM pays full model cost to re-derive a
check the validator does for free, and (worse) a verifier with generation tools can drift into doing
the work and grading itself. Thin + deterministic-first is both cheaper *and* harder to game. Measured
claim to test when built: on a real run, the LLM (step 2) should fire on **< ~10–20% of gated outputs**
because the deterministic check (step 1) absorbs the rest — if it fires on most, the validator floor
is mis-set, not the verifier.

---

## supervisor-lab — status and port plan

**It exists.** `~/code/supervisor-lab` is a real, non-trivial repo
(`github.com/tangle-network/supervisor-lab`), not a stub. `ls ~/code | grep -i supervisor` → it's
there.

It already is what one might propose to "create": the product/experiment layer for supervisor agents
over the `agent-runtime` substrate, dependency-one-way (`supervisor-lab → agent-runtime →
agent-eval`). It ships:

- **the two-agent loop, already ported** — `bench/supervise-topology.ts` is exactly the "two-agent
  loop": a supervisor mounts the coordination MCP over a live `Scope`/`Supervisor`
  (`createSupervisor`, `serveCoordinationMcp`), authors worker `AgentProfile`s as code, spawns them,
  drains the bus (`await_event`), steers (`steer_agent`), and grades on a real judge. It has an
  **OFFLINE $0 scripted path** and a LIVE cli-bridge path. This is the loop to plug these sketches
  into — it does not need to be built.
- **profile archetypes** — `profiles/research/{grounded-researcher,research-then-build-driver}.ts`,
  `profiles/engineering/{parallel-fanout-supervisor,long-horizon-plan-driver,hardware-auditor}.ts`.
  Sketches 1 and 3 above are *already these files*.
- **a skill layer** — `skills/{authoring-agent-profiles,orchestrating-workers,dynamic-workflows,
  spawning-research-loops}/SKILL.md`, each in the exact emilkowalski frontmatter+rules shape.
- **a catalog + ingest pipeline** — `src/catalog/`, `src/ingest/skills.ts` ingests vendored
  Claude-Code-style skill packs (the same shape as `emilkowalski/skills`) by convention.
- **the richness gate** — `assessAuthoredProfile` / `profileRichnessFinding` / `thinProfileRatio`,
  the deterministic "is this a stub" check that is the dedup-verifier's first line.

### How to port the two-agent loop (it's already there — this is how to extend it)

Because the loop already exists, "porting" means **adding these four profiles + the thin-verifier gate
into the existing harness**, not rebuilding it:

1. **Land the profiles as catalog files.** Sketches 1 and 3 are already
   `profiles/research/grounded-researcher.ts` and `research-then-build-driver.ts`. Sketch 2
   (`verifier-driver`) and Sketch 4 (`dedup-verifier`) are new files under
   `profiles/research/` — author them as `defineAgentProfile` entries, resolve their skills via the
   `skills(...)` helper in `profiles/_shared.ts` (fails closed on an unknown skill).

2. **Wire the dedup-verifier into the gate.** In `bench/supervise-topology.ts`, the worker's
   `runWorker` already grades on `adapter.judge`. For research tasks, replace/augment that with the
   deterministic `createResearcherValidator` + `agent-knowledge lint` path FIRST, and only escalate to
   the LLM semantic check on a deterministic pass. This is the dedup point made executable: the
   existing `assessAuthoredProfile` richness gate is the *profile* check; the validator is the
   *output* check. Both run before any LLM judge.

3. **Add a research bench arm.** `supervise-topology.ts` auto-detects domain (repo vs. answer/text).
   A research arm is an "answer/text" task whose `adapter.judge` is the cited-output validator. Add
   `BENCH=research` that loads a research question + namespace and grades via
   `createResearcherValidator`. The OFFLINE scripted path already proves the harness at $0; extend
   `scriptedRun.workerResult` to emit a cited/uncited synthesis so the offline smoke exercises the
   verifier without spend.

4. **Run the existing experiment knob.** The whole point of the lab is the one knob: catalog/skills
   ON vs. OFF (`CATALOG=1`). With these profiles + the thin verifier in the catalog, run
   capability-aware vs. baseline on a hard research task and read `thinProfileRatio` + delivery rate —
   does giving the supervisor the research archetypes + the cheap gate produce better-composed teams
   and more *cited, gated* deliveries.

### Cross-repo note

`agent-knowledge` already owns the deterministic research checker (`createResearcherValidator`, the
`lint`/`validate` CLI) and the researcher profile (`researcherProfile`,
`multiHarnessResearcherFanout`). The thin verifier should **call those**, not reimplement them —
`supervisor-lab` depends on `agent-runtime`, and the research checks live in `agent-knowledge`, so the
research bench arm pulls `@tangle-network/agent-knowledge` for the verifier's deterministic line. That
keeps the dedup in one place: the validator is authored once, the verifier profile is a thin lens over
it.
