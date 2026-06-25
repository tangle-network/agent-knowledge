import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildEvalKnowledgeBundle,
  defineReadinessSpec,
  type KnowledgeReadinessSpec,
} from '../../src/eval-readiness'
import { sha256, stableId } from '../../src/ids'
import { buildKnowledgeIndex } from '../../src/indexer'
import { createResearchDrivingDriver } from '../../src/research-driving-driver'
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
  type WorkerResearchContext,
} from '../../src/two-agent-research-loop'
import {
  createTangleRouterClient,
  createVerifyingResearchDriver,
  createWebResearchWorker,
  type RouterClient,
  type RouterUsage,
} from '../../src/web-research-worker'
import {
  type ExamTopic,
  type ExpectedGroup,
  gradeTopicAgainstText,
  heldOutExam,
  totalExamQuestions,
} from './held-out-exam'

// ===========================================================================
// THE RESEARCH-QUALITY A/B: does the research-DRIVING loop answer MORE held-out
// deep questions than single-agent collection or the verify/dedup two-agent
// loop, at EQUAL compute?
//
// The prior A/B (research-loop-equal-compute.test.ts) measured CLEANLINESS —
// how few sources the verifier admits. That is the WRONG metric for the driving
// driver, whose whole thesis is the opposite: it pursues DEPTH and VALIDATION,
// not source hygiene. So this file changes the metric to research QUALITY:
//
//   QUALITY = held-out deep questions the resulting KB can answer.
//
// THE FIREWALL (the load-bearing design choice). The exam (held-out-exam.ts) is
// NEVER shown to any loop. Every arm is told only the topic name + the SAME
// generic readiness specs (a "definition" gap and a "results" gap). It researches
// blind. AFTER it finishes we grade the KB it built against questions it never
// saw, with a $0 deterministic substring grader (no LLM, so the exam can't leak
// into a model the loop observes). A high score is therefore research quality
// (the arm pursued the depth that happens to answer the exam) — NOT teaching to
// the test.
//
// THE THREE ARMS — identical real web worker, differ ONLY in the driver:
//   (A) single-agent collection: the worker alone, no driver. It collects.
//   (B) verify/dedup two-agent loop (createVerifyingResearchDriver): a second
//       LLM filters each source for relevance / near-duplicates. It cleans.
//   (C) research-DRIVING loop (createResearchDrivingDriver): the driver extracts
//       claims, tracks independent-source support + contradictions, and steers
//       the worker DEEPER each round (comparative / mechanism / gap /
//       contradiction sub-questions). It deepens.
//
// EQUAL COMPUTE — counted in agent passes (same unit as the prior A/B):
//   - single-agent iter = 1 worker pass.
//   - two-agent round   = 1 worker pass + 1 driver pass = 2 passes.
// Each arm gets the SAME pass ceiling B; the single-agent arm gets up to B iters
// to spend the budget the two-agent arms burn on their driver. The harness reads
// RouterClient.usage() per arm so the dollars/tokens/calls are MEASURED, not
// assumed — the honest cost half.
//
// HYPOTHESIS: arm C answers MORE held-out deep questions than A or B, because it
// chased depth + corroboration rather than breadth (A) or cleanliness (B). If it
// does NOT, this file says so plainly — a real negative result.
// ===========================================================================

/** The generic readiness specs every arm gets — the ONLY thing the loop is told. */
function genericSpecsForGoal(goal: string): KnowledgeReadinessSpec[] {
  return [
    defineReadinessSpec({
      id: 'topic/definition',
      description: `what ${goal} is and how it works`,
      query: `${goal} how it works method`,
      requiredFor: ['ResearchAgent'],
      importance: 'blocking',
      minSources: 1,
      minHits: 1,
    }),
    defineReadinessSpec({
      id: 'topic/results',
      description: `reported results, mechanisms, or trade-offs for ${goal}`,
      query: `${goal} results trade-offs mechanism`,
      requiredFor: ['ResearchAgent'],
      importance: 'blocking',
      minSources: 1,
      minHits: 1,
    }),
  ]
}

