import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetHttpThrottle,
  createCornellLiiSource,
  createIrsPublicationsSource,
  createStateSosSource,
} from '../src/sources/index'

/** Representative authority HTML keeps parser tests deterministic and offline. */

let cacheDir: string
const originalFetch = globalThis.fetch

beforeEach(async () => {
  __resetHttpThrottle()
  cacheDir = await mkdtemp(join(tmpdir(), 'agent-knowledge-sources-mock-'))
})

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true })
  globalThis.fetch = originalFetch
})

function mockOnce(html: string, status = 200): void {
  globalThis.fetch = vi.fn(
    async () =>
      new Response(html, {
        status,
        headers: { 'content-type': 'text/html', 'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT' },
      }),
  ) as unknown as typeof globalThis.fetch
}

const CORNELL_USCODE_HTML = `<!doctype html><html><head>
<title>18 U.S. Code &sect; 1836 - Civil proceedings | LII / Legal Information Institute</title>
</head><body>
<header>NAV</header>
<main id="main"><div id="content">
<h1 class="title" id="page_title"> 18 U.S. Code § 1836 - Civil proceedings </h1>
<text><div class="text">
<div class="subsection">(a) The Attorney General may, in a civil action, obtain appropriate injunctive relief against any violation of this chapter.</div>
<div class="subsection">(b) Private Civil Actions. — An owner of a trade secret may bring a civil action under this subsection.</div>
</div></text>
<div>Amendments 2016 — Pub. L. 114–153</div>
</div></main>
<footer>FOOT</footer>
</body></html>`

const CORNELL_WEX_HTML = `<!doctype html><html><head>
<title>Non-compete | Wex | US Law | LII / Legal Information Institute</title>
</head><body>
<main id="main"><div id="content"><div id="extracted-content"><div id="main-content">
<h1 class="title" id="page-title">Non-compete</h1>
<p>${'A non-compete agreement is a contract between an employer and employee. '.repeat(20)}</p>
<p>On August 20, 2024, the U.S. District Court for the Northern District of Texas set aside the FTC rule.</p>
</div></div></div></main>
</body></html>`

const IRS_INDEX_HTML = `<!doctype html><html><head>
<title>Publications | Internal Revenue Service</title>
</head><body>
<main role="main">
<table><tbody>
<tr><td>Publication 15 (2026), (Circular E), Employer's Tax Guide</td><td><a href="https://www.irs.gov/publications/p15">Publication 15 (2026)</a></td><td><a href="https://www.irs.gov/pub/irs-pdf/p15.pdf">p15.pdf</a></td></tr>
<tr><td>Publication 17 (2025), Your Federal Income Tax</td><td><a href="https://www.irs.gov/publications/p17">Publication 17 (2025)</a></td><td><a href="https://www.irs.gov/pub/irs-pdf/p17.pdf">p17.pdf</a></td></tr>
</tbody></table>
</main></body></html>`

const IRS_PUB_HTML = `<!doctype html><html><head>
<title>Publication 15 (2026), (Circular E), Employer's Tax Guide | Internal Revenue Service</title>
<meta property="og:title" content="Publication 15 (2026), Employer&#39;s Tax Guide">
</head><body>
<main role="main">
<h1>Publication 15 (2026), (Circular E), Employer's Tax Guide</h1>
<p>${'For use in 2026. This publication explains your tax responsibilities as an employer. '.repeat(10)}</p>
</main></body></html>`

const SOS_CA_HTML = `<!doctype html><html><head>
<title>Forms, Samples and Fees :: California Secretary of State</title>
</head><body>
<main>
<h1>Forms, Samples and Fees</h1>
<div id="main-content">
<p>${'LLC formation is governed by RULLCA. Filing fee is $70. '.repeat(8)}</p>
</div>
</main></body></html>`

describe('cornell-lii parsing', () => {
  it('extracts statute body and tags US-FED jurisdiction', async () => {
    mockOnce(CORNELL_USCODE_HTML)
    const source = createCornellLiiSource({ selectors: [{ kind: 'uscode', path: '18/1836' }] })
    const [f] = await source.fetch({ cacheDir })
    expect(f!.id).toBe('uscode:18/1836')
    expect(f!.provenance.url).toBe('https://www.law.cornell.edu/uscode/text/18/1836')
    expect(f!.provenance.jurisdiction).toBe('US-FED')
    expect(f!.provenance.verifiable).toBe(true)
    expect(f!.body).toContain('Attorney General')
    expect(f!.body).toContain('Private Civil Actions')
    expect(f!.dimensionHints).toContain('jurisdictional_accuracy')
    expect(f!.title).toContain('1836')
  })

  it('extracts effective date from the Amendments block', async () => {
    mockOnce(CORNELL_USCODE_HTML)
    const source = createCornellLiiSource({ selectors: [{ kind: 'uscode', path: '18/1836' }] })
    const [f] = await source.fetch({ cacheDir })
    expect(f!.provenance.sourceUpdatedAt).toBe('2016-12-31T00:00:00.000Z')
  })

  it('handles Wex slugs and uses fallback dimension hints', async () => {
    mockOnce(CORNELL_WEX_HTML)
    const source = createCornellLiiSource({ selectors: [{ kind: 'wex', path: 'non-compete' }] })
    const [f] = await source.fetch({ cacheDir })
    expect(f!.id).toBe('wex:non-compete')
    expect(f!.provenance.url).toBe('https://www.law.cornell.edu/wex/non-compete')
    expect(f!.body).toMatch(/Northern District of Texas/)
    expect(f!.dimensionHints).toEqual(['citation_hygiene'])
  })

  it('surfaces verifiable=false when authority serves a 4xx', async () => {
    mockOnce('not found', 404)
    const source = createCornellLiiSource({ selectors: [{ kind: 'uscode', path: '99/9999' }] })
    const [f] = await source.fetch({ cacheDir })
    expect(f!.provenance.verifiable).toBe(false)
    expect(f!.body).toBe('')
    expect(f!.provenance.unverifiableReason).toMatch(/non-2xx/)
  })
})

