# Compatibility and peer versions

Knowledge 22 requires Node.js 22.12 or later and Interface 5.

The `@tangle-network/agent-eval` peer range in [package.json](../package.json) owns the
supported Eval minors, and its development pin is the newest. Each depends on Core 0.12,
Interface 5 and Trace Contract 2. Packed-package checks run once per minor, from the range's
floor through the development pin (`evalCompatibilityVersions` in
[peer-range.mjs](../scripts/lib/peer-range.mjs)), each with one physical copy of Eval, Core 0.12,
Interface 5 and Zod 4.6.5. Official optimizer checks require the matching `agent-eval-rpc`
Python bridge for each of those versions. The [adopt-stack workflow](../.github/workflows/adopt-stack.yml)
pins each new Eval release and widens the range's upper bound; raising the floor stays a
deliberate edit.

Use Knowledge 21 with Interface 4 and Eval 0.212. Use Knowledge 20 with Interface 3
and Eval 0.209 through 0.211. Use Knowledge 19 with Interface 2 and Eval 0.201
through 0.208, and Knowledge 17 with older Eval releases.
