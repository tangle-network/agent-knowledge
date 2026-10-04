# Play-scoped Hindsight memory

`@tangle-network/agent-knowledge/memory` provides `createHindsightMemoryAdapter`
for the pinned Hindsight **0.10.2** API and `createPlayMemoryTools` for an
explicitly commissioned play. The host supplies the authenticated transport;
this package does not discover servers, grant tools, start services, or import
Runtime. Hindsight is optional and adds no SDK dependency.

Use a stable logical play namespace and branch ID. A new execution attempt may
reuse that identity; an independent play or checkpoint fork gets a new identity.
Keep the Runtime attempt ID in the host's invocation provenance. Putting a
changing attempt ID into the memory scope deliberately selects another bank.

```ts
import {
  createAgentMemoryBranch,
  createHindsightMemoryAdapter,
  createPlayMemoryTools,
} from '@tangle-network/agent-knowledge/memory'

const branch = createAgentMemoryBranch({
  adapter: createHindsightMemoryAdapter({
    client: authenticatedClient,
    backendRef: 'qualified-private-hindsight-deployment',
    branchId: 'terraform-play-branch-1',
  }),
  branchId: 'terraform-play-branch-1',
  baseScope: { namespace: 'terraform-play-1' },
  policy: { read: ['shared'], write: 'shared' },
})

const tools = createPlayMemoryTools({
  branch,
  actorId: trustedRuntimeNodeId,
  onCheckpoint: saveAcceptedCheckpoint,
  recordRetrieval: saveRetrievalReceipt,
  namePrefix: 'agent_runtime_coordination_',
})
```

The tools are ordinary Agent Interface `ToolDefinition` values with Zod
`inputSchema` and JSON `inputSchemaJson`. A Runtime resolver converts that shape
and grants the exact profile names `agent_runtime_coordination_memory_recall`
and `agent_runtime_coordination_memory_record`. The resolver validates the
commissioned execution identity before exposing them. Actor attribution is
write metadata and retrieval receipt metadata; it does not partition shared
memory. Every collaborator in one process uses the same branch instance.

The injected client has one method:

```ts
request({ method, path, body, signal }): Promise<{ status, body }>
```

It owns endpoint selection, credentials, network access, and response decoding.
The adapter selects only `/version` and its bound bank's document, operation,
retain, and recall paths. It derives a full SHA-256 bank ID from deployment
identity, branch ID, and the entire physical scope supplied by the existing
branch policy. Tags alone are not an isolation boundary. A raw transport that
can access every bank is still a host capability; do not expose it to agents.
Host loopback access does not establish access from a cloud Sandbox.

## Writes and recovery

`memory_record` requires a stable caller ID, kind, text, and optional title and
source references. It refuses caller-supplied scopes, banks, and metadata.
The host must retain the original tool input before dispatch so an interrupted
call can be retried with the same ID, bytes, and actor. The tool requires an
`onCheckpoint` callback and acknowledges accepted writes only after it returns.
Persist snapshots through the application's existing record owner and durable
filesystem helpers; an in-memory callback is not durable persistence.

The adapter submits bounded asynchronous retains with deterministic native
operation IDs and waits for explicit completion. It checks the retained
document's ID, exact source text, and provenance digest before acceptance.
Native completion means ingestion completed, not that a claim was validated.
Retrying a completed tool input uses the journal and does not submit another
retain. Conflicting bytes under one ID are refused.

An ambiguous response, timeout, failure, cancellation, or expired operation
history remains unknown. A source document by itself does not prove successful
ingestion. An unresolved operation blocks checkpointing; retry the same write
to reconcile it. In-process tool publication serializes collaborators and
requires reconciliation before another write. Do not silently generate a new
ID after an ambiguous response. Provider work may continue after the client
stops waiting, but it remains confined to that branch's bank.

To resume, deserialize the saved snapshot and construct a fresh adapter with
the same deployment and branch identities. Pass the snapshot to
`createAgentMemoryBranch`; preserve its scope and policy instead of recreating
equivalent-looking values. Rebinding is continuation against retained provider
state, not rollback to a historical provider database image. Calls interrupted
before journal publication must be reconciled from the host's saved tool input.

To fork, call `forkAgentMemoryBranchSnapshot` with the saved snapshot, a fresh
adapter bound to a new branch ID, and a new play namespace. The existing branch
owner replays accepted source inputs into the child's bank. Parent writes after
the checkpoint are excluded. Extracted facts can differ because replay performs
new model-backed ingestion; this is not a transactional Hindsight bank clone.
An interrupted fork can leave a partial isolated bank. This adapter offers no
clear/cancel guarantee; failed fork cleanup is explicit and the host must
quarantine its ID rather than publish a successful checkpoint.

One trusted branch owner per play is required. Separate processes or independent
director controllers need an application-owned serialized publication path.
Whole-snapshot last-writer-wins persistence can lose another director's journal.
This module does not implement a cross-process journal merger or scheduler.

## Evidence and cost

Recall returns provider facts, original document metadata, source-fact IDs where
the provider supplies them, and an explicit attribution status. The receipt
hash covers the actual delivered context and actor. Optional undefined object
fields are omitted exactly as in JSON serialization. A receipt proves delivery,
not that an agent used or verified the information. Register and validate source
evidence through the normal Knowledge intake before promoting findings.

Defaults bound source text to 8,000 characters, each request to 15 seconds,
ingestion polling to 120 seconds, and recall to the provider's low budget with
1,000 output tokens. Native model cost is currently unmeasured and is never
reported as zero. There is no measured corpus-scale latency guarantee. Journal
snapshots and forks scale with accepted source inputs; neither is O(1).

For immutable source-document search and reads, use the separate
[QMD provider](qmd-retrieval.md). A source manifest and a memory branch are
different evidence views that the host can commission under the same play.
