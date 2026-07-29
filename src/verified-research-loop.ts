import type { KnowledgeReadinessReport } from '@tangle-network/agent-eval'
import {
  type BuildEvalKnowledgeBundleOptions,
  buildEvalKnowledgeBundle,
  type EvalKnowledgeBundleBuildResult,
  type KnowledgeReadinessSpec,
} from './eval-readiness'
import { createKnowledgeEvent } from './events'
import { buildKnowledgeIndex } from './indexer'
import { FileSystemKbStore } from './kb-store'
import { applyKnowledgeWriteBlocks } from './proposals'
import { readinessFor } from './readiness-helpers'
import { searchKnowledge } from './search'
import { type AddSourceOptions, type AddSourceTextInput, addSourceText } from './sources'
import { initKnowledgeBase } from './store'
import type { KnowledgeEvent, KnowledgeIndex, KnowledgeSearchResult, SourceRecord } from './types'

/**
 * A knowledge gap the loop surfaces from `scoreKnowledgeReadiness`. The worker
 * targets these; the driver folds the unfilled remainder into the worker's next
 * prompt and runs its own gap-fill pass over them.
 */
export interface KnowledgeGap {
  /** Readiness-spec id this gap belongs to. */
  id: string
  /** Human-readable description of what's missing. */
  description: string
  /** The search query the readiness check ran for this requirement. */
  query: string
  /** True when the gap blocks readiness (vs. a soft, non-blocking gap). */
  blocking: boolean
}

/** A new source the worker (or driver) discovered and wants to add to the KB. */
export type ResearchSourceProposal = AddSourceTextInput

/**
 * What a research agent contributes in one round. Both the worker and (when
 * `driverResearches` is on) the driver produce this shape — the worker ADDS
 * primary findings, the driver gap-FILLS the ones the worker missed.
 *
 * `proposalText` is the safe write-protocol text (`---FILE: knowledge/...---`
 * blocks). The loop only applies it AFTER the driver has verified the round's
 * sources, so a rejected source never reaches the curated pages.
 */
export interface ResearchContribution {
  /** Immutable sources to register (the raw evidence). */
  sources?: ResearchSourceProposal[]
  /** Safe write-protocol text producing curated `knowledge/*.md` pages. */
  proposalText?: string
  /**
   * Build the page write-protocol text FROM the sources the driver accepted —
   * the curated, citing pages the readiness gate searches. Receives the
   * registered `SourceRecord`s (with their assigned ids, so a page's frontmatter
   * `sources:` can cite them). Returns `---FILE: knowledge/...---` block text or
   * `undefined`. Runs after verification, so a page never cites a rejected
   * source. Concatenated after any static `proposalText`.
   */
  buildPages?: (acceptedSources: SourceRecord[]) => string | undefined
  /** Free-form research transcript — products can persist this. */
  notes?: string
  metadata?: Record<string, unknown>
}

/** Context handed to the worker each round. */
export interface WorkerResearchContext {
  root: string
  goal: string
  round: number
  index: KnowledgeIndex
  /** Gaps the readiness gate currently reports — what the worker should close. */
  gaps: KnowledgeGap[]
  /** Steer text the driver folded in from the previous round's remaining gaps. */
  steer?: string
  readiness: EvalKnowledgeBundleBuildResult
  signal?: AbortSignal
}

/** Context handed to the driver's verifier for one candidate source. */
export interface SourceVerificationContext {
  root: string
  goal: string
  round: number
  index: KnowledgeIndex
  gaps: KnowledgeGap[]
  /** Sources already accepted earlier THIS round (in-round dedup). */
  acceptedThisRound: ResearchSourceProposal[]
  signal?: AbortSignal
}

/** A single rejected source plus the reason the driver gave. */
export interface RejectedSource {
  source: ResearchSourceProposal
  reason: string
}

/** Context handed to the driver's gap-fill pass (only when `driverResearches`). */
export interface DriverResearchContext {
  root: string
  goal: string
  round: number
  index: KnowledgeIndex
  /** Gaps STILL open after the worker's accepted contribution applied. */
  remainingGaps: KnowledgeGap[]
  readiness: EvalKnowledgeBundleBuildResult
  signal?: AbortSignal
}

/**
 * The differentiated driver role.
 *
 * - `verifySource` — the gate the worker's additions pass before they commit.
 *   Return `{ accept: true }` to keep a source or `{ accept: false, reason }`
 *   to reject it (not real / not relevant / duplicate). The loop dedups exact
 *   duplicates (same `uri` already in the KB or accepted this round) BEFORE
 *   calling this, so the verifier only sees genuinely-new candidates.
 * - `research` — the driver's OWN gap-fill pass over the gaps the worker left
 *   open. Only invoked when `driverResearches` is true.
 * - `foldGaps` — turn the remaining gaps into a steer string for the worker's
 *   next prompt. Defaults to a compact bulleted list when omitted.
 * - `checkpoint` — write whatever state the driver accumulated to durable
 *   storage. Called at the end of every round, after `foldGaps`, so state that
 *   a synchronous hook produced is on disk before the next round can crash.
 * - `prepareFold` — durably announce the next synchronous fold before it runs,
 *   so a crash between question generation and `checkpoint` can be recovered.
 */
