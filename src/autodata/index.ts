/**
 * Autodata — the LIVE dataset builder: ground on a real source document, run the agentic
 * data-creation loop with REAL two-tier solver models (the paper's Qwen tiers via the Tangle
 * router), and emit a discriminative QA dataset + the empirical strong/weak gap.
 *
 * The inner loop (`createDataCreationLoop` / `discriminativeAcceptRule`) is vendored from the
 * agent-runtime example and composes only published substrate primitives. This package adds the
 * real grounding (`grounding`), the real router roles (`router-roles`), and the pipeline +
 * JSONL writer (`build-dataset`).
 */

export {
  type AutodataDatasetConfig,
  type AutodataDatasetResult,
  buildAutodataDataset,
  type DatasetRow,
  type DiscriminativeThresholds,
} from './build-dataset'
export {
  type AcceptDecision,
  type AttemptRecord,
  createDataCreationLoop,
  type DataCreationConfig,
  type DataCreationResult,
  type DataExample,
  discriminativeAcceptRule,
  type ExampleEvaluation,
  qualityCheck,
  type SolverArtifact,
  type SolverEval,
  type SolverSample,
} from './data-creation-loop'
export {
  DEFAULT_SOURCE_URL,
  type GroundDocOptions,
  type GroundedDoc,
  groundDoc,
} from './grounding'
export { analyzeTrails, type DocTrail, type PoweredStats } from './powered'
export {
  type AutodataRoles,
  buildAutodataRoles,
  CHALLENGER_MODEL,
  type ChallengerStyle,
  DEFAULT_BASE_URL,
  JUDGE_MODEL,
  parseDataExample,
  type RouterCallRecord,
  type RouterChatInput,
  type RouterChatResult,
  type RouterRolesConfig,
  routerChat,
  type SmokeResult,
  STRONG_SOLVER_MODEL,
  smokeTestModels,
  WEAK_SOLVER_MODEL,
} from './router-roles'
