# Knowledge retrieval and use receipts

A knowledge page appearing in a prompt, a final answer resembling a prior result, and a citation in a generated document are three different facts. None of them alone proves that a particular agent retrieved a particular page and used it in a downstream decision.

This module records two immutable links:

```text
exact visible knowledge snapshot
        ↓
retrieval receipt (references the snapshot by digest)
        ↓
selected returned result
        ↓
knowledge-use receipt
        ↓
decision / artifact / experiment / candidate / message
```

The receipts establish provenance. They do not decide whether using the knowledge was wise, whether the downstream result is correct, or whether it is novel. Those are Eval questions over the retained evidence.

## Visibility snapshot

`createKnowledgeVisibilitySnapshot()` binds the ordered set of pages visible to one retrieval operation. Every entry records:

- position;
- stable page id;
- origin (`here`, `inherited:<runId>`, or `shared`);
- path;
- canonical page digest;
- source ids;
- whether the page was invalidated.

Order is identity-bearing because retrieval algorithms may use order as a tie break or candidate window. Page text, frontmatter, citations, contradictions, invalidation state, path, and source joins are included in each page digest.

```ts
import { createKnowledgeVisibilitySnapshot } from '@tangle-network/agent-knowledge'

const visibility = createKnowledgeVisibilitySnapshot(await stores.loadChain(runId))
console.log(visibility.snapshotDigest)
```

A repeated path at the same origin is refused. The same stable page id may remain visible at different origins; ambiguity-safe citation resolution is handled separately.

Create the snapshot once per knowledge view and reuse it for every retrieval over that view. Snapshot creation hashes every visible page; each retrieval receipt over a reused snapshot then costs only its own results. `verifyKnowledgeVisibilitySnapshot()` proves a snapshot's schema and canonical digest, and runs once per snapshot object.

## Durable snapshot storage

The snapshot is the evidence a compact receipt points at, so a production adapter persists it once per view:

```ts
import {
  encodeKnowledgeVisibilitySnapshot,
  knowledgeVisibilityArtifactRef,
} from '@tangle-network/agent-knowledge'

const bytes = encodeKnowledgeVisibilitySnapshot(visibility)
await store.put('artifact://run/visibility.json', bytes)
const artifact = knowledgeVisibilityArtifactRef({ uri: 'artifact://run/visibility.json', bytes })
```

`encodeKnowledgeVisibilitySnapshot()` returns the snapshot's canonical bytes; `decodeKnowledgeVisibilitySnapshot()` parses stored bytes and verifies their digest. `knowledgeVisibilityArtifactRef()` binds the storage uri to the exact stored bytes: their sha256 digest and byte length. Pass the reference as `visibilityArtifact` when creating receipts so a later verifier can locate the snapshot.

The artifact reference is optional at this contract layer: a caller that retains the snapshot in another durable record may omit it. A production adapter should require a durable locator.

## Retrieval receipt

`createKnowledgeRetrievalReceipt()` binds:

- run id;
- optional actor, profile, and execution identities;
- exact query;
- retriever id, version, and configuration digest;
- a compact visibility reference: the snapshot digest, the visible page count, and the optional artifact locator;
- every ranked returned page, origin, path, digest, score, snippet, and reason;
- trace or artifact evidence references;
- bounded scalar attributes;
- creation timestamp.

The input takes the precomputed `visibility` snapshot. A result is accepted only when its exact page bytes, path, id, and origin occur in that snapshot. Ranks must be unique and contiguous from one. Scores must be finite, and normalized scores must lie in `[0, 1]`. The receipt stores the snapshot's reference, not its entries, so a receipt's size is bounded by its results.

