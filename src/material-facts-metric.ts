/**
 * `materialFactsSurfaced` — the held-out investment-research METRIC.
 *
 * Given a knowledge base a research loop built for a company and the company's
 * HELD-OUT material-fact checklist (`tests/eval/investment-thesis-set.ts`, never
 * shown to the loop), this returns the FRACTION of checklist items the KB's
 * pages surface + ground. The check is the same `$0`, model-free, deterministic
 * substring grader the loop's checklist already ships (`gradeFactAgainstText` /
 * `gradeCompanyAgainstText`) — so the answer key never reaches a model the loop
 * could observe, exactly the firewall the ML deep-question exam uses.
 *
 * The ONLY thing this file adds over the raw grader is the KB→text join: it reads
 * the curated pages (and the raw source text) the loop wrote and hands their
 * concatenation to the grader. That join mirrors `kbText` in the research-quality
 * A/B (research-driving-ab.test.ts) so the thesis metric and the ML-exam metric
 * read a KB the same way.
 *
 * WHY pages AND source text: an honest thesis surfaces a buried fact in its
 * curated thesis PAGE (the judgment), but a loop whose page is thin while its
 * fetched filings are rich should still get credit for what it actually pulled.
 * Grading the union is the faithful, not the lenient, choice — it rewards the
 * loop that REACHED the filing even if its synthesis was terse, and it cannot
 * manufacture a hit the underlying evidence does not contain.
 */

import { buildKnowledgeIndex } from './indexer'
import {
  type CompanyEvalCase,
  gradeCompanyAgainstText,
  gradeFactAgainstText,
} from './investment-thesis-set'
import type { KnowledgeIndex } from './types'

/** Per-fact grade plus the fact's id/lens, for the audit trail. */
export interface FactResult {
  id: string
  lens: CompanyEvalCase['facts'][number]['lens']
  surfaced: boolean
  groupsFound: number
  groupsTotal: number
  foundLabels: string[]
}

/** The metric's result for one company: the surfaced fraction + the per-fact trail. */
export interface MaterialFactsResult {
  ticker: string
  company: string
  /** Held-out facts the KB surfaced + grounded. */
  surfaced: number
  /** Total held-out facts for this company (the denominator). */
  total: number
  /** `surfaced / total` in [0, 1]. */
  fraction: number
  /** Per-fact grade, in checklist order, for the doc / audit. */
  perFact: FactResult[]
}

/**
 * Join a KB index into the single text blob the grader scans: every curated PAGE
 * (title + body) followed by every raw SOURCE (title + fetched text). This is the
 * text read AFTER the loop finished — it is never handed to the loop. Identical
 * in spirit to `kbText` in the research-quality A/B so both metrics read a KB the
 * same way.
 */
export function kbIndexToText(index: KnowledgeIndex): string {
  const pageText = index.pages.map((page) => `${page.title}\n${page.text}`).join('\n\n')
  const sourceText = index.sources
    .map((source) => `${source.title ?? ''}\n${source.text ?? ''}`)
    .join('\n\n')
  return `${pageText}\n\n${sourceText}`
}

/**
 * Grade one company's KB against its held-out material-fact checklist, given the
 * KB's already-joined text. The pure core — no I/O — so calibration can score a
 * hand-written shallow/deep thesis string directly and the live path can score a
 * real KB. Returns the surfaced FRACTION plus the per-fact audit trail.
 */
export function materialFactsSurfacedInText(
  company: CompanyEvalCase,
  kbText: string,
): MaterialFactsResult {
  const grade = gradeCompanyAgainstText(company, kbText)
  const perFact: FactResult[] = company.facts.map((fact) => {
    const r = gradeFactAgainstText(fact, kbText)
    return {
      id: fact.id,
      lens: fact.lens,
      surfaced: r.surfaced,
      groupsFound: r.groupsFound,
      groupsTotal: r.groupsTotal,
      foundLabels: r.foundLabels,
    }
  })
  return {
    ticker: company.ticker,
    company: company.company,
    surfaced: grade.surfaced,
    total: grade.total,
    fraction: grade.total === 0 ? 0 : grade.surfaced / grade.total,
    perFact,
  }
}

/**
 * `materialFactsSurfaced(kb, checklist)` — the metric in its KB-reading form.
 *
 * `kb` is EITHER a knowledge-base root directory (the loop wrote pages there) or
 * an already-built `KnowledgeIndex`. `checklist` is the company's held-out
 * `CompanyEvalCase`. Returns the surfaced fraction + per-fact trail.
 *
 * The checklist is HELD OUT by construction: it lives in the test eval set, is
 * never passed to the loop, and is read only here, after the loop finished.
 */
export async function materialFactsSurfaced(
  kb: string | KnowledgeIndex,
  checklist: CompanyEvalCase,
): Promise<MaterialFactsResult> {
  const index = typeof kb === 'string' ? await buildKnowledgeIndex(kb) : kb
  return materialFactsSurfacedInText(checklist, kbIndexToText(index))
}
