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
agent-knowledge source-add ./docs/spec.md --root .
agent-knowledge sources --root .
agent-knowledge apply-write-blocks ./proposal.txt --root .
agent-knowledge index --root .
agent-knowledge search "portfolio risk" --root .
agent-knowledge inspect --root .
agent-knowledge explain knowledge/concepts/risk.md --root .
agent-knowledge graph --root . --format json
agent-knowledge lint --root .
agent-knowledge validate --strict --root .
agent-knowledge export --root . --format json
agent-knowledge viz --root .
```

The default layout is:

```txt
raw/
  sources/
knowledge/
  index.md   # scaffold: human-navigation only, excluded from the page index
  log.md     # scaffold: human-navigation only, excluded from the page index
.agent-knowledge/
  sources.json
  index.json
```

`initKnowledgeBase` writes `knowledge/index.md` and `knowledge/log.md` for
authors to curate by hand. They are deliberately excluded from
`buildKnowledgeIndex` / `searchKnowledge` so they do not inflate page counts
or pollute search hits. Any nested `<dir>/index.md` or `<dir>/log.md` is
treated the same way. The shared predicate is `isScaffoldPath`, exported
from `@tangle-network/agent-knowledge`.

## Design

- Raw sources are immutable evidence.
- Generated knowledge is editable but validated.
- Claims should cite source records when promoted.
- Lint fails on pages that cite unknown source IDs.
- Text sources get deterministic anchors (`all`, `l1`, `l51`, ...) for precise citations like `[^src_id#all]`.
- Agent write proposals can be safely applied with `apply-write-blocks`.
- `KbStore` keeps storage consumer-owned; use `MemoryKbStore`, `FileSystemKbStore`, or implement D1 in the app.
- Discovery uses worker/dispatcher contracts, with a local dispatcher for dev and tests.
- Zod schemas define the stable wire shape.
- Graph/search/lint are deterministic and fast.
- `searchKnowledge` returns hits with three score fields. `score` and
  `rrfScore` are the raw reciprocal-rank-fusion value (typically 0.01–0.05);
  use them when intent matters or when fusing across queries.
  `normalizedScore` is the same value scaled into [0, 1] relative to the top
  hit *in this result set* (top hit = 1, others = score / topScore) — use it
  when comparing against natural confidence thresholds. The normalization is
  within-set ranking, not a cross-query absolute confidence.
- Optimization uses `@tangle-network/agent-eval` internally instead of reimplementing eval gates.

The `/viz` subpath exports graph insight helpers without UI dependencies.

## Agent-Eval Integration

Use `runKnowledgeBaseOptimization()` when the question is whether a candidate knowledge base actually improves agent task success. The candidate is passed through `runMultiShotOptimization`, so `n=1` single-turn tasks and variable-length multi-turn traces use the same path.

Use `knowledgeReleaseReportFromOptimization()` to turn optimizer output into release confidence evidence using `agent-eval` release gates and `RunRecord` validation.
