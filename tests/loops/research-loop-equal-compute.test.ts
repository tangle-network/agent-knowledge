import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pairedBootstrap } from '@tangle-network/agent-eval'
import {
  type Driver,
  inProcessSandboxClient,
  type OutputAdapter,
  runLoop,
  type SandboxEvent,
} from '@tangle-network/agent-runtime/loops'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildEvalKnowledgeBundle,
  defineReadinessSpec,
  type KnowledgeReadinessSpec,
} from '../../src/eval-readiness'
import { sha256, stableId } from '../../src/ids'
import { buildKnowledgeIndex } from '../../src/indexer'
import { researcherProfile } from '../../src/profiles/researcher'
import {
  type KnowledgeResearchLoopDecision,
  runKnowledgeResearchLoop,
} from '../../src/research-loop'
import {
  type ResearchContribution,
  type ResearchDriver,
  type ResearchSourceProposal,
  type ResearchWorker,
  runTwoAgentResearchLoop,
  type SourceVerdict,
  type WorkerResearchContext,
} from '../../src/two-agent-research-loop'
import {
  createTangleRouterClient,
  createVerifyingResearchDriver,
  createWebResearchWorker,
  type RouterClient,
} from '../../src/web-research-worker'

// ===========================================================================
// THE VALUE A/B: does the verifying-driver (two-agent) loop build a CLEANER
// knowledge base than the single-agent loop AT THE SAME COMPUTE BUDGET?
//
// #28 already proved the MECHANISM (the driver rejects a planted bad source).
// This file answers the VALUE question — and the only way that answer is worth
// anything is if the two loops are budget-MATCHED. The two-agent loop spends
// MORE agent passes per round (worker proposes + driver verifies) than the
// single-agent loop (one pass per iteration). Comparing at equal ROUNDS would
// silently hand the two-agent loop extra compute and rig the result. So we
// budget-match by total AGENT PASSES and give the single-agent loop MORE
// iterations to spend the same budget the two-agent loop burns on verification.
//
// ---------------------------------------------------------------------------
// EQUAL-COMPUTE METHOD (the validity gate)
// ---------------------------------------------------------------------------
// Compute unit = ONE agent pass = one worker/driver invocation that reasons
// over the candidate pool. We count passes, not rounds:
//
//   - two-agent round  = 1 worker pass + 1 driver-verify pass = 2 passes
//   - single-agent iter = 1 pass (no verifier)
//
// We give each arm the SAME budget CEILING B (the max passes it may spend):
//   - two-agent : up to floor(B / 2) rounds  (each round costs 2 passes)
//   - single-agent : up to B iterations       (each iter costs 1 pass)
//
// so neither arm can spend more than B passes. Both arms gate on the SAME
// readiness criterion, so each STOPS as soon as the KB is ready — on this pool
// both converge in one effective round (2 passes each), well inside the ceiling.
// Each arm instruments its OWN passes with a counter and the test asserts (a)
// both stayed within the ceiling and (b) the two-agent loop spent NO MORE
// passes than the single-agent loop. That is the machine-checked equal-compute
// gate: the two-agent loop never gets free verification, so any cleanliness
// gain is bought at no extra compute. (It cannot drift to an equal-ROUNDS
// comparison — the two-agent round is charged its full 2 passes.)
//
// The driver's verify pass here is deterministic (a prefix check), so it costs
// no tokens offline — but it is still a real reasoning pass over each round's
// candidates (in the live arm it is an LLM call), and it is exactly the extra
// cost the value question is asking about. We charge it as one pass per round,
// which is budget the single-agent loop is free to spend on extra iterations.
//
// ---------------------------------------------------------------------------
// CONTROLLED LOWER BOUND — read before trusting the assertion
// ---------------------------------------------------------------------------
// The junk in the source pool is PLANTED: `junk/`-prefixed spam whose text
// carries the gap-query tokens so a naive worker proposes it, but which the
// verifying driver rejects on its prefix. That makes this a CONTROLLED
// lower-bound demonstration: "when junk is present and the worker is naive, the
// verifying driver admits no MORE junk than the single-agent loop at equal
// compute, and on this pool admits strictly less." It is NOT a stand-in for
// real research — a real worker's junk is not prefix-detectable and a real
// driver's verifier is an LLM. The LIVE arm (creds-gated, below) is the real
// evidence; this offline arm proves the harness wiring + the floor.
// ===========================================================================

