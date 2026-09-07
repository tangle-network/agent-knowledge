import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertKnowledgeMutationPath } from '../../src/file-transaction'
import {
  createKnowledgeEvent,
  FileSystemKbStore,
  hashKnowledgeBase,
  improveSelectedKnowledgeCandidate,
  knowledgeImprovementCandidateRef,
  promoteKnowledgeCandidate,
  restoreKnowledgeCandidateBaseline,
  withKnowledgeImprovementCandidate,
  withKnowledgeImprovementComparison,
} from '../../src/index'
import {
  improveTestKnowledgeBase,
  passingMetric,
  TEST_KNOWLEDGE_IMPLEMENTATION_REF,
  withKb,
} from '../support/kb-improvement'

const stateScope = { pagesDirectory: 'kb/pages', researchState: true }
const ledgerPath = '.agent-knowledge/claim-ledgers/episode.json'

async function recordResearch(root: string, rounds: number) {
  const store = new FileSystemKbStore({ root })
  await store.putClaimLedger({
    schemaVersion: 2,
    id: 'episode',
    goal: 'Learn retry policy',
    updatedAt: '2026-09-07T00:00:00.000Z',
    rounds,
    claimEvidence: [],
    registeredSources: [],
    claims: [],
    questions: [],
  })
  await store.putEvent(
    createKnowledgeEvent({
      type: 'research.iteration',
      metadata: { rounds },
      now: () => new Date('2026-09-07T00:00:00.000Z'),
    }),
  )
}

async function prepare(root: string) {
  await mkdir(join(root, 'kb/pages'), { recursive: true })
  await writeFile(join(root, 'kb/pages/retry.md'), '---\nid: retry\n---\nRetry three times.\n')
  await recordResearch(root, 1)
}

const readRounds = async (root: string) =>
  (await new FileSystemKbStore({ root }).getClaimLedger('episode'))?.rounds

