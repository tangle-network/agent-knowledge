import { describe, expect, it } from 'vitest'
import { mean } from './statistics'

describe('mean', () => {
  it('averages the measurements it was given', () => {
    expect(mean([1, 2, 3])).toBe(2)
    expect(mean([0.25, 0.75])).toBe(0.5)
  })

  it('leaves out a measurement that is not a finite number', () => {
    expect(mean([1, Number.NaN, 3])).toBe(2)
    expect(mean([1, Number.POSITIVE_INFINITY, 3])).toBe(2)
  })
})
