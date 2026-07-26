import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createClaimGroundingVerifier, withCitedClaim } from '../../src/claim-grounding'
import {
  buildEvalKnowledgeBundle,
  defineReadinessSpec,
  type KnowledgeReadinessSpec,
} from '../../src/eval-readiness'
import { buildKnowledgeIndex } from '../../src/indexer'
import {
  type ResearchContribution,
  type ResearchDriver,
  type ResearchSourceProposal,
  type ResearchWorker,
  runVerifiedResearchLoop,
  type WorkerResearchContext,
} from '../../src/verified-research-loop'
import {
  createTangleRouterClient,
  createVerifyingResearchDriver,
  createWebResearchWorker,
  type RouterClient,
} from '../../src/web-research-worker'

// ===========================================================================
// CLAIM-GROUNDING A/B: does checking each citation's CLAIM against the fetched
// page text catch an error band the relevance verifier and de-dup CANNOT — and
// does it do so for MORE quality per dollar than the relevance verifier earns
// on the de-dup-dominated topic set (docs/results/cost-quality.md)?
//
// The cost/quality result showed the relevance verifier's cleanliness win is
// dominated by DE-DUPLICATION, which a deterministic content-hash captures at
// ~none of the LLM premium. So the open question is: is there a band where the
// verifier earns its premium — an error a hash and a relevance judge both miss?
//
// MISATTRIBUTION is that band: a source that is on-topic, unique, and real, but
// whose cited CLAIM does not appear in the page (a fabricated / mis-cited fact).
//   - de-dup: passes it (it's unique).
//   - relevance judge: passes it (it's on-topic).
//   - claim-grounding: REJECTS it (the claim is absent from the fetched text).
//
// The grounding check is DETERMINISTIC text presence over `htmlToText` output —
// executable ground truth, $0 inference — so its value-per-dollar denominator is
// near-zero, which is the whole point: it catches what the expensive judge can't
// for what the cheap rule can't.
// ===========================================================================

interface PoolEntry {
  uri: string
  title: string
  text: string
  /** The claim the worker will cite this source for. */
  claim: string
  /** True when `claim` is NOT present in `text` — a planted misattribution. */
  misattributed: boolean
}

const goal = 'self-speculative decoding'

/**
 * A controlled pool: each source's TEXT is what a real fetch would return; the
 * CLAIM is what a citation asserts. Two sources are correctly grounded; two are
 * misattributed — on-topic, unique, real text, but the cited claim never appears
 * in the page. A relevance judge would keep all four; de-dup would keep all four
 * (distinct URLs); only claim-grounding rejects the misattributed two.
 */
const pool: PoolEntry[] = [
  {
    uri: 'https://arxiv.org/abs/self-spec-decoding',
    title: 'Draft & Verify: Lossless LLM Acceleration via Self-Speculative Decoding',
    text:
      'Self-speculative decoding drafts tokens by skipping intermediate layers, then verifies them ' +
      'with the full model. It reports a 1.73x speedup on LLaMA-2 with no quality loss.',
    claim: 'self-speculative decoding reports a 1.73x speedup on LLaMA-2 with no quality loss',
    misattributed: false,
  },
  {
    uri: 'https://example.org/layer-skip-explainer',
    title: 'How layer skipping accelerates decoding',
    text:
      'By skipping intermediate transformer layers during the draft stage, the same model produces ' +
      'candidate tokens cheaply, which the full forward pass then verifies in parallel.',
    claim: 'skipping intermediate layers lets the same model produce candidate tokens cheaply',
    misattributed: false,
  },
  {
    // On-topic, real text, UNIQUE url — but the cited claim (a 5x speedup on a
    // separate draft network) appears NOWHERE in the page. Misattribution.
    uri: 'https://blog.example.com/spec-decoding-overview',
    title: 'A short overview of speculative decoding',
    text:
      'Speculative decoding uses a small draft model to propose tokens that a larger target model ' +
      'verifies. Self-speculative variants reuse a single model instead of a separate draft model.',
    claim: 'achieves a 5x speedup using a separately trained draft transformer network',
    misattributed: true,
  },
  {
    // On-topic, real text, UNIQUE url — cited claim invents a benchmark/number
    // the page never states. Misattribution.
    uri: 'https://news.example.com/decoding-roundup',
    title: 'Decoding methods roundup',
    text:
      'This roundup compares several inference-time decoding strategies and notes that speculative ' +
      'approaches trade extra compute for lower latency on autoregressive generation.',
    claim: 'measured a 4.8x speedup on the GPT-4 MT-bench benchmark with zero accuracy drop',
    misattributed: true,
  },
]

