# Changelog

## 10.8.0 — 2026-08-22

### Fixed

- A knowledge root that canonicalizes to a different path than the caller holds now opens its file transactions instead of failing with `knowledge transaction directory escaped its root`.
`withTransactionRoot` compared the transaction root against the knowledge root with `resolve` on both sides.
`resolve` is lexical and cannot read a symbolic link, while the transaction root arrives already canonical from `withSafeDirectory`, so the two described one directory with two strings and the containment test rejected a directory that was inside the root.
On macOS this happened on every run that placed a knowledge base under `os.tmpdir()`, because `/var/folders/...` is a link to `/private/var/folders/...`.
It also happened on any platform when a caller passed a root reached through a symbolic link.
- `loadRunState` and `assertStateIdentity` compared a persisted root against a supplied root the same way, and reported a mismatch between two spellings of one directory.

### Added

- `relativeWithinRoot(root, candidate)`, `canonicalRelativeWithinRoot(root, candidate)`, and `canonicalPathsEqual(left, right)`.
`src/durable-fs.ts` now owns every comparison between two filesystem paths.
`canonicalRelativeWithinRoot` and `canonicalPathsEqual` canonicalize both sides first, and neither path has to exist: the deepest existing ancestor is canonicalized and the remaining segments are appended, so a directory that is about to be created is measured against the same root as one that already is.
Canonicalizing both sides also tightens the boundary, because a candidate that leaves the root through a symbolic link is rejected where a lexical comparison admits it.
- `pnpm run check:path-containment`, which fails a path comparison written inline instead of through those owners.
It runs inside `verify:package`, so both workflows enforce it.
A lexical comparison looks correct on Linux, where `/tmp` is a real directory and the two forms coincide, so this class of defect cannot be caught by running the suite on the machine that gates the merge.

## 10.7.1 — 2026-08-22

### Changed

- Accept Eval `>=0.170.0 <0.171.0`, replacing Eval `>=0.163.2 <0.164.0`, and Interface `^1.6.0`, replacing Interface `^1.4.0`.
The old Eval range admitted exactly one published version while Eval `latest` was 0.170.0, so a consumer installing the cohort got an unmet peer on this package and could not complete the install.
- **A consumer must move Eval and Interface with this package.**
Interface moves because Eval 0.170.0 depends on agent-core 0.9.5, which requires Interface `^1.5.0`.
Interface 1.4.0 leaves a second physical copy of the contract package in the tree, and one contract package must resolve to one copy.
Move Eval to 0.170.x and Interface to 1.6.x in the same change.
- The new Eval ceiling is measured, not assumed.
This package imports 79 distinct symbols from Eval across five entry points: `.` (37), `/campaign` (35), `/rl` (4), `/experiment` (2), and `/analyst` (1), plus one dynamic `import()` of `/campaign`.
A compiler probe over every symbol gives the same result against 0.163.2 and against 0.170.0: 78 resolve, and `JsonValue` resolves in neither, because two test files import it from `/campaign` where it has never been exported.
Eval 0.170.0 removes six `/analyst` exports, which are `createJudgeAdapter`, `createRunCriticAdapter`, `createVerifierAdapter`, and their three option types.
This package imports none of the six.
All 15 symbols this package imports from Interface resolve at 1.6.0 exactly as they do at 1.4.0.
- A pre-1.0 dependency earns a single-minor range, so `<0.171.0` is the boundary the evidence covers.
An Eval minor above 0.170.x must be verified before the range admits it.

## 10.7.0 — 2026-08-21

### Added

- `createKnowledgeControlLoopAdapter` now returns `stopPolicies.stateFingerprint`. `observe` hands the caller's `AbortSignal` to `act` through the loop state, and Eval's control runtime fingerprints that state with RFC 8785 canonical JSON, which refuses a class instance. Eval's contract names this exact case: a caller whose state is not plain JSON supplies its own fingerprint. The adapter fingerprints the observable knowledge and leaves the signal out, so a caller spreading `...adapter` needs to know none of this.

### Fixed

- Nothing this package writes encodes an absent optional as `undefined` any more. `createKnowledgeEvent` (`actor`, `target`, `metadata`), the research-loop step (`notes`, `applied`, `readiness`, `metadata`), its event metadata (`written`), and readiness requirement metadata (`validUntil`, `lastVerifiedAt`) all omit the key instead. A key present with no value and an absent key are the same JSON, so the canonical encoder refuses to guess between them — and every control-loop run through `createKnowledgeControlLoopAdapter` aborted at step 0 because of it. `createKnowledgeEvent` is the single owner of every event this package emits, so the fix there covers all of them.

### Changed

