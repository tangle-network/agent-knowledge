import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scoreKnowledgeReadiness } from '@tangle-network/agent-eval'
import {
  type Driver,
  inProcessSandboxClient,
  type OutputAdapter,
  runLoop,
  type SandboxEvent,
} from '@tangle-network/agent-runtime/loops'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineReadinessSpec } from '../../src/eval-readiness'
import { buildKnowledgeIndex } from '../../src/indexer'
import { researcherProfile } from '../../src/profiles/researcher'
import { searchKnowledge } from '../../src/search'
import {
  type ResearchContribution,
  type ResearchDriver,
  type ResearchSourceProposal,
  type ResearchWorker,
  runTwoAgentResearchLoop,
  type SourceVerdict,
  type WorkerResearchContext,
} from '../../src/two-agent-research-loop'

// ---------------------------------------------------------------------------
// Offline agent scaffolding: a researcher AgentProfile driven through the REAL
// runLoop kernel + inProcessSandboxClient (no creds, no network). The agent's
// per-prompt behaviour is a deterministic stub that emits research sources for
// the gaps it is told about, encoded in the prompt the worker hands it.
// ---------------------------------------------------------------------------

interface StubFinding {
  uri: string
  title: string
  text: string
}

/** A trivial output the offline agent emits: the sources it "found" this turn. */
interface AgentResearch {
  sources: StubFinding[]
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
    async plan(_task, history) {
      return history.length === 0 ? [_task] : []
    },
    decide() {
      return 'done'
    },
  }
}

/**
 * Build a `ResearchWorker` backed by the offline researcher agent. The agent is
 * a corpus keyed by query token: when a gap mentions a token in `corpus`, the
 * agent returns the matching finding. This proves the loop drives a real
 * AgentProfile through runLoop + inProcessSandboxClient end-to-end offline.
 */
function offlineResearchWorker(corpus: StubFinding[]): ResearchWorker {
  const { profile } = researcherProfile({ harness: 'offline-stub' })
  return async (ctx: WorkerResearchContext): Promise<ResearchContribution> => {
    const sandboxClient = inProcessSandboxClient({
      onPrompt(prompt): SandboxEvent[] {
        // The agent "researches": return every corpus finding whose token the
        // prompt (gap queries the worker folded in) mentions.
        const found = corpus.filter((finding) =>
          finding.uri
            .split(/[^a-z0-9]+/i)
            .some(
              (token) => token.length > 2 && prompt.toLowerCase().includes(token.toLowerCase()),
            ),
        )
        return [{ type: 'result', data: { result: { sources: found } } }]
      },
    })

    const queries = ctx.gaps.map((gap) => `${gap.description} ${gap.query}`).join(' | ')
    const result = await runLoop<{ prompt: string }, AgentResearch, 'done'>({
      driver: oneShotDriver(),
      agentRun: {
        profile,
        taskToPrompt: (task) => task.prompt,
        name: 'offline-researcher',
      },
      output: agentOutput,
      task: { prompt: `Research these gaps for "${ctx.goal}": ${queries}\n${ctx.steer ?? ''}` },
      ctx: { sandboxClient },
    })

    const sources: ResearchSourceProposal[] = (result.winner?.output.sources ?? []).map(
      (finding) => ({ uri: finding.uri, text: finding.text, title: finding.title }),
    )
    return {
      sources,
      // Curated, searchable pages cite the sources the driver accepted. The
      // readiness gate searches PAGES, so growing the KB = sources + citing pages.
      buildPages: pageBuilder(sources),
      notes: `offline worker found ${sources.length} source(s)`,
    }
  }
}

/**
 * Build curated `knowledge/*.md` pages that cite the accepted sources, matched
 * back to their proposals by `metadata.originalUri`. The page text repeats the
 * source text so the token-based readiness search hits it.
 */
