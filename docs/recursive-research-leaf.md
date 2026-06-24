# Skill: spawn a driver-loop as a leaf for a large sub-topic

Supervisor-facing guidance. The `runResearchSupervisor` brain (see
`src/research-supervisor.ts`) decomposes a goal into sub-topics and spawns one
researcher per sub-topic over the live `Scope`. By default each spawn is a **bare
worker**: a single researcher pass that adds sources and proposes pages.

For a **large** sub-topic, a single worker pass under-covers it. The recursive
move is to spawn, in place of that bare worker, a **driver-loop leaf** — a child
that is itself a driver running its own worker (the two-agent loop), so the
sub-topic gets verify + gap-fill + readiness-gate iteration, not one shot.

`agent-runtime`'s `Scope.spawn(agent, task, opts)` makes this a first-class
recursion: the spawned `Agent` can itself be a driver, not just a worker. The
supervisor spawns a child `Agent` whose `act(task, childScope)` runs
`runTwoAgentResearchLoop` (or its own `runResearchSupervisor`) scoped to the
sub-topic, against the SAME knowledge base root, with a sub-topic-scoped slice of
readiness specs. The conserved budget pool reserves `opts.budget` for the child
atomically and refunds the unspent remainder on settle, so a driver-loop leaf
spends from the same pool a bare worker would have — depth costs budget, not extra
budget.

## When it's worth it

Spawn a driver-loop leaf (instead of a bare worker) for a sub-topic when ANY of
these hold; otherwise spawn a bare worker.

| Signal | Bare worker | Driver-loop leaf |
| --- | --- | --- |
| **Breadth** — distinct readiness specs the sub-topic must close | 1–2 | 3+ |
| **Depth** — does a fact need a source THEN a derived claim citing it? | shallow (source ≈ answer) | layered (source → claim → cross-check) |
| **Expected rounds** — passes to reach no-blocking-gaps for the sub-topic | ~1 | 2+ (a worker's first pass predictably leaves blocking gaps) |
| **Verification risk** — is a wrong/duplicate source likely and costly here? | low | high (the leaf's driver rejects bad sources before they commit) |
| **Budget headroom** — iterations/tokens left in the pool for this branch | tight | comfortable (a leaf needs ≥ ~3× a worker's per-pass spend) |

Rule of thumb: **breadth ≥ 3 specs OR expected rounds ≥ 2 OR high verification
risk ⇒ driver-loop leaf.** A sub-topic that is one fact from one source is a bare
worker — wrapping it in a driver only burns budget on a loop that stops after
round 1.

## The shape

```ts
import type { Agent, Scope } from '@tangle-network/agent-runtime/loops'
import { runTwoAgentResearchLoop, type TwoAgentResearchLoopResult } from '@tangle-network/agent-knowledge'

// For a LARGE sub-topic, spawn a sub-driver leaf that runs the two-agent loop
// scoped to that sub-topic. The child shares the KB root and the conserved
// budget pool; it gets its own driver (verify + fill + gate) instead of a single
// worker pass. The child is an `Agent` whose `act` IS the two-agent loop.
const researchLeaf: Agent<typeof subTopic, TwoAgentResearchLoopResult> = {
  name: `research-leaf:${subTopic.id}`,
  async act(task, childScope: Scope<TwoAgentResearchLoopResult>) {
    return runTwoAgentResearchLoop({
      root, // the SAME knowledge base
      goal: task.goal,
      worker, // the sub-topic researcher
      driver, // verifies the worker's sources, gap-fills, gates on readiness
      driverResearches: true, // the leaf's driver also researches the missed gaps
      readinessSpecs: task.specs, // the sub-topic's slice of the gate
      signal: childScope.signal,
    })
  },
}

// Reserves `budget` from the conserved pool atomically; refunds on settle.
const spawned = scope.spawn(researchLeaf, subTopic, {
  label: `research-leaf:${subTopic.id}`,
  budget: perSubTopicBudget, // a slice of the conserved pool
})
if (!spawned.ok) {
  // fail-closed: 'budget-exhausted' | 'depth-exceeded' — spawn a bare worker or stop.
}
```

A bare worker, by contrast, is `scope.spawn(workerFromBackend(backend)(...), …)`
of the researcher profile — no inner driver, no per-sub-topic readiness gate, one
pass.

## Why this is a leaf, not a fork

The driver-loop leaf is still ONE branch of the supervisor's tree. It reads and
writes the same knowledge base, settles back through the same `Scope`, and
spends from the same budget pool. The recursion is depth (a sub-driver inside a
branch), not a second knowledge base — there is exactly one KB, and the
supervisor's readiness gate over the whole KB is still what ends the run.