- Accept Eval `>=0.163.2 <0.164.0` and Interface `^1.4.0`, replacing Eval `>=0.149.0 <0.150.0` and Interface `^1.1.0`. Eval 0.150.0 through 0.163.2 removed the paid model transports, deleted 86 unused exports, and changed the raw-finding codec, the GEPA bridge output, and the GEPA engine seed; this package builds and tests against 0.163.2, so the peer range now states that.
- **A consumer must move Eval and Interface with this package.** Installing 10.7.0 beside Eval 0.149.x is an unmet peer, not a warning to ignore: the GEPA bridge output shape differs between the two. Move Eval to 0.163.2 and Interface to 1.4.0 in the same change.

## 10.6.0 — 2026-08-21

### Added

- Add `createKnowledgeTools({ stores, runId, retrieverVersion, ... })`, returning provider-neutral `ToolDefinition[]` for `knowledge_search`, `knowledge_read`, `knowledge_record`, and `knowledge_resolve`. This package owns every handler; a runtime transports the definitions and the calls and runs no knowledge loop. `knowledge_search` mints a retrieval receipt on every call and hands it to the optional `recordRetrieval` sink, so retrieval is recorded rather than claimed. `knowledge_record` applies the write intake gate. `knowledge_read` reports an id visible at two origins as `ambiguous` with both candidates and never chooses one.
- Add `createKnowledgeRetrievalDisposition` and `verifyKnowledgeRetrievalDisposition`, the record for a retrieval that influenced nothing. A use receipt requires a selected rank, so a retrieval with no use previously left no record at all and "no evidence of use" was indistinguishable from "evidence of no use". The disposition binds to one `retrievalReceiptDigest`, carries `relation: 'irrelevant' | 'no-use'`, and has no rank.

## 10.5.0 — 2026-08-21

### Added

- Add `promoteRunScopedPages(stores, runId, { pageIds, sharedRoot, actor, reason })`, the only path from run scope into the curated shared store. It carries the closure of the run-local pages a promoted page cites, each keeping its own evidence fields exactly as written, and refuses the promotion when any citation would not resolve in the target — including one qualified with `here::` or `inherited:`, whose scope does not exist in shared. Pages travel as the bytes their store holds, so a promoted page has one digest in both scopes.
- Every promotion writes a record at `<shared>/.agent-knowledge/promotions/<digest>.json` naming the source run, each page digest, which pages were requested and which were carried support, the actor, the reason, and the time. The record is content-addressed, so re-running one promotion writes the same bytes at the same path. Read it back with `loadKnowledgePromotionRecord(sharedRoot, digest)`.
- Add `RunScopedStores.storePath(runId)`. Promotion carries a page unchanged, which needs the store root a chain read hides.

## 10.4.0 — 2026-08-21

### Added

- Add `buildKnowledgeBrief(visiblePages, question, options)`. It ranks the knowledge one question can see, renders a deterministic `- [id] title — snippet` line per page, and returns `results` in exactly the shape `createKnowledgeRetrievalReceipt` takes, so a retrieval is recorded rather than claimed. It is pure: no clock, no filesystem, no network. `excludeInvalidated` defaults to `true`, the opposite of `searchKnowledge`, because a brief offers every page it names with an id ready to cite.
- The brief also returns `retrieverId` and `retrieverConfigDigest`, the retriever identity a receipt needs, so a caller declares only the running package version.
- Add `searchKnowledgePages(pages, query, options)`, the ranking over a page set that is not a built index, such as the chain a run can see. `searchKnowledge(index, ...)` is now this function over `index.pages`, so the two entry points cannot drift.

## 10.3.0 — 2026-08-21

### Added

- Add `planInvalidationPropagation(visiblePages)` and `formatKnowledgeInvalidationProposal(plan)`. Every page authored in the target store that cites a page carrying an `invalidation` is stamped with `citesInvalidated: [ids]`; a citation whose target was revalidated has the stamp removed. The plan is a diff, so a second pass over an already stamped store produces no mutation. Only `here` pages are stamped, because a run does not write the stores it inherits or shares.
- Add the `cites-invalidated` lint finding, a warning naming every live citation from a page into a page its own evidence refuted.
- Add `SearchKnowledgeOptions.excludeInvalidated`, which drops refuted pages from a result set. It defaults to `false`, so what search returns does not change for an existing caller.
- Add `originatedPages(pages, origin?)`, which presents plain pages as a visibility chain of one origin, so citation resolution, the write intake gate, and invalidation propagation take one page shape whether or not the caller runs run-scoped stores.

## 10.2.0 — 2026-08-21

### Added

- Add `assertKnowledgeWriteIntake(candidates, { visiblePages, nearDuplicates?, citations? })`, a write-time gate that refuses a page which restates visible knowledge without relating itself to it, and a page whose citation resolves to no visible page. A duplicate is cleared by citing the matched page, naming it in `contradicts`, or reusing its id so the write updates it. The candidates are part of the corpus both checks see, so a batch may cite a page it writes in the same call.
- Add the `intake` option to `applyKnowledgeWriteBlocks` and `applyKnowledgeWriteBlocksFile`, and `--intake` / `--intake-threshold` to `agent-knowledge apply-write-blocks`. The gate runs inside the write lock and refuses the whole proposal, so a refused write leaves nothing on disk.
- Add `knowledgePageFromMarkdown(path, content, pagesDirectory?)` and `isKnowledgePagePath(path)`. The reader and the intake gate build pages through this one constructor, so a gate judges exactly what the store loads back.

