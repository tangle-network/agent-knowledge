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

## Search and read use the same identity

`buildKnowledgeBrief` and `knowledge_search` rank distinct visible documents without
merging pages that share a bare id. Their returned `citationIds` and rendered links
use the resolver's qualified form whenever the full visible chain is ambiguous,
even if only one of those pages matches the query or survives a filter. Unique
ordinary ids retain their previous short form. Returned pages and retrieval
receipts preserve the original bytes and origins, not rewritten page objects.

Use each returned handle directly with `knowledge_read`, `knowledge_resolve`, or
`cites`; a query for a local page cannot be substituted with a same-id inherited
page. Ambiguous or malformed outgoing links are not graph-ranking evidence;
citation audit still sees the unchanged source page and can diagnose them.

`knowledge_search` accepts optional `excludeInvalidated`, `tags`, and `kinds` using
the existing brief semantics. For historical research, `excludeInvalidated: false`
includes refuted approaches; this does not make their claims valid or change the
host defaults for subsequent calls. Receipt identities capture the selected filters.

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

### Read budgets

A finite lineage is not invalid merely because it contains many runs. Ancestry reads have no
implicit depth cutoff. Supply `maxAncestors` to `createRunScopedStores` when the caller needs a
read budget, including `0` for a root-only view. A chain exactly at that bound is accepted; a
longer chain is refused explicitly rather than truncated. Cycles, invalid run identities,
conflicting parents, and path-containment checks remain enforced independently of that budget.

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