export interface ResearchDriver {
  verifySource(
    source: ResearchSourceProposal,
    ctx: SourceVerificationContext,
  ): Promise<SourceVerdict> | SourceVerdict
  research?(ctx: DriverResearchContext): Promise<ResearchContribution> | ResearchContribution
  foldGaps?(gaps: KnowledgeGap[]): string
  prepareFold?(): Promise<void> | void
  checkpoint?(): Promise<void> | void
}

export type SourceVerdict = { accept: true } | { accept: false; reason: string }

/** The worker: primary research targeting the round's gaps. */
export type ResearchWorker = (
  ctx: WorkerResearchContext,
) => Promise<ResearchContribution> | ResearchContribution

export interface VerifiedResearchLoopOptions {
  root: string
  goal: string
  worker: ResearchWorker
  driver: ResearchDriver
  /**
   * When false (default), the driver ONLY verifies + gates — a pure coordinator
   * that contributes no research of its own (the "doesn't participate in the
   * work" mode). When true, the driver also runs its `research` gap-fill pass
   * each round over the gaps the worker left open.
   */
  driverResearches?: boolean
  maxRounds?: number
  actor?: string
  /** Readiness specs define the gate; an empty list means the loop never gates. */
  readinessSpecs?: KnowledgeReadinessSpec[]
  readinessTaskId?: string
  readiness?: Omit<BuildEvalKnowledgeBundleOptions, 'taskId' | 'index' | 'specs'>
  sourceOptions?: Pick<AddSourceOptions, 'adapters' | 'now'>
  signal?: AbortSignal
  onRound?: (round: VerifiedResearchRound) => Promise<void> | void
}

export interface VerifiedResearchRound {
  round: number
  /** Gaps reported at the START of the round (what the worker targeted). */
  gaps: KnowledgeGap[]
  /** Worker sources accepted by the driver and written to the KB. */
  acceptedWorkerSources: SourceRecord[]
  /** Worker sources the driver rejected (with reasons) — never written. */
  rejectedWorkerSources: RejectedSource[]
  /** Sources the driver itself added in its gap-fill pass. */
  driverSources: SourceRecord[]
  /** Curated pages written this round (worker proposal + driver proposal). */
  writtenPages: string[]
  readiness?: EvalKnowledgeBundleBuildResult
  /** True once the readiness gate reports no blocking gaps. */
  ready: boolean
  event: KnowledgeEvent
  notes: { worker?: string; driver?: string }
}

export interface VerifiedResearchLoopResult {
  root: string
  goal: string
  rounds: number
  ready: boolean
  index: KnowledgeIndex
  readiness?: EvalKnowledgeBundleBuildResult
  steps: VerifiedResearchRound[]
}

/**
 * Two-agent (driver + worker) sibling of `runKnowledgeResearchLoop`.
 *
 * Both agents research to grow ONE knowledge base. The roles are differentiated:
 *
 * - **WORKER** = primary research. Each round it reads the open gaps, discovers
 *   new sources, and proposes additions (`sources` + `proposalText`). It ADDS.
 * - **DRIVER** = the verifier / gap-filler / gate. It (1) VERIFIES the worker's
 *   sources before they commit — dedup against the KB, then `verifySource`
 *   rejects ones that aren't real/relevant; (2) GAP-FILLS the gaps the worker
 *   missed with its own research pass (when `driverResearches`); (3) folds the
 *   remaining gaps into the worker's next prompt; and (4) GATES on
 *   `scoreKnowledgeReadiness` — the loop stops as soon as there are no blocking
 *   gaps.
 *
 * Set `driverResearches: false` (default) for the pure-coordinator mode: the
 * driver only verifies + gates and contributes no research itself.
 *
 * Composes existing atoms — `initKnowledgeBase`, `addSourceText`,
 * `applyKnowledgeWriteBlocks`, `buildEvalKnowledgeBundle` (the readiness gate),
 * and `searchKnowledge` — and reinvents none of them.
 */
