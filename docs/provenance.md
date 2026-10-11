# Prove what the agent saw and used

> Extracted from the README — see the [README](../README.md) for the package overview.

## Prove what the agent saw and used

A page existing in a knowledge base, a page appearing in retrieval results, and a page influencing a decision are three different facts. The receipt APIs preserve those joins without pretending they prove the page is true or that it improved the outcome.

```ts
import {
  createKnowledgeRetrievalReceipt,
  createKnowledgeUseReceipt,
  createKnowledgeVisibilitySnapshot,
  encodeKnowledgeVisibilitySnapshot,
  KNOWLEDGE_SEARCH_RETRIEVER_ID,
  knowledgeVisibilityArtifactRef,
} from '@tangle-network/agent-knowledge'

const visibility = createKnowledgeVisibilitySnapshot(await runStores.loadChain(runId))
const bytes = encodeKnowledgeVisibilitySnapshot(visibility)
await artifacts.put('artifact://run/visibility.json', bytes)

const retrieval = createKnowledgeRetrievalReceipt({
  runId,
  query: 'prior verifier obstruction',
  retriever: { id: KNOWLEDGE_SEARCH_RETRIEVER_ID, version: '1.0.0', configDigest },
  visibility,
  visibilityArtifact: knowledgeVisibilityArtifactRef({
    uri: 'artifact://run/visibility.json',
    bytes,
  }),
  results,
})

const use = createKnowledgeUseReceipt({
  retrieval,
  selectedRank: 1,
  relation: 'extends',
  consumer: { kind: 'artifact', uri: 'artifact://run/DECISION.md', digest },
})

console.log(visibility.snapshotDigest, retrieval.receiptDigest, use.receiptDigest)
```

ELI5: the visibility snapshot is the bookshelf the agent was allowed to see, the retrieval receipt is the exact books search handed back, and the use receipt records which returned book the agent attached to a downstream decision or artifact.

Create the snapshot once per knowledge view and reuse it: the retrieval receipt stores the snapshot's digest, page count, and storage locator, not its pages, so repeated queries over one view do not re-serialize the inventory.
`verifyKnowledgeRetrievalReceipt` proves the receipt itself; `assertKnowledgeRetrievalMatchesVisibility` and `assertKnowledgeRetrievalMatchesVisibilityArtifact` prove that every returned result occurs in that exact snapshot.

The receipts are content-addressed and mutation-sensitive. They do **not** establish correctness, novelty, compliance, or causal lift; Eval owns those later judgments. Read [knowledge retrieval and use receipts](docs/knowledge-use-receipts.md) for the complete proof boundary, trace attributes, and experiment design.