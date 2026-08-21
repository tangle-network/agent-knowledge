import { canonicalCandidateDigest, sha256Bytes } from '@tangle-network/agent-interface'
import { describe, expect, it } from 'vitest'
import {
  assertKnowledgeRetrievalMatchesVisibility,
  assertKnowledgeRetrievalMatchesVisibilityArtifact,
  createKnowledgeRetrievalReceipt,
  createKnowledgeUseReceipt,
  createKnowledgeVisibilitySnapshot,
  decodeKnowledgeVisibilitySnapshot,
  encodeKnowledgeVisibilitySnapshot,
  KnowledgeVisibilityUnavailableError,
  knowledgePageDigest,
  knowledgeVisibilityArtifactRef,
  type OriginatedKnowledgeSearchResult,
  verifyKnowledgeRetrievalReceipt,
  verifyKnowledgeUseReceipt,
  verifyKnowledgeVisibilitySnapshot,
} from './knowledge-use-receipts'
import type { OriginatedPage } from './run-scoped'
import type { KnowledgePage } from './types'

const createdAt = '2026-08-17T12:00:00.000Z'

function page(input: {
  id: string
  path?: string
  text?: string
  sourceIds?: string[]
  cites?: string[]
}): KnowledgePage {
  return {
    id: input.id,
    path: input.path ?? `knowledge/${input.id}.md`,
    title: `Title ${input.id}`,
    text: input.text ?? `Knowledge for ${input.id}`,
    frontmatter: { id: input.id, title: `Title ${input.id}` },
    sourceIds: input.sourceIds ?? [],
    tags: ['fixture'],
    outLinks: [],
    ...(input.cites ? { cites: input.cites } : {}),
  }
}

function fixture() {
  const current = page({ id: 'current-result', sourceIds: ['source-current'] })
  const inherited = page({ id: 'parent-result', sourceIds: ['source-parent'] })
  const shared = page({ id: 'instrument-calibration', sourceIds: ['source-shared'] })
  const visiblePages: OriginatedPage[] = [
    { page: current, origin: 'here' },
    { page: inherited, origin: 'inherited:run-parent' },
    { page: shared, origin: 'shared' },
  ]
  const results: OriginatedKnowledgeSearchResult[] = [
    {
      page: inherited,
      origin: 'inherited:run-parent',
      score: 0.04,
      rrfScore: 0.04,
      normalizedScore: 1,
      rank: 1,
      snippet: 'The parent result contains the needed obstruction.',
      reasons: ['title-match', 'body-token-match'],
    },
    {
      page: shared,
      origin: 'shared',
      score: 0.02,
      rrfScore: 0.02,
      normalizedScore: 0.5,
      rank: 2,
      snippet: 'The shared page documents the calibrated verifier.',
      reasons: ['body-token-match'],
    },
  ]
  return { current, inherited, shared, visiblePages, results }
}

function retrieval(overrides: Partial<Parameters<typeof createKnowledgeRetrievalReceipt>[0]> = {}) {
  const data = fixture()
  return createKnowledgeRetrievalReceipt({
    runId: 'run-child',
    actorId: 'root:s0',
    profileDigest: canonicalCandidateDigest({ profile: 'researcher-v1' }),
    executionRef: canonicalCandidateDigest({ executor: 'runtime-v1' }),
    query: 'prior obstruction calibrated verifier',
    retriever: {
      id: 'inspectable-token-overlap',
      version: '1.0.0',
      configDigest: canonicalCandidateDigest({ tokenizer: 'unicode-words', limit: 5 }),
    },
    visibility: createKnowledgeVisibilitySnapshot(data.visiblePages),
    results: data.results,
    evidenceRefs: [{ kind: 'event', uri: 'event://run-child/retrieval-1' }],
    attributes: { purpose: 'research', limit: 5, inheritedEnabled: true },
    createdAt,
    ...overrides,
  })
}

