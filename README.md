# @tangle-network/agent-knowledge

Build, search, test, and improve source-backed knowledge bases in TypeScript.

The package manages source records, Markdown knowledge, indexes, retrieval tests, candidate workspaces, and memory adapters. It does not browse, call models, or run agents — supply application callbacks, or use `@tangle-network/agent-runtime` to run them with agents.

## Install

```bash
pnpm add @tangle-network/agent-knowledge
```

Requires Node.js 22.12 or later. See the [compatibility table](./docs/compatibility.md) for peer version requirements.

## Contents

- [Choose an API](#choose-an-api) — which surface for which job
- [Create and search](#create-and-search-a-knowledge-base) — your first knowledge base in 30 seconds
- [Prove what the agent saw](./docs/provenance.md) — retrieval and use receipts
- [Improve a live knowledge base](./docs/improvement.md) — without editing in place
- [Evaluate and improve RAG](./docs/rag-evaluation.md) — retrieval testing
- [CLI](./docs/cli.md) — command-line tools
- [Agent tools](./docs/agent-tools.md) — MCP-style tool access
- [Memory systems](./docs/memory.md) — adapters for external memory

## Choose an API

| Goal | Start with | Import |
|---|---|---|
| Create a file-backed knowledge base | `initKnowledgeBase`, `addSourceText`, `applyKnowledgeWriteBlocks` | package root |
| Search an existing knowledge base | `createFileSystemSearchProvider` | package root |
| Isolate knowledge per run | `createRunScopedStores` | package root |
| Prove what was visible and used | `createKnowledgeRetrievalReceipt`, `createKnowledgeUseReceipt` | package root |
| Improve a live knowledge base | `improveKnowledgeBase` | package root |
| Evaluate retrieval quality | the `@tangle-network/agent-eval` integration | package root |
| Run from the CLI | `agent-knowledge` CLI | `npx` |

## Create and search a knowledge base

This example stores one source, writes one cited page, validates the result, and searches it.

```ts
import {
  addSourceText,
  applyKnowledgeWriteBlocks,
  createFileSystemSearchProvider,
  initKnowledgeBase,
  validateKnowledgeIndex,
  writeKnowledgeIndex,
} from '@tangle-network/agent-knowledge'

const root = './support-kb'
await initKnowledgeBase(root)

const source = await addSourceText(root, {
  uri: 'inline://refund-policy',
  title: 'Refund policy',
  text: 'Customers may request a refund within 30 days of purchase.',
})

await applyKnowledgeWriteBlocks(
  root,
  [
    '---FILE: knowledge/refunds.md---',
    '---',
    'id: refunds',
    'title: Refunds',
    'sources:',
    `  - ${source.id}`,
    '---',
    '# Refunds',
    `The refund window is 30 days.[^${source.id}#all]`,
    '---END FILE---',
  ].join('\n'),
)

const index = await writeKnowledgeIndex(root)
const validation = validateKnowledgeIndex(index, { strict: true })
if (!validation.ok) throw new Error(JSON.stringify(validation.findings))

const search = createFileSystemSearchProvider({ root, index })
console.log(await search.search('How long is the refund window?', { limit: 3 }))
```

The provider ranks with BM25 over title, path, and body, keeps exact-title and phrase matches ahead of bag-of-words matches, and fuses that list with link and shared-source structure by reciprocal rank fusion.
It builds the lexical index once per page index and drops both together on `refresh` or `invalidate()`.
Declare `KNOWLEDGE_SEARCH_RETRIEVER_ID` (`bm25-rrf-v1`) as the retriever id when minting a retrieval receipt from these results.
Pass `refresh: 'always'` to rebuild its index before every query, or call `invalidate()` after changing files.
Use `asRetrievalEvalRetriever()` to send the same search path into retrieval tests.

`knowledgePageRelations(pages)` lists the labeled relations between pages (`wikilink`, `citation`, `shared-source`, `contradicts`), and `buildKnowledgeGraph` collapses them into the weighted page graph stored in the index.

Pages live under `knowledge/` unless you name another root-relative directory.
`loadKnowledgePages`, `buildKnowledgeIndex`, `writeKnowledgeIndex`, `applyKnowledgeWriteBlocks`, `createFileSystemSearchProvider`, and `createRunScopedStores` all take one `pagesDirectory` option (`KnowledgePagesOptions`), so a store laid out as `kb/pages/<line>/` is read, indexed, searched, chained, and written through the same value.
The write protocol and the file transaction refuse a `FILE` block outside `<pagesDirectory>/`, and `normalizePagesDirectory` refuses `..`, absolute paths, drive letters, and the package-owned `.agent-knowledge` and `raw` trees.

## Documentation

| Topic | Document |
|---|---|
| Retrieval and use receipts (provenance) | [docs/provenance.md](./docs/provenance.md) |
| Improving a live knowledge base | [docs/improvement.md](./docs/improvement.md) |
| Retrieval evaluation (RAG) | [docs/rag-evaluation.md](./docs/rag-evaluation.md) |
| CLI commands | [docs/cli.md](./docs/cli.md) |
| Agent tool access | [docs/agent-tools.md](./docs/agent-tools.md) |
| Memory adapters | [docs/memory.md](./docs/memory.md) |
| Compatibility and peer versions | [docs/compatibility.md](./docs/compatibility.md) |

## License

MIT