function pageBuilder(proposals: ResearchSourceProposal[]) {
  return (acceptedSources: { id: string; metadata?: Record<string, unknown> }[]): string => {
    return acceptedSources
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
}

/**
 * A verifying driver: rejects any source whose uri starts with `bad/` (the
 * deliberately-bad source), accepts the rest. Gates on readiness (the loop does
 * that), and does NOT research (pure coordinator) unless `research` is supplied.
 */
function verifyingDriver(): ResearchDriver {
  return {
    verifySource(source: ResearchSourceProposal): SourceVerdict {
      if (source.uri.startsWith('bad/')) {
        return { accept: false, reason: 'source is not a real/relevant reference' }
      }
      return { accept: true }
    },
  }
}

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'two-agent-kb-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const specs = [
  defineReadinessSpec({
    id: 'topic/ventilation',
    description: 'coop ventilation requirements',
    query: 'coop ventilation airflow',
    requiredFor: ['IntakeAgent'],
    // `blocking` importance makes the gate actually gate: an unmet requirement
    // lands in `blockingMissingRequirements` (a soft `high` requirement would
    // only be a non-blocking gap and never stop the loop).
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

describe('runTwoAgentResearchLoop (offline, real FileSystemKbStore temp dir)', () => {
  it('(a) GROWS the knowledge base across rounds via the offline agent', async () => {
    const corpus: StubFinding[] = [
      {
        uri: 'web/ventilation-guide',
        title: 'Coop Ventilation Guide',
        text: 'Coop ventilation airflow keeps the flock healthy. Cross-ventilation near the roof.',
      },
      {
        uri: 'web/predator-fencing',
        title: 'Predator Protection',
        text: 'Predator protection fencing and hardware cloth stop raccoons and foxes.',
      },
    ]

    const result = await runTwoAgentResearchLoop({
      root,
      goal: 'backyard chicken coop requirements',
      worker: offlineResearchWorker(corpus),
      driver: verifyingDriver(),
      readinessSpecs: specs,
      maxRounds: 3,
    })

    const index = await buildKnowledgeIndex(root)
    // The KB grew: both corpus sources were registered.
    expect(index.sources.length).toBeGreaterThanOrEqual(2)
    const originalUris = index.sources.map((s) => s.metadata?.originalUri)
    expect(originalUris).toContain('web/ventilation-guide')
    expect(originalUris).toContain('web/predator-fencing')
    // Sources are searchable through the existing search atom.
    expect(searchKnowledge(index, 'ventilation airflow', 5).length).toBeGreaterThan(0)
    // At least one round ran and recorded accepted sources.
    expect(result.steps.length).toBeGreaterThanOrEqual(1)
    expect(
      result.steps.reduce((n, step) => n + step.acceptedWorkerSources.length, 0),
    ).toBeGreaterThanOrEqual(2)
  })

  it("(b) the driver's verification REJECTS a deliberately-bad source the worker proposes", async () => {
    const corpus: StubFinding[] = [
      {
        uri: 'web/ventilation-guide',
        title: 'Coop Ventilation Guide',
        text: 'Coop ventilation airflow keeps the flock healthy.',
      },
      {
        // The deliberately-bad source: relevant-looking query tokens, but the
        // verifier rejects anything under `bad/`.
        uri: 'bad/ventilation-spam',
        title: 'Buy Ventilation Fans Cheap',
        text: 'ventilation airflow predator — SPAM advertisement, not a real reference.',
      },
    ]

    const result = await runTwoAgentResearchLoop({
      root,
      goal: 'backyard chicken coop requirements',
      worker: offlineResearchWorker(corpus),
      driver: verifyingDriver(),
      readinessSpecs: specs,
      maxRounds: 2,
    })

    const rejected = result.steps.flatMap((step) => step.rejectedWorkerSources)
    expect(rejected.length).toBeGreaterThanOrEqual(1)
    expect(rejected.some((r) => r.source.uri === 'bad/ventilation-spam')).toBe(true)
    expect(rejected[0]?.reason).toMatch(/real\/relevant|reference/)

    // The bad source NEVER reached the knowledge base.
    const index = await buildKnowledgeIndex(root)
    const originalUris = index.sources.map((s) => s.metadata?.originalUri)
    expect(originalUris).not.toContain('bad/ventilation-spam')
    expect(originalUris).toContain('web/ventilation-guide')
  })

  it('(c) STOPS as soon as scoreKnowledgeReadiness reports the KB is ready', async () => {
    const corpus: StubFinding[] = [
      {
        uri: 'web/ventilation-guide',
        title: 'Coop Ventilation Guide',
        text: 'Coop ventilation airflow keeps the flock healthy.',
      },
      {
        uri: 'web/predator-fencing',
        title: 'Predator Protection',
        text: 'Predator protection fencing stops raccoons and foxes.',
      },
    ]

    let rounds = 0
    const result = await runTwoAgentResearchLoop({
      root,
      goal: 'backyard chicken coop requirements',
      worker: offlineResearchWorker(corpus),
      driver: verifyingDriver(),
      readinessSpecs: specs,
      maxRounds: 5,
      onRound: () => {
        rounds += 1
      },
    })

    // The gate ended the loop BEFORE maxRounds.
    expect(result.ready).toBe(true)
    expect(result.rounds).toBeLessThan(5)
    expect(rounds).toBe(result.rounds)

    // Ground-truth the stop with the same scorer the loop gates on.
    const index = await buildKnowledgeIndex(root)
    const report = scoreKnowledgeReadiness({
      taskId: 'backyard chicken coop requirements',
      requirements: result.readiness?.requirements ?? [],
    })
    expect(report.blockingMissingRequirements.length).toBe(0)
    // The last recorded round is the one that flipped `ready`.
    expect(result.steps.at(-1)?.ready).toBe(true)
  })

  it('driverResearches=false is the pure-coordinator mode (driver adds no sources)', async () => {
    const corpus: StubFinding[] = [
      {
        uri: 'web/ventilation-guide',
        title: 'Coop Ventilation Guide',
        text: 'Coop ventilation airflow keeps the flock healthy.',
      },
      {
        uri: 'web/predator-fencing',
        title: 'Predator Protection',
        text: 'Predator protection fencing stops raccoons.',
      },
    ]
    const result = await runTwoAgentResearchLoop({
      root,
      goal: 'backyard chicken coop requirements',
      worker: offlineResearchWorker(corpus),
      driver: verifyingDriver(),
      driverResearches: false,
      readinessSpecs: specs,
      maxRounds: 3,
    })
    // Coordinator-only: the driver contributed zero sources of its own.
    expect(result.steps.every((step) => step.driverSources.length === 0)).toBe(true)
  })

  it('driverResearches=true lets the driver gap-fill what the worker missed', async () => {
    // The worker only ever finds the ventilation source; the predator gap stays
    // open until the DRIVER fills it in its own research pass.
    const workerCorpus: StubFinding[] = [
      {
        uri: 'web/ventilation-guide',
        title: 'Coop Ventilation Guide',
        text: 'Coop ventilation airflow keeps the flock healthy.',
      },
    ]
    const driverFinding: ResearchSourceProposal = {
      uri: 'web/predator-fencing',
      title: 'Predator Protection',
      text: 'Predator protection fencing stops raccoons and foxes.',
    }
    const driver: ResearchDriver = {
      ...verifyingDriver(),
      research(ctx) {
        // Fill the remaining (predator) gap if it is still open.
        const needsPredator = ctx.remainingGaps.some((gap) => gap.id === 'topic/predators')
        return needsPredator
          ? { sources: [driverFinding], buildPages: pageBuilder([driverFinding]) }
          : {}
      },
    }

    const result = await runTwoAgentResearchLoop({
      root,
      goal: 'backyard chicken coop requirements',
      worker: offlineResearchWorker(workerCorpus),
      driver,
      driverResearches: true,
      readinessSpecs: specs,
      maxRounds: 3,
    })

    expect(result.steps.reduce((n, s) => n + s.driverSources.length, 0)).toBeGreaterThanOrEqual(1)
    const index = await buildKnowledgeIndex(root)
    const originalUris = index.sources.map((s) => s.metadata?.originalUri)
    expect(originalUris).toContain('web/predator-fencing')
    expect(result.ready).toBe(true)
  })

  // Live variant — gated on creds; runs a real harness instead of the offline
  // inProcessSandboxClient. Skipped unless AGENT_KNOWLEDGE_LIVE is set.
  it.skipIf(!process.env.AGENT_KNOWLEDGE_LIVE)(
    'live: drives a real researcher harness through the two-agent loop',
    async () => {
      const result = await runTwoAgentResearchLoop({
        root,
        goal: 'backyard chicken coop requirements',
        // A live worker would drive researcherProfile over a real backend.
        worker: offlineResearchWorker([]),
        driver: verifyingDriver(),
        readinessSpecs: specs,
        maxRounds: 2,
      })
      expect(result.rounds).toBeGreaterThanOrEqual(1)
    },
  )
})
