import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  ResearchClaimEvidence,
  ResearchClaimLedger,
  ResearchClaimRecord,
  ResearchSourceProposal,
  ResearchSourceVersion,
  SourceRecord,
  SourceVerificationContext,
} from '../src/index'
import {
  addSourcePath,
  buildKnowledgeIndex,
  ClaimLedgerGoalConflictError,
  ClaimLedgerMigrationRequiredError,
  claimEvidenceId,
  claimId,
  createKnowledgeEvent,
  createPersistentResearchDrivingDriver,
  createResearchDrivingDriver,
  DeepQuestionSchema,
  deepQuestionId,
  defineReadinessSpec,
  FileSystemKbStore,
  initKnowledgeBase,
  KB_CLAIM_LEDGER_DIR,
  KB_STORE_DIR,
  KNOWLEDGE_EVENT_TYPES,
  KnowledgeEventSchema,
  linkClaimContradictions,
  MemoryKbStore,
  mergeClaimLedgers,
  ResearchClaimLedgerSchema,
  runVerifiedResearchLoop,
  sha256,
  textSourceId,
  withSafeDescendant,
  writeFileDurable,
  writeJsonDurableWithinRoot,
  writeKnowledgeIndex,
} from '../src/index'
import type { RouterClient } from '../src/web-research-worker'

