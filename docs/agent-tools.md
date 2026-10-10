# Give an agent the tools

> Extracted from the README — see the [README](../README.md) for the package overview.

## Give an agent the tools

`createKnowledgeTools` returns provider-neutral `ToolDefinition[]` for search, read, record, and resolve. Knowledge owns what each tool does; a runtime only transports the definitions and the calls.

```ts
const tools = createKnowledgeTools({
  stores,
  runId,
  retrieverVersion,
  actorId,
  intake: {},
  recordRetrieval: (receipt) => ledger.append(receipt),
})
```

`knowledge_search` builds a brief and mints a retrieval receipt on every call, so retrieval is recorded by the infrastructure rather than claimed by the run.
`knowledge_read` reports an id visible at two origins as `ambiguous` with both candidates, and never chooses one.
`knowledge_record` writes into this run's store through the intake gate.
Each proposal must contain complete `---FILE: <page-path>---` / `---END FILE---` blocks, with delimiters on separate lines.
The tool rejects malformed, unsafe, or empty proposals before writing any pages.
Read an existing page before editing it.
Pass expectedPageDigests with the page path and pageDigest returned by knowledge_read.
The write checks each digest under the store lock.
A stale edit refuses the whole proposal and names the current digest.
New pages need no digest; an explicit null requires the path to be absent.
Retrying an identical completed write is safe.
It does not report a partial write as tool success.
The lower-level `applyKnowledgeWriteBlocks` API retains its explicit `written` and `warnings` result for callers that inspect partial proposals.
`knowledge_resolve` returns the resolution status of each reference.
Every tool result carries `timing` in milliseconds: `viewMs` to obtain the current page view for search, read and resolve, `visibilityMs` to persist a search's snapshot, and `lockWaitMs` and `lockHoldMs` for a record.
Tools re-read only the page files whose identity changed since the previous call, and concurrent calls share one refresh.

Knowledge tools retain write history by default.
Each transaction records the host actorId, runId, and exact prior and new bytes.
An absent author remains explicitly null.
An application can disable history with retainHistory: false.
Lower-level writers opt into history with retainHistory: true and conditional edits with expectedPageDigests.
Completed write transactions then retain their existing manifest and before/after snapshots under `.agent-knowledge/history/<transactionId>`.
The move is atomic and a repeated finish after a lost acknowledgement is idempotent.
The default remains cleanup after completion, so callers choose retention deliberately and account for its unbounded storage growth.
Retained bytes inherit the store's access boundary; this option does not publish or merge them.
Use the existing transaction and candidate-snapshot readers to inspect or restore them.

Supply `retrieverVersion` yourself: a bundled build cannot read its own manifest, and a receipt that guessed the version would be a receipt that lies about what ranked the results.

When a retrieval influences nothing, record that too:

```ts
createKnowledgeRetrievalDisposition({
  retrieval: receipt,
  relation: 'no-use',
  consumer: { kind: 'decision', uri },
})
```

A use receipt requires a selected rank, so without this record a retrieval that influenced nothing is indistinguishable from a retrieval nobody bothered to record. `irrelevant` means the results did not bear on the question; `no-use` means they did and the consumer still used none of them.