export async function runVerifiedResearchLoop(
  options: VerifiedResearchLoopOptions,
): Promise<VerifiedResearchLoopResult> {
  const maxRounds = Math.max(1, options.maxRounds ?? 3)
  await initKnowledgeBase(options.root)
  const store = new FileSystemKbStore({ root: options.root })
  const steps: VerifiedResearchRound[] = []
  let index = await buildKnowledgeIndex(options.root)
  let readiness = readinessFor(options, index)
  let ready = isReady(readiness?.report)
  let steer: string | undefined

  for (let round = 1; round <= maxRounds && !ready; round++) {
    if (options.signal?.aborted) throw new Error('Verified research loop aborted')

    const gaps = gapsFromReadiness(readiness)

    // 1. WORKER: primary research over the open gaps.
    const workerContribution = await options.worker({
      root: options.root,
      goal: options.goal,
      round,
      index,
      gaps,
      steer,
      readiness: requireReadiness(readiness, options),
      signal: options.signal,
    })

    // 2. DRIVER VERIFIES the worker's sources before they commit.
    const accepted: ResearchSourceProposal[] = []
    const rejectedWorkerSources: RejectedSource[] = []
    // Dedup against the ORIGINAL input uri. `addSourceText` rewrites `record.uri`
    // to a slugified raw path and stashes the caller's uri under
    // `metadata.originalUri`, so that — not the stored uri — is the round-to-round
    // identity a verifier dedups against.
    const existingUris = new Set(
      index.sources.flatMap((source) =>
        typeof source.metadata?.originalUri === 'string' ? [source.metadata.originalUri] : [],
      ),
    )
    for (const source of workerContribution.sources ?? []) {
      if (isDuplicate(source, existingUris, accepted)) {
        rejectedWorkerSources.push({ source, reason: 'duplicate: already in the knowledge base' })
        continue
      }
      const verdict = await options.driver.verifySource(source, {
        root: options.root,
        goal: options.goal,
        round,
        index,
        gaps,
        acceptedThisRound: accepted,
        signal: options.signal,
      })
      if (verdict.accept) accepted.push(source)
      else rejectedWorkerSources.push({ source, reason: verdict.reason })
    }

    // Register the accepted worker sources, then apply the worker's curated
    // pages — but only when at least one source survived verification, so a
    // page never cites a rejected source.
    const acceptedWorkerSources = await registerSources(options, accepted)
    const writtenPages: string[] = []
    writtenPages.push(
      ...(await applyPages(options.root, workerContribution, acceptedWorkerSources)),
    )

    // Re-index so the driver's gap-fill pass sees the worker's contribution.
    index = await buildKnowledgeIndex(options.root)
    readiness = readinessFor(options, index)

    // 3. DRIVER GAP-FILLS the gaps the worker left open (opt-in).
    let driverSources: SourceRecord[] = []
    let driverNotes: string | undefined
    if (options.driverResearches && options.driver.research) {
      const remainingGaps = gapsFromReadiness(readiness)
      const driverContribution = await options.driver.research({
        root: options.root,
        goal: options.goal,
        round,
        index,
        remainingGaps,
        readiness: requireReadiness(readiness, options),
        signal: options.signal,
      })
      driverNotes = driverContribution.notes
      driverSources = await registerSources(options, driverContribution.sources ?? [])
      writtenPages.push(...(await applyPages(options.root, driverContribution, driverSources)))
      index = await buildKnowledgeIndex(options.root)
      readiness = readinessFor(options, index)
    }

    // 4. DRIVER GATES on readiness and folds the remainder into the next prompt.
    ready = isReady(readiness?.report)
    const remainingGaps = gapsFromReadiness(readiness)
    if (ready || remainingGaps.length === 0) {
      steer = undefined
    } else {
      await options.driver.prepareFold?.()
      steer = foldGaps(options.driver, remainingGaps)
    }

    const step: VerifiedResearchRound = {
      round,
      gaps,
      acceptedWorkerSources,
      rejectedWorkerSources,
      driverSources,
      writtenPages,
      readiness,
      ready,
      event: createKnowledgeEvent({
        type: 'research.iteration',
        actor: options.actor,
        target: options.root,
        metadata: {
          goal: options.goal,
          round,
          ready,
          acceptedWorkerSourceCount: acceptedWorkerSources.length,
          rejectedWorkerSourceCount: rejectedWorkerSources.length,
          driverSourceCount: driverSources.length,
          writtenPageCount: writtenPages.length,
          remainingGapCount: remainingGaps.length,
        },
      }),
      notes: { worker: workerContribution.notes, driver: driverNotes },
    }
    // Commit the driver's state before publishing the round event. A persisted
    // event therefore never claims a round whose generated questions were lost.
    await options.driver.checkpoint?.()
    await store.putEvent(step.event)

    steps.push(step)
    await options.onRound?.(step)
  }

  return {
    root: options.root,
    goal: options.goal,
    rounds: steps.length,
    ready,
    index,
    readiness,
    steps,
  }
}

