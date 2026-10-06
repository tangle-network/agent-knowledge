import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  ResearchClaimEvidence,
  ResearchClaimLedger,
  ResearchClaimRecord,
  ResearchSourceVersion,
} from '../src/index'
import {
  ClaimLedgerGoalConflictError,
  ClaimLedgerMigrationRequiredError,
  claimEvidenceId,
  claimId,
  createKnowledgeEvent,
  DeepQuestionSchema,
  deepQuestionId,
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
  sha256,
  textSourceId,
  writeFileDurable,
  writeJsonDurableWithinRoot,
  writeKnowledgeIndex,
} from '../src/index'

const GOAL = 'self-speculative decoding'

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agent-knowledge-claims-'))
  try {
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

// ===========================================================================
// Claims must survive the process that discovered them.
// ===========================================================================

describe('research claim ledger — persistence', () => {
  it('rejects a ledger id that would escape its directory', async () => {
    const store = new MemoryKbStore()
    for (const ledgerId of ['../escape', 'nested/id', '..', '.', '', 'a\0b']) {
      await expect(store.getClaimLedger(ledgerId)).rejects.toThrow(/claim ledger id/)
    }
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
})

// ===========================================================================
// durable-fs is reachable, and still refuses to be redirected.
// ===========================================================================

describe('durable-fs on the package entrypoint', () => {
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
