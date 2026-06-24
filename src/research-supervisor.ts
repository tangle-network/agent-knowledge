import {
  type Budget,
  type DeliverableSpec,
  type ExecutorConfig,
  type SupervisedResult,
  type SuperviseOptions,
  type SupervisorProfile,
  supervise,
} from '@tangle-network/agent-runtime/loops'
import {
  type BuildEvalKnowledgeBundleOptions,
  buildEvalKnowledgeBundle,
  type KnowledgeReadinessSpec,
} from './eval-readiness'
import { buildKnowledgeIndex } from './indexer'
import { researcherProfile } from './profiles/researcher'
import { initKnowledgeBase } from './store'

/**
 * Default standing instructions for a research supervisor. It does NOT solve the
 * research itself — it DECOMPOSES the goal into sub-topics and spawns one
 * researcher per sub-topic over the live `Scope`, widening/narrowing until the
 * readiness gate (the deliverable check) reports the knowledge base is ready.
 */
export const RESEARCH_SUPERVISOR_SYSTEM_PROMPT = [
  'You are a research SUPERVISOR. You do not answer the research question yourself —',
  'you create and manage a team of researcher workers that grow ONE shared',
  'knowledge base until it is ready.',
  '',
  'Each round:',
  '  1. Read the goal and the gaps the readiness gate still reports.',
  '  2. DECOMPOSE the open work into independent sub-topics. Spawn ONE researcher',
  '     per sub-topic (spawn_agent) — split by sub-topic, never duplicate work.',
  '     Spawn more researchers for a broad goal, fewer for a narrow one.',
  '  3. Wait for the researchers to settle (await_event). Steer or re-spawn for',
  '     the sub-topics that came back thin.',
  '  4. STOP as soon as the deliverable check reports the knowledge base is ready.',
  '',
  'Conserve your budget: every spawn spends from one shared pool. Prefer a small',
  'number of well-scoped researchers over a large fanout that re-covers the same',
  'ground.',
].join('\n')

export interface ResearchSupervisorOptions {
  /** Where the knowledge base lives. The deliverable check reads readiness here. */
  root: string
  /** The research goal handed to the supervisor as its task. */
  goal: string
  /**
   * Readiness specs define DONE: the supervisor's deliverable check passes once
   * `scoreKnowledgeReadiness` reports no blocking gaps over the live KB. Required
   * — without a gate the supervisor would never know when to stop.
   */
  readinessSpecs: KnowledgeReadinessSpec[]
  readinessTaskId?: string
  readiness?: Omit<BuildEvalKnowledgeBundleOptions, 'taskId' | 'index' | 'specs'>
  /** The conserved compute pool for the whole supervised run. */
  budget: Budget
  /**
   * WHERE researcher workers run — the caller's real backend seam (sandbox with
   * a `sandboxClient`, or router/cli/bridge). The supervisor spawns researchers
   * on this backend; assembling the seam (creds, sandbox SDK) is the caller's,
   * so there is no fabricated default.
   */
  backend: ExecutorConfig
  /** Harness for the researcher worker profile (default `researcherProfile`'s). */
  harness?: string
  /** The supervisor brain's router model. */
  supervisorModel?: string
  /** Custom supervisor instructions. Defaults to {@link RESEARCH_SUPERVISOR_SYSTEM_PROMPT}. */
  supervisorSystemPrompt?: string
  /** Extra `supervise()` knobs (perWorker, maxLiveWorkers, router, allowedModels, …). */
  superviseOptions?: Partial<Omit<SuperviseOptions, 'budget' | 'backend' | 'deliverable'>>
}

/**
 * Build the deliverable (completion oracle) for a research supervisor: "settled
 * ⟺ the knowledge base is ready". It re-reads the KB from disk and runs the
 * readiness gate, so the supervisor stops on the REAL grounded state — not on a
 * worker's self-report.
 */
export function knowledgeReadinessDeliverable(
  options: Pick<
    ResearchSupervisorOptions,
    'root' | 'goal' | 'readinessSpecs' | 'readinessTaskId' | 'readiness'
  >,
): DeliverableSpec<unknown> {
  return {
    describe: `knowledge base at ${options.root} is ready for: ${options.goal}`,
    async check() {
      const index = await buildKnowledgeIndex(options.root)
      const bundle = buildEvalKnowledgeBundle({
        ...(options.readiness ?? {}),
        taskId: options.readinessTaskId ?? options.goal,
        index,
        specs: options.readinessSpecs,
      })
      return bundle.report.blockingMissingRequirements.length === 0
    },
  }
}

/**
 * A research supervisor: a SUPERVISOR brain creates the topology dynamically —
 * how many researchers, split by sub-topic — over the `Scope`, with the
 * knowledge-readiness gate as its stop condition.
 *
 * This is a thin wrapper over `supervise(profile, goal, opts)`. It composes the
 * existing pieces and builds nothing new: the researcher `AgentProfile` (from
 * `researcherProfile`) is the worker shape the supervisor spawns, and
 * `knowledgeReadinessDeliverable` (over `scoreKnowledgeReadiness`) is the
 * completion oracle that decides when the KB is ready.
 *
 * Needs creds (a real supervisor router brain + a worker backend), so it is the
 * LIVE path. The offline two-agent loop is `runTwoAgentResearchLoop`.
 */
export async function runResearchSupervisor(
  options: ResearchSupervisorOptions,
): Promise<SupervisedResult<unknown>> {
  await initKnowledgeBase(options.root)

  // The researcher profile is the worker CONTRACT the supervisor spawns against.
  // Its system prompt is appended so the supervisor authors researcher workers
  // that emit source-grounded, propose-don't-apply contributions.
  const { profile: workerProfile } = researcherProfile({ harness: options.harness })
  const baseInstructions = options.supervisorSystemPrompt ?? RESEARCH_SUPERVISOR_SYSTEM_PROMPT
  const workerContract = workerProfile.prompt?.systemPrompt
  const systemPrompt = workerContract
    ? `${baseInstructions}\n\nEach researcher worker you spawn follows this contract:\n${workerContract}`
    : baseInstructions

  const profile: SupervisorProfile = {
    name: 'research-supervisor',
    model: options.supervisorModel,
    systemPrompt,
  }

  return supervise(profile, options.goal, {
    ...options.superviseOptions,
    budget: options.budget,
    backend: options.backend,
    deliverable: knowledgeReadinessDeliverable(options),
  })
}