## 10.1.0 — 2026-08-21

### Changed

- `searchKnowledge` ranks its lexical list with Okapi BM25 instead of the hand-weighted substring scorer. A term that occurs in most pages is discounted by inverse document frequency, term frequency saturates, and a long page no longer outranks a short one by repetition. An exact title or path match, a title that contains the query, and a body that contains the query stay ahead of a bag-of-words match, so exact lookups keep their order. The hit shape, `normalizedScore`, `snippet`, `reasons`, the reciprocal-rank fusion with the link graph, and the path tie-break are unchanged. There is no option to select the previous scorer.
- The retrieval-eval retriever, the CLI `search` command, and `FileSystemSearchProvider` inherit the new ranking. The provider builds one lexical index per page index and drops both together on `refresh` or `invalidate()`.

### Added

- Add `buildKnowledgeLexicalIndex(pages, { tokenize, fieldBoosts })` and `scoreBm25(index, tokens, { k1, b })` in `src/lexical-index.ts`: a pure inverted index with field-boosted term frequencies, document lengths, average document length, and document count. No dependency and no native module, so the package stays importable at the edge.
- Add `tokenizeText`, the token stream that indexing and querying share; `tokenizeQuery` is its distinct-token form and moves to the same module, so one tokenizer serves both sides and the vocabularies cannot drift.
- Add `KNOWLEDGE_SEARCH_RETRIEVER_ID` (`bm25-rrf-v1`), the retriever identity to declare in a retrieval receipt minted from `searchKnowledge` results.
- `SearchKnowledgeOptions.lexicalIndex` accepts an index built from exactly the searched pages, for a caller that queries one page index repeatedly. A mismatched index is refused.

## 10.0.0 — 2026-08-20

### Breaking Changes

- **A retrieval receipt now references the visibility snapshot instead of embedding it.** `KnowledgeRetrievalReceipt.visibility` becomes `KnowledgeVisibilityRef { snapshotDigest, pageCount, artifact?: { uri, digest, byteLength } }`, and `KNOWLEDGE_USE_RECEIPT_SCHEMA_VERSION` becomes `2.0.0`. Every verifier refuses a `1.0.0` record, which has no reader. A receipt is now bounded by its results rather than by the visible page count.
- **`createKnowledgeRetrievalReceipt` takes `visibility: KnowledgeVisibilitySnapshot` instead of `visiblePages`.** Create the snapshot once with `createKnowledgeVisibilitySnapshot` and reuse it for every retrieval over that view. Results still join against the snapshot entries, so a result absent from the view is refused as before. Repeated retrievals over one snapshot no longer re-serialize or re-hash the page inventory.
- **The verification claim is split, so a check cannot overstate what it proved.** `verifyKnowledgeRetrievalReceipt(receipt)` proves receipt shape, canonical digest, rank continuity, finite scores, and a well-formed reference, and makes no result-to-snapshot claim. `assertKnowledgeRetrievalMatchesVisibility(receipt, snapshot | visiblePages)` recomputes the snapshot digest and page count and joins every returned result.

### Added

- Add `assertKnowledgeRetrievalMatchesVisibilityArtifact(receipt, loadArtifact)`, which loads the referenced snapshot artifact, checks its stored-byte digest and byte length, decodes and verifies the snapshot, and then proves the same join. A snapshot that cannot be obtained raises `KnowledgeVisibilityUnavailableError` with an explicit reason; it is never treated as an empty snapshot.
- Add `verifyKnowledgeVisibilitySnapshot`, `encodeKnowledgeVisibilitySnapshot`, `decodeKnowledgeVisibilitySnapshot`, and `knowledgeVisibilityArtifactRef({ uri, bytes })` so an adapter persists and reloads a snapshot without inventing its serialization.

## 9.0.0 — 2026-08-20

### Breaking Changes

- Rename `LoadKnowledgePagesOptions` to `KnowledgePagesOptions`. The same `{ pagesDirectory }` option now drives the write path as well as the reader, so the `Load` name no longer described it. Replace the type name; the option field is unchanged.

**What to do:** import `KnowledgePagesOptions` where `LoadKnowledgePagesOptions` was imported. No runtime behavior changes for a caller that names no directory.

### Added

