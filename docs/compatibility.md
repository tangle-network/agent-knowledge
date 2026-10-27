# Compatibility and peer versions

Knowledge 23 requires Node.js 22.12 or later, Interface 5 and Eval 1.

`package.json` owns the supported Eval versions: the `@tangle-network/agent-eval` caret peer
range and its exact development pin. Eval 1 states that a minor is additive, so the range admits
every later 1.x release. `scripts/lib/peer-range.mjs` derives the checked versions, the range's
floor and the pin, and packed-package checks run once for each, with one physical copy of Eval,
Core, Interface and Zod. Official optimizer checks require the matching `agent-eval-rpc` Python
bridge, `==<version>`, for each.

Use Knowledge 22 with Eval 0.218 through 0.222.
Use Knowledge 21 with Interface 4 and Eval 0.212. Use Knowledge 20 with Interface 3
and Eval 0.209 through 0.211. Use Knowledge 19 with Interface 2 and Eval 0.201
through 0.208, and Knowledge 17 with older Eval releases.
