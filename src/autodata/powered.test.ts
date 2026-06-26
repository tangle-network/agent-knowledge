import { describe, expect, it } from 'vitest'
import type { AttemptRecord, SolverEval } from './data-creation-loop'
import { analyzeTrails, type DocTrail } from './powered'

// A minimal attempt-row factory: only the fields `analyzeTrails` reads matter.
function attempt(args: {
  slot: number
  iteration: number
  weak: number
  strong: number
  accept: boolean
  qualityOk?: boolean
}): AttemptRecord {
  const weak: SolverEval = { mean: args.weak, samples: [] }
  const strong: SolverEval = { mean: args.strong, samples: [] }
  const gap = args.strong - args.weak
  return {
    slotIndex: args.slot,
    iteration: args.iteration,
    example: { context: 'c', question: 'q', reference: 'r', rubric: ['a', 'b'] },
    weak,
    strong,
    gap,
    decision: { accept: args.accept, reason: args.accept ? 'discriminates' : 'rejected' },
    qualityOk: args.qualityOk ?? true,
  }
}

describe('analyzeTrails (powered aggregation)', () => {
  it('counts accept-rate per slot over the requested target, not the trailed slots', () => {
    // 3 slots requested, only 2 left a trail; slot 0 accepted, slot 1 rejected, slot 2 errored (no rows).
    const trail: DocTrail = {
      tag: 'd',
      url: 'u',
      target: 3,
      rows: [
        attempt({ slot: 0, iteration: 0, weak: 0.7, strong: 0.8, accept: false }),
        attempt({ slot: 0, iteration: 1, weak: 0.3, strong: 0.9, accept: true }),
        attempt({ slot: 1, iteration: 0, weak: 0.6, strong: 0.7, accept: false }),
      ],
    }
    const s = analyzeTrails([trail], { bootstrapSeed: 1 })
    expect(s.totalSlots).toBe(3) // denominator = requested target, not 2 trailed slots
    expect(s.acceptedSlots).toBe(1)
    expect(s.acceptRate.estimate).toBeCloseTo(1 / 3, 6)
    // Wilson lower bound is strictly above 0 and the point estimate sits inside the interval.
    expect(s.acceptRate.lower).toBeGreaterThan(0)
    expect(s.acceptRate.lower).toBeLessThan(s.acceptRate.estimate)
    expect(s.acceptRate.upper).toBeGreaterThan(s.acceptRate.estimate)
    // Slot 2 left no trail → counted as a challenger-stage failure, still in the denominator.
    expect(s.slotsWithAttempts).toBe(2)
    expect(s.challengerFailedSlots).toBe(1)
    // Among only producing slots the denominator is 2, so the rate is higher.
    expect(s.acceptRateAmongProducing.estimate).toBeCloseTo(0.5, 6)
  })

  it('takes the slot best-gap from quality-clean attempts and pairs plain→refined', () => {
    const trail: DocTrail = {
      tag: 'd',
      url: 'u',
      target: 1,
      rows: [
        attempt({ slot: 0, iteration: 0, weak: 0.7, strong: 0.8, accept: false }), // plain gap 0.10
        attempt({ slot: 0, iteration: 1, weak: 0.3, strong: 0.9, accept: true }), // refined gap 0.60
      ],
    }
    const s = analyzeTrails([trail], { bootstrapSeed: 1 })
    expect(s.bestGapPerSlot.max).toBeCloseTo(0.6, 6)
    expect(s.plainGap.median).toBeCloseTo(0.1, 6)
    // The fold widened the gap from 0.10 to 0.60 → a positive paired delta.
    expect(s.widening.meanDelta).toBeCloseTo(0.5, 6)
  })

  it('a leaky (quality-failed) draft contributes a 0 best-gap but is excluded from the condition decomposition', () => {
    const trail: DocTrail = {
      tag: 'd',
      url: 'u',
      target: 1,
      rows: [
        attempt({ slot: 0, iteration: 0, weak: 0, strong: 0, accept: false, qualityOk: false }),
      ],
    }
    const s = analyzeTrails([trail], { bootstrapSeed: 1 })
    expect(s.bestGapPerSlot.max).toBe(0)
    expect(s.conditions.nAttempts).toBe(0) // quality-failed attempt excluded
    expect(s.acceptedSlots).toBe(0)
  })

  it('decomposes the accept rule: the binding gate is weak < 0.5', () => {
    // All attempts have strong high + gap wide, but weak only struggles half the time.
    const trail: DocTrail = {
      tag: 'd',
      url: 'u',
      target: 4,
      rows: [
        attempt({ slot: 0, iteration: 0, weak: 0.2, strong: 0.9, accept: true }),
        attempt({ slot: 1, iteration: 0, weak: 0.7, strong: 0.95, accept: false }), // weak too competent
        attempt({ slot: 2, iteration: 0, weak: 0.1, strong: 0.85, accept: true }),
        attempt({ slot: 3, iteration: 0, weak: 0.75, strong: 0.98, accept: false }), // weak too competent
      ],
    }
    const s = analyzeTrails([trail], { bootstrapSeed: 1 })
    expect(s.conditions.strongHi).toBeCloseTo(1, 6) // strong always high
    expect(s.conditions.gapWide).toBeCloseTo(1, 6) // gap always wide
    expect(s.conditions.weakLo).toBeCloseTo(0.5, 6) // weak struggles only half → the binding gate
    expect(s.conditions.all).toBeCloseTo(0.5, 6)
    expect(s.acceptRate.estimate).toBeCloseTo(0.5, 6)
  })

  it('aggregates across multiple docs (denominators add)', () => {
    const a: DocTrail = {
      tag: 'a',
      url: 'u1',
      target: 2,
      rows: [attempt({ slot: 0, iteration: 0, weak: 0.2, strong: 0.9, accept: true })],
    }
    const b: DocTrail = {
      tag: 'b',
      url: 'u2',
      target: 2,
      rows: [attempt({ slot: 0, iteration: 0, weak: 0.6, strong: 0.7, accept: false })],
    }
    const s = analyzeTrails([a, b], { bootstrapSeed: 1 })
    expect(s.totalSlots).toBe(4)
    expect(s.acceptedSlots).toBe(1)
    expect(s.perDoc).toHaveLength(2)
    expect(s.perDoc[0]?.accepted).toBe(1)
    expect(s.perDoc[1]?.accepted).toBe(0)
  })
})
