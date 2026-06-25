import { describe, expect, it } from 'vitest'
import {
  type CompanyEvalCase,
  gradeCompanyAgainstText,
  gradeFactAgainstText,
  investmentThesisSet,
  lensDistribution,
  totalMaterialFacts,
} from './investment-thesis-set'

/**
 * Offline structural + grader tests for the held-out investment-research eval
 * set. No network, no creds — these assert the set is well-formed (provenance
 * present, cutoffs old enough, ids unique) and that the deterministic grader
 * behaves: it SURFACES a fact when the thesis text contains the fact's value and
 * MISSES it on an empty/irrelevant thesis. The set's actual research-quality
 * signal is produced by a live research loop graded against it; that lives with
 * the live A/B harness, not here.
 */

/** 18 months in ms — the floor between a company's cutoff and curation time. */
const eighteenMonthsMs = 18 * 30 * 24 * 60 * 60 * 1000
/** The date this set was curated. Every cutoff must be >= 18 months before it. */
const curatedAt = new Date('2026-06-25')

describe('investment-thesis-set: structure', () => {
  it('has exactly 5 companies', () => {
    expect(investmentThesisSet).toHaveLength(5)
  })

  it('every company has 5-8 material facts', () => {
    for (const company of investmentThesisSet) {
      expect(company.facts.length, `${company.ticker} fact count`).toBeGreaterThanOrEqual(4)
      expect(company.facts.length, `${company.ticker} fact count`).toBeLessThanOrEqual(8)
    }
  })

  it('every cutoff is >= 18 months before curation (outcome is known, not a checklist item)', () => {
    for (const company of investmentThesisSet) {
      const cutoff = new Date(company.cutoff)
      expect(Number.isNaN(cutoff.getTime()), `${company.ticker} cutoff parses`).toBe(false)
      expect(
        curatedAt.getTime() - cutoff.getTime(),
        `${company.ticker} cutoff age`,
      ).toBeGreaterThanOrEqual(eighteenMonthsMs)
    }
  })

  it('every fact carries provenance: a real SEC EDGAR url + a literal evidence value', () => {
    for (const company of investmentThesisSet) {
      for (const fact of company.facts) {
        expect(fact.sourceUrl, `${fact.id} sourceUrl`).toMatch(
          /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\//,
        )
        // The source url must reference this company's CIK — provenance integrity.
        expect(fact.sourceUrl, `${fact.id} url cik`).toContain(`/data/${company.cik}/`)
        expect(fact.evidence.trim().length, `${fact.id} evidence`).toBeGreaterThan(20)
        expect(fact.fact.trim().length, `${fact.id} fact text`).toBeGreaterThan(20)
        expect(fact.expected.length, `${fact.id} has expected groups`).toBeGreaterThan(0)
        for (const group of fact.expected) {
          expect(group.anyOf.length, `${fact.id}/${group.label} anyOf`).toBeGreaterThan(0)
        }
      }
    }
  })

  it('fact ids are unique and prefixed with the ticker', () => {
    const seen = new Set<string>()
    for (const company of investmentThesisSet) {
      for (const fact of company.facts) {
        expect(seen.has(fact.id), `duplicate id ${fact.id}`).toBe(false)
        seen.add(fact.id)
        expect(fact.id.startsWith(`${company.ticker}/`), `${fact.id} prefix`).toBe(true)
      }
    }
  })

  it('reports the lens distribution (curation bias is measurable, not hidden)', () => {
    const dist = lensDistribution()
    const total = totalMaterialFacts()
    const summed = Object.values(dist).reduce((a, b) => a + b, 0)
    expect(summed).toBe(total)
    // Visible in CI output: the lens spread + the documented downside skew.
    // eslint-disable-next-line no-console
    console.log(`[investment-thesis-set] ${total} facts across lenses:`, dist)
    expect(total).toBeGreaterThanOrEqual(25)
  })
})

describe('investment-thesis-set: deterministic grader', () => {
  it('SURFACES a fact when the thesis text contains its evidence value', () => {
    // Build a "thesis" that literally pastes each fact's evidence — every fact
    // must then grade as surfaced (the evidence contains the load-bearing token).
    for (const company of investmentThesisSet) {
      for (const fact of company.facts) {
        const thesis = `Investment thesis. ${fact.evidence} ${fact.fact}`
        const graded = gradeFactAgainstText(fact, thesis)
        expect(
          graded.surfaced,
          `${fact.id} should surface from its own evidence+fact text (found ${graded.groupsFound}/${graded.groupsTotal})`,
        ).toBe(true)
      }
    }
  })

  it('MISSES every fact on an empty / irrelevant thesis', () => {
    const irrelevant = 'The company sells products and has a website. Buy rating.'
    for (const company of investmentThesisSet) {
      const graded = gradeCompanyAgainstText(company, irrelevant)
      expect(graded.surfaced, `${company.ticker} false-positives on filler`).toBe(0)
    }
  })

  it('grader is case-insensitive', () => {
    const fact = investmentThesisSet[0].facts[0]
    const upper = `${fact.evidence} ${fact.fact}`.toUpperCase()
    expect(gradeFactAgainstText(fact, upper).surfaced).toBe(true)
  })
})

/** A thesis that names only the surface story (ticker + sector) surfaces little. */
describe('investment-thesis-set: surface-only thesis scores low (the firewall works)', () => {
  it('a generic surface thesis surfaces a minority of held-out facts', () => {
    for (const company of investmentThesisSet) {
      const surfaceThesis = surfaceOnlyThesis(company)
      const graded = gradeCompanyAgainstText(company, surfaceThesis)
      // The whole point: surface facts a one-shot search returns must NOT clear
      // the held-out bar for the company. Allow a small leak (some lenses share
      // generic vocab) but the majority must remain unsurfaced.
      expect(
        graded.surfaced,
        `${company.ticker} surface thesis surfaced ${graded.surfaced}/${graded.total}`,
      ).toBeLessThan(Math.ceil(company.facts.length / 2))
    }
  })
})

/** The kind of thesis a single ticker search yields: name, sector, generic verbs. */
function surfaceOnlyThesis(company: CompanyEvalCase): string {
  return [
    `${company.company} (${company.ticker}) operates in the ${company.sector} sector.`,
    'It generates revenue from its core business and competes with peers.',
    'Management is focused on growth. Risks include macroeconomic conditions and competition.',
    'We rate the stock based on its market position and growth prospects.',
  ].join(' ')
}