function isReady(report: KnowledgeReadinessReport | undefined): boolean {
  // No specs ⇒ no gate ⇒ the loop runs to `maxRounds`. With specs, the gate is
  // "no blocking gaps remain".
  if (!report) return false
  return report.blockingMissingRequirements.length === 0
}

function gapsFromReadiness(readiness: EvalKnowledgeBundleBuildResult | undefined): KnowledgeGap[] {
  if (!readiness) return []
  const blocking = readiness.report.blockingMissingRequirements.map((requirement) =>
    gapFor(requirement, readiness, true),
  )
  const nonBlocking = readiness.report.nonBlockingGaps.map((requirement) =>
    gapFor(requirement, readiness, false),
  )
  return [...blocking, ...nonBlocking]
}

function gapFor(
  requirement: { id: string; description: string; metadata?: Record<string, unknown> },
  readiness: EvalKnowledgeBundleBuildResult,
  blocking: boolean,
): KnowledgeGap {
  const spec = readiness.requirements.find((entry) => entry.id === requirement.id)
  const query =
    typeof spec?.metadata?.query === 'string' ? spec.metadata.query : requirement.description
  return { id: requirement.id, description: requirement.description, query, blocking }
}

function foldGaps(driver: ResearchDriver, gaps: KnowledgeGap[]): string | undefined {
  if (gaps.length === 0) return undefined
  if (driver.foldGaps) return driver.foldGaps(gaps)
  return [
    'The knowledge base is still missing the following. Prioritise these next round:',
    ...gaps.map(
      (gap) => `- (${gap.blocking ? 'blocking' : 'soft'}) ${gap.description} [${gap.id}]`,
    ),
  ].join('\n')
}

function isDuplicate(
  source: ResearchSourceProposal,
  existingUris: Set<string>,
  accepted: ResearchSourceProposal[],
): boolean {
  return existingUris.has(source.uri) || accepted.some((candidate) => candidate.uri === source.uri)
}

async function registerSources(
  options: VerifiedResearchLoopOptions,
  sources: ResearchSourceProposal[],
): Promise<SourceRecord[]> {
  const records: SourceRecord[] = []
  for (const source of sources) {
    records.push(await addSourceText(options.root, source, options.sourceOptions))
  }
  return records
}

/**
 * Apply a contribution's curated pages. Static `proposalText` plus a
 * `buildPages(acceptedSources)` result are concatenated and run through the safe
 * write protocol — but ONLY when at least one source survived verification, so a
 * page never cites a rejected (or absent) source.
 */
async function applyPages(
  root: string,
  contribution: ResearchContribution,
  acceptedSources: SourceRecord[],
): Promise<string[]> {
  if (acceptedSources.length === 0) return []
  const parts: string[] = []
  if (contribution.proposalText) parts.push(contribution.proposalText)
  const built = contribution.buildPages?.(acceptedSources)
  if (built) parts.push(built)
  if (parts.length === 0) return []
  const applied = await applyKnowledgeWriteBlocks(root, parts.join('\n'))
  return applied.written
}

function requireReadiness(
  readiness: EvalKnowledgeBundleBuildResult | undefined,
  options: VerifiedResearchLoopOptions,
): EvalKnowledgeBundleBuildResult {
  if (readiness) return readiness
  // The worker/driver contexts type `readiness` as required for ergonomics; when
  // no specs are configured there is no gate to report, so synthesise an empty
  // bundle rather than forcing every caller to handle `undefined`.
  return buildEvalKnowledgeBundle({
    ...(options.readiness ?? {}),
    taskId: options.readinessTaskId ?? options.goal,
    index: emptyIndex(options.root),
    specs: [],
  })
}

function emptyIndex(root: string): KnowledgeIndex {
  return {
    root,
    generatedAt: new Date(0).toISOString(),
    sources: [],
    pages: [],
    graph: { nodes: [], edges: [] },
  }
}

/**
 * Helper for verifiers: does the candidate source's text/title overlap any page
 * the readiness search returns for a gap query? A cheap relevance heuristic the
 * driver can compose into `verifySource` (real verifiers can do more).
 */
export function sourceMatchesGaps(
  source: ResearchSourceProposal,
  index: KnowledgeIndex,
  gaps: KnowledgeGap[],
): KnowledgeSearchResult[] {
  const haystack = `${source.title ?? ''}\n${source.text}`.toLowerCase()
  const hits: KnowledgeSearchResult[] = []
  for (const gap of gaps) {
    for (const token of gap.query.toLowerCase().split(/\s+/).filter(Boolean)) {
      if (haystack.includes(token)) {
        hits.push(...searchKnowledge(index, gap.query, 1))
        break
      }
    }
  }
  return hits
}