/**
 * The full curated text of a KB, joined for grading. We grade against PAGES
 * (what the loop curated + what readiness scores) AND raw source text (so an arm
 * whose pages are thin but whose sources are rich still gets credit for what it
 * actually fetched). This is the text the held-out grader scans — it is read
 * ONLY after the loop finished, never handed to the loop.
 */
async function kbText(root: string): Promise<string> {
  const index = await buildKnowledgeIndex(root)
  const pageText = index.pages.map((page) => `${page.title}\n${page.text}`).join('\n\n')
  const sourceText = index.sources
    .map((source) => `${source.title ?? ''}\n${source.text ?? ''}`)
    .join('\n\n')
  return `${pageText}\n\n${sourceText}`
}

/** Distinct held-out answer COMPONENTS (expected groups) the KB covers — the depth proxy. */
function depthComponentsCovered(
  topic: ExamTopic,
  text: string,
): { covered: number; total: number } {
  const haystack = text.toLowerCase()
  const allGroups: ExpectedGroup[] = topic.questions.flatMap((question) => question.expected)
  const covered = allGroups.filter((group) =>
    group.anyOf.some((fragment) => haystack.includes(fragment.toLowerCase())),
  ).length
  return { covered, total: allGroups.length }
}

/** Per-arm cost diff from the shared router's cumulative usage accumulator. */
function costDiff(before: RouterUsage, after: RouterUsage) {
  return {
    chatCalls: after.chatCalls - before.chatCalls,
    searchCalls: after.searchCalls - before.searchCalls,
    tokens:
      after.promptTokens + after.completionTokens - before.promptTokens - before.completionTokens,
    usd: after.usd - before.usd,
    wallMs: after.wallMs - before.wallMs,
  }
}

/**
 * ARM A — single-agent collection. The real worker proposes; the loop applies
 * every proposal with NO driver gate. Up to `maxIterations` worker passes. The
 * worker is invoked ONCE per pass (sources + buildPages from the same call), so
 * arm A's cost is exactly one worker pass per iteration — fair against the
 * two-agent arms whose extra cost is the driver, not a duplicate worker call.
 */
async function runSingleAgentArm(
  root: string,
  goal: string,
  maxIterations: number,
  worker: ResearchWorker,
  specs: KnowledgeReadinessSpec[],
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
      if (report && report.blockingMissingRequirements.length === 0) {
        return { done: true, notes: 'readiness gate met' }
      }
      const gaps = (report?.blockingMissingRequirements ?? []).map((req) => ({
        id: req.id,
        description: req.description,
        query:
          typeof req.metadata?.query === 'string'
            ? (req.metadata.query as string)
            : req.description,
        blocking: true,
      }))
      const index = await buildKnowledgeIndex(root)
      // No steer: the single-agent arm has no driver, so it never receives the
      // depth steering the two-agent arms fold in. That asymmetry IS the arm.
      const contribution = await worker({
        root,
        goal,
        round: passes,
        index,
        gaps,
        readiness: buildEvalKnowledgeBundle({ taskId: goal, index, specs: [] }),
      })
      const proposals = contribution.sources ?? []
      if (proposals.length === 0) return { notes: 'no new proposals' }
      // Apply every proposal with the worker's own citing-page builder, NO gate
      // (that is the whole point of the single-agent arm). Pages cite the
      // precomputed real source id the loop will assign.
      const built = contribution.buildPages?.(
        proposals.map((p) => ({
          id: predictedSourceId(p),
          uri: p.uri,
          contentHash: '',
          createdAt: new Date().toISOString(),
          metadata: { originalUri: p.uri },
        })),
      )
      return { sourceTexts: proposals, proposalText: built, notes: `applied ${proposals.length}` }
    },
  })
  return { passes }
}

/**
 * ARMS B and C — the two-agent loop with the given driver. Each round is one
 * worker pass + one driver pass = 2 passes; capped at `rounds` rounds. The
 * worker pass is counted via a thin wrapper so the equal-compute accounting holds.
 */
