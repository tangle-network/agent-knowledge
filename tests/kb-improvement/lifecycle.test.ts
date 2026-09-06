import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  RagGapFinding,
  RagKnowledgeAcquisitionInput,
  RagKnowledgeUpdateInput,
} from '../../src/index'
import {
  improveTestKnowledgeBase as improveKnowledgeBase,
  passingMetric,
  withKb,
} from '../support/kb-improvement'
import { testExecutionRef } from '../support/optimization'

describe('knowledge candidate learning state', () => {
  it.each(['gap-diagnosis', 'answer-quality'] as const)(
    'rejects disabled required phase %s before candidate work',
    async (phase) => {
      await withKb(async (root) => {
        let updates = 0
        await expect(
          improveKnowledgeBase({
            root,
            runId: 'disabled-required-phase',
            goal: 'Require every configured phase',
            enabledPhases: [],
            requiredPhases: [phase],
            updateKnowledge: () => {
              updates += 1
              return { applied: false, summary: 'Must not run.' }
            },
          }),
        ).rejects.toThrow(`required phase ${phase} is not enabled`)
        expect(updates).toBe(0)
      })
    },
  )

  it('carries diagnosis and update results through development into final measurement', async () => {
    await withKb(async (root) => {
      const calls: string[] = []
      const findings: RagGapFinding[] = [
        {
          id: 'policy-gap',
          kind: 'missing-source',
          severity: 'warning',
          message: 'Missing policy.',
        },
      ]
      const finalFinding: RagGapFinding = {
        id: 'answer-observation',
        kind: 'unknown',
        severity: 'info',
        message: 'Final answer observed.',
      }
      const acquisition = { notes: 'Read the policy source.', done: true }
      const update = { applied: true, summary: 'Updated the policy page.' }
      let acquisitionInput: RagKnowledgeAcquisitionInput | undefined
      let updateInput: RagKnowledgeUpdateInput | undefined
      const result = await improveKnowledgeBase({
        root,
        runId: 'shared-learning-state',
        goal: 'Improve answers using diagnosed policy gaps',
        answerQualityCostCeiling: 0,
        enabledPhases: [
          'gap-diagnosis',
          'knowledge-acquisition',
          'knowledge-update',
          'answer-quality',
          'promotion',
        ],
        diagnose(input) {
          calls.push('diagnose')
          expect(input.optimization).toBeUndefined()
          expect(input.retrieval).toBeUndefined()
          return findings
        },
        acquireKnowledge(input) {
          calls.push('acquire')
          acquisitionInput = input
          expect(input.findings).toEqual(findings)
          return acquisition
        },
        async updateKnowledge(input) {
          calls.push('update')
          updateInput = input
          expect(input.findings).toEqual(findings)
          expect(input.acquisition).toEqual(acquisition)
          await writeFile(join(input.candidateRoot, 'knowledge', 'policy.md'), '# Policy\n')
          return update
        },
        evaluateDevelopment({ lifecycle }) {
          calls.push('development')
          expect(lifecycle?.findings).toEqual(findings)
          expect(lifecycle?.knowledgeUpdate).toEqual(update)
          expect(lifecycle?.answerQuality).toBeUndefined()
          return passingMetric()
        },
        evaluateAnswers(input) {
          calls.push('answers')
          expect(input.findings).toEqual(findings)
          expect(input.acquisition).toEqual(acquisition)
          expect(input.knowledgeUpdate).toEqual(update)
          expect(input.phases.map((phase) => phase.phase)).toEqual([
            'gap-diagnosis',
            'knowledge-acquisition',
            'knowledge-update',
          ])
          return {
            passed: true,
            metrics: { quality: 0.4 },
            finalScenarioIds: ['policy-final-a', 'policy-final-b'],
            datasetRef: testExecutionRef('shared-state-final-data'),
            evaluatorRef: testExecutionRef('shared-state-final-evaluator'),
            cost: { totalCostUsd: 0, accountingComplete: true, incompleteReasons: [] },
            findings: [finalFinding],
          }
        },
        decidePromotion(input) {
          calls.push('promotion')
          expect(input.findings).toEqual([...findings, finalFinding])
          expect(input.acquisition).toEqual(acquisition)
          expect(input.knowledgeUpdate).toEqual(update)
          expect(input.answerQuality?.metrics).toEqual({ quality: 0.4 })
          return { promoted: true, reason: 'Configured answer checks passed.' }
        },
      })

      expect(calls).toEqual([
        'diagnose',
        'acquire',
        'update',
        'development',
        'answers',
        'promotion',
      ])
      expect(acquisitionInput?.findings).toEqual(findings)
      expect(updateInput?.findings).toEqual(findings)
      expect(updateInput?.phases.some((phase) => phase.phase === 'answer-quality')).toBe(false)
      expect(result.lifecycle?.findings).toEqual([...findings, finalFinding])
      expect(result.evaluation?.dimensions).toEqual({
        validation: 1,
        kb_quality: 1,
        answer_quality: 0.4,
        promotion_decision: 1,
      })
      expect(result.evaluation?.score).toBeCloseTo(0.85)
      expect(result.evaluation?.notes).not.toContain('no task outcome evaluation')
      expect(result.promoted).toBe(false)
      expect(result.state.status).toBe('candidate-ready')
    })
  })

  it('runs diagnosis without consuming final cases or reporting unmeasured checks', async () => {
    await withKb(async (root) => {
      let diagnoses = 0
      const result = await improveKnowledgeBase({
        root,
        runId: 'diagnosis-only',
        goal: 'Inspect existing knowledge',
        enabledPhases: ['gap-diagnosis'],
        requiredPhases: ['gap-diagnosis'],
        diagnose: () => {
          diagnoses += 1
          return []
        },
        evaluateAnswers: () => {
          throw new Error('disabled answer evaluation must not run')
        },
      })

      expect(diagnoses).toBe(1)
      expect(result.lifecycle?.phases.map((phase) => phase.phase)).toEqual(['gap-diagnosis'])
      expect(result.candidate?.finalEvaluationStartedAt).toBeUndefined()
      expect(result.candidate?.candidateHash).toBe(result.candidate?.baseHash)
      expect(result.evaluation).toMatchObject({
        score: 1,
        passed: true,
        provenance: { version: '2', method: 'deterministic' },
      })
      expect(result.evaluation?.dimensions).toEqual({ validation: 1, kb_quality: 1 })
      expect(result.evaluation?.notes).toContain(
        'structural checks only; no task outcome evaluation was performed',
      )
      expect(result.promoted).toBe(false)
      expect(result.state.status).toBe('candidate-ready')
    })
  })
})
