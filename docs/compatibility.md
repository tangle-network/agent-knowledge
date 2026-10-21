# Compatibility and peer versions

Knowledge 22 requires Node.js 22.12 or later and Interface 5.

`package.json` owns the supported Eval versions: the `@tangle-network/agent-eval` peer
range and its exact development pin. The supported minors run from the range's floor through
the pin's minor; all depend on Core 0.12, Interface 5 and Trace Contract 2.
`scripts/lib/peer-range.mjs` derives the list, and packed-package checks run once per minor,
at x.y.0 and at the pin for the last, each with one physical copy of Eval, Core 0.12,
Interface 5 and Zod 4.6.5. Official optimizer checks require the matching `agent-eval-rpc`
Python bridge, `==<version>`, for each.

Use Knowledge 21 with Interface 4 and Eval 0.212. Use Knowledge 20 with Interface 3
and Eval 0.209 through 0.211. Use Knowledge 19 with Interface 2 and Eval 0.201
through 0.208, and Knowledge 17 with older Eval releases.
