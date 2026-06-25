/**
 * Re-export of the held-out investment-research eval set + grader, which now live
 * in `src/` (`src/investment-thesis-set.ts`) so the shipped `materialFactsSurfaced`
 * metric can import them without crossing the `src` rootDir boundary. The data and
 * the firewall are unchanged — this is the same checklist; see the source file for
 * the full provenance ledger and `docs/eval/investment-material-facts.md`.
 */
export * from '../../src/investment-thesis-set'
