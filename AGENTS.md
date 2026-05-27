# Agent Knowledge Operator Guide

Use this package when an agent needs persistent, source-grounded knowledge that improves over time.

## Repo layering — this package depends on agent-eval, never the reverse

```
agent-knowledge (this repo) ─┐
                             ├──► agent-eval (substrate — the bottom)
agent-runtime ───────────────┘
```

**Rule: agent-knowledge depends on agent-eval. agent-eval MUST NOT import from agent-knowledge.** No upward imports, no peerDependency declaration in agent-eval pointing at agent-knowledge. Substrate primitives that agent-knowledge needs (`AnalystFinding`, `RunRecord`, optimizer types, release-confidence types) live in agent-eval; this repo consumes them.

Types that stay in THIS repo because they're knowledge-domain-shaped:
- `KbStore`, `KnowledgeFragment`, `KnowledgeChange`
- `KnowledgeDiscoveryDispatcher`, source adapters (`createCornellLiiSource`, `createIrsPublicationsSource`)
- Freshness store + change-detection primitives

**The test for "where does a type live?"** — does this concept make sense WITHOUT persistent knowledge or sourced fragments? If yes, it's substrate (agent-eval). If no, it's a knowledge-domain concept (stays here).

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

Use `runKnowledgeBaseOptimization()` when comparing candidate knowledge bases on an actual task corpus. It delegates to `@tangle-network/agent-eval` multi-shot optimization, so single-turn and multi-turn agents share the same path.

Use `knowledgeReleaseReportFromOptimization()` before promotion. It projects optimizer traces and `RunRecord` rows into `agent-eval` release confidence evidence.

## Integration Boundaries

- Use `KbStore` for storage. Implement D1 in the consuming app when needed.
- Use `KnowledgeDiscoveryDispatcher` for research workers. Production apps should wire this to their own swarm/fleet runtime.
- Do not bypass `lint` or `validate` before using generated knowledge in an agent.

## Pluggable Sources + Freshness + Changes

Agents that need to stay current against external authorities should compose:

- `createCornellLiiSource({ selectors })` — US Code + Wex from law.cornell.edu.
- `createIrsPublicationsSource({ publications, revenueProcedures })` — IRS index + named pubs.
- `createStateSosSource({ state, baseUrl, entities })` — generic state SOS adapter.

Every fetch returns `KnowledgeFragment[]` with `provenance.verifiable` indicating whether the authority was successfully authenticated. Refuse to cite fragments with `verifiable: false`.

Track per-tenant freshness with `createFileSystemFreshnessStore({ root })` and re-fetch only when `stale({ workspaceId, sourceId, ttlMs })` returns true.

Diff snapshots with `detectChanges(prev, next)`. Each `KnowledgeChange` carries `affectedDimensions` — pass those to your eval scheduler to re-run only the relevant campaigns.

## Authorship

Do not add `Co-Authored-By:` trailers (or any other AI-attribution lines) to commits, PR descriptions, or other artifacts in this repo. Author = the human running the session. Applies to every contributor, including AI agents and subagents — do not include the default Claude Code template trailer.

## Comment & doc discipline (no historical narrative)

Comments describe **what the code does and why** — never what it used to do, what it replaced, which audit found a bug, or what the prior version looked like. History belongs in commit messages and PR descriptions, not the source tree.

- Bad: `// replaces the inline retry loop`, `// fix for the silent-zero bug`, `// the 2yr rewrite added this`, `// audit fix`
- Good: `// value: null when retries exhaust — callers must inspect succeeded`

Applies to docstrings, README sections, SKILL.md, AGENTS.md, CLAUDE.md — anywhere the source tree carries prose.

## No fallbacks. Fail loud.

Sloppy fallbacks corrupt every signal downstream. No silent zeros, no `?? default` on required fields, no `try/catch { return null }` that erases diagnostic info, no legacy back-compat mode defaulted on for new code.

External-boundary calls (LLM, network, FS, subprocess) return *typed outcomes* (`{ succeeded, value, error }`). Callers MUST inspect `succeeded` before using `value`. Named, opted-in fallback rotations (`policy.fallbackModels: [...]`) are fine; deep `?? "kimi"` helpers are not.

Full doctrine: `~/dotfiles/claude/AGENTS.md` → "No fallbacks. Fail loud."