- `applyKnowledgeWriteBlocks(root, text, { pagesDirectory })` and `applyKnowledgeWriteBlocksFile` accept the pages directory the reader accepts. The parser allows only `FILE` blocks under `<pagesDirectory>/`, and the file transaction enforces the same bound, so a store laid out as `kb/pages/<line>/` can use the safe-write protocol.
- `buildKnowledgeIndex`, `writeKnowledgeIndex`, `FileSystemSearchProviderOptions`, and `RunScopedStoresOptions` take `pagesDirectory`, so the custom directory is indexed, searched, and read through the lineage chain. The CLI takes `--pages-dir <dir>` on `apply-write-blocks`, `index`, `search`, and every other index-reading command.
- `normalizePagesDirectory` and `DEFAULT_PAGES_DIRECTORY` are exported. The normalizer refuses `..`, `.` and empty segments, absolute paths, drive letters, control characters, and the package-owned `.agent-knowledge` and `raw` trees, because the value is a write allowlist prefix as well as a read location.
- A knowledge file transaction journals the pages directory it was prepared under (`pagesDirectory`, absent for the default), so recovery and replay enforce the same allowlist as the prepare step. The default journal is byte-identical to before.

## 8.1.0 — 2026-08-20

### Added

- Add `buildKnowledgeRelationGraph({ nodes, relations })`, which builds a labeled multi-edge graph from `KnowledgeRelation[]` and caller-declared nodes with a `kind`, `label`, and `metadata`. The graph keeps one edge per `(sourceId, targetId, predicate)`; a repeated triple is accepted only when it is byte-identical, and an endpoint outside the declared nodes is refused.
- Add `neighbors`, `walk`, and `isReachable` over that graph, filtered by predicate and direction (`out`, `in`, `both`), with a cycle-safe breadth-first walk.
- Add `KnowledgeRelationSchema`, `KnowledgeRelationNodeSchema`, and `KnowledgeRelationGraphSchema`, with an explicit `metadata` field so a persisted graph round-trips. `KnowledgeBaseCandidateSchema` uses the same relation schema.
- Add `knowledgePageRelations(pages)`, the labeled page relations (`wikilink`, `citation`, `shared-source`, `contradicts`) that `buildKnowledgeGraph` now collapses into its weighted edges; the collapsed graph bytes are unchanged.

## 8.0.10 — 2026-08-19

### Changed

- Require Eval `0.149.0`, so the peer range becomes `>=0.149.0 <0.150.0`.
  Eval 0.149.0 preserves every published entry point and declaration used by this package.
  The previous window rejected the current Eval release because Eval is pre-1.0 and npm locks a 0.x range to its minor.

## 8.0.9 — 2026-08-18

### Changed

- Require Eval `0.148.0`, so the peer range becomes `>=0.148.0 <0.149.0`. Eval 0.148.0 adds the evidence-receipt surface on `/experiment` and the search-history surface on `/campaign`, and removes no export this package consumes. The previous window stopped at 0.148.0 because Eval is pre-1.0, and npm locks a 0.x range to its minor. That window refused an additive release, and every consumer that adopts Eval 0.148.0 was blocked behind this declaration.
- Require Interface `1.1.0`, so the peer range becomes `^1.1.0`. Eval 0.148.0 depends on Interface `^1.1.0`, and the cohort holds one installed copy, so the floor moves with it.

### Added

- Add content-addressed knowledge visibility, retrieval, and downstream-use receipts. Retrieval receipts bind the exact ordered current/ancestor/shared page snapshot, query, retriever configuration, ranked results, actor/profile/execution identities, and Eval evidence references. Use receipts bind one returned rank to a decision, artifact, experiment, candidate, message, or other consumer with an explicit `supports`, `contradicts`, `extends`, `rederives`, or `background` relation. Verification fails on changed page bytes, visibility, query, rank, consumer, relation, or retrieval identity; the receipts provide provenance without claiming correctness, novelty, or causal lift.

## 8.0.6 — 2026-08-16

### Changed

- Require Eval `0.146.0`, so the peer range becomes `>=0.146.0 <0.147.0`. Eval 0.146.0 adds the `multishot/golden` subpath and removes no export: measured against 0.145.21, the published type surface loses no entry point, no top-level export, and no interface member. The previous window stopped at 0.146.0 because Eval is pre-1.0, and npm locks a 0.x range to its minor. That window refused an additive release, and every consumer that needs `multishot/golden` was blocked behind this declaration.

## 8.0.5 — 2026-08-16

### Changed

- Declare the Interface peer as `^1.0.0` instead of the one-generation window `>=0.56.0 <0.57.0`. Interface 1.0.0 publishes the surface of 0.56.0 unchanged and states a compatibility promise: a minor is additive, a patch is a fix, and only a major removes or narrows. A later additive minor now needs no release here.
- Require Eval `0.145.21`, the release that declares the Interface caret range.
- `scripts/verify-package.mjs` compares a cohort dependency by admission, not by string equality. A caret range and the single version it resolves to are different strings, so the old check refused the declaration it should accept. The one-installed-copy assertion it guards is unchanged.

## 8.0.4 — 2026-08-16

### Changed

- Require Interface `0.56.0` and Eval `0.145.18` as one compatible contract cohort.

## 8.0.3 — 2026-08-16

### Changed

