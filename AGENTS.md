# Agent Knowledge Operator Guide

Use this package when an agent needs persistent, source-grounded knowledge that improves over time.

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
