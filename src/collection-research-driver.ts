/**
 * The SINGLE-AGENT COLLECTION driver — the blind-collection baseline (Arm A).
 *
 * This is the honest null the depth A/B is measured against. The other drivers
 * spend extra inference to do something differentiated:
 *   - `createVerifyingResearchDriver` runs an LLM gate per source (Arm B),
 *   - `createResearchDrivingDriver` extracts claims, tracks corroboration, and
 *     synthesizes deep follow-up questions to drive depth (Arm C).
 *
 * This driver does NONE of that. It is a pass-through: it accepts every source
 * the worker proposes and contributes no research, no gating, and no steering of
 * its own. The loop still dedups exact-uri duplicates before calling
 * `verifySource` (that is the loop's job, not the driver's), and the default
 * `foldGaps` (a plain bulleted list of the still-open readiness gaps) still folds
 * the gaps into the worker's next prompt — so the worker keeps researching, but
 * NOTHING intelligent sits between the worker and the knowledge base.
 *
 * In other words: ONE agent (the worker) collects sources round after round, and
 * the "driver" is an inert rubber stamp. That is exactly what "single-agent
 * collection" means — the topology with zero coordinator intelligence — so its
 * material-facts score is the floor every other arm must beat to justify its
 * extra inference cost.
 *
 * It adds NO router calls of its own: `verifySource` is a synchronous accept and
 * `foldGaps` is omitted so the loop uses its built-in gap list. So Arm A's cost
 * is the worker's cost alone — the cleanest possible blind-collection baseline.
 */

import type {
  ResearchDriver,
  ResearchSourceProposal,
  SourceVerdict,
} from './two-agent-research-loop'

/**
 * Build the single-agent collection driver. Accepts every source; never gates,
 * never researches, never steers beyond the loop's default open-gap list. The
 * worker is the only agent that thinks.
 */
export function createCollectionResearchDriver(): ResearchDriver {
  return {
    verifySource(_source: ResearchSourceProposal): SourceVerdict {
      return { accept: true }
    },
  }
}