- Require Interface `0.55.0` and Eval `0.145.17` as one compatible contract cohort.

## 8.0.2 — 2026-08-16

### Changed

- Require Eval `0.145.16` and Interface `0.54.0` as one compatible contract cohort.

## 8.0.1 — 2026-08-15

### Changed

- Require Eval `0.145.14` and Interface `0.53.0` as one compatible contract cohort.

## 8.0.0 — 2026-08-15

### Breaking Changes

- **`assertGradeableEvidence` now throws for the two shapes `verdictFor` refuses.** At rung 4 and
  above it used to require only that some check exists. It now also throws `UncheckableClaimError`
  for a check recorded without an `expect` value, and for a constant-emitter check. Recording is
  the boundary where these shapes are still cheap to fix; by grading, the ungradeable claim has
  already circulated as verified. This change needs a major release.
- Both boundaries use one detector and one set of messages, so record time refuses exactly what
  grade time grades `uncheckable`, in the same order and in the same words. A constant emitter
  keeps its narrow definition: the whole command is `true` or `:`, or the whole command is one
  `echo` or `printf` whose arguments hold no command substitution, no pipe, no command separator,
  no redirection from a file, and no variable reference.
- `UncheckableClaimError` takes a second `note` argument and carries `rung` and `note` as readable
  fields. The note names the refused shape and the value the check must print, so an author reads
  one message wherever the claim is stopped.
- Behaviour below rung 4 does not change. A check that reads a value, such as
  `echo "n=$(grep -c x out.txt)"`, is still recordable at every rung.

**What to do:** a rung 4 or 5 claim must record a command that reads the artifact the claim is
about, plus the `expect` value that command prints. A claim that cannot carry one is a rung 3
claim, and recording it at rung 3 is accepted unchanged.

## 7.2.7 — 2026-08-15

### Changed

- **`verdictFor` refuses a check that cannot fail.** At rung 4 and above, two evidence shapes that
  used to grade `verified` now grade `uncheckable`: a check recorded without an `expect` value, and
  a constant-emitter check. An exit code alone does not reproduce a value, and a command that
  prints its own expectation cannot refute the claim it is attached to.
- A constant emitter is defined narrowly and mechanically: the whole command is `true` or `:`, or
  the whole command is one `echo` or `printf` whose arguments hold no command substitution, no
  pipe, no command separator, no redirection from a file, and no variable reference. A check that
  reads a value, such as `echo "n=$(grep -c x out.txt)"`, still verifies.
- Behaviour below rung 4 does not change. An execution that decided the claim still outranks these
  refusals: a missing input stays `unrunnable`, and a nonzero exit stays `contradicted`.

### Added

- `gradeFor(evidence, execution)` returns `{ verdict, note }`. The note names the refused shape and
  tells the author what to record. `verdictFor` keeps its signature and returns the verdict alone.

## 7.2.6

### Changed

- Require Eval `0.145.11` and Interface `0.52.0` as the current shared contract cohort.
- Bump the exact Eval and Interface development pins to `0.145.11` and `0.52.0`.
- Packed-consumer verification now installs the new cohort and checks one copy of Eval, Core, and Interface.

## 7.2.5

### Changed

- Require Eval `0.145.10` and Interface `0.49.0` as the current shared contract cohort.
- Bump the exact Eval and Interface development pins to `0.145.10` and `0.49.0`.

## 7.2.4

### Changed

- Require Eval `0.145.2` and Interface `0.47.0` as the current shared contract cohort.
- Bump the exact Eval and Interface development pins to `0.145.2` and `0.47.0`.

## 7.2.3

### Changed

- Align the required Eval peer and exact development pin with Eval `0.145.0`.
- Keep the published Knowledge package on one Eval copy after Eval's tiered root-barrel release.

## 7.2.2

### Fixed

- Import `pairArms` from Eval's `experiment` subpath so the published package works with Eval `0.144.13`.

## 7.2.1

### Changed

- Updated the required Eval peer and exact development pin to `0.144.11` so consumers install one current shared cohort.

## 7.2.0

### Changed

- Changed `@tangle-network/agent-eval` and `@tangle-network/agent-interface` to required compatible peers.
- Kept exact development pins at Eval `0.144.10` and Interface `0.46.1`.
- Consumers now select one shared Eval and Interface cohort instead of nested package copies.

## 7.1.3

### Changed

- Updated `@tangle-network/agent-eval` to `0.144.8` so Knowledge and Runtime install the duplicate-safe candidate contract without an older Eval copy.

## 7.1.2

### Changed

- Updated `@tangle-network/agent-eval` to `0.144.6` and `@tangle-network/agent-interface` to `0.46.1`, so Knowledge consumers resolve one canonical interaction-binding contract through Eval, Core, and Interface.

## 7.1.1

### Changed

- Updated `@tangle-network/agent-eval` to `0.144.5` and `@tangle-network/agent-interface` to `0.46.0`, so Knowledge consumes the current profile contract through one exact dependency set.