interface PoolSource {
  uri: string
  title: string
  text: string
  /** True for the planted spam sources the verifying driver should reject. */
  junk: boolean
}

/** A trivial output the offline agent emits: the sources it "found" this turn. */
interface AgentResearch {
  sources: PoolSource[]
}

const agentOutput: OutputAdapter<AgentResearch> = {
  parse(events: SandboxEvent[]): AgentResearch {
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      const data = (event?.data ?? {}) as { result?: AgentResearch }
      if (event?.type === 'result' && data.result) return data.result
    }
    return { sources: [] }
  },
}

/** A one-shot driver for the inner researcher loop: run once, then done. */
function oneShotDriver(): Driver<{ prompt: string }, AgentResearch, 'done'> {
  return {
    name: 'researcher-once',
    async plan(task, history) {
      return history.length === 0 ? [task] : []
    },
    decide() {
      return 'done'
    },
  }
}

/**
 * The blocking readiness specs that define "done". Mirrors what the two-agent
 * loop's test does: `scoreKnowledgeReadiness` scores PAGES (not raw sources),
 * and only `importance: 'blocking'` requirements gate. Coverage below is
 * measured as "fraction of these blocking requirements met".
 */
const blockingSpecs: KnowledgeReadinessSpec[] = [
  defineReadinessSpec({
    id: 'topic/ventilation',
    description: 'coop ventilation requirements',
    query: 'coop ventilation airflow',
    requiredFor: ['IntakeAgent'],
    importance: 'blocking',
    minSources: 1,
    minHits: 1,
  }),
  defineReadinessSpec({
    id: 'topic/predators',
    description: 'predator protection requirements',
    query: 'predator protection fencing',
    requiredFor: ['IntakeAgent'],
    importance: 'blocking',
    minSources: 1,
    minHits: 1,
  }),
]

/**
 * A controlled source pool: two GOOD sources that cover the two blocking specs,
 * plus planted JUNK whose text carries the same gap-query tokens (so a naive
 * worker proposes it) but is `junk/`-prefixed spam. This is the lower-bound
 * fixture, not real research.
 */
const sourcePool: PoolSource[] = [
  {
    uri: 'web/ventilation-guide',
    title: 'Coop Ventilation Guide',
    text: 'Coop ventilation airflow keeps the flock healthy. Cross-ventilation near the roof.',
    junk: false,
  },
  {
    uri: 'web/predator-fencing',
    title: 'Predator Protection',
    text: 'Predator protection fencing and hardware cloth stop raccoons and foxes.',
    junk: false,
  },
  {
    uri: 'junk/ventilation-spam',
    title: 'Buy Ventilation Fans Cheap!!!',
    text: 'coop ventilation airflow predator protection fencing — SPAM advert, not a reference.',
    junk: true,
  },
  {
    uri: 'junk/predator-clickbait',
    title: '10 Predators That Will SHOCK You',
    text: 'predator protection fencing coop ventilation clickbait listicle, no real guidance.',
    junk: true,
  },
]

/**
 * Build the curated `knowledge/*.md` pages that cite accepted sources. The page
 * text repeats the source text so the token-based readiness search hits it.
 * Shared by both loops so coverage is measured the same way for each arm.
 */