describe('declared candidate state', () => {
  it('uses the declared pages directory in the maintained research writer and evaluator', async () => {
    await withKb(async (root) => {
      const scope = { pagesDirectory: 'kb/pages.json' }
      const result = await improveTestKnowledgeBase({
        root,
        goal: 'Learn custom-layout retry policy',
        stateScope: scope,
        step: () => ({
          done: true,
          proposalText:
            '---FILE: kb/pages.json/retry.md---\n---\nid: retry\n---\nRetry three times.\n---END FILE---',
        }),
        evaluate: ({ candidateIndex }) => {
          expect(candidateIndex.pages.map((page) => page.id)).toEqual(['retry'])
          return passingMetric()
        },
      })
      await promoteKnowledgeCandidate({ root, candidate: knowledgeImprovementCandidateRef(result) })
      expect(await readFile(join(root, 'kb/pages.json/retry.md'), 'utf8')).toContain('three')
    })
  })

  it('binds declared state and scope while excluding caches and unrelated files from default identity', async () => {
    await withKb(async (root) => {
      await prepare(root)
      const baseline = await hashKnowledgeBase(root)
      const declared = await hashKnowledgeBase(root, stateScope)
      await recordResearch(root, 2)
      expect(await hashKnowledgeBase(root)).toBe(baseline)
      expect(await hashKnowledgeBase(root, stateScope)).not.toBe(declared)
      const changed = await hashKnowledgeBase(root, stateScope)
      await writeFile(join(root, '.agent-knowledge/index.json'), '{}')
      await writeFile(join(root, '.env'), 'TOKEN=not-a-real-secret')
      expect(await hashKnowledgeBase(root, stateScope)).toBe(changed)
      expect(await hashKnowledgeBase(root, { pagesDirectory: 'kb/pages' })).not.toBe(changed)
      await writeFile(join(root, 'kb/pages/retry.md'), 'Retry five times.')
      expect(await hashKnowledgeBase(root, stateScope)).not.toBe(changed)
    })
  })

  it('isolates siblings, resumes exact state, and promotes and restores declared research and custom pages', async () => {
    await withKb(async (root) => {
      await prepare(root)
      const baseline = await hashKnowledgeBase(root, stateScope)
      let updates = 0
      const options = {
        root,
        goal: 'Learn retry policy',
        stateScope,
        async updateKnowledge({ candidateRoot }: { candidateRoot: string }) {
          updates++
          expect(await readRounds(candidateRoot)).toBe(1)
          await recordResearch(candidateRoot, 2)
          await writeFile(
            join(candidateRoot, 'kb/pages/retry.md'),
            '---\nid: retry\n---\nRetry five times.\n',
          )
          return { applied: true, summary: 'Updated retry evidence' }
        },
        evaluate: passingMetric,
      }
      const first = await improveTestKnowledgeBase({ ...options, runId: 'first' })
      const sibling = await improveTestKnowledgeBase({ ...options, runId: 'sibling' })
      expect(await hashKnowledgeBase(root, stateScope)).toBe(baseline)
      expect(await readRounds(root)).toBe(1)
      const resumed = await improveTestKnowledgeBase({ ...options, runId: 'first' })
      expect(updates).toBe(2)
      expect(knowledgeImprovementCandidateRef(resumed)).toEqual(
        knowledgeImprovementCandidateRef(first),
      )
      await expect(
        improveTestKnowledgeBase({ ...options, runId: 'first', stateScope: {} }),
      ).rejects.toThrow('stateScope')
      const reference = knowledgeImprovementCandidateRef(first)
      await expect(
        withKnowledgeImprovementCandidate(
          { root, candidate: reference },
          async ({ root: isolated }) => {
            await recordResearch(isolated, 99)
          },
        ),
      ).rejects.toThrow('snapshot changed during use')
      await withKnowledgeImprovementComparison(
        { root, candidate: knowledgeImprovementCandidateRef(sibling) },
        async (comparison) => {
          expect(comparison.stateScope).toEqual(stateScope)
          expect(await readRounds(comparison.baseline.root)).toBe(1)
          expect(await readRounds(comparison.candidate.root)).toBe(2)
        },
      )
      await expect(
        promoteKnowledgeCandidate({
          root,
          candidate: reference,
          onState() {
            throw new Error('interrupted after durable promotion state')
          },
        }),
      ).rejects.toThrow('interrupted after durable promotion state')
      await promoteKnowledgeCandidate({ root, candidate: reference })
      expect(await hashKnowledgeBase(root, stateScope)).toBe(reference.candidateHash)
      expect(await readRounds(root)).toBe(2)
      expect(await readFile(join(root, 'kb/pages/retry.md'), 'utf8')).toContain('five')
      await restoreKnowledgeCandidateBaseline({ root, candidate: reference })
      expect(await hashKnowledgeBase(root, stateScope)).toBe(baseline)
      expect(await readRounds(root)).toBe(1)
    })
  })

  it('remeasures selected custom pages and research records using the source scope', async () => {
    await withKb(async (root) => {
      await prepare(root)
      const result = await improveTestKnowledgeBase({
        root,
        goal: 'Learn retry policy',
        stateScope,
        async updateKnowledge({ candidateRoot }) {
          await recordResearch(candidateRoot, 2)
          return { applied: true, summary: 'Second research round' }
        },
        evaluate: passingMetric,
      })
      const selected = await improveSelectedKnowledgeCandidate({
        root,
        goal: 'Select the claim state',
        implementationRef: TEST_KNOWLEDGE_IMPLEMENTATION_REF,
        sourceCandidate: knowledgeImprovementCandidateRef(result),
        selectedPaths: [ledgerPath],
        evaluate: passingMetric,
      })
      const reference = knowledgeImprovementCandidateRef(selected)
      await promoteKnowledgeCandidate({ root, candidate: reference })
      expect(await readRounds(root)).toBe(2)
      expect(await new FileSystemKbStore({ root }).listEvents()).toHaveLength(1)
    })
  })

  it('requires explicit research permission and rejects credentials and derived state in transaction paths', () => {
    expect(() => assertKnowledgeMutationPath(ledgerPath, 'kb/pages')).toThrow('unsupported')
    expect(assertKnowledgeMutationPath(ledgerPath, 'kb/pages', true)).toBe(ledgerPath)
    for (const path of [
      '.env',
      '.agent-knowledge/index.json',
      '.agent-knowledge/mutation-epoch.json',
      '.agent-knowledge/claim-ledgers/../token.json',
    ]) {
      expect(() => assertKnowledgeMutationPath(path, 'kb/pages', true)).toThrow()
    }
  })
})
