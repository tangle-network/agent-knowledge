# Run-scoped citations

A run-scoped knowledge chain contains three visibility classes:

1. pages written by the current run (`here`);
2. pages written by declared ancestors (`inherited:<runId>`);
3. pages in an optional curated shared store (`shared`).

`createRunScopedStores()` preserves every visible page and its origin. It does not shadow a page merely because a nearer store has the same stable id.

## Persisted citation form

A page records stable page references in `cites` frontmatter:

```yaml
---
id: later-result
cites:
  - prior-result
---
```

An unqualified id is valid only when exactly one visible page has that id. When duplicate ids are intentional, qualify the origin:

```yaml
cites:
  - here::current-result
  - inherited:run-2026-08-16::prior-result
  - shared::instrument-calibration
```

Use `parseKnowledgeCitationReference()` and `formatKnowledgeCitationReference()` rather than assembling qualified strings in application code.

## Resolution

```ts
import {
  assertCurrentRunCitationsResolved,
  createRunScopedStores,
  resolveRunScopedCitation,
} from '@tangle-network/agent-knowledge'

const stores = createRunScopedStores({
  root: './runs',
  sharedRoot: './curated-knowledge',
})

const resolved = await resolveRunScopedCitation(stores, 'run-b', {
  pageId: 'prior-result',
})

if (resolved.status !== 'resolved') {
  console.error(resolved.status, resolved.candidates)
}

await assertCurrentRunCitationsResolved(stores, 'run-b')
```

Resolution has three non-coercing outcomes:

- `resolved`: exactly one visible page matches;
- `missing`: no visible page matches;
- `ambiguous`: more than one visible page matches.

Missing and ambiguous references remain explicit. They never select the nearest page, the newest page, or the shared page by default.

## Product-owned lineage

A product that already owns run ancestry should provide a `RunLineageAuthority` rather than copying its manifest into `lineage.json`:

```ts
const stores = createRunScopedStores({
  root: './runs',
  runStorePath: (runId) => `./runs/${runId}/knowledge-base`,
  sharedRoot: './curated-knowledge',
  lineageAuthority: {
    async parentOf(runId) {
      const manifest = await readRunManifest(runId)
      return manifest.parentRunId
    },
  },
})
```

A read-only authority must already contain the lineage before `init()` is called. `init()` verifies the requested parent against that authority and fails on disagreement. An authority that also implements `record()` may durably create the lineage itself.

The default file-backed authority is idempotent. Reopening a run with the same parent is accepted; reopening it with another parent is a lineage conflict.

## Lint and graph behavior

`auditCurrentRunCitations()` checks current-run pages against one materialized visibility chain. `lintCurrentRunCitations()` converts missing, ambiguous, and self-citations into blocking package lint findings.

Within one knowledge index, unambiguous `cites` relations become graph edges with reason `citation`. Duplicate target ids do not produce a guessed edge; the relation remains unresolved until it is qualified or the duplicate is removed.

## Migration rule

For an existing application-owned store:

1. freeze the old reader and writer behavior with golden fixtures;
2. expose the existing run manifest as a `RunLineageAuthority`;
3. dual-read the same frozen corpus through both implementations;
4. classify every mismatch without coercion;
5. switch new reads and writes only after parity is demonstrated;
6. retain historical bytes and delete the duplicate live owner.

A migration is not complete while two implementations can independently write lineage, page identities, or citation relations.