async function runTwoAgentArm(
  root: string,
  goal: string,
  rounds: number,
  worker: ResearchWorker,
  driver: ResearchDriver,
  specs: KnowledgeReadinessSpec[],
): Promise<{ passes: number }> {
  let workerPasses = 0
  const countedWorker: ResearchWorker = async (
    ctx: WorkerResearchContext,
  ): Promise<ResearchContribution> => {
    workerPasses += 1
    return worker(ctx)
  }
  await runTwoAgentResearchLoop({
    root,
    goal,
    worker: countedWorker,
    driver,
    readinessSpecs: specs,
    maxRounds: rounds,
  })
  return { passes: workerPasses * 2 }
}

/** The deterministic source-record id `addSourceText` will assign (src/sources.ts). */
function predictedSourceId(source: ResearchSourceProposal): string {
  return stableId('src', `${sha256(source.text)}:${source.uri}`)
}

interface ArmResult {
  passes: number
  answered: number
  total: number
  depthCovered: number
  depthTotal: number
  cost: ReturnType<typeof costDiff>
}

/** Run one arm, grade its KB against the held-out exam, diff its cost. */
async function runAndGrade(
  run: (root: string) => Promise<{ passes: number }>,
  topic: ExamTopic,
  router: RouterClient,
): Promise<ArmResult> {
  const root = await mkdtemp(join(tmpdir(), 'rq-arm-'))
  try {
    const before = router.usage()
    const { passes } = await run(root)
    const cost = costDiff(before, router.usage())
    const text = await kbText(root)
    const grade = gradeTopicAgainstText(topic, text)
    const depth = depthComponentsCovered(topic, text)
    return {
      passes,
      answered: grade.answered,
      total: grade.total,
      depthCovered: depth.covered,
      depthTotal: depth.total,
      cost,
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// OFFLINE WIRING TEST (no creds): proves the grader + the three-arm harness
// work against a scripted KB, so a live run that returns zeros is a real null,
// not a broken harness.
// ---------------------------------------------------------------------------

describe('research-quality A/B harness (offline wiring)', () => {
  it('the held-out grader answers a question only when the KB text contains the expected answer', () => {
    const topic = heldOutExam[0]
    if (!topic) throw new Error('exam topic 0 missing')
    // A KB whose text contains the rejection-sampling mechanism + lossless claim
    // answers specdec/q1; an empty KB answers nothing.
    const richText =
      'Speculative decoding uses rejection sampling to accept draft tokens, which preserves the target distribution exactly (lossless, no quality loss). The speedup is bounded by the acceptance rate and is ultimately memory bandwidth limited. A separate small draft model proposes tokens verified in a single forward pass in parallel.'
    const rich = gradeTopicAgainstText(topic, richText)
    const empty = gradeTopicAgainstText(topic, '')
    expect(rich.answered).toBeGreaterThan(0)
    expect(empty.answered).toBe(0)
    // Depth components: the rich text covers several expected groups; empty zero.
    expect(depthComponentsCovered(topic, richText).covered).toBeGreaterThan(0)
    expect(depthComponentsCovered(topic, '').covered).toBe(0)
  })

  it('the exam is well-formed: 5 topics, 4-6 deep questions each, every question checkable', () => {
    expect(heldOutExam.length).toBe(5)
    for (const topic of heldOutExam) {
      expect(topic.questions.length).toBeGreaterThanOrEqual(4)
      expect(topic.questions.length).toBeLessThanOrEqual(6)
      for (const question of topic.questions) {
        expect(question.expected.length).toBeGreaterThan(0)
        for (const group of question.expected) {
          expect(group.anyOf.length).toBeGreaterThan(0)
        }
      }
    }
    expect(totalExamQuestions()).toBeGreaterThanOrEqual(20)
  })
})

// ===========================================================================
// LIVE 3-ARM A/B — the real evidence. Skipped offline (no creds). Runs the real
// web worker on each held-out topic through all three drivers at equal compute,
// grades each KB against the firewalled exam, and reports per-arm answered /
// depth / cost. Gate: AGENT_KNOWLEDGE_LIVE=1 + a TANGLE_API_KEY with glm-5.2.
//   RQ_LIVE_BUDGET — agent-pass ceiling B per arm (default 4)
//   RQ_LIVE_MODEL  — router chat model (default glm-5.2)
//   RQ_LIVE_TOPICS — `|`-separated subset of exam topic names (default: all 5)
// ===========================================================================

describe.skipIf(!process.env.AGENT_KNOWLEDGE_LIVE)('live: research-quality 3-arm A/B', () => {
  it('driving vs verify/dedup vs single-agent — held-out deep questions answered', async () => {
    const budgetPasses = Number(process.env.RQ_LIVE_BUDGET ?? 4)
    const model = process.env.RQ_LIVE_MODEL ?? 'glm-5.2'
    const topicFilter = (process.env.RQ_LIVE_TOPICS ?? '')
      .split('|')
      .map((t) => t.trim())
      .filter(Boolean)
    const topics = topicFilter.length
      ? heldOutExam.filter((t) => topicFilter.some((f) => t.topic.includes(f)))
      : heldOutExam
    expect(topics.length).toBeGreaterThan(0)

    // ONE shared router client for the whole run (web search + chat). usage() is
    // cumulative; each arm diffs it.
    const router: RouterClient = createTangleRouterClient({ model })

    // COST GATE: a cheap glm-5.2 smoke BEFORE the multi-arm burn. Proves the key
    // works + the reasoning-token floor returns visible content. Fail fast if not.
    const smoke = await router.chat(
      [
        { role: 'system', content: 'Reply with exactly the word: OK' },
        { role: 'user', content: 'Say OK.' },
      ],
      1200,
    )
    console.log(`[RQ smoke] ${model} visible content length=${smoke.trim().length}`)
    expect(smoke.trim().length).toBeGreaterThan(0)

    // The SAME real worker for all three arms — only the driver differs.
    const worker = createWebResearchWorker({
      router,
      resultsPerQuery: 3,
      queriesPerGap: 1,
      maxSourcesPerRound: 6,
    })

    const perArm: Record<'single' | 'verify' | 'driving', ArmResult[]> = {
      single: [],
      verify: [],
      driving: [],
    }

    for (const topic of topics) {
      const goal = topic.topic
      const specs = genericSpecsForGoal(goal)

      // ARM A — single-agent collection (no driver).
      const single = await runAndGrade(
        (root) => runSingleAgentArm(root, goal, budgetPasses, worker, specs),
        topic,
        router,
      )
      // ARM B — verify/dedup two-agent loop. A fresh verifying driver per topic.
      const verify = await runAndGrade(
        (root) =>
          runTwoAgentArm(
            root,
            goal,
            budgetPasses / 2,
            worker,
            createVerifyingResearchDriver({ router }),
            specs,
          ),
        topic,
        router,
      )
      // ARM C — research-DRIVING loop. A fresh driving driver per topic.
      const driving = await runAndGrade(
        (root) =>
          runTwoAgentArm(
            root,
            goal,
            budgetPasses / 2,
            worker,
            createResearchDrivingDriver({ router }),
            specs,
          ),
        topic,
        router,
      )

      perArm.single.push(single)
      perArm.verify.push(verify)
      perArm.driving.push(driving)

      const fmt = (a: ArmResult) =>
        `ans=${a.answered}/${a.total} depth=${a.depthCovered}/${a.depthTotal} passes=${a.passes} ` +
        `calls=${a.cost.chatCalls} tok=${a.cost.tokens} $${a.cost.usd.toFixed(4)} ${a.cost.wallMs}ms`
      console.log(
        `[RQ ${JSON.stringify(goal)} @ B<=${budgetPasses}]\n` +
          `  single : ${fmt(single)}\n` +
          `  verify : ${fmt(verify)}\n` +
          `  driving: ${fmt(driving)}`,
      )
    }

    // Aggregate per arm: total held-out questions answered + total depth + cost.
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
    const agg = (results: ArmResult[]) => ({
      answered: sum(results.map((r) => r.answered)),
      total: sum(results.map((r) => r.total)),
      depthCovered: sum(results.map((r) => r.depthCovered)),
      depthTotal: sum(results.map((r) => r.depthTotal)),
      usd: sum(results.map((r) => r.cost.usd)),
      calls: sum(results.map((r) => r.cost.chatCalls)),
      tokens: sum(results.map((r) => r.cost.tokens)),
    })
    const a = agg(perArm.single)
    const b = agg(perArm.verify)
    const c = agg(perArm.driving)
    const examTotal = totalExamQuestions(topics)

    console.log(
      `\n[RQ TOTALS over ${topics.length} topics, ${examTotal} held-out questions @ B<=${budgetPasses}]\n` +
        `  single-agent : answered ${a.answered}/${a.total} depth ${a.depthCovered}/${a.depthTotal} $${a.usd.toFixed(4)} (${a.calls} calls, ${a.tokens} tok)\n` +
        `  verify/dedup : answered ${b.answered}/${b.total} depth ${b.depthCovered}/${b.depthTotal} $${b.usd.toFixed(4)} (${b.calls} calls, ${b.tokens} tok)\n` +
        `  DRIVING      : answered ${c.answered}/${c.total} depth ${c.depthCovered}/${c.depthTotal} $${c.usd.toFixed(4)} (${c.calls} calls, ${c.tokens} tok)\n` +
        `  HYPOTHESIS (driving answers MORE deep questions): ${c.answered > a.answered && c.answered > b.answered ? 'SUPPORTED' : 'NOT SUPPORTED'} ` +
        `(driving ${c.answered} vs single ${a.answered} vs verify ${b.answered})`,
    )

    // The live arm is only evidence if at least one arm fetched real pages and
    // answered at least one held-out question. All-zero across arms = the worker
    // never reached the web — a FALSE null, fail loud.
    expect(a.answered + b.answered + c.answered).toBeGreaterThan(0)

    // This is a MEASUREMENT, not a pass/fail gate — the doc reports the honest
    // verdict whichever way it falls. We only assert the harness produced a
    // real, gradable result for every arm (each ran its passes within budget).
    for (const arm of [...perArm.single, ...perArm.verify, ...perArm.driving]) {
      expect(arm.passes).toBeLessThanOrEqual(budgetPasses)
    }
  }, 1_200_000)
})

// ===========================================================================
// CONTROLLED MULTI-ROUND PROBE — the driving thesis's FAIREST test.
//
// The main A/B above found driving does NOT win. The autopsy (see the doc)
// showed WHY: the generic readiness gate (one source per spec) is satisfied by
// the FIRST round's fetch, so the loop stops after one round — and the driving
// driver's whole mechanism is multi-round steering (extract claims → demand
// corroboration → re-search). It never gets a round 2 to drive. So the main A/B
// tests "does driving help in one round?" (no, it just costs more), NOT "does
// driving's depth-steering help WHEN it runs?".
//
// This probe isolates the latter. It raises the readiness bar (minSources high)
// so the gate STAYS unmet and the loop runs the full round budget — forcing the
// driving driver to actually steer across rounds. Same real worker, same round
// budget; the ONLY difference is whether the driver steers (driving) or the
// worker re-searches the same gaps blind (single). If driving's steering has
// ANY value, this is where it shows — a KB built over rounds the driver pushed
// deeper should answer more held-out questions than the same rounds run blind.
// If it STILL doesn't win here, the negative result is robust, not a gate
// artifact. Gate: AGENT_KNOWLEDGE_LIVE=1 + RQ_PROBE=1 (it is the priciest run).
// ===========================================================================

/** Readiness specs that STAY unmet (high minSources) so the loop runs all rounds. */
function multiRoundSpecsForGoal(goal: string): KnowledgeReadinessSpec[] {
  return [
    defineReadinessSpec({
      id: 'topic/definition',
      description: `what ${goal} is and how it works`,
      query: `${goal} how it works method`,
      requiredFor: ['ResearchAgent'],
      importance: 'blocking',
      // Demand many sources so the gate never closes the loop early — the loop
      // runs the full maxRounds and the driving driver gets to steer each round.
      minSources: 99,
      minHits: 1,
    }),
  ]
}

describe.skipIf(!(process.env.AGENT_KNOWLEDGE_LIVE && process.env.RQ_PROBE))(
  'live: controlled multi-round probe (driving steering vs blind re-search)',
  () => {
    it('forces N rounds so driving actually steers — does it then answer more?', async () => {
      const rounds = Number(process.env.RQ_PROBE_ROUNDS ?? 3)
      const model = process.env.RQ_LIVE_MODEL ?? 'glm-5.2'
      const topicFilter = (process.env.RQ_LIVE_TOPICS ?? '')
        .split('|')
        .map((t) => t.trim())
        .filter(Boolean)
      const topics = topicFilter.length
        ? heldOutExam.filter((t) => topicFilter.some((f) => t.topic.includes(f)))
        : heldOutExam
      const router: RouterClient = createTangleRouterClient({ model })

      const smoke = await router.chat(
        [
          { role: 'system', content: 'Reply with exactly the word: OK' },
          { role: 'user', content: 'Say OK.' },
        ],
        1200,
      )
      expect(smoke.trim().length).toBeGreaterThan(0)

      const worker = createWebResearchWorker({
        router,
        resultsPerQuery: 3,
        queriesPerGap: 1,
        maxSourcesPerRound: 6,
      })
      const drivingResults: ArmResult[] = []
      const blindResults: ArmResult[] = []

      for (const topic of topics) {
        const goal = topic.topic
        const specs = multiRoundSpecsForGoal(goal)
        // DRIVING: the driver steers the worker deeper each of `rounds` rounds.
        const driving = await runAndGrade(
          (root) =>
            runTwoAgentArm(
              root,
              goal,
              rounds,
              worker,
              createResearchDrivingDriver({ router }),
              specs,
            ),
          topic,
          router,
        )
        // BLIND: the SAME worker over the SAME rounds with a no-op driver (accept
        // every source, no steer) — it re-searches the same gaps without the
        // driver's depth steering. The matched control for "steering vs not".
        const blind = await runAndGrade(
          (root) => runTwoAgentArm(root, goal, rounds, worker, noopDriver(), specs),
          topic,
          router,
        )
        drivingResults.push(driving)
        blindResults.push(blind)
        console.log(
          `[RQ PROBE ${JSON.stringify(goal)} @ ${rounds} rounds]\n` +
            `  driving: ans=${driving.answered}/${driving.total} depth=${driving.depthCovered}/${driving.depthTotal} $${driving.cost.usd.toFixed(4)}\n` +
            `  blind  : ans=${blind.answered}/${blind.total} depth=${blind.depthCovered}/${blind.depthTotal} $${blind.cost.usd.toFixed(4)}`,
        )
      }

      const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
      const dAns = sum(drivingResults.map((r) => r.answered))
      const blAns = sum(blindResults.map((r) => r.answered))
      const dUsd = sum(drivingResults.map((r) => r.cost.usd))
      const blUsd = sum(blindResults.map((r) => r.cost.usd))
      console.log(
        `\n[RQ PROBE TOTALS over ${topics.length} topics @ ${rounds} rounds]\n` +
          `  DRIVING (steered): answered ${dAns} $${dUsd.toFixed(4)}\n` +
          `  blind (no steer) : answered ${blAns} $${blUsd.toFixed(4)}\n` +
          `  STEERING HELPS: ${dAns > blAns ? 'YES' : 'NO'} (driving ${dAns} vs blind ${blAns})`,
      )
      expect(dAns + blAns).toBeGreaterThan(0)
    }, 1_800_000)
  },
)

/** A no-op driver: accept every source, no steer. The blind control for the probe. */
function noopDriver(): ResearchDriver {
  return { verifySource: () => ({ accept: true }) }
}

let _root: string
beforeEach(async () => {
  _root = await mkdtemp(join(tmpdir(), 'rq-'))
})
afterEach(async () => {
  await rm(_root, { recursive: true, force: true })
})