## 7.0.11

### Changed

- Updated `@tangle-network/agent-eval` to `0.144.4` and `@tangle-network/agent-interface` to `0.43.1`, so Knowledge consumes prompt-cache accounting through one exact Core, Interface, and Eval dependency set.

## 7.0.10

### Changed

- Updated `@tangle-network/agent-eval` to `0.144.3` so Knowledge consumers use exact profile-matrix evidence validation and concurrent profile comparison without installing an older Eval copy.

## 7.0.9

### Changed

- Updated `@tangle-network/agent-eval` to `0.144.1` so Knowledge and Runtime install the same official-optimizer callback contract.

## 7.0.8

### Changed

- Updated `@tangle-network/agent-eval` to `0.143.0` so Knowledge preserves exact observed, estimated, and uncaptured evaluation costs without installing an older Eval copy.

## 7.0.7

### Changed

- Updated `@tangle-network/agent-eval` to `0.142.2` and `@tangle-network/agent-interface` to `0.43.0` so Knowledge, Runtime, and Sandbox use one current canonical profile contract.

## 7.0.6

### Changed

- Updated `@tangle-network/agent-eval` to `0.142.1` and `@tangle-network/agent-interface` to `0.42.1` so one installed stack uses the current shared contracts without nested older copies.

## 7.0.5

### Added

- Added `runAgentMemoryLearningExperiment` for matched stateful-versus-stateless memory measurement under one shared cost limit.
- Added exact paired gain, explicitly labeled transfer probes, and repeated-probe forgetting reports.
- Limited learning gain to post-first-step probes, averaged repetitions within independent sequences, and added per-candidate intervals.
- Added recorded arm order for counterbalanced runs and exact sequence references for safe crash recovery.
- Added abort and resume support, content-addressed comparison and probe evidence, and exact cell artifact hashes.

### Changed

- Memory experiment artifacts and cache identities now record `memoryMode` and a full `comparisonRef`; non-equivalent arms fail comparison.
- Updated `@tangle-network/agent-eval` to `0.142.0` and `@tangle-network/agent-interface` to `0.42.0` so one installed stack uses the same exact evaluation, profile, and interface contracts without older nested copies.
- Extended packed-package verification to reject stack dependency overrides, mismatched transitive versions, and multiple installed copies of Eval, Core, or Interface.

## 7.0.1

### Changed

- Updated `@tangle-network/agent-eval` to `0.135.4` and `@tangle-network/agent-interface` to `0.37.0` so one installed stack uses the same exact trace-ingestion, source-identity, and interface contracts without older nested copies.

## 7.0.0

### Breaking Changes

- Changed research source confirmation from URI strings to exact `SourceRecord` values and versioned the durable claim ledger schema so every observation is bound to its registry id, original URI, and full SHA-256 content hash.
- URI-only 6.2 ledgers now fail with `ClaimLedgerMigrationRequiredError` and remain untouched for explicit archive-and-reverify migration; they are never guessed into the exact-source schema.

### Fixed

- Prevented registering one version of a URI from activating claims extracted from different bytes at that URI, including concurrent writers and crash recovery.
- Snapshotted source proposals before asynchronous work, preserved the exact submitted raw bytes, and used full content hashes in raw-source paths.
- Kept one-sided contradiction observations pending until both claims have exact registered support, preventing a missing counterpart from satisfying completion.

## 6.2.0

### Added

- Added durable, merge-safe research claim ledgers and `createPersistentResearchDrivingDriver`, preserving corroboration, contradictions, deep questions, and round state across crashes, resumes, and concurrent workers.
- Exported the durable filesystem write primitives used by the reference store so other journaled consumers can reuse the same atomic, symlink-safe writes.

### Fixed

- Kept extracted claim evidence pending until its exact source registration is confirmed, and reconciled interrupted registrations on restart so absent sources cannot satisfy completion while registered sources are not lost.
- Routed knowledge indexes, research iteration events, and claim ledgers through the canonical store layout and one mutation-lock domain.

## 6.1.11

### Changed

- Updated `@tangle-network/agent-eval` to `0.135.2` so knowledge improvement uses the corrected paired promotion decisions without installing an older Eval copy.
- Updated the installation example to pin the matching Knowledge and Eval releases.

## 6.1.10

### Fixed

- Extended packed-package verification to reject bare side-effect imports of packages that patch Node builtins while continuing to allow dynamic imports.

### Changed

- Updated `@tangle-network/agent-eval` to `0.135.1` for strict rollout-record validation and stable estimated-cost receipt validation.
- Updated the installation example to pin the matching Knowledge and Eval releases.

## 6.1.9

### Fixed