const specs: KnowledgeReadinessSpec[] = [
  defineReadinessSpec({
    id: 'topic/definition',
    description: `what ${goal} is and how it works`,
    query: `${goal} how it works method`,
    requiredFor: ['ResearchAgent'],
    importance: 'blocking',
    minSources: 1,
    minHits: 1,
  }),
]

/** A worker that proposes the whole pool, each source carrying its cited claim. */
function poolWorker(onPass: () => void): ResearchWorker {
  return async (_ctx: WorkerResearchContext): Promise<ResearchContribution> => {
    onPass()
    const sources: ResearchSourceProposal[] = pool.map((entry) =>
      withCitedClaim(
        {
          uri: entry.uri,
          title: entry.title,
          text: entry.text,
          metadata: { planted_misattributed: entry.misattributed },
        },
        entry.claim,
      ),
    )
    return {
      sources,
      buildPages: (accepted) =>
        accepted
          .map((record) => {
            const original = record.metadata?.originalUri
            const entry = pool.find((p) => p.uri === original)
            const slug = String(original ?? record.id).replace(/[^a-z0-9]+/gi, '-')
            return [
              `---FILE: knowledge/${slug}.md---`,
              '---',
              `title: ${entry?.title ?? record.id}`,
              `sources: ["${record.id}"]`,
              '---',
              `# ${entry?.title ?? record.id}`,
              entry?.text ?? '',
              '---END FILE---',
            ].join('\n')
          })
          .join('\n'),
      notes: `proposed ${sources.length} sources (2 grounded, 2 misattributed)`,
    }
  }
}

/** A no-op verifier: accepts everything (the "no verifier" arm). */
const acceptAllDriver: ResearchDriver = { verifySource: () => ({ accept: true }) }

/** A relevance-only verifier stand-in: every pool source IS on-topic, so accept all. */
const relevanceOnlyDriver: ResearchDriver = {
  verifySource: (source: ResearchSourceProposal) => {
    // Everything in the pool mentions decoding/tokens/model → on-topic → accept.
    // This is exactly why relevance can't catch misattribution: the page IS
    // relevant; only its cited claim is wrong.
    const onTopic = /decod|token|model|layer/i.test(source.text)
    return onTopic ? { accept: true } : { accept: false, reason: 'off-topic' }
  },
}

/** Count how many planted-misattributed sources reached the KB. */
async function misattributedAdmitted(root: string): Promise<number> {
  const index = await buildKnowledgeIndex(root)
  return index.sources.filter((s) => s.metadata?.planted_misattributed === true).length
}

async function admittedCount(root: string): Promise<number> {
  const index = await buildKnowledgeIndex(root)
  return index.sources.length
}

let groundRoot: string
let relevanceRoot: string
let noneRoot: string

beforeEach(async () => {
  groundRoot = await mkdtemp(join(tmpdir(), 'cg-ground-'))
  relevanceRoot = await mkdtemp(join(tmpdir(), 'cg-relevance-'))
  noneRoot = await mkdtemp(join(tmpdir(), 'cg-none-'))
})
afterEach(async () => {
  await rm(groundRoot, { recursive: true, force: true })
  await rm(relevanceRoot, { recursive: true, force: true })
  await rm(noneRoot, { recursive: true, force: true })
})

