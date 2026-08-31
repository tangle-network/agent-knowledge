# Release Progress

## Target
- Environment: npm public registry
- Live URL: https://www.npmjs.com/package/@tangle-network/agent-knowledge
- Artifact path: package tarball produced by the tag workflow
- Rollback artifact/path: previous published package `10.8.0`
- Credential files: GitHub OIDC trusted publisher and npm registry metadata

## Local State
- Branch: `fix/interface-2-peer-20260831`
- Commit: `411beae`
- Dirty files: `CHANGELOG.md`, `README.md`, `package.json`, `pnpm-lock.yaml`
- Gates planned: Eval `0.171.0` registry publication, install, tests, typecheck, lint, build, package verification, CI, release workflow, registry and consumer checks

## Remote State
- Host/provider: GitHub Actions and npm
- Current live artifact: `@tangle-network/agent-knowledge@10.8.0`
- Current service status: package registry available
- Last smoke result: public Eval `0.171.0` installed with Interface `2.0.0` and Zod `4.5.4`; package verification passed with portable declarations.

## Decision
- Build path: GitHub tag release workflow
- Reason: the repository publish workflow owns trusted npm provenance
- Expected duration: CI and publication duration after the dependency becomes public
- Fallback/rollback: stop before commit if Eval is unavailable; do not publish a package with a local tar dependency

## Timeline
- 2026-08-31: inspected the prepared Interface 2 and Eval 0.171 changes
- 2026-08-31: confirmed Eval `0.171.0` is public with tarball shasum `c82e612719fe793b6b37f73c720789b3205c0eae`
- 2026-08-31: confirmed Eval `0.171.0` integrity `sha512-SBbzZIDdoqeA8QmbpnGAKpOO5hDBgCIMNnmt2/vDpvTqCKpOA+tqQw8vROx183DrMPC0rmmnVR8qWBq508dF4w==`
- 2026-08-31: pinned Zod `4.5.4` and added its version-scoped release-age exception to keep the Interface 2 cohort on one schema implementation
- 2026-08-31: fixed the Zod declaration leak with an explicit `KnowledgeImprovementActivationRecord` type and a package declaration portability check