- Load `proper-lockfile` with a dynamic import inside the functions that take a lock, instead of at module scope.
  It pulls in `graceful-fs`, which patches Node's `fs` at import time (`fs.close = ...`).
  workerd exposes those as getter-only accessors, so the assignment threw while Cloudflare validated an uploaded Worker (`Cannot set property close of #<Object> which has only a getter [code: 10021]`), rejecting the whole Worker, including consumers that never take a lock.
  `verify:package` now fails on any static import of a module that patches a Node builtin, because `wrangler deploy --dry-run` bundles without executing and cannot see this class of failure.

## 6.1.8

### Changed

- Updated `@tangle-network/agent-eval` to `0.134.2` so knowledge evaluation resolves complete multishot judge cost accounting without installing an older Eval copy.

## 6.1.7

### Changed

- Updated `@tangle-network/agent-eval` to `0.134.1` so Knowledge consumers resolve the corrected Eval implementation without installing an older copy.

## 6.1.6

### Changed

- Updated `@tangle-network/agent-eval` to `0.134.0` so Knowledge and Runtime share one explicit proposal-finding contract without installing an older Eval copy.

## 6.1.5

### Changed

- Updated `@tangle-network/agent-eval` to `0.133.3` so knowledge evaluation and promotion use the corrected exact, Student-t, rank-test, and Welch implementations.

## 6.1.4

### Changed

- Updated `@tangle-network/agent-eval` to `0.133.2` for final-evaluation data isolation, lazy OpenCode SQLite loading, and fail-closed paired comparisons.
- Increased the official optimizer check's pip timeout and retries so slow package downloads do not fail an otherwise valid release.

## 6.1.3

### Changed

- Updated `@tangle-network/agent-eval` to `0.133.1` for corrected normal-approximation statistics.

## 6.1.2

### Changed

- Updated `@tangle-network/agent-eval` to `0.133.0` and `@tangle-network/agent-interface` to `0.36.0`.

## 6.1.1

### Changed

- Updated `@tangle-network/agent-eval` to `0.131.0` while retaining the exact `@tangle-network/agent-interface` `0.35.0` contract.
- Extended packed-package verification to confirm both installed agent stack dependencies match the package manifest.

## 6.1.0

### Changed

- Updated `@tangle-network/agent-eval` to `0.130.1`, `@tangle-network/agent-interface` to `0.35.0`, Mem0 to `3.1.2`, and the maintained build toolchain.
- Replaced tsup with tsdown so declaration builds support TypeScript 7.
- Added package export validation with publint and Are the Types Wrong to every release.
- Split Mem0 hosted and OSS client contracts, compile them against Mem0 3.1.2, and exercise the OSS SQLite lifecycle locally.
- Updated GitHub Actions to their current stable releases.

## 6.0.0

### Breaking Changes

- Renamed the verified research entry point to `runVerifiedResearchLoop` and removed the old two-agent function, option, result, round, and module names.
- Updated `@tangle-network/agent-eval` to `0.129.0` and `@tangle-network/agent-interface` to `0.34.0`.

## 5.0.4

### Changed

- Updated `@tangle-network/agent-eval` to `0.128.2` for canonical task-failure imports, reports, validation, and the exact Core 0.4.21 and Interface 0.33 dependencies.
- Updated `@tangle-network/agent-interface` to `0.33.0` so Knowledge and Runtime share the current certified context contract.

## 5.0.3

### Changed

- Updated `@tangle-network/agent-eval` to `0.127.0` and adopted its explicit run outcome, cost provenance, and scenario identity contract.
- Allowed filesystem-heavy lifecycle tests enough time to complete under shared-runner load.

## 5.0.2

### Changed

- Updated the maintained Neo4j Agent Memory and Mem0 adapters plus compatible build and formatting dependencies.
- Aligned the official optimizer bridge with `@tangle-network/agent-eval@0.126.7`.
- Forced patched Hono, Node server, WebSocket, Vite, and esbuild releases so the installed graph has no known npm advisories.

## 5.0.1

### Changed

- Updated `@tangle-network/agent-eval` to `0.126.6` so Knowledge and Runtime use the same optimizer provenance contract.

## 5.0.0

### Breaking Changes

- Retrieval improvement now requires independent train, selection, and final scenarios plus an explicit complete `OptimizationMethod`.
- Serialized retrieval and RAG optimization now requires an immutable `executionRef` covering candidate execution and scoring behavior.
- Memory configuration improvement now requires a baseline configuration, a complete `OptimizationMethod`, and independent train, selection, and final histories.
- The RAG lifecycle promotion callback is now `decidePromotion` and runs only after final evidence passes regression, provenance, and cost checks.
- Knowledge improvement requires an immutable `implementationRef`, separates repeatable development evaluation from single-use final evaluation, and refuses to resume after interrupted final scoring.
- Memory candidate factories no longer receive scenario, repetition, or seed identity and must report observed external charges through `recordExternalCost()`.
- Answer-quality hooks require immutable evaluator identity, final scenario identity, and complete cost evidence.
- Removed the public retrieval and memory proposer-search options; candidate generation and selection now belong to `agent-eval` methods.

### Added

