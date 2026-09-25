# Published packages sweep 4

Base audited: `c0a41f8b3c92b4b964678d1abe4af01a30587472`.

## Findings

- `src/web-research-worker.ts` implements its own Router client over raw `fetch`, including retries, auth headers, model calls, search calls, usage accounting, and hard-coded model pricing.
- The package otherwise uses published `@tangle-network/agent-eval` and `@tangle-network/agent-interface` peer contracts.
- No vendored package directory was found.

## Replacement boundary

Model and search transport belongs to the published `@tangle-network/tcloud` client. Knowledge should keep research policy and source verification, but not duplicate Router HTTP, retry, authentication, or pricing logic.

## Follow-up required

Replace `createTangleRouterClient` internals with `TCloudClient.chat()` and `TCloudClient.search()`, preserve the injectable `RouterClient` seam, and delete `fetchWithRetry`, local auth headers, and the hard-coded GLM price table. Use SDK-reported usage/cost where available instead of inventing a second ledger.
