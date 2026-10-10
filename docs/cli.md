# Use the CLI

> Extracted from the README — see the [README](../README.md) for the package overview.

## Use the CLI

The CLI exposes the same file-backed workflow.

```bash
pnpm exec agent-knowledge init --root ./support-kb
pnpm exec agent-knowledge source-add ./refund-policy.md --root ./support-kb
pnpm exec agent-knowledge apply-write-blocks ./proposal.txt --root ./support-kb
pnpm exec agent-knowledge index --root ./support-kb
pnpm exec agent-knowledge search "refund window" --root ./support-kb
pnpm exec agent-knowledge validate --strict --root ./support-kb
```

Run `pnpm exec agent-knowledge help` for every command.
Pass `--pages-dir <dir>` to `apply-write-blocks`, `index`, `search`, and the other index-reading commands when the pages live outside `knowledge/`.