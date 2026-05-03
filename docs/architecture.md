# Architecture

`@tangle-network/agent-knowledge` is a domain-agnostic knowledge growth layer for agents.

It does not try to be a vector database, a RAG framework, or a product-specific wiki. It owns the small set of primitives every serious agent knowledge system needs:

- immutable source records
- generated knowledge pages and units
- claims with source references
- deterministic indexing, graph construction, search, and lint
- safe LLM write proposals
- eval-gated optimization through `@tangle-network/agent-eval`
- visualization DTOs under the `/viz` subpath
- storage contracts with memory/filesystem reference adapters
- discovery worker/dispatcher contracts
- event and release report models
- Zod schemas for public JSON shapes

## Boundaries

`agent-eval` owns traces, ASI, multi-shot optimization, run records, and promotion gates.

`agent-knowledge` owns sources, claims, pages, graph/search/lint, and knowledge base candidates. It calls `agent-eval` instead of reimplementing evaluation.

Product apps own domain policies, source adapters, task corpora, and promotion decisions.

Core does not own a D1 schema or fleet dispatcher. Apps wire `KbStore` and `KnowledgeDiscoveryDispatcher` to their tenancy, queue, budget, auth, and sandbox systems.

## Runtime Loop

1. Normalize sources into immutable source records.
2. Generate staged knowledge write proposals.
3. Parse write proposals through the safe write protocol.
4. Validate paths, citations, links, and schema.
5. Index generated knowledge pages.
6. Search and graph-lint the knowledge base.
7. Evaluate candidate KB variants with `runKnowledgeBaseOptimization`.
8. Promote only variants that pass downstream gates.

## CLI

The CLI is intentionally fast and local:

```bash
agent-knowledge init
agent-knowledge source-add ./source.md
agent-knowledge sources
agent-knowledge apply-write-blocks ./proposal.txt
agent-knowledge index
agent-knowledge search "query"
agent-knowledge inspect
agent-knowledge explain knowledge/concepts/example.md
agent-knowledge graph
agent-knowledge lint
agent-knowledge validate --strict
agent-knowledge export --format json
agent-knowledge viz
```

It does not call an LLM. It operates over markdown and cached JSON indexes so fleet jobs and dev containers can use it cheaply.
