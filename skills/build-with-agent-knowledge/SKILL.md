---
name: build-with-agent-knowledge
description: Build, evaluate, and improve source-backed knowledge, retrieval, and memory systems.
---

# Build With Agent Knowledge

Use this when a product needs a knowledge base, retrieval system, RAG improvement process, or agent memory provider.
Read the installed package README, exports, types, and nearest tests before choosing an API.
Do not copy signatures from this skill.

## Choose The Job

| Product need | Package capability |
|---|---|
| Start a source-backed Markdown knowledge base | File knowledge base and source registry |
| Search an existing package knowledge base | File search provider or a product search adapter |
| Improve knowledge without editing live files | Isolated knowledge candidates |
| Tune retrieval on labeled questions | Retrieval improvement loop |
| Diagnose and repair retrieval, sources, pages, and answers together | RAG knowledge improvement loop |
| Compare memory systems | Memory adapter and experiment APIs |
| Run retrieval, answer, knowledge, or memory cases | Knowledge benchmark APIs |
| Let agents research or edit candidates | Runtime knowledge integration |

Use the narrowest capability that solves the product problem.
Do not add an agent loop when deterministic ingestion or indexing is enough.

## Define Truth And Success

Record:

- the user task the knowledge should improve;
- authoritative and disallowed sources;
- tenant, user, agent, and sharing scope;
- freshness and deletion requirements;
- the current retrieval, answer, or memory baseline;
- objective checks, semantic checks, cost, and latency limits;
- who may approve and apply a candidate.

Use independent labels and source evidence.
The agent's current answer is not a gold answer.

## Keep The Boundary Clean

`agent-knowledge` owns source records, indexes, retrieval tests, memory contracts, isolated candidates, and exact promotion.
It does not own model choice, prompts, browsing, agent scheduling, product authorization, or product storage transactions.

Supply callbacks for research, retrieval, answer generation, and scoring.
Use `@tangle-network/agent-runtime/knowledge` when those callbacks should run agents.
Use existing vector, graph, search, and memory systems through adapters instead of rebuilding their databases here.

## Build The Smallest Complete Path

1. Ingest one real source with provenance and tenant scope.
2. Build or connect the index used by the product.
3. Run one representative query or memory sequence through the production path.
4. Capture retrieved items, final answer or action, citations, errors, tokens, cost, and latency.
5. Prove a known good case passes and a realistic unsupported or missed case fails.
6. Add only the missing improvement step: retrieval search, source acquisition, page update, answer repair, or memory policy.
7. Write changes to an isolated candidate with a stable run identity.
8. Compare baseline and candidate on the same development cases, then on unseen cases.
9. Apply only an approved candidate whose base identity is still current.

Use separate run IDs for parallel branches and the same run ID to resume interrupted work.
Reject stale promotion rather than replacing newer knowledge.

## Evaluate The Right Layer

| Layer | Minimum evidence |
|---|---|
| Retrieval | Labeled relevant items, ranking measures, misses, latency, and cost |
| Answer | Claim support, relevance, citation correctness, abstention, and final text |
| Knowledge base | Source coverage, provenance, freshness, structure, conflicts, and validation findings |
| Memory | Multi-turn task outcome, correct recall, harmful recall, isolation, writes, latency, and cost |

Report service and measurement failures separately from product failures.
Keep candidate-generation cases separate from the final decision set.
Bundled benchmark samples prove adapter wiring only; use complete external datasets for benchmark claims.

## Completion

One customer-like path must prove:

```text
source or memory event -> production retrieval -> observable answer or action
-> isolated candidate -> baseline comparison -> unseen comparison
-> approved promotion or correctly rejected change -> reproducible rerun
```

Report installed versions, exact imports, provider adapters, scope policy, case counts, baseline and candidate results, cost, latency, candidate identity, promotion result, and artifact paths.

## Then consider

- `eval-engineering` when new production-derived cases are needed.
- `build-with-agent-runtime` when agents should research, edit, or compare candidates.
- `agent-eval-adoption` when the product needs shared comparison and release records.
- `harden` when changing tenant isolation, source trust, deletion, or promotion authority.
