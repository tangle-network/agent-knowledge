import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  hashKnowledgeBase,
  improveSelectedKnowledgeCandidate,
  knowledgeImprovementCandidateRef,
  knowledgeImprovementRunDir,
  promoteKnowledgeCandidate,
  withKnowledgeImprovementComparison,
} from '../../src/index'
import {
  improveTestKnowledgeBase as improveKnowledgeBase,
  passingMetric,
  TEST_KNOWLEDGE_IMPLEMENTATION_REF,
  withKb,
} from '../support/kb-improvement'

describe('improveSelectedKnowledgeCandidate', () => {
  it('remeasures the exact selected subset before ordinary promotion', async () => {
    await withKb(async (root) => {
      await writeFile(join(root, 'knowledge', 'original.md'), '# Original\n')
      const baseHash = await hashKnowledgeBase(root)
      const source = await improveKnowledgeBase({
        root,
        goal: 'Generate a broad candidate from which a measured subset will be selected',
        runId: 'broad-source-candidate',
        updateKnowledge: async ({ candidateRoot }) => {
          await writeFile(join(candidateRoot, 'knowledge', 'keep.md'), '# Keep\n')
          await writeFile(join(candidateRoot, 'knowledge', 'drop.md'), '# Drop\n')
          await writeFile(join(candidateRoot, 'knowledge', 'original.md'), '# Changed\n')
          return { applied: true, summary: 'created a three-file broad candidate' }
        },
        evaluate: passingMetric,
      })
      const sourceCandidate = knowledgeImprovementCandidateRef(source)
      let evaluatedSelectedSnapshot = false
      let diagnosisCalls = 0

      const selected = await improveSelectedKnowledgeCandidate({
        root,
        goal: 'Measure only the useful files from the broad candidate',
        implementationRef: TEST_KNOWLEDGE_IMPLEMENTATION_REF,
        sourceCandidate,
        selectedPaths: ['knowledge/original.md', 'knowledge/keep.md'],
        rationale: 'The dropped page is redundant with an existing source.',
        selectionMetadata: { reviewer: 'test-reviewer', policyVersion: 1 },
        diagnose() {
          diagnosisCalls += 1
          return [
            {
              id: 'selected-gap',
              kind: 'unknown',
              severity: 'info',
              message: 'Inspect selected pages.',
            },
          ]
        },
        async evaluate(input) {
          expect(input.lifecycle?.findings.map((finding) => finding.id)).toEqual(['selected-gap'])
          expect(input.lifecycle?.knowledgeUpdate?.applied).toBe(true)
          expect(input.candidateRoot).not.toBe(input.baselineRoot)
          await expect(
            readFile(join(input.candidateRoot, 'knowledge', 'keep.md'), 'utf8'),
          ).resolves.toBe('# Keep\n')
          await expect(
            readFile(join(input.candidateRoot, 'knowledge', 'original.md'), 'utf8'),
          ).resolves.toBe('# Changed\n')
          await expect(
            readFile(join(input.candidateRoot, 'knowledge', 'drop.md'), 'utf8'),
          ).rejects.toMatchObject({ code: 'ENOENT' })
          evaluatedSelectedSnapshot = true
          return passingMetric()
        },
      })
      const candidate = knowledgeImprovementCandidateRef(selected)

      expect(evaluatedSelectedSnapshot).toBe(true)
      expect(diagnosisCalls).toBe(1)
      expect(candidate.baseHash).toBe(baseHash)
      expect(selected.selection).toMatchObject({
        kind: 'measured-knowledge-change-selection-receipt',
        sourceCandidate,
        selectedPaths: ['knowledge/keep.md', 'knowledge/original.md'],
        selectedCandidateHash: candidate.candidateHash,
        selectedPlanHash: candidate.promotionPlanHash,
        selectedEvidenceHash: candidate.evidenceHash,
      })

      await withKnowledgeImprovementComparison({ root, candidate }, async (comparison) => {
        await expect(
          readFile(join(comparison.candidate.root, 'knowledge', 'keep.md'), 'utf8'),
        ).resolves.toBe('# Keep\n')
        await expect(
          readFile(join(comparison.candidate.root, 'knowledge', 'drop.md'), 'utf8'),
        ).rejects.toMatchObject({ code: 'ENOENT' })
      })

      const promoted = await promoteKnowledgeCandidate({ root, candidate })
      expect(promoted).toMatchObject({ promoted: true, blocked: false })
      await expect(readFile(join(root, 'knowledge', 'keep.md'), 'utf8')).resolves.toBe('# Keep\n')
      await expect(readFile(join(root, 'knowledge', 'original.md'), 'utf8')).resolves.toBe(
        '# Changed\n',
      )
      await expect(readFile(join(root, 'knowledge', 'drop.md'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })

      const receiptPath = join(
        knowledgeImprovementRunDir(root, candidate.runId),
        'candidates',
        candidate.candidateId,
        'selection.json',
      )
      const storedReceipt = JSON.parse(await readFile(receiptPath, 'utf8'))
      expect(storedReceipt).toEqual(selected.selection)
    })
  })

  it('makes a harmful subset fail its own evaluator instead of inheriting the whole-candidate pass', async () => {
    await withKb(async (root) => {
      const source = await improveKnowledgeBase({
        root,
        goal: 'Create a whole candidate whose two pages work together',
        runId: 'whole-pair-source',
        updateKnowledge: async ({ candidateRoot }) => {
          await writeFile(join(candidateRoot, 'knowledge', 'claim.md'), '# Claim\nUses support.\n')
          await writeFile(join(candidateRoot, 'knowledge', 'support.md'), '# Support\nEvidence.\n')
          return { applied: true, summary: 'created claim and support pages' }
        },
        evaluate: passingMetric,
      })
      const sourceCandidate = knowledgeImprovementCandidateRef(source)

      const selected = await improveSelectedKnowledgeCandidate({
        root,
        goal: 'Test whether the claim page survives without its support page',
        implementationRef: TEST_KNOWLEDGE_IMPLEMENTATION_REF,
        sourceCandidate,
        selectedPaths: ['knowledge/claim.md'],
        async evaluate({ candidateRoot }) {
          try {
            await readFile(join(candidateRoot, 'knowledge', 'support.md'), 'utf8')
            return passingMetric()
          } catch {
            return {
              score: 0,
              passed: false,
              notes: 'claim is missing its supporting page',
              provenance: {
                evaluator: 'selected-candidate-dependency-check',
                version: '1',
                method: 'deterministic',
              },
            }
          }
        },
      })

      expect(selected.candidate).toMatchObject({ status: 'rejected' })
      expect(selected.evaluation).toMatchObject({ passed: false })
      expect(() => knowledgeImprovementCandidateRef(selected)).toThrow(/is not ready/)
      await expect(readFile(join(root, 'knowledge', 'claim.md'), 'utf8')).rejects.toMatchObject({
        code: 'ENOENT',
      })
    })
  })

  it('rejects unknown, repeated, and generated paths before opening a derived run', async () => {
    await withKb(async (root) => {
      const source = await improveKnowledgeBase({
        root,
        goal: 'Create one selectable page',
        runId: 'selection-shape-source',
        updateKnowledge: async ({ candidateRoot }) => {
          await writeFile(join(candidateRoot, 'knowledge', 'page.md'), '# Page\n')
          return { applied: true, summary: 'created one page' }
        },
        evaluate: passingMetric,
      })
      const sourceCandidate = knowledgeImprovementCandidateRef(source)
      const common = {
        root,
        goal: 'Refuse a malformed selection',
        implementationRef: TEST_KNOWLEDGE_IMPLEMENTATION_REF,
        sourceCandidate,
        evaluate: passingMetric,
      }

      await expect(
        improveSelectedKnowledgeCandidate({ ...common, selectedPaths: ['knowledge/missing.md'] }),
      ).rejects.toThrow(/not a changed source-candidate file/)
      await expect(
        improveSelectedKnowledgeCandidate({
          ...common,
          selectedPaths: ['knowledge/page.md', 'knowledge/page.md'],
        }),
      ).rejects.toThrow(/repeated/)
      await expect(
        improveSelectedKnowledgeCandidate({ ...common, selectedPaths: ['knowledge/index.md'] }),
      ).rejects.toThrow(/derived knowledge path/)
    })
  })

  it('reopens the same measured selection without rerunning its evaluator', async () => {
    await withKb(async (root) => {
      const source = await improveKnowledgeBase({
        root,
        goal: 'Create a resumable source candidate',
        runId: 'selected-resume-source',
        updateKnowledge: async ({ candidateRoot }) => {
          await writeFile(join(candidateRoot, 'knowledge', 'selected.md'), '# Selected\n')
          return { applied: true, summary: 'created selected page' }
        },
        evaluate: passingMetric,
      })
      let evaluationCalls = 0
      const options = {
        root,
        goal: 'Measure a stable selected candidate',
        runId: 'selected-resume-derived',
        implementationRef: TEST_KNOWLEDGE_IMPLEMENTATION_REF,
        sourceCandidate: knowledgeImprovementCandidateRef(source),
        selectedPaths: ['knowledge/selected.md'],
        evaluate() {
          evaluationCalls += 1
          return passingMetric()
        },
      }

      const first = await improveSelectedKnowledgeCandidate(options)
      expect(evaluationCalls).toBe(1)
      const second = await improveSelectedKnowledgeCandidate(options)

      expect(evaluationCalls).toBe(1)
      expect(second.selection).toEqual(first.selection)
      expect(knowledgeImprovementCandidateRef(second)).toEqual(
        knowledgeImprovementCandidateRef(first),
      )
    })
  })
})