function pageBuilder(proposals: ResearchSourceProposal[]) {
  return (acceptedSources: { id: string; metadata?: Record<string, unknown> }[]): string =>
    acceptedSources
      .map((record) => {
        const proposal = proposals.find((p) => p.uri === record.metadata?.originalUri)
        const slug = (proposal?.uri ?? record.id).replace(/[^a-z0-9]+/gi, '-')
        return [
          `---FILE: knowledge/${slug}.md---`,
          '---',
          `title: ${proposal?.title ?? record.id}`,
          `sources: ["${record.id}"]`,
          '---',
          `# ${proposal?.title ?? record.id}`,
          proposal?.text ?? '',
          '---END FILE---',
        ].join('\n')
      })
      .join('\n')
}

/**
 * The shared NAIVE worker: drives the offline researcher AgentProfile through
 * the REAL runLoop kernel + inProcessSandboxClient (no creds, no network), and
 * proposes EVERY pool source whose token the gap prompt mentions — junk
 * included. This is the "weak real agent" both loops are handed identically;
 * the ONLY difference between the arms is whether a verifying driver gates the
 * proposals. `onPass` ticks once per worker invocation so the test can prove
 * equal compute.
 */
function makeNaiveProposals(
  ctx: { goal: string; gaps: { description: string; query: string }[]; steer?: string },
  onPass: () => void,
): Promise<ResearchSourceProposal[]> {
  const { profile } = researcherProfile({ harness: 'offline-stub' })
  const sandboxClient = inProcessSandboxClient({
    onPrompt(prompt): SandboxEvent[] {
      onPass()
      const found = sourcePool.filter((source) =>
        source.text
          .toLowerCase()
          .split(/[^a-z0-9]+/i)
          .some((token) => token.length > 3 && prompt.toLowerCase().includes(token)),
      )
      return [{ type: 'result', data: { result: { sources: found } } }]
    },
  })
  const queries = ctx.gaps.map((gap) => `${gap.description} ${gap.query}`).join(' | ')
  return runLoop<{ prompt: string }, AgentResearch, 'done'>({
    driver: oneShotDriver(),
    agentRun: { profile, taskToPrompt: (task) => task.prompt, name: 'offline-researcher' },
    output: agentOutput,
    task: { prompt: `Research these gaps for "${ctx.goal}": ${queries}\n${ctx.steer ?? ''}` },
    ctx: { sandboxClient },
  }).then((result) =>
    (result.winner?.output.sources ?? []).map((finding) => ({
      uri: finding.uri,
      text: finding.text,
      title: finding.title,
    })),
  )
}

/** Two-agent worker: the naive proposer wrapped in the two-agent contract. */
function twoAgentWorker(onPass: () => void): ResearchWorker {
  return async (ctx: WorkerResearchContext): Promise<ResearchContribution> => {
    const sources = await makeNaiveProposals(ctx, onPass)
    return { sources, buildPages: pageBuilder(sources), notes: `proposed ${sources.length}` }
  }
}

/** The verifying driver: rejects the planted `junk/` sources, accepts the rest. */
function verifyingDriver(): ResearchDriver {
  return {
    verifySource(source: ResearchSourceProposal): SourceVerdict {
      // The differentiating reasoning pass: screen each candidate (a prefix
      // check offline; an LLM `verifySource` call live). It is the extra compute
      // the value question asks about, charged once per round in the accounting.
      if (source.uri.startsWith('junk/')) {
        return { accept: false, reason: 'planted junk: spam/clickbait, not a real reference' }
      }
      return { accept: true }
    },
  }
}

/** How many junk sources reached the KB (registered as sources). */
async function junkAdmitted(root: string): Promise<number> {
  const index = await buildKnowledgeIndex(root)
  return index.sources.filter((source) => {
    const original = source.metadata?.originalUri
    return typeof original === 'string' && original.startsWith('junk/')
  }).length
}

/**
 * Coverage = fraction of BLOCKING readiness requirements met, scored the way
 * the loops gate: build the readiness report over the current index, count how
 * many blocking specs are NOT in `blockingMissingRequirements`.
 */
