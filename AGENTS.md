# Agent Knowledge Operator Guide

Use this package when an agent needs persistent, source-grounded knowledge that improves over time.

## Package layering

```
agent-runtime
      |
agent-knowledge
    /       \
agent-eval  agent-interface
```

Imports flow downward in this diagram.
`agent-knowledge` may import `agent-eval` and `agent-interface`, but it must not import `agent-runtime`.
Agent-powered work enters this package through callbacks.
`agent-runtime` owns live agent execution and composes this package when a complete agent workflow is needed.
`agent-eval` must not import `agent-knowledge`.
Shared run and experiment types that knowledge needs live in `agent-eval`.

Types that stay in THIS repo because they're knowledge-domain-shaped:
- `KbStore`, `KnowledgeFragment`, `KnowledgeChange`
- `KnowledgeDiscoveryDispatcher`, source adapters (`createCornellLiiSource`, `createIrsPublicationsSource`)
- Freshness store + change-detection primitives

**The test for "where does a type live?"**
If the concept makes sense without persistent knowledge or sourced fragments, it belongs in `agent-eval` or `agent-interface`.
Otherwise, it stays in this package.

## Rules

- Register sources before citing them: `agent-knowledge source-add <path>`.
- Generated pages live under `knowledge/`.
- Raw evidence lives under `raw/sources/` and should not be edited.
- Run `agent-knowledge index` after page changes.
- Run `agent-knowledge lint` before trusting or promoting knowledge.
- Treat `missing-source` lint findings as blocking.
- Use `--json` for automation.

## Common Commands

```bash
agent-knowledge init
agent-knowledge source-add ./source.md --json
agent-knowledge apply-write-blocks ./proposal.txt
agent-knowledge index --json
agent-knowledge search "query" --json
agent-knowledge inspect --json
agent-knowledge explain knowledge/concepts/example.md --json
agent-knowledge lint --json
agent-knowledge validate --strict --json
agent-knowledge viz --json
```

## Write Proposal Format

Agents should stage generated edits as FILE blocks:

```txt
---FILE: knowledge/concepts/example.md---
---
id: example
title: Example
sources:
  - src_abc123
---
# Example

Sourced knowledge with links to [[Related Page]].
---END FILE---
```

The parser rejects absolute paths, `..`, control characters, and writes outside `knowledge/`.

## Eval Boundary

Use a complete `OptimizationMethod` from `@tangle-network/agent-eval` with `runRetrievalImprovementLoop()`, `runRagOptimization()`, `optimizeKnowledgeBasePolicy()`, or `runAgentMemoryImprovement()`.
The method owns candidate search and resume compatibility.
This package owns serialized knowledge candidates, real KB or memory adapters, isolated data partitions, and safe activation.

Use `knowledgeReleaseReport()` before promotion. It folds the candidate and baseline `RunRecord[]` (plus optional traces and the gate decision) into `agent-eval` release confidence evidence.

## Integration Boundaries

- Use `KbStore` for storage. Applications may provide any durable backend that implements it.
- Use `new FileSystemKbStore({ root })` when opening a knowledge-base root; it keeps every record under `<root>/.agent-knowledge/` — index, event log, and per-run claim ledgers.
  The string constructor retains the published direct-directory behavior.
  A legacy string that names `<root>/.agent-knowledge` is canonicalized to the same root lock, so the two constructor forms cannot race on one file under different locks.
  The store is the single writer of `index.json`; `writeKnowledgeIndex` goes through it.
  Do not add a second writer for a record this store owns.
- Research state is durable state. A driver that accumulates belief across rounds takes a store and a `ledgerId` (`createPersistentResearchDrivingDriver`) so corroboration counts, contradiction edges, and open questions survive the process. `runVerifiedResearchLoop` durably announces a fold before its synchronous question generation, calls `driver.checkpoint()` before publishing the round event, and reconstructs an interrupted fold on resume.
- `TrackedClaim` remains the live Set-based driver API; `ResearchClaimRecord` is its sorted-array durable form. Convert at the persistence boundary rather than changing the published live shape.
- More than one writer per ledger means `mergeClaimLedger(id, merge)`, never `putClaimLedger`. `putClaimLedger` writes the whole record, so two writers accumulating into one ledger each write what they built from a stale read and the later write erases the earlier writer's claims. `mergeClaimLedger` holds the store's lock across read, merge, and write; `mergeClaimLedgers` is the combining rule and is commutative, associative, and idempotent, so replay and arrival order cannot change the result.
- Use `writeFileDurable` / `writeJsonDurableWithinRoot` from the entrypoint for any file that must survive a crash. They are atomic, fsynced, and symlink-safe; a hand-rolled `writeFile` is none of those.
- Use `KnowledgeDiscoveryDispatcher` for research workers. Applications should connect it to their own runtime.
- Do not bypass `lint` or `validate` before using generated knowledge in an agent.

## Pluggable Sources + Freshness + Changes

Agents that need to stay current against external authorities should compose:

- `createCornellLiiSource({ selectors })`: US Code and Wex from law.cornell.edu.
- `createIrsPublicationsSource({ publications, revenueProcedures })`: IRS index and named publications.
- `createStateSosSource({ state, baseUrl, entities })`: generic state SOS adapter.

Every fetch returns `KnowledgeFragment[]` with `provenance.verifiable` indicating whether the configured URL returned an acceptable response and the expected content was extracted.
This flag does not authenticate the publisher or cryptographically prove the content.
Refuse to cite fragments with `verifiable: false`.

Track per-tenant freshness with `createFileSystemFreshnessStore({ root })` and re-fetch only when `stale({ workspaceId, sourceId, ttlMs })` returns true.

Diff snapshots with `detectChanges(prev, next)`.
Each `KnowledgeChange` carries `affectedDimensions`; pass those to your eval scheduler to run only the relevant campaigns again.

## Authorship

Do not add `Co-Authored-By:` trailers or other AI-attribution lines to commits, PR descriptions, or repository artifacts.
The author is the human running the session.

## Comment & doc discipline (no historical narrative)

Comments describe **what the code does and why**.
They must not describe what code used to do, what it replaced, which audit found a bug, or what a prior version looked like.
History belongs in commit messages and PR descriptions.

- Bad: `// replaces the inline retry loop`, `// fix for the silent-zero bug`, `// the 2yr rewrite added this`, `// audit fix`
- Good: `// value is null when retries exhaust; callers must inspect succeeded`

This applies anywhere the repository carries prose.

## No fallbacks. Fail loud.

Sloppy fallbacks corrupt every signal downstream. No silent zeros, no `?? default` on required fields, no `try/catch { return null }` that erases diagnostic info, no legacy back-compat mode defaulted on for new code.

External-boundary calls (LLM, network, FS, subprocess) return *typed outcomes* (`{ succeeded, value, error }`). Callers MUST inspect `succeeded` before using `value`. Named, opted-in fallback rotations (`policy.fallbackModels: [...]`) are fine; deep `?? "kimi"` helpers are not.

Full doctrine: `~/dotfiles/claude/AGENTS.md` → "No fallbacks. Fail loud."