describe('claim-grounding A/B (offline, controlled): catches misattribution dedup+relevance miss', () => {
  it('only the claim-grounding verifier rejects the planted misattributions', async () => {
    let groundPasses = 0
    await Promise.all([
      runVerifiedResearchLoop({
        root: groundRoot,
        goal,
        worker: poolWorker(() => {
          groundPasses += 1
        }),
        driver: { verifySource: createClaimGroundingVerifier() },
        readinessSpecs: specs,
        maxRounds: 1,
      }),
      runVerifiedResearchLoop({
        root: relevanceRoot,
        goal,
        worker: poolWorker(() => {}),
        driver: relevanceOnlyDriver,
        readinessSpecs: specs,
        maxRounds: 1,
      }),
      runVerifiedResearchLoop({
        root: noneRoot,
        goal,
        worker: poolWorker(() => {}),
        driver: acceptAllDriver,
        readinessSpecs: specs,
        maxRounds: 1,
      }),
    ])

    const [groundMis, relevanceMis, noneMis, groundAdmitted] = await Promise.all([
      misattributedAdmitted(groundRoot),
      misattributedAdmitted(relevanceRoot),
      misattributedAdmitted(noneRoot),
      admittedCount(groundRoot),
    ])

    console.log(
      `[claim-grounding A/B offline] misattributed admitted — ` +
        `grounding=${groundMis} relevance=${relevanceMis} no-verifier=${noneMis} ` +
        `(grounding kept ${groundAdmitted}/${pool.length} sources)`,
    )

    // The band: relevance + no-verifier let BOTH misattributions through (they
    // are on-topic + unique); only claim-grounding rejects them.
    expect(groundMis).toBe(0)
    expect(relevanceMis).toBe(2)
    expect(noneMis).toBe(2)
    // Grounding still keeps the two correctly-grounded sources (no over-rejection).
    expect(groundAdmitted).toBe(2)
    expect(groundPasses).toBe(1)
  })
})

// ===========================================================================
// LIVE claim-grounding A/B — the real evidence. Skipped offline (no creds).
//
// Runs a REAL web-research worker (glm-5.2 query-gen → live /v1/search →
// politeFetch → htmlToText) on a topic set, then INJECTS a controlled fraction
// of MISATTRIBUTED citations (real fetched page + a deliberately-wrong claim) so
// there is a measurable correctable band. Three verifier arms gate the SAME
// proposals on the SAME topics:
//
//   A. no-verifier      — accept all (the floor).
//   B. relevance (LLM)  — the shipped createVerifyingResearchDriver: 1 LLM call
//                         per source, judges on-topic relevance.
//   C. claim-grounding  — deterministic groundClaimInText over the fetched text:
//                         $0 inference, rejects misattributions.
//
// Using #36's RouterClient.usage() we diff each arm's tokens/$/latency/calls and
// report VALUE PER DOLLAR = misattributions-caught ÷ marginal-USD. Arm C's
// denominator is ~$0, so if it catches the injected misattributions it dominates
// arm B on this band — the cost the relevance judge could not earn on the
// de-dup-dominated set.
//
// Gate: AGENT_KNOWLEDGE_LIVE=1 + TANGLE_API_KEY with glm-5.2 credits.
//   CLAIM_GROUNDING_LIVE_GOALS  — `|`-separated topics
//   CLAIM_GROUNDING_LIVE_MODEL  — router chat model (default glm-5.2)
// ===========================================================================

interface ArmCost {
  chatCalls: number
  tokens: number
  usd: number
  wallMs: number
}

function diffCost(
  a: ReturnType<RouterClient['usage']>,
  b: ReturnType<RouterClient['usage']>,
): ArmCost {
  return {
    chatCalls: b.chatCalls - a.chatCalls,
    tokens: b.promptTokens + b.completionTokens - a.promptTokens - a.completionTokens,
    usd: b.usd - a.usd,
    wallMs: b.wallMs - a.wallMs,
  }
}

/**
 * Take the sources a real worker fetched and (1) attach a GROUNDED claim built
 * from the page's own text, then (2) corrupt every `corruptEvery`-th source into
 * a MISATTRIBUTION by replacing its claim with one whose specific words are not
 * in the page. Returns the annotated sources plus the count corrupted, so the
 * arms share an identical proposal set with a known misattribution band.
 */