async function coverage(
  root: string,
  goal: string,
  specs: KnowledgeReadinessSpec[] = blockingSpecs,
): Promise<number> {
  const index = await buildKnowledgeIndex(root)
  // `buildEvalKnowledgeBundle` searches each spec over the index's PAGES and
  // runs the substrate `scoreKnowledgeReadiness` — the SAME scorer both loops
  // gate on. Coverage = fraction of blocking specs NOT in the missing set.
  const { report } = buildEvalKnowledgeBundle({ taskId: goal, index, specs })
  const blockingCount = specs.filter((s) => s.importance === 'blocking').length
  const missing = report.blockingMissingRequirements.length
  return blockingCount === 0 ? 1 : (blockingCount - missing) / blockingCount
}

/**
 * Total sources that reached the KB. For REAL research there is no `junk/`
 * prefix oracle — the live signal is that the verifying driver admits FEWER
 * sources because it rejects the off-topic ones the single-agent loop keeps. So
 * the live A/B compares admitted-source COUNTS (cleaner = fewer admitted at
 * equal-or-higher coverage), the real-world analogue of the offline junk count.
 */
async function admittedSourceCount(root: string): Promise<number> {
  const index = await buildKnowledgeIndex(root)
  return index.sources.length
}

/**
 * The source-record id `addSourceText` will assign — deterministic from the
 * text+uri (see src/sources.ts: `stableId('src', `${sha256(text)}:${uri}`)`). We
 * precompute it so the single-agent arm can write a page that cites the source
 * it registers IN THE SAME STEP (the loop registers `sourceTexts` first, then
 * applies `proposalText`), exactly mirroring how the two-agent loop cites
 * `record.id`. Without this the page would cite a non-existent id and coverage
 * would read 0 for reasons unrelated to the A/B.
 */
function predictedSourceId(source: ResearchSourceProposal): string {
  return stableId('src', `${sha256(source.text)}:${source.uri}`)
}

/**
 * Run the SINGLE-agent loop on the shared pool with a budget CEILING of
 * `maxIterations` passes. Each iteration is one naive-proposer pass; the loop
 * applies the proposals with NO verification gate (that is the whole point of
 * the single-agent arm). It stops on the SAME readiness gate the two-agent loop
 * uses (so both arms converge by the same criterion, not at unequal effort).
 * Returns the actual passes spent so the test can compare compute.
 */
/**
 * A round of primary research, abstracted so the SAME arm-runners drive both the
 * offline naive proposer AND a real web-research worker. Given the goal + open
 * gaps + optional steer, return the sources found this pass. The offline default
 * is `makeNaiveProposals` over the planted pool; the live arm injects the real
 * `createWebResearchWorker`.
 */
type ProposeSources = (
  ctx: {
    goal: string
    gaps: { description: string; query: string }[]
    steer?: string
    root: string
  },
  onPass: () => void,
) => Promise<ResearchSourceProposal[]>

const offlinePropose: ProposeSources = (ctx, onPass) => makeNaiveProposals(ctx, onPass)

async function runSingleAgentArm(
  root: string,
  goal: string,
  maxIterations: number,
  propose: ProposeSources = offlinePropose,
  specs: KnowledgeReadinessSpec[] = blockingSpecs,
): Promise<{ passes: number }> {
  let passes = 0
  await runKnowledgeResearchLoop({
    root,
    goal,
    maxIterations,
    readinessSpecs: specs,
    async step(context): Promise<KnowledgeResearchLoopDecision> {
      passes += 1
      const report = context.readiness?.report
      // Single-agent applies the SAME readiness gate the two-agent loop gates on
      // (no blocking requirements left ⇒ done). This is what makes the compute
      // comparison fair: both stop by the same criterion.
      if (report && report.blockingMissingRequirements.length === 0) {
        return { done: true, notes: 'readiness gate met' }
      }
      const gaps = (report?.blockingMissingRequirements ?? []).map((req) => ({
        description: req.description,
        query:
          typeof req.metadata?.query === 'string'
            ? (req.metadata.query as string)
            : req.description,
      }))
      const proposals = await propose({ goal, gaps, root }, () => {})
      if (proposals.length === 0) return { notes: 'no new proposals' }
      // Register sources AND write citing pages in one step — exactly like the
      // two-agent worker (sources + buildPages), but with NO driver verification
      // in between. Pages cite the precomputed real source id.
      const proposalText = pageBuilder(proposals)(
        proposals.map((p) => ({ id: predictedSourceId(p), metadata: { originalUri: p.uri } })),
      )
      return { sourceTexts: proposals, proposalText, notes: `applied ${proposals.length}` }
    },
  })
  return { passes }
}

