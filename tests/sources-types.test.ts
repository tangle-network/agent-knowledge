import { describe, expect, it } from 'vitest'
import {
  createCornellLiiSource,
  createIrsPublicationsSource,
  createStateSosSource,
  extractLinks,
  htmlToText,
  looksLikeBlockPage,
} from '../src/sources/index'

/**
 * Pure-unit checks. No network. Bug class each test defends against:
 *
 *   - factories returning wrong source id ⇒ freshness store keys break
 *     across releases.
 *   - block-page heuristic missing common interstitials ⇒ verifiable=true
 *     when it should be false, corrupting change detection.
 *   - htmlToText eating <br> separators ⇒ statute subsection structure
 *     collapses into one paragraph.
 *   - extractLinks accepting wrong-pattern hrefs ⇒ IRS index parser
 *     would catalogue ads / navigation links as publications.
 */
describe('source factories', () => {
  it('cornell-lii default id is stable', () => {
    const source = createCornellLiiSource({ selectors: [{ kind: 'uscode', path: '18/1836' }] })
    expect(source.id).toBe('cornell-lii')
    expect(source.name).toMatch(/Cornell/)
  })

  it('cornell-lii id override is honoured', () => {
    const source = createCornellLiiSource({
      selectors: [{ kind: 'wex', path: 'non-compete' }],
      id: 'cornell-lii-trade-secrets',
    })
    expect(source.id).toBe('cornell-lii-trade-secrets')
  })

  it('irs-publications default id is stable', () => {
    const source = createIrsPublicationsSource()
    expect(source.id).toBe('irs-publications')
  })

  it('state-sos id derived from postal code (lower-cased)', () => {
    const source = createStateSosSource({
      state: 'CA',
      baseUrl: 'https://www.sos.ca.gov',
      entities: [],
    })
    expect(source.id).toBe('state-sos:ca')
    expect(source.name).toBe('CA Secretary of State')
  })
})

describe('looksLikeBlockPage', () => {
  it('catches Cloudflare interstitial', () => {
    expect(looksLikeBlockPage('<html>Just a moment...<br>Verify you are human</html>')).toBe(true)
  })

  it('catches CAPTCHA pages', () => {
    expect(looksLikeBlockPage('<div>Please complete the CAPTCHA</div>')).toBe(true)
  })

  it('catches Incapsula block pages', () => {
    expect(looksLikeBlockPage('<!-- Incapsula block --> Request unsuccessful.')).toBe(true)
  })

  it('does not false-positive on real statute text', () => {
    expect(
      looksLikeBlockPage(
        '18 U.S. Code § 1836 - Civil proceedings. The Attorney General may, in a civil action, obtain appropriate injunctive relief...',
      ),
    ).toBe(false)
  })

  it('empty body is not a block page (different failure path)', () => {
    expect(looksLikeBlockPage('')).toBe(false)
  })
})

describe('htmlToText', () => {
  it('preserves <br> and </p> as newlines', () => {
    const text = htmlToText('<p>alpha</p><p>beta</p><div>gamma<br>delta</div>')
    expect(text.split('\n')).toEqual(['alpha', 'beta', 'gamma', 'delta'])
  })

  it('strips scripts and styles entirely', () => {
    const text = htmlToText('<script>doom()</script><style>.x{display:none}</style><p>visible</p>')
    expect(text).toBe('visible')
  })

  it('decodes the section sign and common entities', () => {
    const text = htmlToText('<p>18 U.S. Code &sect;&nbsp;1836 &mdash; &quot;trade secret&quot;</p>')
    expect(text).toContain('§')
    expect(text).toContain('—')
    expect(text).toContain('"trade secret"')
  })

  it('decodes numeric entities', () => {
    expect(htmlToText('<p>&#167;1836</p>')).toBe('§1836')
    expect(htmlToText('<p>&#xa7;1836</p>')).toBe('§1836')
  })
})

describe('extractLinks', () => {
  it('filters by href pattern and resolves against base', () => {
    const html =
      '<a href="https://www.irs.gov/publications/p15">Pub 15</a>' +
      '<a href="/about">About</a>' +
      '<a href="https://www.irs.gov/publications/p17">Pub 17</a>'
    const links = extractLinks(html, /\/publications\/p\d+/i, 'https://www.irs.gov')
    expect(links).toEqual([
      { href: 'https://www.irs.gov/publications/p15', text: 'Pub 15' },
      { href: 'https://www.irs.gov/publications/p17', text: 'Pub 17' },
    ])
  })

  it('skips empty link text', () => {
    const html = '<a href="https://www.irs.gov/publications/p15"></a>'
    expect(extractLinks(html, /\/publications\//i, 'https://www.irs.gov')).toEqual([])
  })
})
