import { describe, expect, it } from 'vitest'
import {
  type AttemptRecord,
  createDataCreationLoop,
  discriminativeAcceptRule,
  qualityCheck,
} from './data-creation-loop'
import {
  baseInstruction,
  buildRubricJudge,
  challengerClient,
  groundingDoc,
  solverClient,
} from './offline-fixtures'
import { parseDataExample } from './router-roles'

describe('discriminativeAcceptRule (the new piece)', () => {
  it('accepts an example that separates strong from weak', () => {
    const d = discriminativeAcceptRule({ strongScore: 0.77, weakScore: 0.46 })
    expect(d.accept).toBe(true)
    expect(d.reason).toContain('discriminates')
  })

  it('rejects "too easy" when the weak solver passes', () => {
    const d = discriminativeAcceptRule({ strongScore: 0.86, weakScore: 0.84 })
    expect(d.accept).toBe(false)
    expect(d.reason).toContain('too easy')
  })

  it('rejects "too hard" when even the strong solver misses', () => {
    const d = discriminativeAcceptRule({ strongScore: 0.55, weakScore: 0.3 })
    expect(d.accept).toBe(false)
    expect(d.reason).toContain('too hard')
  })

  it('rejects when the gap is below minGap even if both thresholds hold', () => {
    const d = discriminativeAcceptRule({ strongScore: 0.66, weakScore: 0.48 })
    expect(d.accept).toBe(false)
    expect(d.reason).toContain('not discriminative')
  })

  it('honors custom thresholds', () => {
    const strict = discriminativeAcceptRule({ strongScore: 0.77, weakScore: 0.46, minGap: 0.4 })
    expect(strict.accept).toBe(false)
  })
})

describe('qualityCheck', () => {
  it('rejects a reference that leaks verbatim into the context', () => {
    const q = qualityCheck({
      context: 'The answer is 42 and nothing else matters.',
      question: 'What is the answer?',
      reference: 'The answer is 42',
      rubric: ['a', 'b'],
    })
    expect(q.ok).toBe(false)
    expect(q.reason).toContain('leaked')
  })

  it('rejects a thin rubric', () => {
    const q = qualityCheck({ context: 'c', question: 'q', reference: 'r', rubric: ['only one'] })
    expect(q.ok).toBe(false)
    expect(q.reason).toContain('thin rubric')
  })

  it('passes a clean example', () => {
    const q = qualityCheck({
      context: 'Some grounding context that does not contain the answer phrasing.',
      question: 'Why does it matter?',
      reference: 'Because of a distinct reasoning chain.',
      rubric: ['states X', 'explains Y'],
    })
    expect(q.ok).toBe(true)
  })
})

describe('parseDataExample (challenger JSON parsing)', () => {
  it('parses a bare JSON object', () => {
    const ex = parseDataExample('{"context":"c","question":"q","reference":"r","rubric":["a","b"]}')
    expect(ex.question).toBe('q')
    expect(ex.rubric).toHaveLength(2)
  })

  it('parses JSON wrapped in a ```json fence with surrounding prose', () => {
    const ex = parseDataExample(
      'Sure, here is the example:\n```json\n{"context":"c","question":"q","reference":"r","rubric":["a","b"]}\n```\nDone.',
    )
    expect(ex.reference).toBe('r')
  })

  it('throws loud when no JSON object is present', () => {
    expect(() => parseDataExample('no json here')).toThrow()
  })

  it('throws loud when a required field is missing', () => {
    expect(() => parseDataExample('{"context":"c","question":"q"}')).toThrow()
  })
})

describe('createDataCreationLoop (offline)', () => {
  it('manufactures discriminating examples and separates plain from agentic gaps', async () => {
    const result = await createDataCreationLoop({
      doc: groundingDoc,
      baseInstruction,
      challenger: challengerClient(),
      weakSolver: solverClient('weak'),
      strongSolver: solverClient('strong'),
      judge: buildRubricJudge(),
      target: 2,
      samples: 3,
      maxRetries: 4,
    })

    expect(result.accepted).toHaveLength(2)
    for (const ex of result.accepted) {
      expect(ex.decision.accept).toBe(true)
      expect(ex.gap).toBeGreaterThanOrEqual(0.2)
    }

    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    const plain = mean(result.plainGaps)
    const agentic = mean(result.agenticGaps)
    expect(plain).toBeLessThan(0.1)
    expect(agentic).toBeGreaterThan(0.25)
    expect(agentic - plain).toBeGreaterThanOrEqual(0.15)

    const stored = await result.corpus.query({ area: 'training-data' })
    expect(stored).toHaveLength(2)
    expect(result.cost.summary().totalCostUsd).toBeGreaterThan(0)
  })

  it('emits a per-attempt record (with both solvers’ answers) for every candidate, accepted or rejected', async () => {
    const attempts: AttemptRecord[] = []
    const result = await createDataCreationLoop({
      doc: groundingDoc,
      baseInstruction,
      challenger: challengerClient(),
      weakSolver: solverClient('weak'),
      strongSolver: solverClient('strong'),
      judge: buildRubricJudge(),
      target: 1,
      samples: 3,
      maxRetries: 4,
      onAttempt: (rec) => {
        attempts.push(rec)
      },
    })

    // The first slot's first draft is the EASY example (rejected "too easy"), then the fold steers
    // to a HARD example (accepted) — so we observe at least one reject AND one accept.
    expect(attempts.length).toBeGreaterThanOrEqual(2)
    const rejected = attempts.filter((a) => !a.decision.accept)
    const accepted = attempts.filter((a) => a.decision.accept)
    expect(rejected.length).toBeGreaterThanOrEqual(1)
    expect(accepted.length).toBeGreaterThanOrEqual(1)
    expect(result.accepted).toHaveLength(1)

    // Every emitted attempt carries the raw answers + scores the autopsy needs.
    for (const a of attempts) {
      expect(a.weak.samples).toHaveLength(3)
      expect(a.strong.samples).toHaveLength(3)
      expect(typeof a.weak.samples[0]?.answer).toBe('string')
      expect(a.gap).toBeCloseTo(a.strong.mean - a.weak.mean, 6)
    }

    // The first attempt (iteration 0) is the plain draft and should NOT discriminate; a later
    // attempt should — the fold widened the gap.
    const plain = attempts.find((a) => a.iteration === 0)
    expect(plain?.decision.accept).toBe(false)
    expect(Math.max(...attempts.map((a) => a.gap))).toBeGreaterThan(plain?.gap ?? 0)
  })
})
