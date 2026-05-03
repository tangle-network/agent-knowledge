# agent-knowledge

Source-grounded, eval-gated knowledge growth primitives for agents.

This package turns raw sources and generated markdown knowledge into a versionable graph that agents can search, lint, evaluate, and improve over time. It is intentionally domain-agnostic: legal, tax, coding, research, finance, business, and scientific workflows define their own policies and rubrics on top.

## Install

```bash
pnpm add @tangle-network/agent-knowledge @tangle-network/agent-eval
```

## CLI

```bash
agent-knowledge init --root .
agent-knowledge index --root .
agent-knowledge search "portfolio risk" --root .
agent-knowledge graph --root . --format json
agent-knowledge lint --root .
```

The default layout is:

```txt
raw/
  sources/
knowledge/
  index.md
  log.md
```

## Design

- Raw sources are immutable evidence.
- Generated knowledge is editable but validated.
- Claims should cite source records when promoted.
- Graph/search/lint are deterministic and fast.
- Optimization uses `@tangle-network/agent-eval` internally instead of reimplementing eval gates.

The `/viz` subpath exports graph insight helpers without UI dependencies.
