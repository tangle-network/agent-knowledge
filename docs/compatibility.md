# Compatibility and peer versions

Knowledge 21 requires Node.js 22.12 or later and Interface 4.

Eval 0.212 is the supported minor. Development and packed-package checks use its exact
0.212.0 floor, with one physical copy each of Eval, Core 0.11, Interface 4 and Zod 4.6.5.
Official optimizer checks require the matching `agent-eval-rpc==0.212.0` Python bridge.
The new cohort retains Trace Contract 2.

Use Knowledge 20 with Interface 3 and Eval 0.209 through 0.211. Use Knowledge 19 with
Interface 2 and Eval 0.201 through 0.208, and Knowledge 17 with older Eval releases.
