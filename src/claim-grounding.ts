/**
 * Deterministic claim grounding: is a claim present in a text?
 *
 * The check is text presence, not a model call. RAG answer scoring uses it to
 * test whether a generated claim is supported by the retrieved context.
 */

export interface GroundingResult {
  /** True when the claim is sufficiently present in the page text. */
  grounded: boolean
  /** How the claim matched (or why it didn't). For audit/notes. */
  mode: 'verbatim' | 'normalized' | 'overlap' | 'absent' | 'empty-claim' | 'empty-text'
  /**
   * Fraction of the claim's content words found in the page text. 1 for a
   * verbatim/normalized hit; the measured overlap otherwise.
   */
  overlap: number
  /** Content words present in the claim but NOT in the page text. */
  missingWords: string[]
}

export interface GroundClaimOptions {
  /**
   * Minimum fraction of the claim's content words that must appear in the page
   * text to count as a close paraphrase when there is no verbatim/normalized
   * hit. Default 0.7 — a high bar, because a misattribution is exactly a claim
   * whose specific words the page does not contain.
   */
  minOverlap?: number
  /**
   * Content words shorter than this are ignored (drops "the", "of", "is", …)
   * and never count toward overlap. Default 3.
   */
  minWordLength?: number
}

/**
 * Stopwords stripped before overlap scoring so the bar measures the claim's
 * SUBSTANTIVE words (the numbers, nouns, methods it asserts), not filler a
 * misattributed page would trivially share with the real one.
 */
const stopwords = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'as',
  'by',
  'at',
  'from',
  'that',
  'this',
  'these',
  'those',
  'it',
  'its',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'has',
  'have',
  'had',
  'can',
  'will',
  'would',
  'should',
  'may',
  'might',
  'not',
  'no',
  'than',
  'then',
  'over',
  'under',
  'about',
  'into',
  'their',
  'they',
  'them',
])

/** Normalize for presence checks: lowercase, collapse whitespace + punctuation. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The claim's substantive content words (deduped, stopwords + short words removed). */
function contentWords(claim: string, minWordLength: number): string[] {
  const words = normalize(claim)
    .split(' ')
    .filter((word) => word.length >= minWordLength && !stopwords.has(word))
  return [...new Set(words)]
}

/**
 * Is `claim` grounded in `pageText`? Deterministic, no model call:
 *
 *   1. verbatim — the claim string appears as-is (case-insensitive).
 *   2. normalized — the claim appears after collapsing punctuation/whitespace
 *      on both sides (so "5.4x" vs "5.4 x", smart quotes, etc. still match).
 *   3. overlap — a close paraphrase: at least `minOverlap` of the claim's
 *      substantive content words appear in the page text. A misattributed page
 *      fails here because the SPECIFIC words the claim asserts are absent.
 *
 * Returns the match mode, the measured overlap, and the missing content words,
 * so a caller can state why a claim grounded or did not.
 */
export function groundClaimInText(
  claim: string,
  pageText: string,
  options: GroundClaimOptions = {},
): GroundingResult {
  const minOverlap = options.minOverlap ?? 0.7
  const minWordLength = Math.max(1, options.minWordLength ?? 3)

  const claimTrimmed = claim.trim()
  if (!claimTrimmed) return { grounded: false, mode: 'empty-claim', overlap: 0, missingWords: [] }
  if (!pageText.trim()) return { grounded: false, mode: 'empty-text', overlap: 0, missingWords: [] }

  const haystackLower = pageText.toLowerCase()
  if (haystackLower.includes(claimTrimmed.toLowerCase())) {
    return { grounded: true, mode: 'verbatim', overlap: 1, missingWords: [] }
  }

  const haystackNorm = normalize(pageText)
  const claimNorm = normalize(claimTrimmed)
  if (claimNorm && haystackNorm.includes(claimNorm)) {
    return { grounded: true, mode: 'normalized', overlap: 1, missingWords: [] }
  }

  const words = contentWords(claimTrimmed, minWordLength)
  if (words.length === 0) {
    // The claim has no substantive content words (all stopwords/short). With no
    // verbatim/normalized hit there is nothing to ground — treat as absent.
    return { grounded: false, mode: 'absent', overlap: 0, missingWords: [] }
  }
  // Word-boundary presence so "rotary" does not match inside "rotaryxyz".
  const present = words.filter((word) =>
    new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(haystackNorm),
  )
  const missingWords = words.filter((word) => !present.includes(word))
  const overlap = present.length / words.length
  const grounded = overlap >= minOverlap
  return { grounded, mode: grounded ? 'overlap' : 'absent', overlap, missingWords }
}