- Added a shared serialized-candidate adapter for running complete `agent-eval` optimization methods with canonical candidate identity and untouched final comparison.
- Added full RAG configuration optimization and KB maintenance policy optimization.
- Added direct support for official GEPA and SkillOpt methods through the shared `OptimizationMethod` contract.
- Added durable per-configuration memory candidate identities to prevent stale result reuse.
- Added live activation verification so resumed memory runs reject configuration drift.
- Added private execution contexts that expose memory operations, cancellation, and cost metering without evaluation labels.

### Changed

- Updated `@tangle-network/agent-eval` to `0.126.5` and `@tangle-network/agent-interface` to `0.32.0`.
- Kept memory provider evaluations resumable and branch-isolated while moving search ownership to the supplied method.
- Restricted immutable references to lowercase SHA-256 and full Git commit identities.

## 4.1.0

### Added

- Added optional scenario input to `knowledgeReleaseReport()` so a required holdout can prove both scenario and run coverage.

### Changed

- Split knowledge-base improvement and RAG evaluation internals into focused modules while preserving public exports and implementation behavior.
- Split the knowledge improvement tests into candidate, promotion, activation, and integrity suites with shared setup in one support module.
- Removed unused development dependencies and internal-only exports.
- Updated the test runner to Vitest 4 and Node type definitions to 26; TypeScript remains on 5.9 because tsup's declaration bundler does not yet support TypeScript 7.
- Declared Node types explicitly in TypeScript configuration instead of relying on ambient type discovery.
- Corrected the package dependency guide and RAG roadmap to reflect runtime-owned agent execution through `runKnowledgeImprovementJob()`.
- Removed historical commentary and em dashes from repository documentation.

### Fixed

- Replaced the stale versioned HTTP user agent with a stable package identity and added request-header coverage.

## 4.0.1

### Changed

- Split benchmark, memory experiment, and memory improvement internals into focused modules while preserving every public export and signature.
- Split memory and benchmark tests by behavior, with shared controller and adapter fixtures kept in one test-support module.
- Moved retrieval holdout contracts into the memory type layer to remove the holdout/types import cycle.

### Fixed

- Made the Mem0 deletion-convergence test deterministic under file-level parallel execution.

## 4.0.0

### Breaking Changes

- `runAgentMemoryImprovement()` now activates a measured winner through `activation.readCurrent()` and atomic `activation.compareAndSet()` instead of `onPromote`.
- `AgentMemoryActivation.receiptPath` is now `journalPath` because the file is an append-only activation record.
- `mem0MemoryAdapterIdentity()` and `graphitiMemoryAdapterIdentity()` require a stable, non-secret `backendRef` so two deployments cannot share a cache identity.
- Mem0 hosted mode now follows the synchronous array response from `mem0ai` 3.x; the unsupported queued-event options were removed.
- Paid benchmark and improvement work now defaults to a zero dollar limit and requires an explicit `costCeiling` or `maxTotalCostUsd`.
- In-flight run directories from releases before 4.0 are not migrated; archive or clear them before upgrading because 4.0 rejects older attempt records.

### Added

- Official-client adapters for Mem0 hosted and open-source deployments, Graphiti MCP, and Neo4j Agent Memory.
- Isolated memory branches with snapshots, replayable forks, private, team, and shared visibility, and ordered writes per agent.
- Parallel multi-track memory experiments and configuration search on `agent-eval`, with fresh-history comparison before activation.
- Durable controller ownership, interrupted-attempt cleanup, retired-candidate recovery, bounded cleanup work, and conservative recovery cost reconciliation.
- Complete candidate cost attribution across interrupted retries, plus explicit unranked recovery spend for retired benchmark candidates.
- Exact scoped Mem0 deletion with list and search convergence checks.

### Fixed

- Mem0 and direct Neo4j operations reject provider scopes they cannot enforce before any provider call.
- Hosted Mem0 `appId` is an additional filter and cannot authorize an unscoped whole-application read or delete.
- Mem0 cleanup tracks fresh writes until they become visible and confirms deletion from both list and search indexes.
- Broader Mem0 cleanup scopes wait for delayed writes created under matching narrower scopes.
- Mem0 pending-write probes expire after the configured visibility window instead of accumulating for the adapter lifetime.
- Direct Neo4j reasoning writes reject combined session and run scopes because the SDK can enforce only one conversation identifier.
- Timed-out provider work blocks close or reuse of the same adapter until the original operation settles.
- Recovery retries are reserved durably before provider work and stop after three failures per attempt by default.
- Direct memory benchmarks account for billable adapter provisioning and reconnects in the shared dollar limit.
- Fully cached benchmark resumes skip adapter creation and add no provider charge.
- Execute and recovery adapter factories receive abort signals and are bounded by the configured timeout.
- Adapters returned after a timed-out factory call are closed, and experiment adapters also run their configured disposal callback.
- Reported dollar totals are normalized to twelve decimal places instead of exposing binary floating-point artifacts.
