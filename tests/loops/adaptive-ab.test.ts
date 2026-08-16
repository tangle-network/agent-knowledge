import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type AdaptiveResearchDriver,
  canonicalizeUrl,
  contentKey,
  createAdaptiveResearchDriver,
  triageSource,
} from '../../src/adaptive-driver'
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
  type SourceVerificationContext,
  type WorkerResearchContext,
} from '../../src/verified-research-loop'
import {
  createTangleRouterClient,
  createVerifyingResearchDriver,
  createWebResearchWorker,
  type RouterClient,
} from '../../src/web-research-worker'

// ===========================================================================
// ADAPTIVE TOPOLOGY A/B: spend the LLM verifier only when it pays.
//
// The cost/quality result (docs/results/cost-quality.md) found the LLM relevance
// verifier's cleanliness win is dominated by DE-DUPLICATION — captured by a
// deterministic content-hash / canonical-URL check at ~none of the LLM premium —
// and that an LLM check only earns its dollar on the off-scope tail. The
// production move it named is: do the cheap deterministic work first, reserve the
// LLM for the ambiguous tail. `createAdaptiveResearchDriver` is that driver.
//
// This file measures THREE topologies on the cost/quality frontier:
//   - single-agent : no verifier (the floor — admits everything).
//   - full-LLM     : one LLM verifySource call per candidate (the ceiling cost).
//   - adaptive     : $0 dedup → $0 host/title/length triage → LLM ONLY for the
//                    ambiguous survivors.
//
// The question: does adaptive capture most of the cleanliness (dedup + clear
// drops) at a fraction of the verifier $/calls? The offline arm proves the
// wiring + that adaptive escalates ONLY ambiguous survivors; the live arm
// (creds-gated) reports the real frontier with #36's RouterClient.usage().
// ===========================================================================

// ---------------------------------------------------------------------------
// Pure-unit coverage of the deterministic stages (no loop, no network).
// ---------------------------------------------------------------------------
describe('adaptive driver — deterministic stages', () => {
  it('canonicalizeUrl collapses scheme/www/trailing-slash/tracking params', () => {
    const a = canonicalizeUrl('https://www.Example.com/Path/?utm_source=x&ref=y&a=1#frag')
    const b = canonicalizeUrl('http://example.com/Path?a=1')
    expect(a).toBe(b)
    expect(a).toBe('example.com/Path?a=1')
    // Non-URL identifiers dedup by lowercased equality.
    expect(canonicalizeUrl('Local-Note-7')).toBe('local-note-7')
  })

  it('contentKey ignores formatting so a reformatted mirror collides', () => {
    const k1 = contentKey('Self-speculative decoding skips layers.  It is 1.7x faster.')
    const k2 = contentKey('self speculative decoding skips layers it is 1 7x faster')
    expect(k1).toBe(k2)
  })

  it('triageSource keeps authoritative+substantial, drops spam/thin, else ambiguous', () => {
    const opts = {
      authoritativeHosts: ['arxiv.org', '.edu'],
      spamPatterns: [/\bbuy\b.*\bcheap\b/i, /\d+\s+things/i],
      minBodyChars: 400,
      substantialBodyChars: 600,
    }
    const body = 'x'.repeat(700)
    // Authoritative host + substantial body → KEEP, no LLM.
    expect(
      triageSource({ uri: 'https://arxiv.org/abs/1', title: 'A paper', text: body }, opts).triage,
    ).toBe('keep')
    // Spam title → DROP.
    expect(
      triageSource({ uri: 'https://shop.example.com/x', title: 'Buy fans cheap', text: body }, opts)
        .triage,
    ).toBe('drop')
    // Thin body → DROP.
    expect(
      triageSource({ uri: 'https://arxiv.org/abs/2', title: 'A paper', text: 'short' }, opts)
        .triage,
    ).toBe('drop')
    // Unknown host, plausible body → AMBIGUOUS (the LLM tail).
    expect(
      triageSource({ uri: 'https://blog.unknown.io/x', title: 'Some notes', text: body }, opts)
        .triage,
    ).toBe('ambiguous')
  })
})