describe('knowledge visibility snapshots', () => {
  it('binds ordered page bytes, origins, paths, sources, and invalidation state', () => {
    const { visiblePages } = fixture()
    const snapshot = createKnowledgeVisibilitySnapshot(visiblePages)

    expect(snapshot.entries.map((entry) => [entry.position, entry.pageId, entry.origin])).toEqual([
      [0, 'current-result', 'here'],
      [1, 'parent-result', 'inherited:run-parent'],
      [2, 'instrument-calibration', 'shared'],
    ])
    expect(snapshot.entries[1]?.pageDigest).toBe(knowledgePageDigest(visiblePages[1]!.page))
    expect(snapshot.snapshotDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  it('changes identity when page bytes, origin, or ordering changes', () => {
    const { visiblePages } = fixture()
    const baseline = createKnowledgeVisibilitySnapshot(visiblePages).snapshotDigest
    const changedText = structuredClone(visiblePages)
    changedText[1]!.page.text = 'Mutated parent result.'
    const changedOrigin = structuredClone(visiblePages)
    changedOrigin[1]!.origin = 'shared'
    const changedOrder = [visiblePages[1]!, visiblePages[0]!, visiblePages[2]!]

    expect(createKnowledgeVisibilitySnapshot(changedText).snapshotDigest).not.toBe(baseline)
    expect(createKnowledgeVisibilitySnapshot(changedOrigin).snapshotDigest).not.toBe(baseline)
    expect(createKnowledgeVisibilitySnapshot(changedOrder).snapshotDigest).not.toBe(baseline)
  })

  it('refuses a repeated path at the same origin', () => {
    const { current } = fixture()
    expect(() =>
      createKnowledgeVisibilitySnapshot([
        { page: current, origin: 'here' },
        { page: { ...current, id: 'different-id' }, origin: 'here' },
      ]),
    ).toThrow(/repeats path/)
  })

  it('verifies a decoded snapshot and refuses a tampered one', () => {
    const { visiblePages } = fixture()
    const snapshot = createKnowledgeVisibilitySnapshot(visiblePages)
    const decoded = decodeKnowledgeVisibilitySnapshot(encodeKnowledgeVisibilitySnapshot(snapshot))
    expect(decoded).toEqual(snapshot)

    const tampered = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot
    ;(tampered.entries[1] as { pageId: string }).pageId = 'forged-id'
    expect(() => verifyKnowledgeVisibilitySnapshot(tampered)).toThrow(/snapshot digest mismatch/)
  })
})

describe('knowledge retrieval receipts', () => {
  it('binds a compact visibility reference, ranked results, and trace evidence', () => {
    const data = fixture()
    const snapshot = createKnowledgeVisibilitySnapshot(data.visiblePages)
    const receipt = retrieval({ visibility: snapshot })

    expect(verifyKnowledgeRetrievalReceipt(receipt)).toBe(receipt)
    expect(receipt).toMatchObject({
      schemaVersion: '2.0.0',
      kind: 'knowledge-retrieval',
      digestAlgorithm: 'rfc8785-sha256',
      runId: 'run-child',
      actorId: 'root:s0',
      query: 'prior obstruction calibrated verifier',
      visibility: { snapshotDigest: snapshot.snapshotDigest, pageCount: 3 },
      results: [
        { rank: 1, pageId: 'parent-result', origin: 'inherited:run-parent' },
        { rank: 2, pageId: 'instrument-calibration', origin: 'shared' },
      ],
    })
    expect(receipt.results[0]?.pageDigest).toBe(snapshot.entries[1]?.pageDigest)
  })

  it('is deterministic for identical evidence and changes for identity-bearing inputs', () => {
    const first = retrieval()
    const second = retrieval()
    const changedQuery = retrieval({ query: 'different query' })
    const changedExecutor = retrieval({
      executionRef: canonicalCandidateDigest({ executor: 'runtime-v2' }),
    })

    expect(second.receiptDigest).toBe(first.receiptDigest)
    expect(changedQuery.receiptDigest).not.toBe(first.receiptDigest)
    expect(changedExecutor.receiptDigest).not.toBe(first.receiptDigest)
  })

  it('serializes the page inventory once across repeated retrievals', () => {
    const pageCount = 40
    const retrievals = 5
    let textReads = 0
    const visiblePages: OriginatedPage[] = Array.from({ length: pageCount }, (_, index) => {
      const entry = page({ id: `page-${index}` })
      const text = entry.text
      Object.defineProperty(entry, 'text', {
        get() {
          textReads += 1
          return text
        },
      })
      return { page: entry, origin: 'here' }
    })
    const snapshot = createKnowledgeVisibilitySnapshot(visiblePages)
    const readsPerPage = textReads / pageCount
    const afterSnapshot = textReads

    for (let index = 0; index < retrievals; index++) {
      const receipt = createKnowledgeRetrievalReceipt({
        runId: 'run-child',
        query: `query ${index}`,
        retriever: {
          id: 'fixture',
          version: '1',
          configDigest: canonicalCandidateDigest({ fixture: true }),
        },
        visibility: snapshot,
        results: [
          {
            page: visiblePages[index]!.page,
            origin: 'here',
            score: 0.5,
            rrfScore: 0.5,
            normalizedScore: 1,
            rank: 1,
            snippet: '',
            reasons: ['body-token-match'],
          },
        ],
        createdAt,
      })
      expect(receipt.visibility).toEqual({
        snapshotDigest: snapshot.snapshotDigest,
        pageCount,
      })
    }
    // The inventory is read at snapshot time only; each retrieval reads its
    // own returned result, never the remaining visible pages.
    expect(textReads).toBe(afterSnapshot + retrievals * readsPerPage)
  })

  it('omits absent optional identities instead of persisting undefined', () => {
    const receipt = retrieval({
      actorId: undefined,
      profileDigest: undefined,
      executionRef: undefined,
      evidenceRefs: [],
      attributes: {},
    })

    expect(Object.hasOwn(receipt, 'actorId')).toBe(false)
    expect(Object.hasOwn(receipt, 'profileDigest')).toBe(false)
    expect(Object.hasOwn(receipt, 'executionRef')).toBe(false)
    expect(verifyKnowledgeRetrievalReceipt(receipt)).toBe(receipt)
  })

  it('refuses a result absent from the visibility snapshot', () => {
    const data = fixture()
    const fabricated = page({ id: 'fabricated' })

    expect(() =>
      retrieval({
        results: [
          {
            ...data.results[0]!,
            page: fabricated,
          },
        ],
      }),
    ).toThrow(/was not visible/)
  })

  it('refuses page mutation between visibility and retrieval result materialization', () => {
    const data = fixture()
    const mutatedResult = {
      ...data.results[0]!,
      page: { ...data.inherited, text: 'Changed after the visible snapshot was captured.' },
    }

    expect(() =>
      createKnowledgeRetrievalReceipt({
        runId: 'run-child',
        query: 'obstruction',
        retriever: {
          id: 'fixture',
          version: '1',
          configDigest: canonicalCandidateDigest({ fixture: true }),
        },
        visibility: createKnowledgeVisibilitySnapshot(data.visiblePages),
        results: [mutatedResult],
        createdAt,
      }),
    ).toThrow(/does not match its visibility snapshot/)
  })

  it('refuses duplicate, gapped, non-finite, or out-of-range result rows', () => {
    const data = fixture()
    expect(() =>
      retrieval({ results: [data.results[0]!, { ...data.results[1]!, rank: 1 }] }),
    ).toThrow(/repeats rank 1/)
    expect(() => retrieval({ results: [{ ...data.results[0]!, rank: 2 }] })).toThrow(
      /contiguous from 1/,
    )
    expect(() => retrieval({ results: [{ ...data.results[0]!, rrfScore: Number.NaN }] })).toThrow(
      /rrfScore must be a finite number/,
    )
    expect(() => retrieval({ results: [{ ...data.results[0]!, normalizedScore: 1.1 }] })).toThrow(
      /must be in \[0,1\]/,
    )
  })

  it('detects receipt, visibility-reference, and post-retrieval visibility mutations', () => {
    const receipt = retrieval()
    const changedQuery = { ...receipt, query: 'forged query' }
    expect(() => verifyKnowledgeRetrievalReceipt(changedQuery)).toThrow(/receipt digest mismatch/)

    const inflatedCount = {
      ...receipt,
      visibility: { ...receipt.visibility, pageCount: 99 },
    }
    expect(() => verifyKnowledgeRetrievalReceipt(inflatedCount)).toThrow(/receipt digest mismatch/)

    const truncatedCount = {
      ...receipt,
      visibility: { ...receipt.visibility, pageCount: 1 },
    }
    expect(() => verifyKnowledgeRetrievalReceipt(truncatedCount)).toThrow(
      /returns 2 results from 1 visible pages/,
    )

    const { visiblePages } = fixture()
    visiblePages[1]!.page.text = 'The cited page changed after retrieval.'
    expect(() => assertKnowledgeRetrievalMatchesVisibility(receipt, visiblePages)).toThrow(
      /does not match the supplied visibility snapshot/,
    )
  })

  it('cannot verify against a snapshot with the same page ids but different bytes', () => {
    const receipt = retrieval()
    expect(verifyKnowledgeRetrievalReceipt(receipt)).toBe(receipt)

    const changed = fixture()
    changed.inherited.text = 'Same id and path, different bytes.'
    const changedSnapshot = createKnowledgeVisibilitySnapshot([
      { page: changed.current, origin: 'here' },
      { page: changed.inherited, origin: 'inherited:run-parent' },
      { page: changed.shared, origin: 'shared' },
    ])
    expect(changedSnapshot.entries.map((entry) => entry.pageId)).toEqual(
      createKnowledgeVisibilitySnapshot(fixture().visiblePages).entries.map(
        (entry) => entry.pageId,
      ),
    )
    expect(() => assertKnowledgeRetrievalMatchesVisibility(receipt, changedSnapshot)).toThrow(
      /does not match the supplied visibility snapshot/,
    )
  })

  it('refuses nested attribute values that cannot enter the canonical receipt', () => {
    expect(() => retrieval({ attributes: { nested: { invalid: true } } as never })).toThrow(
      /unsupported value/,
    )
  })
})

describe('knowledge visibility artifacts', () => {
  function storedFixture() {
    const data = fixture()
    const snapshot = createKnowledgeVisibilitySnapshot(data.visiblePages)
    const bytes = encodeKnowledgeVisibilitySnapshot(snapshot)
    const artifact = knowledgeVisibilityArtifactRef({
      uri: 'artifact://run-child/visibility.json',
      bytes,
    })
    const receipt = retrieval({ visibility: snapshot, visibilityArtifact: artifact })
    return { snapshot, bytes, artifact, receipt }
  }

  it('round-trips snapshot bytes and proves the join through the stored artifact', async () => {
    const { snapshot, bytes, artifact, receipt } = storedFixture()
    expect(receipt.visibility.artifact).toEqual({
      uri: 'artifact://run-child/visibility.json',
      digest: sha256Bytes(bytes),
      byteLength: bytes.byteLength,
    })

    const loaded = await assertKnowledgeRetrievalMatchesVisibilityArtifact(receipt, (ref) => {
      expect(ref).toEqual(artifact)
      return bytes
    })
    expect(loaded.snapshotDigest).toBe(snapshot.snapshotDigest)
  })

  it('reports a missing artifact as explicit unavailable evidence, never as empty', async () => {
    const { receipt } = storedFixture()
    const missing = await assertKnowledgeRetrievalMatchesVisibilityArtifact(
      receipt,
      () => undefined,
    ).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(missing).toBeInstanceOf(KnowledgeVisibilityUnavailableError)
    expect((missing as KnowledgeVisibilityUnavailableError).reason).toBe('missing')
    expect((missing as KnowledgeVisibilityUnavailableError).uri).toBe(
      'artifact://run-child/visibility.json',
    )
    expect((missing as KnowledgeVisibilityUnavailableError).snapshotDigest).toBe(
      receipt.visibility.snapshotDigest,
    )
  })

  it('reports a loader failure and a receipt without an artifact reference', async () => {
    const { receipt } = storedFixture()
    const failed = await assertKnowledgeRetrievalMatchesVisibilityArtifact(receipt, () => {
      throw new Error('store offline')
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failed).toBeInstanceOf(KnowledgeVisibilityUnavailableError)
    expect((failed as KnowledgeVisibilityUnavailableError).reason).toBe('load-failed')
    expect(((failed as KnowledgeVisibilityUnavailableError).cause as Error).message).toBe(
      'store offline',
    )

    const bare = retrieval()
    const unreferenced = await assertKnowledgeRetrievalMatchesVisibilityArtifact(bare, () => {
      throw new Error('never called')
    }).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(unreferenced).toBeInstanceOf(KnowledgeVisibilityUnavailableError)
    expect((unreferenced as KnowledgeVisibilityUnavailableError).reason).toBe(
      'no-artifact-reference',
    )
  })

  it('refuses stored bytes that do not match the reference or the receipt', async () => {
    const { bytes, receipt } = storedFixture()

    const flipped = new Uint8Array(bytes)
    flipped[flipped.length - 2] = flipped[flipped.length - 2] === 32 ? 33 : 32
    await expect(
      assertKnowledgeRetrievalMatchesVisibilityArtifact(receipt, () => flipped),
    ).rejects.toThrow(/digest mismatch/)

    await expect(
      assertKnowledgeRetrievalMatchesVisibilityArtifact(receipt, () => bytes.slice(0, -1)),
    ).rejects.toThrow(/byteLength mismatch/)

    const other = fixture()
    other.inherited.text = 'Different snapshot with the same page ids.'
    const otherBytes = encodeKnowledgeVisibilitySnapshot(
      createKnowledgeVisibilitySnapshot([
        { page: other.current, origin: 'here' },
        { page: other.inherited, origin: 'inherited:run-parent' },
        { page: other.shared, origin: 'shared' },
      ]),
    )
    const mismatched = retrieval({
      visibilityArtifact: knowledgeVisibilityArtifactRef({
        uri: 'artifact://run-child/visibility.json',
        bytes: otherBytes,
      }),
    })
    await expect(
      assertKnowledgeRetrievalMatchesVisibilityArtifact(mismatched, () => otherBytes),
    ).rejects.toThrow(/holds snapshot/)
  })
})

describe('knowledge use receipts', () => {
  it('binds one returned rank to a downstream artifact and its evidence', () => {
    const source = retrieval()
    const use = createKnowledgeUseReceipt({
      retrieval: source,
      selectedRank: 1,
      relation: 'extends',
      consumer: {
        kind: 'artifact',
        uri: 'artifact://run-child/decision.md',
        digest: canonicalCandidateDigest({ artifact: 'decision-v1' }),
      },
      evidenceRefs: [{ kind: 'span', uri: 'trace://run-child/span/use-1' }],
      attributes: { statement: 'Used the parent obstruction to define the next experiment.' },
      createdAt: '2026-08-17T12:05:00.000Z',
    })

    expect(verifyKnowledgeUseReceipt(use, source)).toBe(use)
    expect(use).toMatchObject({
      kind: 'knowledge-use',
      runId: 'run-child',
      retrievalReceiptDigest: source.receiptDigest,
      relation: 'extends',
      used: {
        rank: 1,
        pageId: 'parent-result',
        origin: 'inherited:run-parent',
      },
      consumer: { kind: 'artifact', uri: 'artifact://run-child/decision.md' },
    })
    expect(use.receiptDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(Object.isFrozen(use)).toBe(true)
    expect(Object.isFrozen(use.used)).toBe(true)
  })

  it('refuses a rank the retrieval never returned', () => {
    expect(() =>
      createKnowledgeUseReceipt({
        retrieval: retrieval(),
        selectedRank: 3,
        relation: 'background',
        consumer: { kind: 'decision', uri: 'decision://run-child/next' },
        createdAt,
      }),
    ).toThrow(/was not returned/)
  })

  it('refuses verification against a different retrieval receipt', () => {
    const original = retrieval()
    const use = createKnowledgeUseReceipt({
      retrieval: original,
      selectedRank: 1,
      relation: 'supports',
      consumer: { kind: 'decision', uri: 'decision://run-child/next' },
      createdAt,
    })
    const different = retrieval({ query: 'another query' })

    expect(() => verifyKnowledgeUseReceipt(use, different)).toThrow(/different retrieval receipt/)
  })

  it('detects selected-page, relation, and consumer mutation', () => {
    const source = retrieval()
    const use = createKnowledgeUseReceipt({
      retrieval: source,
      selectedRank: 1,
      relation: 'supports',
      consumer: { kind: 'candidate', uri: 'candidate://profile/1' },
      createdAt,
    })

    expect(() =>
      verifyKnowledgeUseReceipt(
        { ...use, used: { ...use.used, pageDigest: canonicalCandidateDigest({ forged: true }) } },
        source,
      ),
    ).toThrow(/selected result does not match/)
    expect(() => verifyKnowledgeUseReceipt({ ...use, relation: 'extends' }, source)).toThrow(
      /receipt digest mismatch/,
    )
    expect(() =>
      verifyKnowledgeUseReceipt(
        { ...use, consumer: { ...use.consumer, uri: 'candidate://profile/forged' } },
        source,
      ),
    ).toThrow(/receipt digest mismatch/)
  })
})