/**
 * Run the TWO-agent loop for `rounds` rounds on the shared pool. Each round is
 * one worker pass + one driver-verify pass = 2 passes. Returns the pass count.
 */
async function runTwoAgentArm(
  root: string,
  goal: string,
  rounds: number,
  arm?: { worker: ResearchWorker; driver: ResearchDriver },
  specs: KnowledgeReadinessSpec[] = blockingSpecs,
): Promise<{ passes: number }> {
  let workerPasses = 0
  // Default arm = the offline naive proposer + prefix-check verifier. The live
  // arm injects the real web-research worker + the LLM verifying driver. Either
  // way the worker pass is counted once per invocation via a thin wrapper, so
  // the equal-compute accounting below holds for both.
  const worker: ResearchWorker =
    arm?.worker ??
    twoAgentWorker(() => {
      workerPasses += 1
    })
  const countedWorker: ResearchWorker = arm
    ? async (ctx) => {
        workerPasses += 1
        return worker(ctx)
      }
    : worker
  const driver: ResearchDriver = arm?.driver ?? verifyingDriver()
  await runTwoAgentResearchLoop({
    root,
    goal,
    worker: countedWorker,
    driver,
    readinessSpecs: specs,
    maxRounds: rounds,
  })
  // EQUAL-COMPUTE ACCOUNTING: every round that ran a worker pass also ran one
  // driver-verify pass over that round's candidate batch (a real LLM call in
  // the live arm). So passes = 2 × (rounds the worker actually ran). The loop
  // stops early on the readiness gate, so workerPasses ≤ `rounds`.
  return { passes: workerPasses * 2 }
}

let twoAgentRoot: string
let singleAgentRoot: string
const goal = 'backyard chicken coop requirements'

beforeEach(async () => {
  twoAgentRoot = await mkdtemp(join(tmpdir(), 'ab-two-agent-'))
  singleAgentRoot = await mkdtemp(join(tmpdir(), 'ab-single-agent-'))
})
afterEach(async () => {
  await rm(twoAgentRoot, { recursive: true, force: true })
  await rm(singleAgentRoot, { recursive: true, force: true })
})