```ts
import { canonicalCandidateDigest } from '@tangle-network/agent-interface'
import {
  createKnowledgeRetrievalReceipt,
  KNOWLEDGE_SEARCH_RETRIEVER_ID,
} from '@tangle-network/agent-knowledge'

const receipt = createKnowledgeRetrievalReceipt({
  runId,
  actorId: 'root:s0',
  profileDigest,
  executionRef,
  query: 'prior obstruction calibrated verifier',
  retriever: {
    id: KNOWLEDGE_SEARCH_RETRIEVER_ID,
    version: '1.0.0',
    configDigest: canonicalCandidateDigest({ k1: 1.2, b: 0.75, limit: 5 }),
  },
  visibility,
  visibilityArtifact: artifact,
  results,
  evidenceRefs: [{ kind: 'event', uri: `event://${runId}/retrieval-1` }],
})
```

## Verification split

Three checks make three different claims. The names say which:

- `verifyKnowledgeRetrievalReceipt(receipt)` recomputes the receipt digest and checks rank continuity, finite scores, and a well-formed visibility reference. It proves the receipt is internally consistent and unmutated. It does **not** prove that the results occur in the referenced snapshot, because the receipt does not carry the snapshot.
- `assertKnowledgeRetrievalMatchesVisibility(receipt, snapshot | visiblePages)` recomputes the snapshot digest and page count and proves every returned result occurs in that exact snapshot with the same page id and bytes.
- `assertKnowledgeRetrievalMatchesVisibilityArtifact(receipt, loadArtifact)` loads the referenced artifact, proves the stored bytes match the reference (digest and byte length), decodes and verifies the snapshot, and then proves the same join. A snapshot that cannot be obtained — no artifact reference, nothing stored at the uri, or a failing loader — raises `KnowledgeVisibilityUnavailableError` with the reason; it is never treated as an empty snapshot.

Schema version `1.0.0` receipts embedded the snapshot and are refused by every verifier.

## Use receipt

`createKnowledgeUseReceipt()` selects one exact rank returned by a verified retrieval and binds it to a downstream consumer:

```ts
const use = createKnowledgeUseReceipt({
  retrieval: receipt,
  selectedRank: 1,
  relation: 'extends',
  consumer: {
    kind: 'artifact',
    uri: `artifact://${runId}/DECISION.md`,
    digest: decisionArtifactDigest,
  },
  evidenceRefs: [{ kind: 'span', uri: `trace://${runId}/span/knowledge-use-1` }],
})
```

Relations are descriptive:

- `supports`
- `contradicts`
- `extends`
- `rederives`
- `background`

Consumer kinds are:

- `decision`
- `artifact`
- `experiment`
- `candidate`
- `message`
- `other`

The use receipt copies the selected result's rank, page id, origin, path, and digest. It references the retrieval receipt digest. `verifyKnowledgeUseReceipt()` refuses verification against a different retrieval, a result that was not returned, a changed selected page, or any mutation of the relation or consumer identity.

## Canonical serialization

Optional actor, profile, execution, consumer-digest, artifact, and evidence-excerpt fields are omitted when absent. They are never emitted with a JavaScript `undefined` value. Empty evidence and attribute collections remain explicit empty arrays or objects because they are part of the receipt contract.

Attribute values are deliberately limited to strings, finite numbers, booleans, and `null`. Nested arbitrary objects are refused rather than passed through a language-specific serializer. More structured evidence belongs in an artifact or a versioned contract referenced by digest.

The receipt digest covers the complete canonical material except the digest field itself, including the visibility reference's snapshot digest and page count. Copying a digest onto modified content does not verify, and a truncated snapshot cannot satisfy a reference whose page count it no longer matches.

## What a receipt proves

A verified retrieval receipt alone proves:

> Under this exact run/actor/profile/execution identity, this exact retriever configuration searched the knowledge snapshot with this exact digest and page count, using this exact query, and returned these exact ranked page versions.

A retrieval receipt joined against its snapshot — through `assertKnowledgeRetrievalMatchesVisibility` or the artifact verifier — additionally proves:

> Every returned page version occurred, byte for byte, in that exact ordered snapshot.

A valid use receipt additionally proves:

> The consumer selected this exact returned page version and declared this exact relation while producing this exact downstream consumer identity.

It does **not** prove:

- that the page's claim is true;
- that the declared relation is semantically correct;
- that the consumer complied with the page;
- that the downstream artifact passed its verifier;
- that the result is novel rather than a re-derivation;
- that knowledge improved the outcome.

Those claims require Eval findings, artifact checks, paired experiments, novelty/reuse adjudication, and downstream outcome evidence.

## Trace integration

Both receipts accept canonical Eval `EvidenceRef` values. A Runtime or product adapter should emit a trace event/span containing the receipt digest and retain the receipt itself as an artifact or durable record. The trace is an index into the receipt; it is not a second copy of its truth.

Recommended event attributes:

```text
knowledge.receipt.kind
knowledge.receipt.digest
knowledge.visibility.digest
knowledge.visibility.artifact_uri
knowledge.retriever.id
knowledge.retriever.version
knowledge.result.count
knowledge.used.page_id
knowledge.used.origin
knowledge.consumer.kind
knowledge.consumer.uri
knowledge.relation
```

Do not encode absent token, cost, model, status, or artifact state as zero or success while attaching these receipts. Knowledge provenance cannot repair incomplete execution evidence.

## Experiment use

For a knowledge-compounding comparison, record separately:

1. knowledge available to the arm;
2. knowledge retrieved;
3. knowledge selected for use;
4. the downstream decision or artifact;
5. the verifier outcome;
6. whether the contribution duplicated, verified, extended, corrected, newly applied, or independently discovered the prior result.

This separation prevents final-prose similarity or citation count from masquerading as causal evidence that accumulated knowledge improved research.
