# Compatibility and peer versions

Knowledge 22 requires Node.js 22.12 or later and Interface 5.

Eval 0.213 and 0.214 are the supported minors; both depend on Core 0.12, Interface 5
and Trace Contract 2. Development uses 0.214.0. Packed-package checks run once per minor,
at 0.213.0 and 0.214.0, each with one physical copy of Eval, Core 0.12, Interface 5 and
Zod 4.6.5. Official optimizer checks require the matching `agent-eval-rpc` Python bridge
for each minor, `==0.213.0` and `==0.214.0`.

Use Knowledge 21 with Interface 4 and Eval 0.212. Use Knowledge 20 with Interface 3
and Eval 0.209 through 0.211. Use Knowledge 19 with Interface 2 and Eval 0.201
through 0.208, and Knowledge 17 with older Eval releases.