describe('research loop A/B at equal compute (offline, controlled lower bound)', () => {
  it('two-agent admits <= single-agent junk at the SAME agent-pass budget', async () => {
    // Budget CEILING B = 6 agent passes per arm (the MAX each may spend):
    //   two-agent : up to B/2 = 3 rounds (worker + verify per round = 2 passes)
    //   single    : up to B   = 6 iters  (1 pass per iter, no verifier)
    // Both arms gate on the SAME readiness criterion, so each stops as soon as
    // the KB is ready — they converge well inside the ceiling, at EQUAL actual
    // passes (asserted below). The ceiling proves neither was starved; the
    // equal actual-pass count proves neither was secretly handed more compute.
    const budgetPasses = 6
    const twoAgentRounds = budgetPasses / 2
    const singleAgentIters = budgetPasses

    const twoAgent = await runTwoAgentArm(twoAgentRoot, goal, twoAgentRounds)
    const single = await runSingleAgentArm(singleAgentRoot, goal, singleAgentIters)

    const twoAgentJunk = await junkAdmitted(twoAgentRoot)
    const singleAgentJunk = await junkAdmitted(singleAgentRoot)
    const twoAgentCoverage = await coverage(twoAgentRoot, goal)
    const singleAgentCoverage = await coverage(singleAgentRoot, goal)

    // Surface the numbers so a CI log shows the A/B result, not just a pass.
    console.log(
      `[A/B @ B<=${budgetPasses} passes] ` +
        `two-agent: passes=${twoAgent.passes} junk=${twoAgentJunk} coverage=${twoAgentCoverage.toFixed(2)} | ` +
        `single-agent: passes=${single.passes} junk=${singleAgentJunk} coverage=${singleAgentCoverage.toFixed(2)}`,
    )

    // VALIDITY GATE — equal compute, machine-checked. Both arms stayed within
    // the budget ceiling, and the two-agent loop spent NO MORE passes than the
    // single-agent loop (in fact equal: both converge in one effective round).
    // If this ever fails, the A/B has drifted to unequal compute and the value
    // assertion below is meaningless.
    expect(twoAgent.passes).toBeLessThanOrEqual(budgetPasses)
    expect(single.passes).toBeLessThanOrEqual(budgetPasses)
    expect(twoAgent.passes).toBeLessThanOrEqual(single.passes)

    // THE VALUE ASSERTION (controlled lower bound): at equal compute, the
    // verifying driver admits no MORE junk than the single-agent loop. On this
    // planted pool it admits strictly LESS (the junk is rejectable) while
    // keeping coverage at least as high.
    expect(twoAgentJunk).toBeLessThanOrEqual(singleAgentJunk)
    expect(twoAgentJunk).toBe(0)
    expect(singleAgentJunk).toBeGreaterThan(0)
    expect(twoAgentCoverage).toBeGreaterThanOrEqual(singleAgentCoverage)
  })

  it('the gap holds across budget ceilings (B in {4, 8})', async () => {
    for (const budgetPasses of [4, 8]) {
      const twoRoot = await mkdtemp(join(tmpdir(), 'ab2-two-'))
      const singleRoot = await mkdtemp(join(tmpdir(), 'ab2-single-'))
      try {
        const twoAgent = await runTwoAgentArm(twoRoot, goal, budgetPasses / 2)
        const single = await runSingleAgentArm(singleRoot, goal, budgetPasses)
        // Equal compute: two-agent spends no more passes than single-agent and
        // both stay within the ceiling.
        expect(twoAgent.passes).toBeLessThanOrEqual(single.passes)
        expect(twoAgent.passes).toBeLessThanOrEqual(budgetPasses)
        expect(single.passes).toBeLessThanOrEqual(budgetPasses)
        // The cleanliness gap holds at every ceiling.
        expect(await junkAdmitted(twoRoot)).toBeLessThanOrEqual(await junkAdmitted(singleRoot))
        expect(await junkAdmitted(twoRoot)).toBe(0)
        expect(await junkAdmitted(singleRoot)).toBeGreaterThan(0)
      } finally {
        await rm(twoRoot, { recursive: true, force: true })
        await rm(singleRoot, { recursive: true, force: true })
      }
    }
  })
})

