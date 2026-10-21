import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  caretAdmits,
  evalCompatibility,
  evalCompatibilityVersions,
} from './peer-range.mjs'

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

// package.json owns Eval compatibility; this reads a manifest at the adopted
// 0.216.1 pin, the state whose hand-kept copy failed the v22.0.5 publish.
describe('evalCompatibility from package.json', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-knowledge-peer-range-'))
  const packagePath = join(dir, 'package.json')
  writeFileSync(
    packagePath,
    JSON.stringify({
      peerDependencies: { '@tangle-network/agent-eval': '>=0.213.0 <0.217.0' },
      devDependencies: { '@tangle-network/agent-eval': '0.216.1' },
    }),
  )
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('supports every minor from the floor through the development pin', () => {
    expect(evalCompatibilityVersions(packagePath)).toEqual(['0.213.0', '0.214.0', '0.215.0', '0.216.1'])
    expect(evalCompatibility('0.216.1', '0.213.0', packagePath)).toEqual({
      version: '0.213.0',
      peerRange: '>=0.213.0 <0.217.0',
    })
  })

  it('refuses a development version above the peer range', () => {
    expect(() => evalCompatibility('0.217.0', '0.217.0', packagePath)).toThrow(
      'unverified Eval development version: 0.217.0',
    )
  })
})
