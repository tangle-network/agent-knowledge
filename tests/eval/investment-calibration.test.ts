import { describe, expect, it } from 'vitest'
import { materialFactsSurfacedInText } from '../../src/material-facts-metric'
import { calibrationTheses, caseForTicker } from './investment-calibration'
import { investmentThesisSet } from './investment-thesis-set'

// ===========================================================================
// THE CALIBRATION GATE — run this BEFORE any A/B with `materialFactsSurfaced`.
//
// The metric is only valid if it DISCRIMINATES research depth: a shallow,
// one-paragraph ticker summary must score LOW, and a filings-grounded deep thesis
// must score HIGH, for the SAME company. If it does not separate them, the metric
// is measuring word-collection, not research (the exact failure the ML exam had),
// and the A/B would be meaningless. This file is that gate, run at $0 offline.
//
// Bars (from the task spec): shallow < 30%, deep > 70%, per company AND in aggregate.
// ===========================================================================

const SHALLOW_MAX = 0.3
const DEEP_MIN = 0.7

describe('materialFactsSurfaced — CALIBRATION GATE (discriminates shallow vs deep)', () => {
  it('every calibration ticker has a held-out checklist case', () => {
    for (const t of calibrationTheses) {
      expect(() => caseForTicker(t.ticker)).not.toThrow()
    }
    // And every checklist company is calibrated (no silent gaps).
    for (const company of investmentThesisSet) {
      expect(calibrationTheses.some((t) => t.ticker === company.ticker)).toBe(true)
    }
  })

  it('SHALLOW theses score LOW (< 30%) — the metric does not reward collection', () => {
    for (const thesis of calibrationTheses) {
      const company = caseForTicker(thesis.ticker)
      const r = materialFactsSurfacedInText(company, thesis.shallow)
      expect(
        r.fraction,
        `${thesis.ticker} shallow surfaced ${r.surfaced}/${r.total} = ${(r.fraction * 100).toFixed(0)}% (expected < ${SHALLOW_MAX * 100}%) — facts hit: ${r.perFact
          .filter((f) => f.surfaced)
          .map((f) => f.id)
          .join(', ')}`,
      ).toBeLessThan(SHALLOW_MAX)
    }
  })

  it('DEEP theses score HIGH (> 70%) — the metric credits real, surfaced depth', () => {
    for (const thesis of calibrationTheses) {
      const company = caseForTicker(thesis.ticker)
      const r = materialFactsSurfacedInText(company, thesis.deep)
      expect(
        r.fraction,
        `${thesis.ticker} deep surfaced ${r.surfaced}/${r.total} = ${(r.fraction * 100).toFixed(0)}% (expected > ${DEEP_MIN * 100}%) — facts MISSED: ${r.perFact
          .filter((f) => !f.surfaced)
          .map((f) => `${f.id}(${f.groupsFound}/${f.groupsTotal})`)
          .join(', ')}`,
      ).toBeGreaterThan(DEEP_MIN)
    }
  })

  it('the gap (deep - shallow) is large per company AND in aggregate', () => {
    let shallowSurfaced = 0
    let deepSurfaced = 0
    let total = 0
    for (const thesis of calibrationTheses) {
      const company = caseForTicker(thesis.ticker)
      const s = materialFactsSurfacedInText(company, thesis.shallow)
      const d = materialFactsSurfacedInText(company, thesis.deep)
      // Per company the deep thesis must clear the shallow one by a wide margin.
      expect(
        d.fraction - s.fraction,
        `${thesis.ticker}: deep ${(d.fraction * 100).toFixed(0)}% vs shallow ${(s.fraction * 100).toFixed(0)}%`,
      ).toBeGreaterThan(0.4)
      shallowSurfaced += s.surfaced
      deepSurfaced += d.surfaced
      total += s.total
    }
    // Aggregate: across all 27 held-out facts the meter must clearly separate.
    expect(shallowSurfaced / total).toBeLessThan(SHALLOW_MAX)
    expect(deepSurfaced / total).toBeGreaterThan(DEEP_MIN)
  })

  // ANTI-CIRCULARITY GUARD: the deep theses must EARN their score with real,
  // independently-phrased analysis — not by verbatim-embedding the checklist's
  // `evidence` strings (that would be teaching-to-the-test, making the deep score
  // an answer-key echo rather than the meter catching depth). We assert no deep
  // thesis contains any checklist `evidence` string verbatim.
  it('deep theses do not verbatim-embed the checklist evidence (no answer-key leak)', () => {
    for (const thesis of calibrationTheses) {
      const company = caseForTicker(thesis.ticker)
      const deepLower = thesis.deep.toLowerCase()
      for (const fact of company.facts) {
        // The `evidence` field is the literal curation note (quotes the filing +
        // the curator's framing). A faithful deep thesis names the same numbers in
        // its own prose, so the full evidence STRING must not appear verbatim.
        const ev = fact.evidence.toLowerCase()
        expect(
          deepLower.includes(ev),
          `${thesis.ticker} deep thesis verbatim-embeds the evidence string for ${fact.id} — that is an answer-key leak, rewrite in independent prose`,
        ).toBe(false)
      }
    }
  })
})
