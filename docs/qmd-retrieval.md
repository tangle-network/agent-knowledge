# QMD source snapshots

`createQmdSearchProvider` binds QMD's public SDK to one caller-authorized source snapshot.
The host owns the index, collection, source registry, scope identity, and revision.
Neither query text nor tool input can select another collection or source path.
No QMD dependency or model is loaded by Knowledge; inject an installed SDK store.

```ts
import { createStore } from '@tobilu/qmd'
import { createQmdSearchProvider, createQmdKnowledgeTools } from '@tangle-network/agent-knowledge'

const client = await createStore({ dbPath: '/private/play-a/checkpoint-1/index.sqlite' })
const provider = createQmdSearchProvider({
  client,
  collection: 'play-a',
  scopeId: 'play-a',
  revision: 'checkpoint-1',
  documents: approvedSources, // [{qmdPath, source: SourceRecord}]
  // indexedAt: the index owner's recorded successful update time, if known
})
const result = await provider.search('What was independently checked?')
const tools = createQmdKnowledgeTools({ provider, namePrefix: 'agent_runtime_coordination_' })
// The host mounts only tools explicitly granted by the exact AgentProfile.
// Close the injected client after every consumer has finished.
```

Each source requires its original URI and the SHA-256 of the exact indexed UTF-8
text. Search results are joined to the approved manifest; full returned bytes are
checked against the source hash before delivery. Missing documents, foreign
results, and stale content fail explicitly. Do not replace a failed query with an
empty successful result. The response includes the scope, revision, content-bound
snapshot digest, authorized document count, and index timestamp (null if unknown).
That count is the allowed corpus size, not a measurement of index completeness.
A search miss does not establish that an attempt never happened.

Use a dedicated collection containing only the approved snapshot, and prefer a
dedicated SQLite index for independent plays. A collection filter alone is not
authorization. The host must also limit access to the injected client, storage,
and server credentials; these factories cannot restrict a caller that separately
holds a global QMD client. Restrict raw file and MCP access through the same host.

Resume reopens the same source manifest and index. A fork uses a fixed copy of the
parent's approved source manifest and immutable source bytes, with a new scope and
index. Subsequent writes publish a new source revision and update its derived
index before mounting that revision. Retain prior revisions and their hashes;
do not relabel a live parent collection as a frozen fork.

Lexical search invokes no model. Vector search requires `mode: 'vector'` and an
injected client with `searchVector`, using the host's explicitly configured
embedding model. This adapter does not expand queries, rerank, embed documents,
or synthesize answers. QMD SDK 2.8.3 supplies the supported public methods.

The `qmd_search` and `qmd_read` tools call the same provider as a human reader.
Search returns bounded opening excerpts and exact source references; read returns
line-numbered source slices. Runtime's existing tool-call trace records execution;
retrieval alone does not prove a finding changed an agent's decision.
