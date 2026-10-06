import { describe, expect, it } from 'vitest'
import { groundClaimInText } from '../src/claim-grounding'

describe('groundClaimInText (the deterministic grounding oracle)', () => {
  const page =
    'Self-speculative decoding skips intermediate layers to draft tokens, then verifies them ' +
    'with the full model. The paper reports a 1.73x speedup on LLaMA-2 with no quality loss.'

  it('grounds a verbatim claim', () => {
    const r = groundClaimInText('skips intermediate layers to draft tokens', page)
    expect(r.grounded).toBe(true)
    expect(r.mode).toBe('verbatim')
    expect(r.overlap).toBe(1)
  })

  it('grounds across punctuation/whitespace differences (normalized)', () => {
    // The page says "1.73x speedup"; the claim spaces it differently + adds a comma.
    const r = groundClaimInText('a 1.73x, speedup', page)
    expect(r.grounded).toBe(true)
    expect(['verbatim', 'normalized']).toContain(r.mode)
  })

  it('grounds a close paraphrase via content-word overlap', () => {
    // Reworded but the substantive words are present in the page (drops the
    // "no-quality-loss" ordering). Inflected forms that the page does NOT
    // contain verbatim (e.g. "drafts" vs "draft") legitimately lower the score —
    // that strictness is the point, so this paraphrase keeps to present words.
    const r = groundClaimInText(
      'draft tokens by skipping intermediate layers then verifies with the full model',
      page,
    )
    expect(r.grounded).toBe(true)
    expect(r.mode).toBe('overlap')
    expect(r.overlap).toBeGreaterThanOrEqual(0.7)
  })

  it('REJECTS a misattributed claim — relevant topic, wrong numbers/facts', () => {
    // On-topic (mentions speculative decoding) but the page never says any of this:
    // a different speedup, a different model, a different mechanism. A relevance
    // judge would pass it; grounding must not.
    const r = groundClaimInText(
      'achieves a 4.8x speedup on GPT-4 using a separate draft transformer network',
      page,
    )
    expect(r.grounded).toBe(false)
    expect(r.mode).toBe('absent')
    expect(r.missingWords).toContain('gpt')
    expect(r.missingWords).toContain('network')
  })

  it('rejects an empty page text and an empty claim', () => {
    expect(groundClaimInText('anything', '').grounded).toBe(false)
    expect(groundClaimInText('anything', '').mode).toBe('empty-text')
    expect(groundClaimInText('   ', page).grounded).toBe(false)
    expect(groundClaimInText('   ', page).mode).toBe('empty-claim')
  })

  it('does not let a stopword-only claim ground spuriously', () => {
    const r = groundClaimInText('the of and to', page)
    expect(r.grounded).toBe(false)
  })

  it('honours a stricter minOverlap', () => {
    // ~0.6 overlap claim: grounds at 0.5, fails at 0.9.
    const claim = 'speedup verifies tokens nonexistentwordzz alsofakewordzz'
    expect(groundClaimInText(claim, page, { minOverlap: 0.5 }).grounded).toBe(true)
    expect(groundClaimInText(claim, page, { minOverlap: 0.9 }).grounded).toBe(false)
  })
})
