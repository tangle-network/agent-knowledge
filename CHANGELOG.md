# Changelog

## Unreleased

### Fixed

- Frontmatter formatting now JSON-encodes strings that the line-oriented parser would otherwise truncate, trim, or coerce. Multi-line checks, empty strings, edge whitespace, quoted or bracketed text, numeric-looking text, booleans-as-text, structured values, and unsafe array entries round-trip without silent data loss. Non-serializable values fail loudly instead of being written ambiguously.

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
