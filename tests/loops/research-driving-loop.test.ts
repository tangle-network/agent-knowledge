import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineReadinessSpec, type KnowledgeReadinessSpec } from '../../src/eval-readiness'
import { buildKnowledgeIndex } from '../../src/indexer'
import { createResearchDrivingDriver } from '../../src/research-driving-driver'
import {
  type ResearchContribution,
  type ResearchSourceProposal,
  type ResearchWorker,
  runVerifiedResearchLoop,
  type WorkerResearchContext,
} from '../../src/verified-research-loop'
import type { RouterClient, RouterUsage } from '../../src/web-research-worker'

// ===========================================================================
// OFFLINE SCRIPTED END-TO-END: the research-DRIVING driver inside the REAL
// runVerifiedResearchLoop (no creds, no network). The driver's job is to drive
// DEPTH + VALIDATION, the opposite of a source-count filter. We prove, against
// the real loop:
//
//   1. The driver generates DEEPER sub-questions across rounds (round 2's steer
//      interrogates the round-1 claims it didn't have yet), folded into the
//      worker's next prompt via the loop's steer channel.
//   2. The driver FLAGS an unsupported claim (only one independent source) as an
//      invalidation target and demands corroboration — and is NOT complete while
//      that claim is weakly supported, regardless of how many sources exist.
//   3. Once a SECOND independent source corroborates the claim, the driver
//      reaches >= 2 independent sources for it (the real done bar, not count).
//
// The worker is a deterministic scripted corpus keyed by what the steer asks for,
// so the loop drives a real worker↔driver exchange with zero inference.
// ===========================================================================

interface ScriptedSource {
  uri: string
  title: string
  text: string
  /** The single claim a real extractor would pull — scripted for the stub router. */
  claim: string
  /** Round this source is "discovered" (the worker reveals it once steered). */
  round: number
  /** A token that must appear in the worker's prompt (steer) to reveal it. */
  revealOn?: string
}

/**
 * Scripted corpus for the topic. Round 1 reveals ONE source (a weakly-supported
 * claim). Round 2 reveals a SECOND, INDEPENDENT-host source that corroborates the
 * same claim — but only after the driver's steer asks for corroboration.
 */
const corpus: ScriptedSource[] = [
  {
    uri: 'https://arxiv.org/abs/self-spec',
    title: 'Self-Speculative Decoding',
    text:
      'Self-speculative decoding drafts tokens by skipping intermediate layers, then verifies them ' +
      'with the full model. It reports a 1.73x speedup on LLaMA-2 with no quality loss. ' +
      'self speculative decoding speedup llama how it works method',
    claim: 'self-speculative decoding reports a 1.73x speedup on LLaMA-2',
    round: 1,
  },
  {
    // Independent host (acm.org vs arxiv.org), corroborates the SAME claim. Only
    // revealed once the driver's steer demands a corroborating/independent source.
    uri: 'https://dl.acm.org/doi/self-spec-replication',
    title: 'Replication: Self-Speculative Decoding Speedups',
    text:
      'An independent replication confirms self-speculative decoding reports a 1.73x speedup on ' +
      'LLaMA-2, matching the original paper under the same decoding configuration. ' +
      'self speculative decoding speedup llama how it works method',
    claim: 'self-speculative decoding reports a 1.73x speedup on LLaMA-2',
    round: 2,
    revealOn: 'corroborat',
  },
]

// minSources: 2 keeps the readiness gate UNMET after a single source, so the
// loop stays not-ready and the driver folds steer (its depth-driving channel)
// across rounds. This also mirrors the driver's own bar: a claim is not settled
// until >= 2 independent sources back it.
const specs: KnowledgeReadinessSpec[] = [
  defineReadinessSpec({
    id: 'topic/definition',
    description: 'what self-speculative decoding is and how it works',
    query: 'self speculative decoding how it works method',
    requiredFor: ['ResearchAgent'],
    importance: 'blocking',
    minSources: 2,
    minHits: 1,
  }),
]