const GOAL = 'self-speculative decoding'

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agent-knowledge-claims-'))
  try {
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

/** A RouterClient whose `chat` returns scripted claim-extraction JSON by token. */
function stubRouter(repliesByToken: Record<string, string>): RouterClient {
  return {
    search: async () => [],
    chat: async (messages) => {
      const user = messages.find((message) => message.role === 'user')?.content ?? ''
      for (const [token, reply] of Object.entries(repliesByToken)) {
        if (user.includes(token)) return reply
      }
      return '[]'
    },
    usage: () => ({
      chatCalls: 0,
      searchCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      usd: 0,
      wallMs: 0,
    }),
  }
}

function ctx(round: number, goal = GOAL): SourceVerificationContext {
  return {
    root: '/tmp/x',
    goal,
    round,
    index: {
      root: '/tmp/x',
      generatedAt: '',
      sources: [],
      pages: [],
      graph: { nodes: [], edges: [] },
    },
    gaps: [],
    acceptedThisRound: [],
  }
}

function source(uri: string, text: string): ResearchSourceProposal {
  return { uri, text, title: uri }
}

function registeredSource(uri: string, text: string): SourceRecord {
  const contentHash = sha256(text)
  return {
    id: textSourceId(uri, contentHash),
    uri: `raw/sources/${contentHash}.txt`,
    contentHash,
    text,
    metadata: { originalUri: uri },
    createdAt: '2026-07-28T00:00:00.000Z',
  }
}

const CLAIM_A = '[{"claim":"layer skipping gives a 1.73x speedup","contradicts":null}]'

// ===========================================================================
// Claims must survive the process that discovered them.
// ===========================================================================

describe('research claim ledger — persistence', () => {
  it('restores corroboration counts and open questions in a NEW driver instance', async () => {
    const store = new MemoryKbStore()
    const router = stubRouter({ 'PAGE-A': CLAIM_A, 'PAGE-B': CLAIM_A })

    const first = await createPersistentResearchDrivingDriver({ router, store, ledgerId: 'run-1' })
    await first.verifySource(source('https://arxiv.org/a', 'PAGE-A body'), ctx(1))
    await first.commitSources([registeredSource('https://arxiv.org/a', 'PAGE-A body')])
    await first.prepareFold()
    first.foldGaps?.([])
    await first.checkpoint()

    const before = first.researchState()
    expect(before.claims).toHaveLength(1)
    expect(before.claims[0]?.supportingHosts).toEqual(new Set(['arxiv.org']))
    expect(before.openQuestions.length).toBeGreaterThan(0)

    // The process dies here. A NEW driver over the same store is the resume.
    const resumed = await createPersistentResearchDrivingDriver({
      router,
      store,
      ledgerId: 'run-1',
    })
    const restored = resumed.researchState()
    expect(restored.claims).toHaveLength(1)
    expect(restored.claims[0]?.supportingHosts).toEqual(new Set(['arxiv.org']))
    expect(restored.weaklySupported).toHaveLength(1)
    expect(restored.questions.map((question) => question.id).sort()).toEqual(
      before.questions.map((question) => question.id).sort(),
    )
    expect(restored.rounds).toBe(1)

    // And the resumed run keeps ACCUMULATING onto the restored ledger rather
    // than starting a second, parallel belief state.
    await resumed.verifySource(source('https://acm.org/b', 'PAGE-B body'), ctx(2))
    await resumed.commitSources([registeredSource('https://acm.org/b', 'PAGE-B body')])
    const grown = resumed.researchState()
    expect(grown.claims).toHaveLength(1)
    expect([...(grown.claims[0]?.supportingHosts ?? [])].sort()).toEqual(['acm.org', 'arxiv.org'])
    expect(grown.corroborated).toHaveLength(1)
  })

  it('keeps accepted evidence pending until its source registration is confirmed', async () => {
    const store = new MemoryKbStore()
    const router = stubRouter({ 'PAGE-A': CLAIM_A, 'PAGE-B': CLAIM_A })
    const driver = await createPersistentResearchDrivingDriver({
      router,
      store,
      ledgerId: 'mid-round',
    })

    // Verification persists the extraction first, but acceptance is not proof
    // that the separate source-registry write completed.
    const verdict = await driver.verifySource(source('https://arxiv.org/a', 'PAGE-A body'), ctx(1))
    expect(verdict.accept).toBe(true)

    const pending = await store.getClaimLedger('mid-round')
    expect(pending?.claimEvidence).toHaveLength(1)
    expect(pending?.registeredSources).toEqual([])
    expect(pending?.claims).toEqual([])
    expect(driver.isComplete()).toBe(false)

    await driver.commitSources([registeredSource('https://arxiv.org/a', 'PAGE-A body')])
    const afterFirst = await store.getClaimLedger('mid-round')
    expect(afterFirst?.claims[0]?.supportingHosts).toEqual(['arxiv.org'])

    await driver.verifySource(source('https://acm.org/b', 'PAGE-B body'), ctx(1))
    const secondPending = await store.getClaimLedger('mid-round')
    expect(secondPending?.registeredSources).toEqual([
      sourceVersion('https://arxiv.org/a', 'PAGE-A body'),
    ])
    expect(secondPending?.claims[0]?.supportingHosts).toEqual(['arxiv.org'])

    await driver.commitSources([registeredSource('https://acm.org/b', 'PAGE-B body')])
    const afterSecond = await store.getClaimLedger('mid-round')
    expect([...(afterSecond?.claims[0]?.supportingHosts ?? [])].sort()).toEqual([
      'acm.org',
      'arxiv.org',
    ])

    // The crash lands here, between sources and before the round ends.
    const resumed = await createPersistentResearchDrivingDriver({
      router,
      store,
      ledgerId: 'mid-round',
    })
    expect(resumed.researchState().corroborated).toHaveLength(1)
  })

  it('binds same-URI evidence to the exact source bytes that produced it', async () => {
    const uri = 'https://example.org/result'
    const textA = 'PAGE-A exact bytes'
    const textB = 'PAGE-B changed bytes'
    const store = new MemoryKbStore()
    const driver = await createPersistentResearchDrivingDriver({
      store,
      ledgerId: 'same-uri-versions',
      router: stubRouter({
        'PAGE-A': '[{"claim":"claim extracted from bytes A","contradicts":null}]',
        'PAGE-B': '[{"claim":"claim extracted from bytes B","contradicts":null}]',
      }),
    })

    await driver.verifySource(source(uri, textA), ctx(1))
    await driver.verifySource(source(uri, textB), ctx(1))
    await driver.commitSources([registeredSource(uri, textA)])

    expect(driver.researchState().claims.map((claim) => claim.text)).toEqual([
      'claim extracted from bytes A',
    ])
    const afterA = await store.getClaimLedger('same-uri-versions')
    expect(afterA?.claimEvidence).toHaveLength(2)
    expect(afterA?.registeredSources).toEqual([sourceVersion(uri, textA)])
    const reopened = await createPersistentResearchDrivingDriver({
      store,
      ledgerId: 'same-uri-versions',
      router: stubRouter({}),
    })
    expect(reopened.researchState().claims.map((claim) => claim.text)).toEqual([
      'claim extracted from bytes A',
    ])

    await reopened.commitSources([registeredSource(uri, textB)])
    expect(
      reopened
        .researchState()
        .claims.map((claim) => claim.text)
        .sort(),
    ).toEqual(['claim extracted from bytes A', 'claim extracted from bytes B'])
  })

  it('merges concurrent writers that observe different versions of one URI', async () => {
    const uri = 'https://example.org/live-result'
    const store = new MemoryKbStore()
    const router = stubRouter({
      VERSION_A: '[{"claim":"concurrent claim A","contradicts":null}]',
      VERSION_B: '[{"claim":"concurrent claim B","contradicts":null}]',
    })
    const [writerA, writerB] = await Promise.all([
      createPersistentResearchDrivingDriver({ store, ledgerId: 'concurrent-versions', router }),
      createPersistentResearchDrivingDriver({ store, ledgerId: 'concurrent-versions', router }),
    ])

    await Promise.all([
      writerA.verifySource(source(uri, 'VERSION_A bytes'), ctx(1)),
      writerB.verifySource(source(uri, 'VERSION_B bytes'), ctx(1)),
    ])
    await Promise.all([
      writerA.commitSources([registeredSource(uri, 'VERSION_A bytes')]),
      writerB.commitSources([registeredSource(uri, 'VERSION_B bytes')]),
    ])

    const reopened = await createPersistentResearchDrivingDriver({
      store,
      ledgerId: 'concurrent-versions',
      router,
    })
    expect(
      reopened
        .researchState()
        .claims.map((claim) => claim.text)
        .sort(),
    ).toEqual(['concurrent claim A', 'concurrent claim B'])
    expect(reopened.toLedger().registeredSources).toHaveLength(2)
  })

  it('snapshots source identity before awaiting claim extraction', async () => {
    let releaseExtraction: (() => void) | undefined
    const extractionStarted = new Promise<void>((resolve) => {
      releaseExtraction = resolve
    })
    let allowExtraction: (() => void) | undefined
    const extractionBlocked = new Promise<void>((resolve) => {
      allowExtraction = resolve
    })
    const driver = await createPersistentResearchDrivingDriver({
      store: new MemoryKbStore(),
      ledgerId: 'immutable-intake',
      router: {
        ...stubRouter({}),
        chat: async () => {
          releaseExtraction?.()
          await extractionBlocked
          return '[{"claim":"claim from immutable bytes A","contradicts":null}]'
        },
      },
    })
    const mutable = source('https://a.org/result', 'immutable PAGE-A bytes')
    const verification = driver.verifySource(mutable, ctx(3))
    await extractionStarted
    mutable.uri = 'https://b.org/result'
    mutable.text = 'mutated PAGE-B bytes'
    allowExtraction?.()
    await verification

    await driver.commitSources([registeredSource('https://a.org/result', 'immutable PAGE-A bytes')])
    const ledger = driver.toLedger()
    expect(ledger.claims.map((claim) => claim.text)).toEqual(['claim from immutable bytes A'])
    expect(ledger.claimEvidence[0]).toMatchObject({
      sourceUri: 'https://a.org/result',
      sourceContentHash: sha256('immutable PAGE-A bytes'),
    })
  })

  it('validates a source-confirmation batch before mutating live state', async () => {
    const driver = await createPersistentResearchDrivingDriver({
      store: new MemoryKbStore(),
      ledgerId: 'atomic-confirmation',
      router: stubRouter({ PAGE: CLAIM_A }),
    })
    await driver.verifySource(source('https://a.org/result', 'PAGE bytes'), ctx(1))
    const invalid = {
      ...registeredSource('https://b.org/result', 'other bytes'),
      id: 'src_forged',
    }

    await expect(
      driver.commitSources([registeredSource('https://a.org/result', 'PAGE bytes'), invalid]),
    ).rejects.toThrow(/does not match URI-and-content identity/)
    expect(driver.toLedger().registeredSources).toEqual([])
    expect(driver.researchState().claims).toEqual([])
  })

  it('recovers when sources register but the evidence confirmation crashes', async () => {
    await withRoot(async (root) => {
      const store = new FileSystemKbStore({ root })
      const router = stubRouter({ BODY: CLAIM_A })
      const driver = await createPersistentResearchDrivingDriver({
        router,
        store,
        ledgerId: 'source-confirmation-crash',
      })
      const interrupted = {
        ...driver,
        commitSources: async (sources: readonly SourceRecord[]) => {
          if (sources.length > 0) {
            throw new Error('simulated crash after source registration')
          }
          await driver.commitSources(sources)
        },
      }
      const readinessSpecs = [
        defineReadinessSpec({
          id: 'two-results',
          description: 'two independent results',
          query: 'BODY',
          requiredFor: ['ResearchAgent'],
          importance: 'blocking',
          minSources: 2,
          minHits: 1,
        }),
      ]

      await expect(
        runVerifiedResearchLoop({
          root,
          goal: GOAL,
          maxRounds: 1,
          readinessSpecs,
          worker: async () => ({
            sources: [
              source('https://a.org/result', 'BODY one'),
              source('https://b.org/result', 'BODY two'),
            ],
          }),
          driver: interrupted,
        }),
      ).rejects.toThrow(/simulated crash after source registration/)

      // Exact failed state: both source writes completed, while both claim
      // observations remain pending and therefore cannot report completion.
      const registeredIndex = await buildKnowledgeIndex(root)
      expect(registeredIndex.sources).toHaveLength(2)
      const pending = await store.getClaimLedger('source-confirmation-crash')
      expect(pending?.claimEvidence).toHaveLength(2)
      expect(pending?.registeredSources).toEqual([])
      expect(pending?.claims).toEqual([])
      const afterCrash = await createPersistentResearchDrivingDriver({
        router,
        store,
        ledgerId: 'source-confirmation-crash',
      })
      expect(afterCrash.isComplete()).toBe(false)
      await expect(store.listEvents({ type: 'research.iteration' })).resolves.toHaveLength(0)

      // A normal knowledge base may also contain path-imported records, which
      // have no originalUri and are unrelated to text-source reconciliation.
      const pathSource = join(root, 'offline-source.txt')
      await writeFile(pathSource, 'offline corpus bytes')
      await addSourcePath(root, pathSource)

      // A fresh loop reconciles exact original URIs from the source registry
      // before it decides readiness or launches another worker round.
      const resumed = await createPersistentResearchDrivingDriver({
        router,
        store,
        ledgerId: 'source-confirmation-crash',
      })
      let completeBeforeWorker = false
      await expect(
        runVerifiedResearchLoop({
          root,
          goal: GOAL,
          maxRounds: 1,
          readinessSpecs,
          worker: async () => {
            completeBeforeWorker = resumed.isComplete()
            throw new Error('stop after restart reconciliation')
          },
          driver: resumed,
        }),
      ).rejects.toThrow(/stop after restart reconciliation/)
      expect(completeBeforeWorker).toBe(true)
      expect(resumed.isComplete()).toBe(true)
      const recovered = await store.getClaimLedger('source-confirmation-crash')
      expect(recovered?.registeredSources.map((source) => source.uri).sort()).toEqual([
        'https://a.org/result',
        'https://b.org/result',
      ])
      expect(recovered?.claims[0]?.supportingHosts).toEqual(['a.org', 'b.org'])
    })
  })

  it('survives JSON round-tripping — the failure that made the old ledger unstorable', async () => {
    const router = stubRouter({
      SEED: '[{"claim":"the speedup is 5x","contradicts":null}]',
      REFUTE: '[{"claim":"the speedup is only 2x","contradicts":"[__ID__]"}]',
    })
    const driver = createResearchDrivingDriver({
      router: {
        ...router,
        chat: async (messages) => {
          const user = messages.find((message) => message.role === 'user')?.content ?? ''
          if (user.includes('SEED')) return '[{"claim":"the speedup is 5x","contradicts":null}]'
          if (user.includes('REFUTE')) {
            const id = user.match(/\[(c_[0-9a-f]+)\]/)?.[1] ?? ''
            return `[{"claim":"the speedup is only 2x","contradicts":"[${id}]"}]`
          }
          return '[]'
        },
      },
    })
    await driver.verifySource(source('https://a.org/x', 'SEED'), ctx(1))
    await driver.verifySource(source('https://b.org/y', 'REFUTE'), ctx(1))

    const live = driver.researchState()
    expect(live.contested).toHaveLength(2)
    expect(live.claims[0]?.supportingHosts).toBeInstanceOf(Set)

    // The published live API retains Sets; the durable ledger converts them to
    // arrays at the persistence boundary so JSON cannot erase their contents.
    const durable = driver.toLedger()
    const roundTripped = JSON.parse(JSON.stringify(durable)) as typeof durable
    expect(roundTripped.claims[0]?.supportingHosts).toEqual(durable.claims[0]?.supportingHosts)
    expect(roundTripped.claims[0]?.supportingHosts.length).toBe(1)
    expect(roundTripped.claims[1]?.contradicts).toEqual(durable.claims[1]?.contradicts)
    expect(roundTripped.claims[1]?.contradicts.length).toBe(1)
    for (const claim of roundTripped.claims) {
      expect(Array.isArray(claim.supportingHosts)).toBe(true)
      expect(Array.isArray(claim.contradicts)).toBe(true)
    }
  })

  it('does not report a resumed run complete while its questions are still open', async () => {
    const store = new MemoryKbStore()
    const router = stubRouter({ 'PAGE-A': CLAIM_A, 'PAGE-B': CLAIM_A })

    const first = await createPersistentResearchDrivingDriver({ router, store, ledgerId: 'run-2' })
    await first.verifySource(source('https://arxiv.org/a', 'PAGE-A body'), ctx(1))
    await first.commitSources([registeredSource('https://arxiv.org/a', 'PAGE-A body')])
    // The questions this raises exist ONLY in the synchronous fold, so without a
    // checkpoint they would die here and the resumed run would call itself done.
    await first.prepareFold()
    first.foldGaps?.([])
    await first.checkpoint()
    expect(first.isComplete()).toBe(false)

    const resumed = await createPersistentResearchDrivingDriver({
      router,
      store,
      ledgerId: 'run-2',
    })
    expect(resumed.researchState().openQuestions.length).toBeGreaterThan(0)
    expect(resumed.isComplete()).toBe(false)

    // Corroborating the claim settles the CLAIM half, and completion still
    // refuses while a question raised before the crash remains unanswered.
    await resumed.verifySource(source('https://acm.org/b', 'PAGE-B body'), ctx(2))
    await resumed.commitSources([registeredSource('https://acm.org/b', 'PAGE-B body')])
    const settled = resumed.researchState()
    expect(settled.corroborated).toHaveLength(1)
    expect(settled.weaklySupported).toHaveLength(0)
    expect(settled.openQuestions.length).toBeGreaterThan(0)
    expect(resumed.isComplete()).toBe(false)

    // Why that matters, stated as its own violation: a ledger that kept the
    // claims but LOST the questions — which is what a driver without
    // `checkpoint` writes — reports the very same run complete.
    const lossy = (await store.getClaimLedger('run-2'))!
    await store.putClaimLedger({
      ...lossy,
      claims: resumed.toLedger().claims,
      questions: [],
    })
    const lied = await createPersistentResearchDrivingDriver({ router, store, ledgerId: 'run-2' })
    expect(lied.isComplete()).toBe(true)
  })

  it('recovers a fold interrupted before checkpoint without publishing its event', async () => {
    await withRoot(async (root) => {
      const store = new FileSystemKbStore({ root })
      const router = stubRouter({
        BODY: '[{"claim":"the method is 2x faster","contradicts":null}]',
      })
      const driver = await createPersistentResearchDrivingDriver({
        router,
        store,
        ledgerId: 'crashed-fold',
      })
      const interrupted = {
        ...driver,
        checkpoint: async () => {
          throw new Error('simulated crash before checkpoint')
        },
      }

      await expect(
        runVerifiedResearchLoop({
          root,
          goal: GOAL,
          maxRounds: 1,
          readinessSpecs: [
            defineReadinessSpec({
              id: 'still-open',
              description: 'a result the sources do not close',
              query: 'never-present',
              requiredFor: ['ResearchAgent'],
              importance: 'blocking',
              minSources: 3,
              minHits: 1,
            }),
          ],
          worker: async () => ({
            sources: [
              source('https://a.org/result', 'BODY one'),
              source('https://b.org/result', 'BODY two'),
            ],
          }),
          driver: interrupted,
        }),
      ).rejects.toThrow(/simulated crash/)

      const pending = await store.getClaimLedger('crashed-fold')
      expect(pending?.rounds).toBe(0)
      expect(pending?.preparedRounds).toBe(1)
      await expect(store.listEvents({ type: 'research.iteration' })).resolves.toHaveLength(0)

      const resumed = await createPersistentResearchDrivingDriver({
        router,
        store,
        ledgerId: 'crashed-fold',
      })
      expect(resumed.researchState().corroborated).toHaveLength(1)
      expect(resumed.researchState().openQuestions.length).toBeGreaterThan(0)
      expect(resumed.isComplete()).toBe(false)
      const recovered = await store.getClaimLedger('crashed-fold')
      expect(recovered?.rounds).toBe(1)
      expect(recovered?.preparedRounds).toBeUndefined()
      expect(recovered?.questions.length).toBeGreaterThan(0)
    })
  })

  it('refuses to merge two research goals into one ledger', async () => {
    const store = new MemoryKbStore()
    const router = stubRouter({ 'PAGE-A': CLAIM_A })
    const first = await createPersistentResearchDrivingDriver({ router, store, ledgerId: 'run-3' })
    await first.verifySource(source('https://arxiv.org/a', 'PAGE-A body'), ctx(1))
    await first.checkpoint()

    const resumed = await createPersistentResearchDrivingDriver({
      router,
      store,
      ledgerId: 'run-3',
    })
    await expect(
      resumed.verifySource(source('https://acm.org/b', 'PAGE-A body'), ctx(1, 'a different goal')),
    ).rejects.toThrow(/cannot be reused/)
  })

  it('rejects a ledger id that would escape its directory', async () => {
    const store = new MemoryKbStore()
    const router = stubRouter({})
    for (const ledgerId of ['../escape', 'nested/id', '..', '.', '', 'a\0b']) {
      await expect(
        createPersistentResearchDrivingDriver({ router, store, ledgerId }),
      ).rejects.toThrow(/claim ledger id/)
      await expect(store.getClaimLedger(ledgerId)).rejects.toThrow(/claim ledger id/)
    }
  })

  it('keeps two runs against one knowledge base from overwriting each other', async () => {
    await withRoot(async (root) => {
      await initKnowledgeBase(root)
      const store = new FileSystemKbStore({ root })
      const router = stubRouter({
        'PAGE-A': CLAIM_A,
        'PAGE-C': '[{"claim":"a different claim about caches","contradicts":null}]',
      })

      const runA = await createPersistentResearchDrivingDriver({ router, store, ledgerId: 'run-a' })
      await runA.verifySource(source('https://arxiv.org/a', 'PAGE-A body'), ctx(1, 'goal A'))
      await runA.commitSources([registeredSource('https://arxiv.org/a', 'PAGE-A body')])
      const runB = await createPersistentResearchDrivingDriver({ router, store, ledgerId: 'run-b' })
      await runB.verifySource(source('https://acm.org/c', 'PAGE-C body'), ctx(1, 'goal B'))
      await runB.commitSources([registeredSource('https://acm.org/c', 'PAGE-C body')])

      const ledgers = await store.listClaimLedgers()
      expect(ledgers.map((ledger) => ledger.id)).toEqual(['run-a', 'run-b'])
      expect(ledgers[0]?.goal).toBe('goal A')
      expect(ledgers[1]?.goal).toBe('goal B')
      expect(ledgers[0]?.claims[0]?.text).not.toBe(ledgers[1]?.claims[0]?.text)

      // On disk, under the one store directory, one file per run.
      const files = await readdir(join(root, KB_CLAIM_LEDGER_DIR))
      expect(files.sort()).toEqual(['run-a.json', 'run-b.json'])
    })
  })

  it('persists a claim ledger to disk that a fresh store instance reads back', async () => {
    await withRoot(async (root) => {
      await initKnowledgeBase(root)
      const router = stubRouter({ 'PAGE-A': CLAIM_A })
      const driver = await createPersistentResearchDrivingDriver({
        router,
        store: new FileSystemKbStore({ root }),
        ledgerId: 'run-disk',
      })
      await driver.verifySource(source('https://arxiv.org/a', 'PAGE-A body'), ctx(1))
      await driver.commitSources([registeredSource('https://arxiv.org/a', 'PAGE-A body')])
      await driver.prepareFold()
      driver.foldGaps?.([])
      await driver.checkpoint()

      // A different store object over the same root — the durable read path.
      const reader = new FileSystemKbStore({ root })
      const ledger = await reader.getClaimLedger('run-disk')
      expect(ledger?.claims).toHaveLength(1)
      expect(ledger?.claims[0]?.supportingHosts).toEqual(['arxiv.org'])
      expect(ledger?.questions.length).toBeGreaterThan(0)
      expect(ledger?.goal).toBe(GOAL)
      expect(await reader.getClaimLedger('never-written')).toBeNull()
    })
  })

  it('checkpoint on a store-less driver is a no-op rather than a silent write', async () => {
    const driver = createResearchDrivingDriver({ router: stubRouter({ 'PAGE-A': CLAIM_A }) })
    await driver.verifySource(source('https://arxiv.org/a', 'PAGE-A body'), ctx(1))
    await expect(driver.checkpoint()).resolves.toBeUndefined()
    expect(driver.toLedger().id).toBe('in-memory')
    expect(driver.toLedger().claims).toHaveLength(1)
  })
})

// ===========================================================================
// One store, one index file, and an event log with a producer.
// ===========================================================================

describe('knowledge store — one writer, one location', () => {
  it('shows the indexer’s work through the store, and writes exactly one index file', async () => {
    await withRoot(async (root) => {
      await initKnowledgeBase(root)
      await writeFile(join(root, 'knowledge', 'page.md'), '# Page\n\nBody text.\n')

      const built = await writeKnowledgeIndex(root)
      const store = new FileSystemKbStore({ root })
      const stored = await store.getIndex()

      // The exact reproduction that used to resolve to `null`.
      expect(stored).not.toBeNull()
      expect(stored?.pages.map((page) => page.path)).toEqual(built.pages.map((page) => page.path))

      // Violation attempt: no SECOND index file anywhere under the root.
      const found = await findFiles(root, 'index.json')
      expect(found).toEqual([join(root, '.agent-knowledge', 'index.json')])
      await expect(access(join(root, 'index.json'))).rejects.toThrow()
    })
  })

  it('accepts every event type the package declares', async () => {
    await withRoot(async (root) => {
      const store = new FileSystemKbStore({ root })
      for (const type of KNOWLEDGE_EVENT_TYPES) {
        const event = createKnowledgeEvent({ type, target: `target-${type}` })
        expect(() => KnowledgeEventSchema.parse(event)).not.toThrow()
        await store.putEvent(event)
      }
      const stored = await store.listEvents()
      expect(stored.map((event) => event.type).sort()).toEqual([...KNOWLEDGE_EVENT_TYPES].sort())
    })
  })

  it('records the research loop’s round events instead of discarding them', async () => {
    await withRoot(async (root) => {
      const result = await runVerifiedResearchLoop({
        root,
        goal: GOAL,
        maxRounds: 2,
        actor: 'test',
        worker: async ({ round }) => ({
          sources: [source(`https://arxiv.org/r${round}`, `body for round ${round}`)],
        }),
        driver: { verifySource: () => ({ accept: true }) },
      })
      expect(result.rounds).toBe(2)

      const stored = await new FileSystemKbStore({ root }).listEvents({
        type: 'research.iteration',
      })
      expect(stored).toHaveLength(2)
      expect(stored.map((event) => event.metadata?.round)).toEqual([1, 2])
      expect(stored.every((event) => event.actor === 'test')).toBe(true)
    })
  })

  it('checkpoints the driver through a real loop so the run resumes from disk', async () => {
    await withRoot(async (root) => {
      const store = new FileSystemKbStore({ root })
      const router = stubRouter({ 'body for round': CLAIM_A })
      const driver = await createPersistentResearchDrivingDriver({
        router,
        store,
        ledgerId: 'loop-run',
      })

      // A readiness spec the single source cannot satisfy keeps the loop
      // not-ready, which is what makes it fold steer — the driver's synchronous
      // question-raising hook, whose output only reaches disk via `checkpoint`.
      await runVerifiedResearchLoop({
        root,
        goal: GOAL,
        maxRounds: 1,
        readinessSpecs: [
          defineReadinessSpec({
            id: 'topic/definition',
            description: 'what the method is and how it works',
            query: 'body for round',
            requiredFor: ['ResearchAgent'],
            importance: 'blocking',
            minSources: 2,
            minHits: 1,
          }),
        ],
        worker: async ({ round }) => ({
          sources: [source(`https://arxiv.org/r${round}`, `body for round ${round}`)],
        }),
        driver,
      })

      const resumed = await createPersistentResearchDrivingDriver({
        router,
        store,
        ledgerId: 'loop-run',
      })
      const state = resumed.researchState()
      expect(state.claims).toHaveLength(1)
      expect(state.claims[0]?.supportingHosts).toEqual(new Set(['arxiv.org']))
      expect(state.rounds).toBe(1)
      expect(state.openQuestions.length).toBeGreaterThan(0)
    })
  })
})

// ===========================================================================
// durable-fs is reachable, and still refuses to be redirected.
// ===========================================================================

describe('durable-fs on the package entrypoint', () => {
  it('exports the durable write primitives', () => {
    expect(typeof writeFileDurable).toBe('function')
    expect(typeof writeJsonDurableWithinRoot).toBe('function')
    expect(typeof withSafeDescendant).toBe('function')
  })

  it('still refuses a write redirected through a symbolic link', async () => {
    await withRoot(async (root) => {
      const outside = join(root, 'outside')
      const base = join(root, 'base')
      await mkdir(outside, { recursive: true })
      await mkdir(base, { recursive: true })
      await symlink(outside, join(base, 'records'))

      await expect(
        writeJsonDurableWithinRoot(base, 'records/leak.json', { leaked: true }),
      ).rejects.toThrow(/unsafe directory/)
      await expect(access(join(outside, 'leak.json'))).rejects.toThrow()

      // The traversal guard is on the relative path itself, too.
      await expect(writeJsonDurableWithinRoot(base, '../escape.json', {})).rejects.toThrow(
        /unsafe segment/,
      )
    })
  })

  it('replaces a file atomically, leaving no temporary behind', async () => {
    await withRoot(async (root) => {
      const path = join(root, 'record.json')
      await writeFileDurable(path, '{"generation":1}\n', { encoding: 'utf8' })
      await writeFileDurable(path, '{"generation":2}\n', { encoding: 'utf8' })
      expect(await readdir(root)).toEqual(['record.json'])
    })
  })
})

// ===========================================================================
// Persisting is not enough: two writers must ACCUMULATE, not overwrite.
// ===========================================================================

function ledgerOf(
  id: string,
  claims: readonly ResearchClaimRecord[],
  goal = GOAL,
): ResearchClaimLedger {
  const claimEvidence = claims
    .flatMap((claim) =>
      claim.supportingUris.map((sourceUri) =>
        evidenceFrom(claim.text, sourceUri, claim.firstSeenRound, claim.contradicts[0]),
      ),
    )
    .sort((left, right) => left.id.localeCompare(right.id))
  const registeredSources = new Map<string, ResearchSourceVersion>()
  for (const evidence of claimEvidence) {
    registeredSources.set(evidence.sourceId, {
      sourceId: evidence.sourceId,
      uri: evidence.sourceUri,
      contentHash: evidence.sourceContentHash,
    })
  }
  return {
    schemaVersion: 2,
    id,
    goal,
    updatedAt: '2026-07-28T00:00:00.000Z',
    rounds: 1,
    claimEvidence,
    registeredSources: [...registeredSources.values()].sort((a, b) =>
      a.sourceId.localeCompare(b.sourceId),
    ),
    claims: [...claims].sort((a, b) => a.id.localeCompare(b.id)),
    questions: [],
  }
}

function claimFrom(text: string, host: string, round = 1): ResearchClaimRecord {
  return {
    id: claimId(text),
    text,
    supportingHosts: [host],
    supportingUris: [`https://${host}/x`],
    contradicts: [],
    contested: false,
    firstSeenRound: round,
  }
}

function evidenceFrom(
  text: string,
  sourceUri: string,
  round = 1,
  contradictsClaimId?: string,
): ResearchClaimEvidence {
  const observedClaimId = claimId(text)
  const version = sourceVersion(sourceUri)
  return {
    id: claimEvidenceId({
      claimId: observedClaimId,
      sourceId: version.sourceId,
      sourceUri,
      sourceContentHash: version.contentHash,
      contradictsClaimId,
    }),
    claimId: observedClaimId,
    text,
    sourceId: version.sourceId,
    sourceUri,
    sourceContentHash: version.contentHash,
    ...(contradictsClaimId === undefined ? {} : { contradictsClaimId }),
    firstSeenRound: round,
  }
}

function sourceVersion(uri: string, text = `source:${uri}`): ResearchSourceVersion {
  const contentHash = sha256(text)
  return { sourceId: textSourceId(uri, contentHash), uri, contentHash }
}

describe('claim ledger — concurrent accumulation', () => {
  /**
   * The negative control for the whole merge path. If `putClaimLedger` did not
   * lose a concurrent writer's claims, `mergeClaimLedger` would be ceremony —
   * so the loss is asserted here, and the next test asserts the fix. Weakening
   * either one makes the pair vacuous.
   */
  it('loses a concurrent writer’s claims when each writes the whole ledger', async () => {
    const store = new MemoryKbStore()
    const mine = claimFrom('layer skipping gives a 1.73x speedup', 'arxiv.org')
    const theirs = claimFrom('draft heads cost 8% of parameters', 'acm.org')

    // Both read the empty ledger, then both write what they built from it.
    const readByA = await store.getClaimLedger('shared')
    const readByB = await store.getClaimLedger('shared')
    expect(readByA).toBeNull()
    expect(readByB).toBeNull()
    await store.putClaimLedger(ledgerOf('shared', [mine]))
    await store.putClaimLedger(ledgerOf('shared', [theirs]))

    const after = await store.getClaimLedger('shared')
    expect(after?.claims.map((claim) => claim.text)).toEqual([theirs.text])
  })

  it('keeps both writers’ claims when each merges', async () => {
    const store = new MemoryKbStore()
    const mine = claimFrom('layer skipping gives a 1.73x speedup', 'arxiv.org')
    const theirs = claimFrom('draft heads cost 8% of parameters', 'acm.org')

    for (const claim of [mine, theirs]) {
      await store.mergeClaimLedger('shared', (current) =>
        current === null
          ? ledgerOf('shared', [claim])
          : mergeClaimLedgers(current, ledgerOf('shared', [claim])),
      )
    }

    const after = await store.getClaimLedger('shared')
    expect(after?.claims.map((claim) => claim.text).sort()).toEqual([mine.text, theirs.text].sort())
  })

  it('grows one claim’s independent-source count across separate writers', async () => {
    const store = new MemoryKbStore()
    const text = 'layer skipping gives a 1.73x speedup'
    for (const host of ['arxiv.org', 'acm.org', 'arxiv.org']) {
      await store.mergeClaimLedger('shared', (current) => {
        const incoming = ledgerOf('shared', [claimFrom(text, host)])
        return current === null ? incoming : mergeClaimLedgers(current, incoming)
      })
    }

    const after = await store.getClaimLedger('shared')
    expect(after?.claims).toHaveLength(1)
    // Two DISTINCT hosts, and the repeat did not inflate the count — that count
    // is the corroboration threshold, so double-counting one host would report
    // an unconfirmed claim as independently confirmed.
    expect(after?.claims[0]?.supportingHosts.sort()).toEqual(['acm.org', 'arxiv.org'])
  })

  it('serialises concurrent merges on disk so no writer’s claim is dropped', async () => {
    await withRoot(async (root) => {
      await initKnowledgeBase(root)
      const hosts = ['a.org', 'b.org', 'c.org', 'd.org', 'e.org', 'f.org']
      // A separate store instance per writer: same root, no shared memory, which
      // is what two workers in two processes look like to the filesystem.
      await Promise.all(
        hosts.map((host) =>
          new FileSystemKbStore({ root }).mergeClaimLedger('pursuit', (current) => {
            const incoming = ledgerOf('pursuit', [claimFrom(`claim from ${host}`, host)])
            return current === null ? incoming : mergeClaimLedgers(current, incoming)
          }),
        ),
      )

      const after = await new FileSystemKbStore({ root }).getClaimLedger('pursuit')
      expect(after?.claims.map((claim) => claim.text).sort()).toEqual(
        hosts.map((host) => `claim from ${host}`).sort(),
      )
    })
  })

  it('uses one lock when legacy and root constructors address the same files', async () => {
    await withRoot(async (root) => {
      await initKnowledgeBase(root)
      const rootStore = new FileSystemKbStore({ root })
      const legacyStore = new FileSystemKbStore(join(root, KB_STORE_DIR))
      const hosts = Array.from({ length: 12 }, (_, index) => `host-${index}.org`)

      await Promise.all(
        hosts.map((host, index) => {
          const store = index % 2 === 0 ? rootStore : legacyStore
          return store.mergeClaimLedger('aliased', (current) => {
            const incoming = ledgerOf('aliased', [claimFrom(`claim ${index}`, host)])
            return current === null ? incoming : mergeClaimLedgers(current, incoming)
          })
        }),
      )

      const stored = await rootStore.getClaimLedger('aliased')
      expect(stored?.claims).toHaveLength(hosts.length)
    })
  })

  it('two persistent drivers on one ledger see each other’s corroboration', async () => {
    await withRoot(async (root) => {
      await initKnowledgeBase(root)
      const router = stubRouter({ 'PAGE-A': CLAIM_A, 'PAGE-B': CLAIM_A })

      const workerThree = await createPersistentResearchDrivingDriver({
        router,
        store: new FileSystemKbStore({ root }),
        ledgerId: 'pursuit',
      })
      const workerForty = await createPersistentResearchDrivingDriver({
        router,
        store: new FileSystemKbStore({ root }),
        ledgerId: 'pursuit',
      })

      await workerThree.verifySource(source('https://arxiv.org/a', 'PAGE-A body'), ctx(1))
      await workerThree.commitSources([registeredSource('https://arxiv.org/a', 'PAGE-A body')])
      await workerForty.verifySource(source('https://acm.org/b', 'PAGE-B body'), ctx(1))
      await workerForty.commitSources([registeredSource('https://acm.org/b', 'PAGE-B body')])

      // Worker 40 wrote second and read worker 3's evidence back: one claim,
      // two independent hosts, corroborated. Under a whole-record write worker
      // 40 would report one host and the claim would still be weak.
      const seen = workerForty.researchState()
      expect(seen.claims).toHaveLength(1)
      expect([...(seen.claims[0]?.supportingHosts ?? [])].sort()).toEqual(['acm.org', 'arxiv.org'])
      expect(seen.corroborated).toHaveLength(1)
      expect(workerForty.isComplete()).toBe(true)
    })
  })

  it('refuses a merge that returns a ledger under a different id', async () => {
    const store = new MemoryKbStore()
    await expect(
      store.mergeClaimLedger('pursuit', () => ledgerOf('somewhere-else', [])),
    ).rejects.toThrow(/returned a ledger with id 'somewhere-else'/)
    expect(await store.getClaimLedger('pursuit')).toBeNull()

    await withRoot(async (root) => {
      await initKnowledgeBase(root)
      const fileStore = new FileSystemKbStore({ root })
      await expect(
        fileStore.mergeClaimLedger('pursuit', () => ledgerOf('somewhere-else', [])),
      ).rejects.toThrow(/returned a ledger with id 'somewhere-else'/)
      expect(await fileStore.getClaimLedger('pursuit')).toBeNull()
      expect(await fileStore.getClaimLedger('somewhere-else')).toBeNull()
    })
  })

  it('refuses to pool evidence gathered for two different goals', () => {
    const base = ledgerOf('pursuit', [claimFrom('x speeds up y', 'a.org')], 'speculative decoding')
    const other = ledgerOf('pursuit', [claimFrom('x speeds up y', 'b.org')], 'quantization')
    expect(() => mergeClaimLedgers(base, other)).toThrow(ClaimLedgerGoalConflictError)
    // The claim would otherwise have read as corroborated by two independent
    // hosts, on evidence collected for two unrelated questions.
    expect(() => mergeClaimLedgers(base, other)).toThrow(/'speculative decoding'/)
  })

  it('is order-independent and idempotent, so a replayed write changes nothing', () => {
    const a = ledgerOf('pursuit', [claimFrom('claim one', 'a.org', 3)])
    const b = ledgerOf('pursuit', [claimFrom('claim one', 'b.org', 1), claimFrom('two', 'b.org')])

    const ab = mergeClaimLedgers(a, b)
    const ba = mergeClaimLedgers(b, a)
    expect(ab).toEqual(ba)
    expect(mergeClaimLedgers(ab, b)).toEqual(ab)
    expect(mergeClaimLedgers(ab, a)).toEqual(ab)
    // The earliest round a claim was seen in survives the merge; a later
    // sighting must not make the claim look newer than it is.
    expect(ab.claims.find((claim) => claim.id === claimId('claim one'))?.firstSeenRound).toBe(1)
  })

  it('is associative across three independently accumulated ledgers', () => {
    const a = ledgerOf('pursuit', [claimFrom('claim one', 'a.org', 3)])
    const b = ledgerOf('pursuit', [claimFrom('claim one', 'b.org', 1)])
    const c = ledgerOf('pursuit', [claimFrom('claim two', 'c.org', 2)])

    expect(mergeClaimLedgers(mergeClaimLedgers(a, b), c)).toEqual(
      mergeClaimLedgers(a, mergeClaimLedgers(b, c)),
    )
  })

  it('materializes split evidence and source confirmation in either merge order', () => {
    const sourceUri = 'https://a.org/result'
    const evidence = evidenceFrom('claim one', sourceUri)
    const observed = { ...ledgerOf('pursuit', []), claimEvidence: [evidence] }
    const registered = {
      ...ledgerOf('pursuit', []),
      registeredSources: [sourceVersion(sourceUri)],
    }

    const evidenceThenRegistration = mergeClaimLedgers(observed, registered)
    const registrationThenEvidence = mergeClaimLedgers(registered, observed)
    expect(evidenceThenRegistration).toEqual(registrationThenEvidence)
    expect(evidenceThenRegistration.claims[0]?.supportingUris).toEqual([sourceUri])
    expect(mergeClaimLedgers(evidenceThenRegistration, observed)).toEqual(evidenceThenRegistration)
    expect(mergeClaimLedgers(evidenceThenRegistration, registered)).toEqual(
      evidenceThenRegistration,
    )
  })

  it('keeps the two-phase closure associative across independent writers', () => {
    const uriOne = 'https://a.org/result'
    const uriTwo = 'https://b.org/result'
    const evidence = {
      ...ledgerOf('pursuit', []),
      claimEvidence: [
        evidenceFrom('claim one', uriOne, 2),
        evidenceFrom('claim one', uriTwo, 1),
      ].sort((left, right) => left.id.localeCompare(right.id)),
    }
    const firstRegistration = {
      ...ledgerOf('pursuit', []),
      registeredSources: [sourceVersion(uriOne)],
    }
    const secondRegistration = {
      ...ledgerOf('pursuit', []),
      registeredSources: [sourceVersion(uriTwo)],
    }

    const left = mergeClaimLedgers(
      mergeClaimLedgers(evidence, firstRegistration),
      secondRegistration,
    )
    const right = mergeClaimLedgers(
      evidence,
      mergeClaimLedgers(firstRegistration, secondRegistration),
    )
    expect(left).toEqual(right)
    expect(left.claims[0]?.supportingHosts).toEqual(['a.org', 'b.org'])
  })

  it('does not contest a claim against an unregistered counterpart', () => {
    const originalUri = 'https://a.org/original'
    const refuterUri = 'https://b.org/refuter'
    const original = evidenceFrom('the speedup is 5x', originalUri)
    const refuter = evidenceFrom('the speedup is only 2x', refuterUri, 1, original.claimId)
    const observed = {
      ...ledgerOf('pursuit', []),
      claimEvidence: [original, refuter].sort((left, right) => left.id.localeCompare(right.id)),
    }
    const onlyRefuterRegistered = {
      ...ledgerOf('pursuit', []),
      registeredSources: [sourceVersion(refuterUri)],
    }

    const oneSided = mergeClaimLedgers(observed, onlyRefuterRegistered)
    expect(oneSided.claims).toHaveLength(1)
    expect(oneSided.claims[0]?.contested).toBe(false)
    expect(oneSided.claims[0]?.contradicts).toEqual([])

    const bothRegistered = mergeClaimLedgers(oneSided, {
      ...ledgerOf('pursuit', []),
      registeredSources: [sourceVersion(originalUri)],
    })
    expect(bothRegistered.claims).toHaveLength(2)
    expect(bothRegistered.claims.every((claim) => claim.contested)).toBe(true)
    expect(bothRegistered.claims.every((claim) => claim.contradicts.length === 1)).toBe(true)
  })

  it('does not merge opposite directional or polarity claims', () => {
    for (const [left, right] of [
      ['accuracy > 90%', 'accuracy < 90%'],
      ['effect is +5%', 'effect is -5%'],
      ['result is x + y', 'result is x - y'],
      ['result ≥ baseline', 'result ≤ baseline'],
    ]) {
      expect(claimId(left)).not.toBe(claimId(right))
      const merged = mergeClaimLedgers(
        ledgerOf('pursuit', [claimFrom(left, 'a.org')]),
        ledgerOf('pursuit', [claimFrom(right, 'b.org')]),
      )
      expect(merged.claims).toHaveLength(2)
      expect(merged.claims.every((claim) => claim.supportingHosts.length === 1)).toBe(true)
    }
  })

  it('uses a deterministic wording when equal-round writers spell one claim differently', () => {
    const upper = claimFrom('Layer skipping gives a 1.73x speedup!', 'a.org')
    const lower = claimFrom('layer skipping gives a 1 73x speedup', 'b.org')
    expect(upper.id).toBe(lower.id)

    const forward = mergeClaimLedgers(ledgerOf('pursuit', [upper]), ledgerOf('pursuit', [lower]))
    const reverse = mergeClaimLedgers(ledgerOf('pursuit', [lower]), ledgerOf('pursuit', [upper]))
    expect(forward).toEqual(reverse)
    expect(forward.claims[0]?.text).toBe(
      [upper.text, lower.text].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0],
    )
  })

  it('never clears a contradiction a later writer did not happen to see', () => {
    const contrary = claimFrom('x slows down y', 'c.org')
    const contested: ResearchClaimRecord = {
      ...claimFrom('x speeds up y', 'a.org'),
      contradicts: [contrary.id],
      contested: true,
    }
    contrary.contradicts = [contested.id]
    contrary.contested = true
    const oblivious = claimFrom('x speeds up y', 'b.org')
    const merged = mergeClaimLedgers(
      ledgerOf('p', [contested, contrary]),
      ledgerOf('p', [oblivious]),
    )
    const retained = merged.claims.find((claim) => claim.id === contested.id)
    expect(retained?.contested).toBe(true)
    expect(retained?.contradicts).toEqual([contrary.id])
  })

  it('makes a one-sided contradiction symmetric and contests both ends', () => {
    // Only the refuting worker knows about the disagreement: it recorded the
    // edge, the original claim's writer never saw it.
    const refuter: ResearchClaimRecord = {
      ...claimFrom('the speedup is only 2x', 'b.org'),
      contradicts: [claimId('the speedup is 5x')],
      contested: true,
    }
    const original = claimFrom('the speedup is 5x', 'a.org')
    const linked = linkClaimContradictions(ledgerOf('p', [original, refuter]))
    const byId = new Map(linked.claims.map((claim) => [claim.id, claim]))

    expect(byId.get(original.id)?.contested).toBe(true)
    expect(byId.get(original.id)?.contradicts).toEqual([refuter.id])
    expect(byId.get(refuter.id)?.contradicts).toEqual([original.id])
    // Idempotent: a second pass finds the edges already there.
    expect(linkClaimContradictions(linked)).toEqual(linked)
  })

  it('refuses a materialized contradiction whose counterpart has not arrived', () => {
    const original = claimFrom('the speedup is 5x', 'a.org')
    const refuter: ResearchClaimRecord = {
      ...claimFrom('the speedup is only 2x', 'b.org'),
      contradicts: [original.id],
      contested: true,
    }
    expect(() => mergeClaimLedgers(ledgerOf('p', [refuter]), ledgerOf('p', [original]))).toThrow(
      /unmaterialized claim/,
    )
  })

  it('keeps an unclosed contradiction only as evidence until its counterpart arrives', () => {
    const orphan: ResearchClaimRecord = {
      ...claimFrom('x speeds up y', 'a.org'),
      contradicts: [claimId('nobody has written this down yet')],
      contested: true,
    }
    const linked = linkClaimContradictions(ledgerOf('p', [orphan]))
    expect(linked.claims[0]?.contradicts).toEqual([])
    expect(linked.claims[0]?.contested).toBe(false)
    expect(linked.claimEvidence[0]?.contradictsClaimId).toBe(
      claimId('nobody has written this down yet'),
    )
    expect(ResearchClaimLedgerSchema.parse(linked)).toEqual(linked)
  })
})