function plantMisattributions(
  sources: ResearchSourceProposal[],
  corruptEvery: number,
): { annotated: ResearchSourceProposal[]; planted: number } {
  let planted = 0
  const fabricated = [
    'this page reports a 7.3x speedup on the FluxBench-9000 benchmark with zero accuracy loss',
    'the authors trained a separate 12-billion-parameter draft transformer on proprietary data',
    'results show a 94.2 BLEU score on the never-released Zephyr-XL evaluation suite',
  ]
  const annotated = sources.map((source, i) => {
    if (sources.length >= 2 && i % corruptEvery === corruptEvery - 1) {
      const claim = fabricated[planted % fabricated.length] ?? fabricated[0]
      planted += 1
      return withCitedClaim(
        { ...source, metadata: { ...source.metadata, planted_misattributed: true } },
        claim,
      )
    }
    // GROUNDED claim: the first sentence of the page's own text (verbatim-present
    // by construction), so a correct citation grounds.
    const firstSentence = source.text.split(/(?<=[.!?])\s/)[0]?.trim() || source.text.slice(0, 160)
    return withCitedClaim(
      { ...source, metadata: { ...source.metadata, planted_misattributed: false } },
      firstSentence,
    )
  })
  return { annotated, planted }
}

describe.skipIf(!process.env.AGENT_KNOWLEDGE_LIVE)('live: claim-grounding A/B per dollar', () => {
  it('three verifier arms on real web sources with a planted misattribution band', async () => {
    const goals = (
      process.env.CLAIM_GROUNDING_LIVE_GOALS ??
      'self-speculative decoding|rotary position embeddings|grouped-query attention'
    )
      .split('|')
      .map((g) => g.trim())
      .filter(Boolean)
    const model = process.env.CLAIM_GROUNDING_LIVE_MODEL ?? 'glm-5.2'
    const router: RouterClient = createTangleRouterClient({ model })

    // COST GATE: cheap glm-5.2 smoke BEFORE the multi-topic burn.
    const smoke = await router.chat(
      [
        { role: 'system', content: 'Reply with exactly the word: OK' },
        { role: 'user', content: 'Say OK.' },
      ],
      1200,
    )
    console.log(`[LIVE smoke] glm-5.2 visible content length=${smoke.trim().length}`)
    expect(smoke.trim().length).toBeGreaterThan(0)

    const worker = createWebResearchWorker({
      router,
      resultsPerQuery: 3,
      queriesPerGap: 1,
      maxSourcesPerRound: 6,
    })
    const relevanceDriver = createVerifyingResearchDriver({ router })
    const groundingDriver: ResearchDriver = { verifySource: createClaimGroundingVerifier() }

    let totalPlanted = 0
    let anyFetched = false
    const rows: {
      goal: string
      planted: number
      caught: Record<'none' | 'relevance' | 'grounding', number>
      cost: Record<'none' | 'relevance' | 'grounding', ArmCost>
    }[] = []

    for (const liveGoal of goals) {
      const liveSpecs: KnowledgeReadinessSpec[] = [
        defineReadinessSpec({
          id: 'topic/definition',
          description: `what ${liveGoal} is and how it works`,
          query: `${liveGoal} how it works method`,
          requiredFor: ['ResearchAgent'],
          importance: 'blocking',
          minSources: 1,
          minHits: 1,
        }),
      ]
      // 1. REAL fetch ONCE per topic, shared by all three arms.
      const probeRoot = await mkdtemp(join(tmpdir(), 'cg-live-probe-'))
      let annotated: ResearchSourceProposal[] = []
      let planted = 0
      try {
        const index = await buildKnowledgeIndex(probeRoot)
        const readiness = buildEvalKnowledgeBundle({ taskId: liveGoal, index, specs: [] })
        const contribution = await worker({
          root: probeRoot,
          goal: liveGoal,
          round: 1,
          index,
          gaps: liveSpecs.map((s) => ({
            id: s.id,
            description: s.description,
            query: typeof s.metadata?.query === 'string' ? s.metadata.query : s.description,
            blocking: true,
          })),
          readiness,
        })
        const fetched = contribution.sources ?? []
        if (fetched.length > 0) anyFetched = true
        const result = plantMisattributions(fetched, 2)
        annotated = result.annotated
        planted = result.planted
        totalPlanted += planted
      } finally {
        await rm(probeRoot, { recursive: true, force: true })
      }

      // 2. Run each arm's verifier over the SAME annotated proposals, diffing cost.
      const staticWorker: ResearchWorker = async () => ({
        sources: annotated,
        buildPages: (accepted) =>
          accepted.length === 0
            ? undefined
            : accepted
                .map((record) => {
                  const original = record.metadata?.originalUri
                  const src = annotated.find((s) => s.uri === original)
                  const slug = String(original ?? record.id)
                    .replace(/[^a-z0-9]+/gi, '-')
                    .slice(0, 120)
                  return [
                    `---FILE: knowledge/${slug}.md---`,
                    '---',
                    `title: ${src?.title ?? record.id}`,
                    `sources: ["${record.id}"]`,
                    '---',
                    `# ${src?.title ?? record.id}`,
                    src?.text ?? '',
                    '---END FILE---',
                  ].join('\n')
                })
                .join('\n'),
      })

      const caught: Record<'none' | 'relevance' | 'grounding', number> = {
        none: 0,
        relevance: 0,
        grounding: 0,
      }
      const cost: Record<'none' | 'relevance' | 'grounding', ArmCost> = {
        none: { chatCalls: 0, tokens: 0, usd: 0, wallMs: 0 },
        relevance: { chatCalls: 0, tokens: 0, usd: 0, wallMs: 0 },
        grounding: { chatCalls: 0, tokens: 0, usd: 0, wallMs: 0 },
      }
      for (const arm of ['none', 'relevance', 'grounding'] as const) {
        const driver =
          arm === 'none' ? acceptAllDriver : arm === 'relevance' ? relevanceDriver : groundingDriver
        const root = await mkdtemp(join(tmpdir(), `cg-live-${arm}-`))
        try {
          const u0 = router.usage()
          await runVerifiedResearchLoop({
            root,
            goal: liveGoal,
            worker: staticWorker,
            driver,
            readinessSpecs: liveSpecs,
            maxRounds: 1,
          })
          cost[arm] = diffCost(u0, router.usage())
          const admittedMis = await misattributedAdmitted(root)
          // caught = planted − admitted misattributions.
          caught[arm] = planted - admittedMis
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      }

      rows.push({ goal: liveGoal, planted, caught, cost })
      console.log(
        `[LIVE CG ${JSON.stringify(liveGoal)}] planted=${planted} ` +
          `caught none=${caught.none} relevance=${caught.relevance} grounding=${caught.grounding} | ` +
          `$ none=${cost.none.usd.toFixed(4)} relevance=${cost.relevance.usd.toFixed(4)} grounding=${cost.grounding.usd.toFixed(4)} | ` +
          `calls relevance=${cost.relevance.chatCalls} grounding=${cost.grounding.chatCalls}`,
      )
    }

    expect(anyFetched).toBe(true)

    // VALUE PER DOLLAR over all topics: misattributions caught ÷ marginal USD.
    const totalCaught = (arm: 'none' | 'relevance' | 'grounding') =>
      rows.reduce((acc, r) => acc + r.caught[arm], 0)
    const totalUsd = (arm: 'none' | 'relevance' | 'grounding') =>
      rows.reduce((acc, r) => acc + r.cost[arm].usd, 0)
    const relevanceCaught = totalCaught('relevance')
    const groundingCaught = totalCaught('grounding')
    const relevanceUsd = totalUsd('relevance')
    const groundingUsd = totalUsd('grounding')
    const perDollar = (caughtN: number, usd: number) =>
      usd > 0 ? caughtN / usd : caughtN > 0 ? Number.POSITIVE_INFINITY : 0

    console.log(
      `[LIVE CG SUMMARY] planted=${totalPlanted} ` +
        `caught relevance=${relevanceCaught} grounding=${groundingCaught} | ` +
        `$ relevance=${relevanceUsd.toFixed(4)} grounding=${groundingUsd.toFixed(4)} | ` +
        `per-$ relevance=${perDollar(relevanceCaught, relevanceUsd).toFixed(1)} ` +
        `grounding=${perDollar(groundingCaught, groundingUsd).toFixed(1)}`,
    )

    // The claim-grounding arm should catch at least as many misattributions as
    // the relevance arm (it is the band relevance cannot see) at strictly lower
    // marginal cost (deterministic, $0 inference). This is the value-per-dollar
    // claim the doc reports; assert the DIRECTION here, the magnitude in the doc.
    expect(groundingCaught).toBeGreaterThanOrEqual(relevanceCaught)
    expect(groundingUsd).toBeLessThanOrEqual(relevanceUsd)
  }, 600_000)
})