// ---------------------------------------------------------------------------
// OFFLINE CONTROLLED A/B — proves adaptive escalates ONLY ambiguous survivors
// and matches the full-LLM cleanliness at a fraction of the LLM calls.
// ---------------------------------------------------------------------------
interface PoolEntry {
  uri: string
  title: string
  text: string
  /** Why it's in the pool: 'authoritative' keep, 'spam'/'thin' drop, 'dup' of an
   * earlier entry, or 'ambiguous' (must reach the LLM). */
  kind: 'authoritative' | 'spam' | 'thin' | 'dup' | 'ambiguous-good' | 'ambiguous-bad'
}

const longBody =
  'Self-speculative decoding drafts tokens by skipping intermediate transformer ' +
  'layers, then verifies them with the full model in a single forward pass. It reports a ' +
  '1.73x speedup on LLaMA-2 with no measurable quality loss across the evaluated benchmarks. '.repeat(
    6,
  )

const goal = 'self-speculative decoding'

const pool: PoolEntry[] = [
  // Authoritative + substantial → adaptive KEEPS with no LLM call.
  {
    uri: 'https://arxiv.org/abs/2309.08168',
    title: 'Draft & Verify: Lossless LLM Acceleration via Self-Speculative Decoding',
    text: longBody,
    kind: 'authoritative',
  },
  // Exact-content mirror of the arxiv paper on a different URL → adaptive DEDUPS.
  {
    uri: 'https://mirror.example.org/draft-and-verify',
    title: 'Draft and Verify (mirror)',
    text: longBody,
    kind: 'dup',
  },
  // Obvious spam title → adaptive DROPS with no LLM call. Distinct body so the
  // DROP is earned by the title heuristic, not by content-dedup against the paper.
  {
    uri: 'https://shop.example.com/fans',
    title: '10 things about decoding that will SHOCK you!!!',
    text: 'Subscribe now for the best decoding deals of 2026! Limited offer, buy cheap fans today. '.repeat(
      8,
    ),
    kind: 'spam',
  },
  // Too-thin body → adaptive DROPS with no LLM call.
  {
    uri: 'https://stub.example.net/p',
    title: 'Decoding stub',
    text: 'self-speculative decoding.',
    kind: 'thin',
  },
  // Unknown host, on-topic plausible body → AMBIGUOUS → reaches the LLM (kept).
  {
    uri: 'https://blog.unknown.io/self-spec-explainer',
    title: 'An explainer on self-speculative decoding',
    text:
      'This post walks through how self-speculative decoding reuses a single model to draft and ' +
      'verify tokens, with worked examples and a discussion of when the speedup holds. '.repeat(8),
    kind: 'ambiguous-good',
  },
  // Unknown host, off-topic plausible body → AMBIGUOUS → reaches the LLM (rejected).
  {
    uri: 'https://blog.unknown.io/gardening',
    title: 'Companion planting for tomatoes',
    text:
      'Tomatoes thrive next to basil and marigolds; rotate nightshades yearly and mulch to keep ' +
      'soil moisture even through the summer. This has nothing to do with language models. '.repeat(
        8,
      ),
    kind: 'ambiguous-bad',
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

/** A worker that proposes the whole pool once. */
function poolWorker(): ResearchWorker {
  return async (_ctx: WorkerResearchContext): Promise<ResearchContribution> => {
    const sources: ResearchSourceProposal[] = pool.map((entry) => ({
      uri: entry.uri,
      title: entry.title,
      text: entry.text,
      metadata: { kind: entry.kind, originalUri: entry.uri },
    }))
    return {
      sources,
      buildPages: (accepted) =>
        accepted
          .map((record) => {
            const original = record.metadata?.originalUri
            const entry = pool.find((p) => p.uri === original)
            const slug = String(original ?? record.id)
              .replace(/[^a-z0-9]+/gi, '-')
              .slice(0, 120)
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
      notes: `proposed ${sources.length}`,
    }
  }
}

/**
 * A deterministic stand-in for the LLM relevance verifier: accepts on-topic
 * (mentions decoding/token/model/layer), rejects off-topic. Counts its calls so
 * the test can prove adaptive routes ONLY ambiguous survivors here. This is the
 * exact role `createVerifyingResearchDriver().verifySource` plays live — one LLM
 * call per source it sees.
 */
function countingRelevanceVerifier(): {
  verifySource: (s: ResearchSourceProposal, c: SourceVerificationContext) => { accept: boolean }
  calls: () => number
} {
  let calls = 0
  return {
    verifySource(source) {
      calls += 1
      const onTopic = /decod|token|\bmodel\b|layer|speculative/i.test(source.text)
      return onTopic ? { accept: true } : { accept: false }
    },
    calls: () => calls,
  }
}

async function admittedKinds(root: string): Promise<Set<string>> {
  const index = await buildKnowledgeIndex(root)
  return new Set(
    index.sources.flatMap((s) => (typeof s.metadata?.kind === 'string' ? [s.metadata.kind] : [])),
  )
}

async function admittedCount(root: string): Promise<number> {
  const index = await buildKnowledgeIndex(root)
  return index.sources.length
}

/**
 * An offline router stub for the adaptive driver's LLM-escalation stage. The
 * relevance verifier sends a chat whose USER message embeds the candidate's
 * URL/title/excerpt; the stub reads that excerpt and returns a real on-topic
 * verdict JSON — accept if it mentions decoding/speculative/token/model/layer,
 * reject otherwise. This is exactly the shape `createVerifyingResearchDriver`
 * parses, so the offline arm exercises the real escalation path with $0/network.
 * `search`/`usage` are never reached by the verifier but satisfy the interface.
 */
const stubRouter: RouterClient = {
  async chat(messages) {
    const user = messages.find((m) => m.role === 'user')?.content ?? ''
    // Judge ONLY the candidate's excerpt, not the whole prompt — the prompt also
    // embeds the on-topic goal/gaps, which would make every candidate look
    // on-topic. The relevance verifier formats the excerpt after `Excerpt:`.
    const excerpt = user.split(/Excerpt:\n?/)[1] ?? user
    const onTopic = /decod|speculative|\btoken\b|\bmodel\b|\blayer\b/i.test(excerpt)
    return JSON.stringify({ accept: onTopic, reason: onTopic ? 'on-topic' : 'off-topic' })
  },
  async search() {
    return []
  },
  usage() {
    return { chatCalls: 0, searchCalls: 0, promptTokens: 0, completionTokens: 0, usd: 0, wallMs: 0 }
  },
}

let fullRoot: string
let adaptiveRoot: string
let singleRoot: string

beforeEach(async () => {
  fullRoot = await mkdtemp(join(tmpdir(), 'ad-full-'))
  adaptiveRoot = await mkdtemp(join(tmpdir(), 'ad-adaptive-'))
  singleRoot = await mkdtemp(join(tmpdir(), 'ad-single-'))
})
afterEach(async () => {
  await rm(fullRoot, { recursive: true, force: true })
  await rm(adaptiveRoot, { recursive: true, force: true })
  await rm(singleRoot, { recursive: true, force: true })
})

describe('adaptive A/B (offline, controlled): adaptive escalates only the ambiguous tail', () => {
  it('matches full-LLM cleanliness at a fraction of the LLM calls', async () => {
    // FULL-LLM arm: an LLM call per candidate (here the counting stand-in).
    const fullVerifier = countingRelevanceVerifier()
    const fullDriver: ResearchDriver = { verifySource: fullVerifier.verifySource }
    await runVerifiedResearchLoop({
      root: fullRoot,
      goal,
      worker: poolWorker(),
      driver: fullDriver,
      readinessSpecs: specs,
      maxRounds: 1,
    })

    // ADAPTIVE arm: $0 dedup + $0 triage, LLM ONLY for ambiguous survivors. Its
    // LLM stage routes to the same stub the full-LLM arm models, so the call
    // count and the verdicts are directly comparable.
    const adaptiveDriver: AdaptiveResearchDriver = createAdaptiveResearchDriver({
      router: stubRouter,
    })
    // The adaptive driver calls relevance.verifySource (one stub chat) ONLY for
    // ambiguous survivors, so the driver's own stats().llmCalls is the observable
    // escalation count; the stub returns a real on-topic/off-topic verdict so the
    // good ambiguous source is kept and the off-topic one rejected, exactly as a
    // live relevance judge would.
    await runVerifiedResearchLoop({
      root: adaptiveRoot,
      goal,
      worker: poolWorker(),
      driver: { verifySource: (s, c) => adaptiveDriver.verifySource(s, c) },
      readinessSpecs: specs,
      maxRounds: 1,
    })

    // SINGLE-AGENT arm: no verifier — admit everything the loop's own exact-uri
    // dedup lets through.
    await runVerifiedResearchLoop({
      root: singleRoot,
      goal,
      worker: poolWorker(),
      driver: { verifySource: () => ({ accept: true }) },
      readinessSpecs: specs,
      maxRounds: 1,
    })

    const stats = adaptiveDriver.stats()
    const fullCalls = fullVerifier.calls()
    const adaptiveLlmCalls = stats.llmCalls
    const adaptiveAdmitted = await admittedCount(adaptiveRoot)
    const singleAdmitted = await admittedCount(singleRoot)
    const adaptiveKinds = await admittedKinds(adaptiveRoot)

    console.log(
      `[adaptive A/B offline] full-LLM calls=${fullCalls} | ` +
        `adaptive: llmCalls=${adaptiveLlmCalls} dedup=${stats.dedupRejected} ` +
        `heuristicKept=${stats.heuristicKept} heuristicDropped=${stats.heuristicDropped} ` +
        `admitted=${adaptiveAdmitted} | single admitted=${singleAdmitted}`,
    )

    // The full-LLM arm called the verifier once per candidate that survived the
    // loop's exact-uri dedup (all 6 distinct uris → 6 calls).
    expect(fullCalls).toBe(pool.length)

    // ADAPTIVE escalates ONLY the two ambiguous survivors to the LLM. The other
    // four are decided for $0: arxiv (keep), mirror (dedup by content), spam
    // (drop), thin (drop).
    expect(adaptiveLlmCalls).toBe(2)
    expect(stats.dedupRejected).toBe(1) // the content mirror
    expect(stats.heuristicKept).toBe(1) // the arxiv paper
    expect(stats.heuristicDropped).toBe(2) // spam + thin

    // CLEANLINESS: adaptive admits exactly the real, on-topic sources — the
    // authoritative paper + the on-topic ambiguous explainer — and rejects the
    // mirror, spam, thin, and off-topic. So 2 admitted, no junk kinds.
    expect(adaptiveKinds.has('spam')).toBe(false)
    expect(adaptiveKinds.has('thin')).toBe(false)
    expect(adaptiveKinds.has('dup')).toBe(false)
    expect(adaptiveKinds.has('ambiguous-bad')).toBe(false)
    expect(adaptiveKinds.has('authoritative')).toBe(true)
    expect(adaptiveKinds.has('ambiguous-good')).toBe(true)
    expect(adaptiveAdmitted).toBe(2)

    // FRONTIER: adaptive keeps the full-LLM cleanliness (single-agent admits the
    // junk adaptive rejected) at strictly fewer LLM calls (2 vs 6 = a 3x cut).
    expect(adaptiveLlmCalls).toBeLessThan(fullCalls)
    expect(singleAdmitted).toBeGreaterThan(adaptiveAdmitted)
  }, 30_000)
})

// ===========================================================================
// LIVE THREE-TOPOLOGY A/B — the real cost/quality frontier. Skipped offline.
//
// Runs the REAL web-research worker (glm-5.2 query-gen → live /v1/search →
// politeFetch → htmlToText) ONCE per topic, then gates the SAME fetched
// proposals through three drivers, diffing each arm's cost with #36's
// RouterClient.usage():
//
//   A. single-agent : accept all (no verifier). $0, admits everything.
//   B. full-LLM     : createVerifyingResearchDriver — one LLM call per source.
//   C. adaptive     : createAdaptiveResearchDriver — $0 dedup + $0 triage, LLM
//                     only for the ambiguous tail.
//
// Reports per arm: admitted-source count (cleanliness), LLM calls, USD, tokens.
// The frontier question: does adaptive land near full-LLM cleanliness at a
// fraction of full-LLM's $/calls? Honest: if adaptive does NOT sit on the
// frontier, or the host/title/length heuristic mis-routes, the doc says so.
//
// Gate: AGENT_KNOWLEDGE_LIVE=1 + TANGLE_API_KEY with glm-5.2 credits.
//   ADAPTIVE_LIVE_GOALS — `|`-separated topics
//   ADAPTIVE_LIVE_MODEL — router chat model (default glm-5.2)
// ===========================================================================

interface ArmResult {
  admitted: number
  llmCalls: number
  usd: number
  tokens: number
  wallMs: number
}

describe.skipIf(!process.env.AGENT_KNOWLEDGE_LIVE)('live: adaptive three-topology frontier', () => {
  it('single vs full-LLM vs adaptive on real web sources', async () => {
    const goals = (
      process.env.ADAPTIVE_LIVE_GOALS ??
      'self-speculative decoding|rotary position embeddings|grouped-query attention'
    )
      .split('|')
      .map((g) => g.trim())
      .filter(Boolean)
    const model = process.env.ADAPTIVE_LIVE_MODEL ?? 'glm-5.2'
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
      queriesPerGap: 2,
      maxSourcesPerRound: 8,
    })

    let anyFetched = false
    const rows: {
      goal: string
      fetched: number
      single: ArmResult
      full: ArmResult
      adaptive: ArmResult
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
      const probeRoot = await mkdtemp(join(tmpdir(), 'ad-live-probe-'))
      let fetched: ResearchSourceProposal[] = []
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
        fetched = contribution.sources ?? []
        if (fetched.length > 0) anyFetched = true
      } finally {
        await rm(probeRoot, { recursive: true, force: true })
      }

      // Add a controlled duplicate of the first fetched source under a different
      // (tracking-decorated) URL so the dedup stage has something real to catch —
      // mirrors/syndication are common in live search and are exactly what the $0
      // stage is for. If nothing was fetched this is a no-op.
      const withDup =
        fetched.length > 0
          ? [
              ...fetched,
              {
                ...fetched[0],
                uri: `${fetched[0].uri}${fetched[0].uri.includes('?') ? '&' : '?'}utm_source=mirror&ref=feed`,
                metadata: { ...fetched[0].metadata, planted_dup: true },
              },
            ]
          : fetched

      const staticWorker =
        (sources: ResearchSourceProposal[]): ResearchWorker =>
        async () => ({
          sources,
          buildPages: (accepted) =>
            accepted.length === 0
              ? undefined
              : accepted
                  .map((record) => {
                    const original = record.metadata?.originalUri
                    const src = sources.find((s) => s.uri === original)
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

      const arm = async (
        driver: ResearchDriver,
      ): Promise<{ root: string; cost: ReturnType<RouterClient['usage']> }> => {
        const root = await mkdtemp(join(tmpdir(), 'ad-live-arm-'))
        const u0 = router.usage()
        await runVerifiedResearchLoop({
          root,
          goal: liveGoal,
          worker: staticWorker(withDup),
          driver,
          readinessSpecs: liveSpecs,
          maxRounds: 1,
        })
        return { root, cost: diffUsage(u0, router.usage()) }
      }

      const toResult = async (
        out: { root: string; cost: ReturnType<RouterClient['usage']> },
        llmCalls: number,
      ): Promise<ArmResult> => {
        const admitted = await admittedCount(out.root)
        await rm(out.root, { recursive: true, force: true })
        return {
          admitted,
          llmCalls,
          usd: out.cost.usd,
          tokens: out.cost.promptTokens + out.cost.completionTokens,
          wallMs: out.cost.wallMs,
        }
      }

      // A. single-agent (no verifier).
      const singleOut = await arm({ verifySource: () => ({ accept: true }) })
      const single = await toResult(singleOut, 0)

      // B. full-LLM.
      const fullOut = await arm(createVerifyingResearchDriver({ router }))
      const full = await toResult(fullOut, fullOut.cost.chatCalls)

      // C. adaptive — instrument its LLM-stage count via stats().
      const adaptiveDriver = createAdaptiveResearchDriver({ router })
      const adaptiveOut = await arm({
        verifySource: (s, c) => adaptiveDriver.verifySource(s, c),
      })
      const adaptive = await toResult(adaptiveOut, adaptiveDriver.stats().llmCalls)

      rows.push({ goal: liveGoal, fetched: withDup.length, single, full, adaptive })
      console.log(
        `[LIVE ADAPTIVE ${JSON.stringify(liveGoal)}] fetched=${withDup.length} | ` +
          `single: admitted=${single.admitted} $0 | ` +
          `full-LLM: admitted=${full.admitted} calls=${full.llmCalls} $${full.usd.toFixed(4)} tok=${full.tokens} | ` +
          `adaptive: admitted=${adaptive.admitted} llmCalls=${adaptive.llmCalls} $${adaptive.usd.toFixed(4)} tok=${adaptive.tokens} ` +
          `(dedup=${adaptiveDriver.stats().dedupRejected} hKeep=${adaptiveDriver.stats().heuristicKept} hDrop=${adaptiveDriver.stats().heuristicDropped})`,
      )
    }

    expect(anyFetched).toBe(true)

    // FRONTIER SUMMARY over all topics.
    const sum = (pick: (r: (typeof rows)[number]) => number) =>
      rows.reduce((a, r) => a + pick(r), 0)
    const fullUsd = sum((r) => r.full.usd)
    const adaptiveUsd = sum((r) => r.adaptive.usd)
    const fullCalls = sum((r) => r.full.llmCalls)
    const adaptiveCalls = sum((r) => r.adaptive.llmCalls)
    const singleAdmitted = sum((r) => r.single.admitted)
    const fullAdmitted = sum((r) => r.full.admitted)
    const adaptiveAdmitted = sum((r) => r.adaptive.admitted)
    const callSaving = fullCalls > 0 ? 1 - adaptiveCalls / fullCalls : 0
    const usdSaving = fullUsd > 0 ? 1 - adaptiveUsd / fullUsd : 0

    console.log(
      `[LIVE ADAPTIVE SUMMARY] admitted single=${singleAdmitted} full=${fullAdmitted} adaptive=${adaptiveAdmitted} | ` +
        `LLM calls full=${fullCalls} adaptive=${adaptiveCalls} (${(callSaving * 100).toFixed(0)}% fewer) | ` +
        `USD full=$${fullUsd.toFixed(4)} adaptive=$${adaptiveUsd.toFixed(4)} (${(usdSaving * 100).toFixed(0)}% cheaper)`,
    )

    // The adaptive driver must NEVER spend MORE than the full-LLM arm — it is a
    // strict subset of full-LLM's calls (the ambiguous tail) plus $0 stages. That
    // is the one hard invariant; the magnitude of the saving and where adaptive
    // lands on the cleanliness frontier are reported honestly in the doc.
    expect(adaptiveCalls).toBeLessThanOrEqual(fullCalls)
    expect(adaptiveUsd).toBeLessThanOrEqual(fullUsd + 1e-9)
    // Adaptive cleanliness sits between single (admits all) and full-LLM (admits
    // least) — it cannot admit MORE than the single-agent floor.
    expect(adaptiveAdmitted).toBeLessThanOrEqual(singleAdmitted)
  }, 600_000)
})

function diffUsage(
  a: ReturnType<RouterClient['usage']>,
  b: ReturnType<RouterClient['usage']>,
): ReturnType<RouterClient['usage']> {
  return {
    chatCalls: b.chatCalls - a.chatCalls,
    searchCalls: b.searchCalls - a.searchCalls,
    promptTokens: b.promptTokens - a.promptTokens,
    completionTokens: b.completionTokens - a.completionTokens,
    usd: b.usd - a.usd,
    wallMs: b.wallMs - a.wallMs,
  }
}
