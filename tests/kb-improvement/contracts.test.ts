import { describe, expect, it } from 'vitest'
import {
  type KnowledgeImprovementActivationRecord,
  knowledgeImprovementActivationRecordSchema,
} from '../../src/kb-improvement/contracts'

const digest = (character: string) => character.repeat(64)

function activationRecord(): KnowledgeImprovementActivationRecord {
  return {
    kind: 'knowledge-improvement-activation-result',
    candidateId: 'candidate-1',
    mutation: {
      target: 'candidate',
      beforeHash: digest('a'),
      afterHash: digest('b'),
      changed: false,
      transactionId: null,
      recovered: false,
    },
    result: {
      kind: 'agent-improvement-activation-result',
      idempotencyKey: `sha256:${digest('c')}`,
      attemptedAt: '2026-08-31T00:00:00.000Z',
      completedAt: '2026-08-31T00:00:00.000Z',
      outcome: { status: 'expired' },
      digest: `sha256:${digest('d')}`,
    },
  }
}

describe('knowledgeImprovementActivationRecordSchema', () => {
  it('keeps the explicit public record type aligned with runtime parsing', () => {
    const record = activationRecord()
    expect(knowledgeImprovementActivationRecordSchema.parse(record)).toEqual(record)
  })

  it.each(['../candidate', 'candidate\\child', 'candidate\u0000child'])(
    'rejects a non-portable candidate path: %s',
    (candidateId) => {
      expect(() =>
        knowledgeImprovementActivationRecordSchema.parse({
          ...activationRecord(),
          candidateId,
        }),
      ).toThrow()
    },
  )
})