describe('irs-publications parsing', () => {
  it('index fragment captures publication rows', async () => {
    mockOnce(IRS_INDEX_HTML)
    const source = createIrsPublicationsSource()
    const fragments = await source.fetch({ cacheDir })
    const index = fragments.find((f) => f.id === 'index')
    expect(index).toBeDefined()
    expect(index!.body).toMatch(/Publication\s+15\s*\(2026\)/i)
    expect(index!.body).toMatch(/Publication\s+17\s*\(2025\)/i)
    expect(index!.provenance.jurisdiction).toBe('US-FED')
    expect(index!.dimensionHints).toContain('tax_compliance')
  })

  it('publication fragment captures revision year as sourceUpdatedAt', async () => {
    let callCount = 0
    globalThis.fetch = vi.fn(async () => {
      callCount += 1
      if (callCount === 1) {
        return new Response(IRS_INDEX_HTML, {
          status: 200,
          headers: { 'content-type': 'text/html' },
        })
      }
      return new Response(IRS_PUB_HTML, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    }) as unknown as typeof globalThis.fetch

    const source = createIrsPublicationsSource({ publications: ['p15'] })
    const fragments = await source.fetch({ cacheDir })
    const pub = fragments.find((f) => f.id === 'publication:p15')
    expect(pub).toBeDefined()
    expect(pub!.body).toMatch(/Publication 15/)
    expect(pub!.provenance.sourceUpdatedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(pub!.metadata).toMatchObject({ kind: 'publication', slug: 'p15' })
  })

  it('respects includeIndex=false and limit', async () => {
    mockOnce(IRS_PUB_HTML)
    const source = createIrsPublicationsSource({
      includeIndex: false,
      publications: ['p15', 'p17'],
    })
    const fragments = await source.fetch({ cacheDir, limit: 1 })
    expect(fragments).toHaveLength(1)
    expect(fragments[0]!.id).toBe('publication:p15')
  })
})

describe('state-sos parsing', () => {
  it('extracts via id selector and tags jurisdiction', async () => {
    mockOnce(SOS_CA_HTML)
    const source = createStateSosSource({
      state: 'CA',
      baseUrl: 'https://www.sos.ca.gov',
      entities: [
        {
          id: 'llc-formation',
          path: '/business-programs/business-entities/forms',
          title: 'CA LLC Formation',
          selector: { kind: 'id', value: 'main-content' },
        },
      ],
    })
    const [f] = await source.fetch({ cacheDir })
    expect(f!.id).toBe('llc-formation')
    expect(f!.provenance.jurisdiction).toBe('US-CA')
    expect(f!.body).toMatch(/RULLCA/)
    expect(f!.dimensionHints).toContain('jurisdictional_accuracy')
  })

  it('whole-page selector falls back to main when no id match', async () => {
    mockOnce(SOS_CA_HTML)
    const source = createStateSosSource({
      state: 'CA',
      baseUrl: 'https://www.sos.ca.gov',
      entities: [
        {
          id: 'forms',
          path: '/forms',
          title: 'CA Forms',
          selector: { kind: 'whole' },
        },
      ],
    })
    const [f] = await source.fetch({ cacheDir })
    expect(f!.body).toMatch(/Forms, Samples and Fees/)
    expect(f!.body).toMatch(/RULLCA/)
  })

  it('regex selector picks the configured block', async () => {
    mockOnce(SOS_CA_HTML)
    const source = createStateSosSource({
      state: 'CA',
      baseUrl: 'https://www.sos.ca.gov',
      entities: [
        {
          id: 'forms-h1',
          path: '/forms',
          title: 'CA Forms',
          selector: { kind: 'regex', value: /<h1[\s\S]*?<\/h1>/i },
        },
      ],
    })
    const [f] = await source.fetch({ cacheDir })
    // Body is just the h1 text; short, so verifiable=false expected.
    expect(f!.title).toBe('CA Forms')
    expect(f!.body.toLowerCase()).toContain('forms, samples and fees')
    // Short body ⇒ source flags it as not verifiable.
    expect(f!.provenance.verifiable).toBe(false)
  })
})
