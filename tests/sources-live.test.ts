import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __resetHttpThrottle,
  createCornellLiiSource,
  createIrsPublicationsSource,
  createStateSosSource,
} from '../src/sources/index'

/**
 * Live HTTP tests against real authorities (Cornell LII, IRS.gov, CA SOS).
 *
 * Gated on `AGENT_KNOWLEDGE_RUN_NETWORK_TESTS=1` because network tests in
 * sandboxes without outbound connectivity (some CI setups) would otherwise
 * be FALSE FAILURES rather than environmental skips. CI passes the flag.
 *
 * Rate-limit / block-page behaviour: the source contract guarantees
 * `verifiable: false` with a reason rather than throwing. The tests below
 * therefore SKIP (not fail) when an authority is unreachable or serving a
 * block page — the unit-test layer already validates the success path on
 * synthetic HTML; what these tests are checking is "the live shape we
 * built against is still the live shape." That signal is preserved by
 * skipping rather than failing in transient adverse conditions.
 *
 * Bug class each test defends against:
 *
 *   - Cornell LII HTML re-skinning that breaks the section-text selector
 *     ⇒ statute body extraction silently returns navigation text.
 *   - IRS Drupal upgrade that changes the publications-index table markup
 *     ⇒ change detection floods the cron with phantom removals.
 *   - State SOS swapping CMS ⇒ wrong jurisdiction tag would feed into
 *     `KnowledgeChange.affectedDimensions` and re-run the wrong evals.
 *
 * Each test uses a 30s timeout, a per-test fresh cache dir, and resets
 * the in-process throttle so order-of-execution doesn't matter.
 */

const LIVE_ENABLED = process.env.AGENT_KNOWLEDGE_RUN_NETWORK_TESTS === '1'
const TIMEOUT_MS = 30_000

let cacheDir: string

beforeEach(async () => {
  __resetHttpThrottle()
  cacheDir = await mkdtemp(join(tmpdir(), 'agent-knowledge-live-cache-'))
})

afterEach(async () => {
  await rm(cacheDir, { recursive: true, force: true })
})

describe.skipIf(!LIVE_ENABLED)('live: Cornell LII', () => {
  it(
    'fetches DTSA 18 USC § 1836 with verifiable=true and statute text',
    async () => {
      const source = createCornellLiiSource({
        selectors: [{ kind: 'uscode', path: '18/1836' }],
      })
      const fragments = await source.fetch({ cacheDir })
      expect(fragments).toHaveLength(1)
      const f = fragments[0]!
      if (!f.provenance.verifiable) {
        console.warn(`Cornell LII unreachable: ${f.provenance.unverifiableReason} — skipping`)
        return
      }
      expect(f.id).toBe('uscode:18/1836')
      expect(f.title.toLowerCase()).toContain('1836')
      expect(f.provenance.url).toBe('https://www.law.cornell.edu/uscode/text/18/1836')
      expect(f.provenance.jurisdiction).toBe('US-FED')
      // The statute text must include the Attorney General clause.
      expect(f.body.toLowerCase()).toMatch(/attorney general/)
      expect(f.dimensionHints).toContain('jurisdictional_accuracy')
      // Body hash must be deterministic + non-empty.
      expect(f.bodyHash).toMatch(/^[0-9a-f]{64}$/)
    },
    TIMEOUT_MS,
  )

  it(
    'fetches a Wex entry (restraint_of_trade — covers the non-compete doctrine surface)',
    async () => {
      // Cornell's Wex doesn't currently carry a /wex/non-compete slug. The
      // doctrinal surface for the Ryan-LLC v. FTC drift sits under
      // /wex/restraint_of_trade. If Wex later adds a more specific slug we
      // should add it as a second selector — change detection across slugs
      // is exactly what `KnowledgeChange.added` is for.
      const source = createCornellLiiSource({
        selectors: [
          { kind: 'wex', path: 'restraint_of_trade', dimensionHints: ['jurisdictional_accuracy'] },
        ],
      })
      const fragments = await source.fetch({ cacheDir })
      const f = fragments[0]!
      if (!f.provenance.verifiable) {
        console.warn(`Cornell LII Wex unreachable: ${f.provenance.unverifiableReason} — skipping`)
        return
      }
      expect(f.id).toBe('wex:restraint_of_trade')
      expect(f.provenance.url).toBe('https://www.law.cornell.edu/wex/restraint_of_trade')
      expect(f.body.length).toBeGreaterThan(200)
      expect(f.dimensionHints).toEqual(['jurisdictional_accuracy'])
    },
    TIMEOUT_MS,
  )
})

describe.skipIf(!LIVE_ENABLED)('live: IRS publications', () => {
  it(
    'fetches the publications index with table rows extracted',
    async () => {
      const source = createIrsPublicationsSource({ publications: [] })
      const fragments = await source.fetch({ cacheDir })
      const index = fragments.find((f) => f.id === 'index')
      expect(index).toBeDefined()
      if (!index?.provenance.verifiable) {
        console.warn(`IRS index unreachable: ${index?.provenance.unverifiableReason} — skipping`)
        return
      }
      expect(index.provenance.url).toBe('https://www.irs.gov/publications')
      expect(index.provenance.jurisdiction).toBe('US-FED')
      // The publications index must mention at least one current pub.
      expect(index.body).toMatch(/Publication\s+15\b/i)
      expect(index.dimensionHints).toContain('tax_compliance')
    },
    TIMEOUT_MS,
  )

  it(
    'fetches Publication 15 landing page',
    async () => {
      const source = createIrsPublicationsSource({
        includeIndex: false,
        publications: ['p15'],
      })
      const fragments = await source.fetch({ cacheDir })
      const pub = fragments[0]!
      if (!pub.provenance.verifiable) {
        console.warn(`IRS p15 unreachable: ${pub.provenance.unverifiableReason} — skipping`)
        return
      }
      expect(pub.id).toBe('publication:p15')
      expect(pub.provenance.url).toBe('https://www.irs.gov/publications/p15')
      expect(pub.body.length).toBeGreaterThan(500)
    },
    TIMEOUT_MS,
  )
})

describe.skipIf(!LIVE_ENABLED)('live: state SOS (California)', () => {
  it(
    'fetches CA SOS forms page',
    async () => {
      const source = createStateSosSource({
        state: 'CA',
        baseUrl: 'https://www.sos.ca.gov',
        entities: [
          {
            id: 'business-entities-forms',
            path: '/business-programs/business-entities/forms',
            title: 'CA Business Entities Forms',
            selector: { kind: 'whole' },
          },
        ],
      })
      const fragments = await source.fetch({ cacheDir })
      const f = fragments[0]!
      if (!f.provenance.verifiable) {
        console.warn(`CA SOS unreachable: ${f.provenance.unverifiableReason} — skipping`)
        return
      }
      expect(f.id).toBe('business-entities-forms')
      expect(f.provenance.jurisdiction).toBe('US-CA')
      expect(f.body.toLowerCase()).toMatch(/llc|limited liability|forms/)
      expect(f.dimensionHints).toContain('jurisdictional_accuracy')
    },
    TIMEOUT_MS,
  )
})
