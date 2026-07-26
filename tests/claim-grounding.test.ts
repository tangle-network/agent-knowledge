import { describe, expect, it } from 'vitest'
import {
  citedClaimKey,
  citedClaimOf,
  createClaimGroundingVerifier,
  groundClaimInText,
  withCitedClaim,
} from '../src/claim-grounding'
import type {
  ResearchSourceProposal,
  SourceVerificationContext,
} from '../src/verified-research-loop'

const ctx: SourceVerificationContext = {
  root: '/tmp/x',
  goal: 'self-speculative decoding',
  round: 1,
  index: {
    root: '/tmp/x',
    generatedAt: '',
    sources: [],
    pages: [],
    graph: { nodes: [], edges: [] },
  },
  gaps: [],
  acceptedThisRound: [],
}

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

describe('citedClaim helpers', () => {
  const base: ResearchSourceProposal = { uri: 'https://x', text: 't', title: 'T' }

  it('round-trips a claim through metadata', () => {
    const decorated = withCitedClaim(base, 'the claim')
    expect(decorated.metadata?.[citedClaimKey]).toBe('the claim')
    expect(citedClaimOf(decorated)).toBe('the claim')
  })

  it('returns undefined for a missing/blank claim', () => {
    expect(citedClaimOf(base)).toBeUndefined()
    expect(citedClaimOf(withCitedClaim(base, '   '))).toBeUndefined()
  })
})

describe('createClaimGroundingVerifier (the driver gate)', () => {
  const page =
    'The transformer architecture uses multi-head self-attention. Reported BLEU of 28.4 on WMT14 En-De.'

  it('accepts a grounded source', async () => {
    const verify = createClaimGroundingVerifier()
    const source = withCitedClaim(
      { uri: 'https://a', text: page, title: 'Attention' },
      'BLEU of 28.4 on WMT14',
    )
    expect(await verify(source, ctx)).toEqual({ accept: true })
  })

  it('REJECTS a misattributed source with a precise reason', async () => {
    const verify = createClaimGroundingVerifier()
    const source = withCitedClaim(
      { uri: 'https://a', text: page, title: 'Attention' },
      'reports a BLEU of 41.0 on the WMT16 Russian benchmark',
    )
    const verdict = await verify(source, ctx)
    expect(verdict.accept).toBe(false)
    if (!verdict.accept) expect(verdict.reason).toMatch(/misattributed citation/)
  })

  it('rejects an un-annotated source by default (fail-closed)', async () => {
    const verify = createClaimGroundingVerifier()
    const verdict = await verify({ uri: 'https://a', text: page, title: 'T' }, ctx)
    expect(verdict.accept).toBe(false)
    if (!verdict.accept) expect(verdict.reason).toMatch(/no cited claim/)
  })

  it('composes a relevance verifier AFTER grounding passes', async () => {
    let relevanceCalled = false
    const verify = createClaimGroundingVerifier({
      relevanceVerifier: () => {
        relevanceCalled = true
        return { accept: false, reason: 'off-topic per relevance judge' }
      },
    })
    const grounded = withCitedClaim(
      { uri: 'https://a', text: page, title: 'T' },
      'multi-head self-attention',
    )
    const verdict = await verify(grounded, ctx)
    expect(relevanceCalled).toBe(true)
    expect(verdict.accept).toBe(false)
    if (!verdict.accept) expect(verdict.reason).toMatch(/off-topic/)
  })

  it('does NOT call the relevance verifier when grounding already fails', async () => {
    let relevanceCalled = false
    const verify = createClaimGroundingVerifier({
      relevanceVerifier: () => {
        relevanceCalled = true
        return { accept: true }
      },
    })
    const misattributed = withCitedClaim(
      { uri: 'https://a', text: page, title: 'T' },
      'a 99x speedup on a quantum coprocessor',
    )
    const verdict = await verify(misattributed, ctx)
    expect(relevanceCalled).toBe(false)
    expect(verdict.accept).toBe(false)
  })
})