/**
 * A stub RouterClient: claim extraction returns the scripted claim for whichever
 * corpus source's text is in the prompt. No network, no creds.
 */
function scriptedRouter(): RouterClient {
  const usage: RouterUsage = {
    chatCalls: 0,
    searchCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    usd: 0,
    wallMs: 0,
  }
  return {
    search: async () => [],
    chat: async (messages) => {
      usage.chatCalls += 1
      const user = messages.find((m) => m.role === 'user')?.content ?? ''
      for (const entry of corpus) {
        // The extractor prompt embeds the page excerpt; match on a distinctive
        // fragment of the source text.
        if (user.includes(entry.text.slice(0, 40))) {
          return JSON.stringify([{ claim: entry.claim, contradicts: null }])
        }
      }
      return '[]'
    },
    usage: () => ({ ...usage }),
  }
}

/**
 * Scripted worker: reveals corpus sources gated on the round AND on whether the
 * steer text (folded by the driver) contains the source's `revealOn` token. This
 * is what proves the DRIVER's steer actually drives the worker deeper: the
 * corroborating source only surfaces because the driver asked for corroboration.
 */
function scriptedWorker(): ResearchWorker {
  return async (ctx: WorkerResearchContext): Promise<ResearchContribution> => {
    const steer = ctx.steer ?? ''
    const reveal = corpus.filter((entry) => {
      if (entry.round > ctx.round) return false
      if (entry.revealOn && !steer.toLowerCase().includes(entry.revealOn.toLowerCase()))
        return false
      return true
    })
    const sources: ResearchSourceProposal[] = reveal.map((entry) => ({
      uri: entry.uri,
      title: entry.title,
      text: entry.text,
    }))
    return {
      sources,
      buildPages: (accepted) =>
        accepted
          .map((record) => {
            const original = record.metadata?.originalUri
            const entry = corpus.find((e) => e.uri === original)
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
      notes: `scripted worker revealed ${sources.length} source(s) at round ${ctx.round}`,
    }
  }
}

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'driving-kb-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('research-driving driver in the real two-agent loop (offline, scripted)', () => {
  it('drives DEEPER sub-questions across rounds and FLAGS the unsupported claim', async () => {
    const driver = createResearchDrivingDriver({ router: scriptedRouter() })

    const steerByRound: { round: number; deepQuestionTexts: string[]; steer: string }[] = []

    const result = await runVerifiedResearchLoop({
      root,
      goal: 'self-speculative decoding',
      worker: scriptedWorker(),
      driver,
      // Readiness is satisfiable by one source, so the loop would otherwise stop
      // early — we run multiple rounds to exercise the driver's depth-driving by
      // NOT marking it ready until round 2 reveals the corroborating source. The
      // readiness spec only needs one hit, so we drive >1 round via maxRounds and
      // assert on the driver's own state, which is the real "done" signal.
      readinessSpecs: specs,
      maxRounds: 3,
      onRound: () => {
        const last = driver.lastSteer()
        if (last) {
          steerByRound.push({
            round: last.round,
            deepQuestionTexts: last.deepQuestions.map((q) => q.text),
            steer: last.text,
          })
        }
      },
    })

    // The loop ran and the KB grew.
    expect(result.steps.length).toBeGreaterThanOrEqual(1)
    const index = await buildKnowledgeIndex(root)
    expect(index.sources.length).toBeGreaterThanOrEqual(1)

    // --- (1) DEEPER QUESTIONS ACROSS ROUNDS ---------------------------------
    // The driver folded steer at least once with named deep-question kinds.
    expect(steerByRound.length).toBeGreaterThanOrEqual(1)
    const round1 = steerByRound[0]
    expect(round1).toBeDefined()
    expect(round1?.deepQuestionTexts.length).toBeGreaterThan(0)
    // The round-1 steer drives DEPTH (explicitly: not just more sources) and
    // names a gap / invalidation challenge over the one weak claim.
    expect(round1?.steer).toMatch(/Do NOT just add more sources/)
    expect(round1?.steer).toMatch(/corroborat|INDEPENDENT/)

    // --- (2) FLAGS THE UNSUPPORTED CLAIM ------------------------------------
    // After round 1 only ONE independent source asserts the claim → it is flagged
    // weak and demanded for corroboration; the driver is NOT complete.
    const r1Steer = steerByRound.find((s) => s.round === 1)
    expect(r1Steer?.steer).toMatch(/self-speculative decoding reports a 1\.73x speedup/i)

    // --- (3) DRIVING WORKED: corroborating source surfaced because steered ---
    // The driver's steer asked for corroboration; the worker only reveals the
    // independent acm.org source when steered to, so its presence proves the
    // steer drove the worker deeper.
    const originalUris = index.sources.map((s) => s.metadata?.originalUri)
    expect(originalUris).toContain('https://arxiv.org/abs/self-spec')

    // The round-1 steer demanded corroboration; the worker reveals the
    // independent acm.org source ONLY when steered for it, so its presence in the
    // KB proves the driver's steer drove the worker DEEPER (not just wider).
    expect(originalUris).toContain('https://dl.acm.org/doi/self-spec-replication')
    expect(r1Steer?.steer).toMatch(/find a SECOND, independent corroborating source/i)

    // --- DONE BAR = CLAIM SUPPORT, NOT SOURCE COUNT -------------------------
    const state = driver.researchState()
    const theClaim = state.claims.find((c) => c.text.toLowerCase().includes('1.73x speedup'))
    expect(theClaim).toBeDefined()
    // Two INDEPENDENT hosts now assert the claim → corroborated (the real bar).
    expect(theClaim?.supportingHosts.size).toBe(2)
    expect([...(theClaim?.supportingHosts ?? [])].sort()).toEqual(['arxiv.org', 'dl.acm.org'])
    expect(state.corroborated.map((c) => c.text)).toContain(theClaim?.text)
    expect(state.weaklySupported).toHaveLength(0)
  })

  it('is NOT complete while the key claim has only one independent source, regardless of source count', async () => {
    const driver = createResearchDrivingDriver({ router: scriptedRouter() })

    // A worker that floods the SAME-host source many times: lots of sources, one
    // independent host → driver must NOT report complete.
    const floodWorker: ResearchWorker = async (ctx) => {
      if (ctx.round > 1) return { sources: [], notes: 'no more' }
      const sources: ResearchSourceProposal[] = Array.from({ length: 5 }, (_, i) => ({
        uri: `https://arxiv.org/abs/self-spec?v=${i}`,
        title: `copy ${i}`,
        text: corpus[0]?.text ?? '',
      }))
      return {
        sources,
        buildPages: (accepted) =>
          accepted
            .map((record) => {
              const slug = String(record.metadata?.originalUri ?? record.id).replace(
                /[^a-z0-9]+/gi,
                '-',
              )
              return [
                `---FILE: knowledge/${slug}.md---`,
                '---',
                `title: ${record.id}`,
                `sources: ["${record.id}"]`,
                '---',
                `# ${record.id}`,
                corpus[0]?.text ?? '',
                '---END FILE---',
              ].join('\n')
            })
            .join('\n'),
      }
    }

    await runVerifiedResearchLoop({
      root,
      goal: 'self-speculative decoding',
      worker: floodWorker,
      driver,
      readinessSpecs: specs,
      maxRounds: 2,
    })

    const state = driver.researchState()
    // One claim, asserted by many sources but all on ONE host (arxiv.org) →
    // independent support is 1 → still weakly supported → NOT complete.
    expect(state.claims).toHaveLength(1)
    expect(state.claims[0]?.supportingHosts.size).toBe(1)
    expect(state.weaklySupported).toHaveLength(1)
    expect(driver.isComplete()).toBe(false)
  })
})