describe('claim ledger — record integrity', () => {
  const claim = claimFrom('layer skipping gives a 1.73x speedup', 'arxiv.org')
  const questionText = 'What independent result corroborates the speedup?'
  const question = {
    kind: 'gap' as const,
    text: questionText,
    id: deepQuestionId('gap', questionText),
    claimIds: [claim.id],
    addressed: false,
    raisedRound: 1,
  }

  it('accepts a canonical claim and question record', () => {
    const ledger = { ...ledgerOf('pursuit', [claim]), questions: [question] }
    expect(ResearchClaimLedgerSchema.parse(ledger)).toEqual(ledger)
    expect(DeepQuestionSchema.parse(question)).toEqual(question)
  })

  it('refuses a forged claim identity and leaves the store unchanged', async () => {
    const store = new MemoryKbStore()
    const forged = {
      ...ledgerOf('pursuit', [claim]),
      claims: [{ ...claim, id: 'c_forged' }],
    }
    await expect(store.putClaimLedger(forged)).rejects.toThrow(/text-derived identity/)
    await expect(store.getClaimLedger('pursuit')).resolves.toBeNull()
  })

  it('refuses an independent-source count not backed by source URIs', () => {
    const inflated = {
      ...ledgerOf('pursuit', [claim]),
      claims: [{ ...claim, supportingHosts: ['acm.org', 'arxiv.org'] }],
    }
    expect(() => ResearchClaimLedgerSchema.parse(inflated)).toThrow(
      /hosts derived from supportingUris/,
    )
  })

  it('refuses duplicate evidence, self-contradictions, and unbound questions', () => {
    const duplicateEvidence = {
      ...ledgerOf('pursuit', [claim]),
      claims: [{ ...claim, supportingUris: [...claim.supportingUris, ...claim.supportingUris] }],
    }
    expect(() => ResearchClaimLedgerSchema.parse(duplicateEvidence)).toThrow(
      /sorted and contain no duplicates/,
    )

    const selfContradiction = {
      ...ledgerOf('pursuit', [claim]),
      claims: [{ ...claim, contradicts: [claim.id], contested: true }],
    }
    expect(() => ResearchClaimLedgerSchema.parse(selfContradiction)).toThrow(/cannot contradict/)

    const unboundQuestion = {
      ...ledgerOf('pursuit', [claim]),
      questions: [{ ...question, claimIds: ['c_missing'] }],
    }
    expect(() => ResearchClaimLedgerSchema.parse(unboundQuestion)).toThrow(/outside its ledger/)
  })

  it('refuses forged, unregistered, or unmaterialized evidence state', () => {
    const evidence = evidenceFrom(claim.text, claim.supportingUris[0]!)
    const forged = {
      ...ledgerOf('pursuit', []),
      claimEvidence: [{ ...evidence, id: 'e_forged' }],
    }
    expect(() => ResearchClaimLedgerSchema.parse(forged)).toThrow(/content-derived identity/)

    const unregistered = {
      ...ledgerOf('pursuit', [claim]),
      registeredSources: [],
    }
    expect(() => ResearchClaimLedgerSchema.parse(unregistered)).toThrow(
      /without exact registered evidence/,
    )

    const unmaterialized = {
      ...ledgerOf('pursuit', []),
      claimEvidence: [evidence],
      registeredSources: [sourceVersion(evidence.sourceUri)],
    }
    expect(() => ResearchClaimLedgerSchema.parse(unmaterialized)).toThrow(/must be materialized/)
  })

  it('refuses a question whose content is not bound to its id', () => {
    expect(() => DeepQuestionSchema.parse({ ...question, text: 'Different question' })).toThrow(
      /kind-and-text identity/,
    )
  })

  it('preserves an unversioned ledger byte-for-byte until explicit re-verification', async () => {
    await withRoot(async (root) => {
      await initKnowledgeBase(root)
      const directory = join(root, KB_CLAIM_LEDGER_DIR)
      const path = join(directory, 'legacy.json')
      await mkdir(directory, { recursive: true })
      const legacy = {
        id: 'legacy',
        goal: GOAL,
        updatedAt: '2026-07-28T00:00:00.000Z',
        rounds: 1,
        claimEvidence: [],
        registeredSourceUris: [],
        claims: [],
        questions: [],
      }
      const original = `${JSON.stringify(legacy, null, 2)}\n`
      await writeFile(path, original)
      const store = new FileSystemKbStore({ root })

      await expect(store.getClaimLedger('legacy')).rejects.toBeInstanceOf(
        ClaimLedgerMigrationRequiredError,
      )
      await expect(store.listClaimLedgers()).rejects.toBeInstanceOf(
        ClaimLedgerMigrationRequiredError,
      )
      await expect(
        store.mergeClaimLedger('legacy', () => ledgerOf('legacy', [])),
      ).rejects.toBeInstanceOf(ClaimLedgerMigrationRequiredError)
      await expect(store.putClaimLedger(ledgerOf('legacy', []))).rejects.toBeInstanceOf(
        ClaimLedgerMigrationRequiredError,
      )
      expect(await readFile(path, 'utf8')).toBe(original)
    })
  })
})

async function findFiles(root: string, name: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) out.push(...(await findFiles(path, name)))
    else if (entry.name === name) out.push(path)
  }
  return out.sort()
}