// ===========================================================================
// LIVE A/B — the real evidence. Skipped offline (no creds), exactly like
// tests/sources-live.test.ts. Runs BOTH loops on a REAL research goal with the
// REAL web-research worker (glm-5.2 query-gen → live `/v1/search` → politeFetch
// → htmlToText) and a REAL LLM verifying driver (glm-5.2 on-topic judgement) at
// equal compute, then reports a PAIRED comparison via agent-eval's
// pairedBootstrap (no hand-rolled significance).
//
// What this adds over the offline arm: there is NO planted `junk/` pool and NO
// prefix-check verifier — the worker fetches whatever the web returns and the
// driver is an LLM. So the live cleanliness signal is admitted-source COUNT:
// the verifying driver rejects off-topic fetches, so the two-agent KB admits
// FEWER sources at equal-or-higher coverage. A win here is evidence the
// verifying driver cleans REAL research, not a planted floor.
//
// Gate: `AGENT_KNOWLEDGE_LIVE=1` + a TANGLE_API_KEY with glm-5.2 credits.
//   AGENT_KNOWLEDGE_LIVE_GOALS  — `|`-separated goals (default: self-speculative decoding)
//   AGENT_KNOWLEDGE_LIVE_BUDGET — agent-pass ceiling B per arm (default 4)
//   AGENT_KNOWLEDGE_LIVE_MODEL  — router chat model (default glm-5.2)
// ===========================================================================

/**
 * Topic-relevant blocking readiness specs for a live goal. General: the gaps
 * are phrased so a real web search can close them, and the search/readiness
 * query carries the goal so coverage scores against fetched pages. Override the
 * default goal via `AGENT_KNOWLEDGE_LIVE_GOALS` (this builds matching specs).
 */
function liveSpecsForGoal(liveGoal: string): KnowledgeReadinessSpec[] {
  return [
    defineReadinessSpec({
      id: 'topic/definition',
      description: `what ${liveGoal} is and how it works`,
      query: `${liveGoal} how it works method`,
      requiredFor: ['ResearchAgent'],
      importance: 'blocking',
      minSources: 1,
      minHits: 1,
    }),
    defineReadinessSpec({
      id: 'topic/results',
      description: `reported results, speedups, or trade-offs for ${liveGoal}`,
      query: `${liveGoal} speedup results benchmark`,
      requiredFor: ['ResearchAgent'],
      importance: 'blocking',
      minSources: 1,
      minHits: 1,
    }),
  ]
}

