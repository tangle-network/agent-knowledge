import { describe, expect, it } from 'vitest'
import { caretAdmits, expectedPeerRange } from './peer-range.mjs'

// The expected column is npm's own rule, read from semver 7.8.5 with
// includePrerelease. A caret keeps the leftmost non-zero place: ^1.2.3 holds
// major 1, ^0.9.0 holds minor 0.9, and ^0.0.3 holds patch 0.0.3.
describe('caretAdmits', () => {
  const table = [
    ['^1.0.0', '1.0.0', true],
    ['^1.0.0', '1.4.2', true],
    ['^1.0.0', '2.0.0', false],
    ['^1.0.0', '0.9.9', false],
    ['^1.2.0', '1.1.0', false],
    ['^1.2.0', '1.2.0', true],
    ['^1.2.0', '1.99.99', true],
    ['^0.9.0', '0.9.0', true],
    ['^0.9.0', '0.9.3', true],
    ['^0.9.0', '0.10.0', false],
    ['^0.9.0', '0.8.9', false],
    ['^0.9.0', '1.0.0', false],
    ['^0.0.3', '0.0.3', true],
    ['^0.0.3', '0.0.4', false],
    ['^0.0.3', '0.0.2', false],
    ['^0.0.3', '0.1.0', false],
    ['^0.145.21', '0.145.21', true],
    ['^0.145.21', '0.145.99', true],
    ['^0.145.21', '0.146.0', false],
  ]

  for (const [range, version, admitted] of table) {
    it(`${range} ${admitted ? 'admits' : 'refuses'} ${version}`, () => {
      expect(caretAdmits(range, version)).toBe(admitted)
    })
  }

  // A version is compared by its release part, so a prerelease of an admitted
  // release is admitted. This is wider than npm at one point: npm orders
  // 1.0.0-rc.1 below 1.0.0 and refuses it under ^1.0.0, and this admits it. The
  // callers assert one physical copy of a contract package, and a prerelease
  // build of that copy carries the same surface.
  it('reads a prerelease by its release part', () => {
    expect(caretAdmits('^1.0.0', '1.2.0-develop.1')).toBe(true)
    expect(caretAdmits('^0.9.0', '0.9.1-rc.1')).toBe(true)
    expect(caretAdmits('^0.9.0', '0.10.0-rc.1')).toBe(false)
    expect(caretAdmits('^1.0.0', '1.0.0-rc.1')).toBe(true)
  })

  it('refuses a range that is not a plain caret', () => {
    for (const range of ['>=1.0.0', '1.0.0', '~1.0.0', '*', '^1.0', '']) {
      expect(caretAdmits(range, '1.0.0')).toBe(false)
    }
  })

  it('refuses a version it cannot read', () => {
    for (const version of ['', '1.0', 'latest', 'v1.0.0']) {
      expect(caretAdmits('^1.0.0', version)).toBe(false)
    }
  })
})

describe('expectedPeerRange', () => {
  const table = [
    ['1.0.0', '^1.0.0'],
    ['1.4.2', '^1.4.2'],
    ['8.0.5', '^8.0.5'],
    ['0.9.0', '>=0.9.0 <0.10.0'],
    ['0.27.1', '>=0.27.1 <0.28.0'],
    ['0.145.21', '>=0.145.21 <0.146.0'],
    ['0.149.0', '>=0.149.0 <0.150.0'],
  ]

  for (const [version, range] of table) {
    it(`${version} earns ${range}`, () => {
      expect(expectedPeerRange(version)).toBe(range)
    })
  }

  it('refuses a version it cannot read', () => {
    expect(() => expectedPeerRange('1.0')).toThrow('cannot read version 1.0')
  })
})