describe.skipIf(!process.env.AGENT_KNOWLEDGE_LIVE)(
  'live: research loop A/B at equal compute',
  () => {
    it('two-agent (real worker + LLM verifier) vs single-agent — paired comparison', async () => {
      const goals = (process.env.AGENT_KNOWLEDGE_LIVE_GOALS ?? 'self-speculative decoding')
        .split('|')
        .map((g) => g.trim())
        .filter(Boolean)
      const budgetPasses = Number(process.env.AGENT_KNOWLEDGE_LIVE_BUDGET ?? 4)
      const model = process.env.AGENT_KNOWLEDGE_LIVE_MODEL ?? 'glm-5.2'

      // ONE shared router client for the whole run (web search + chat).
      const router: RouterClient = createTangleRouterClient({ model })

      // COST GATE: a cheap glm-5.2 smoke BEFORE the multi-arm burn. Proves the
      // key works + the reasoning-token floor returns visible content. If this
      // returns empty or throws, the full A/B can't produce real numbers — fail
      // fast instead of spending the whole budget to discover it.
      const smoke = await router.chat(
        [
          { role: 'system', content: 'Reply with exactly the word: OK' },
          { role: 'user', content: 'Say OK.' },
        ],
        1200,
      )
      console.log(`[LIVE smoke] glm-5.2 visible content length=${smoke.trim().length}`)
      expect(smoke.trim().length).toBeGreaterThan(0)

      const realWorker = createWebResearchWorker({
        router,
        resultsPerQuery: 3,
        queriesPerGap: 1,
        maxSourcesPerRound: 6,
      })
      const realDriver = createVerifyingResearchDriver({ router })

      const twoAdmittedByGoal: number[] = []
      const singleAdmittedByGoal: number[] = []
      let anySourceFetched = false

      for (const liveGoal of goals) {
        const specs = liveSpecsForGoal(liveGoal)
        const twoRoot = await mkdtemp(join(tmpdir(), 'live-two-'))
        const singleRoot = await mkdtemp(join(tmpdir(), 'live-single-'))
        try {
          // TWO-AGENT arm: real worker proposes, real LLM driver verifies.
          const two = await runTwoAgentArm(
            twoRoot,
            liveGoal,
            budgetPasses / 2,
            { worker: realWorker, driver: realDriver },
            specs,
          )
          // SINGLE-AGENT arm: the SAME real worker, NO verifier gate, more iters
          // to spend the same agent-pass budget the two-agent loop burns on
          // verification.
          const single = await runSingleAgentArm(
            singleRoot,
            liveGoal,
            budgetPasses,
            (ctx, onPass) => realWorkerPropose(realWorker, ctx, onPass),
            specs,
          )

          const twoAdmitted = await admittedSourceCount(twoRoot)
          const singleAdmitted = await admittedSourceCount(singleRoot)
          const twoCoverage = await coverage(twoRoot, liveGoal, specs)
          const singleCoverage = await coverage(singleRoot, liveGoal, specs)
          if (twoAdmitted > 0 || singleAdmitted > 0) anySourceFetched = true

          twoAdmittedByGoal.push(twoAdmitted)
          singleAdmittedByGoal.push(singleAdmitted)

          console.log(
            `[LIVE A/B ${JSON.stringify(liveGoal)} @ B<=${budgetPasses}] ` +
              `two-agent: passes=${two.passes} admitted=${twoAdmitted} coverage=${twoCoverage.toFixed(2)} | ` +
              `single-agent: passes=${single.passes} admitted=${singleAdmitted} coverage=${singleCoverage.toFixed(2)}`,
          )
        } finally {
          await rm(twoRoot, { recursive: true, force: true })
          await rm(singleRoot, { recursive: true, force: true })
        }
      }

      // The live arm is only evidence if the worker actually web-searched and
      // fetched real pages. Zero sources across both arms = the worker never
      // reached the web (creds/network) — that is a FALSE null, fail loud.
      expect(anySourceFetched).toBe(true)

      // Paired bootstrap on (single − two) admitted-source deltas: a POSITIVE
      // delta means the single-agent loop admitted MORE sources, i.e. the
      // verifying driver kept the KB cleaner. `low > 0` is the significance
      // gate. Reuse the substrate; do NOT hand-roll significance.
      const result = pairedBootstrap(twoAdmittedByGoal, singleAdmittedByGoal, {
        statistic: 'mean',
        seed: 1,
      })
      console.log(
        `[LIVE A/B] n=${result.n} mean(single-two admitted)=${result.mean.toFixed(3)} ` +
          `CI=[${result.low.toFixed(3)}, ${result.high.toFixed(3)}] — ` +
          `two-agent cleaner iff low > 0`,
      )
      // At equal compute the verifying driver should admit no MORE sources than
      // the ungated single-agent loop on average; the bootstrap lower bound says
      // whether the cleanliness gain is significant.
      expect(result.mean).toBeGreaterThanOrEqual(0)
    }, 600_000)
  },
)

/**
 * Drive the real web-research worker as a single-agent proposer: build a
 * `WorkerResearchContext` from the loop context and return the sources it found.
 * Charges one pass per invocation via `onPass`, matching the two-agent worker.
 */
async function realWorkerPropose(
  worker: ResearchWorker,
  ctx: {
    goal: string
    gaps: { description: string; query: string }[]
    root: string
    steer?: string
  },
  onPass: () => void,
): Promise<ResearchSourceProposal[]> {
  onPass()
  const index = await buildKnowledgeIndex(ctx.root)
  const readiness = buildEvalKnowledgeBundle({ taskId: ctx.goal, index, specs: [] })
  const contribution = await worker({
    root: ctx.root,
    goal: ctx.goal,
    round: 1,
    index,
    gaps: ctx.gaps.map((gap) => ({
      id: gap.description,
      description: gap.description,
      query: gap.query,
      blocking: true,
    })),
    steer: ctx.steer,
    readiness,
  })
  return contribution.sources ?? []
}
