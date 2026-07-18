import { groundClaimInText } from '../claim-grounding'
import type {
  RagAnswerEvalArtifact,
  RagAnswerEvalScenario,
  RagAnswerQualityJudgeOptions,
  RagEvalCitation,
  RagEvalClaim,
  RagEvalContext,
  RagRequiredContext,
} from './contracts'

export function requiredContextTargets(scenario: RagAnswerEvalScenario): RagRequiredContext[] {
  if (scenario.requiredContext?.length) return [...scenario.requiredContext]
  return (scenario.expectedClaims ?? []).map((text) => ({ text }))
}

export function requiredContextTexts(scenario: RagAnswerEvalScenario): string[] {
  return requiredContextTargets(scenario).flatMap((target) => (target.text ? [target.text] : []))
}

export function contextMatchesTarget(context: RagEvalContext, target: RagRequiredContext): boolean {
  if (target.id && context.id === target.id) return true
  if (target.pageId && context.pageId === target.pageId) return true
  if (target.sourceId && context.sourceId === target.sourceId) return true
  if (target.anchorId && context.anchorId === target.anchorId) return true
  if (target.text && textSupportScore(target.text, context.text) >= 0.7) return true
  return false
}

export function contextIsRelevant(
  context: RagEvalContext,
  scenario: RagAnswerEvalScenario,
): boolean {
  return contextRelevanceScore(context, scenario) >= 0.3
}

export function contextRelevanceScore(
  context: RagEvalContext,
  scenario: RagAnswerEvalScenario,
): number {
  const targets = [
    scenario.query,
    scenario.referenceAnswer,
    ...(scenario.expectedClaims ?? []),
    ...requiredContextTexts(scenario),
  ].filter((value): value is string => Boolean(value?.trim()))
  if (targets.length === 0) return 1
  return Math.max(...targets.map((target) => textSupportScore(target, context.text)))
}

export function claimSupport(
  claim: string,
  contexts: readonly RagEvalContext[],
  options: Pick<RagAnswerQualityJudgeOptions, 'minClaimSupport'>,
): boolean {
  if (contexts.length === 0) return false
  const combined = contexts.map((context) => context.text).join('\n\n')
  const deterministic = groundClaimInText(claim, combined, {
    minOverlap: options.minClaimSupport ?? 0.7,
  })
  return (
    deterministic.grounded || textSupportScore(claim, combined) >= (options.minClaimSupport ?? 0.7)
  )
}

export function scoreCitations(
  claims: readonly RagEvalClaim[],
  artifact: RagAnswerEvalArtifact,
  scenario: RagAnswerEvalScenario,
  options: Pick<RagAnswerQualityJudgeOptions, 'minClaimSupport'>,
): { support: number; citedClaimCount: number; supportedCitationCount: number } {
  if (claims.length === 0)
    return { support: scenario.unanswerable ? 1 : 0, citedClaimCount: 0, supportedCitationCount: 0 }
  const citations = artifact.citations ?? []
  const citedClaims = claims.filter((claim) => citationsForClaim(claim, citations).length > 0)
  if (citedClaims.length === 0) {
    return {
      support: scenario.requireCitations ? 0 : 1,
      citedClaimCount: 0,
      supportedCitationCount: 0,
    }
  }
  let supportedCitationCount = 0
  for (const claim of citedClaims) {
    const citedContexts = contextsForClaim(claim, citations, artifact.contexts)
    if (claimSupport(claim.text, citedContexts, options)) supportedCitationCount += 1
  }
  return {
    support: supportedCitationCount / citedClaims.length,
    citedClaimCount: citedClaims.length,
    supportedCitationCount,
  }
}

function citationsForClaim(
  claim: RagEvalClaim,
  citations: readonly RagEvalCitation[],
): RagEvalCitation[] {
  const claimCitationIds = new Set(claim.citationIds ?? [])
  return citations.filter((citation) => {
    return citation.claimId === claim.id || (citation.id && claimCitationIds.has(citation.id))
  })
}

function contextsForClaim(
  claim: RagEvalClaim,
  citations: readonly RagEvalCitation[],
  contexts: readonly RagEvalContext[],
): readonly RagEvalContext[] {
  const matchedCitations = citationsForClaim(claim, citations)
  const matchedContexts = contexts.filter((context) =>
    matchedCitations.some((citation) => {
      if (citation.contextId && citation.contextId === context.id) return true
      if (citation.pageId && citation.pageId === context.pageId) return true
      if (citation.sourceId && citation.sourceId === context.sourceId) return true
      if (citation.anchorId && citation.anchorId === context.anchorId) return true
      return false
    }),
  )
  return matchedContexts.length > 0 ? matchedContexts : contexts
}

export function scoreAnswerRelevance(
  artifact: RagAnswerEvalArtifact,
  scenario: RagAnswerEvalScenario,
  abstained: boolean,
): number {
  if (scenario.unanswerable) return abstained ? 1 : 0
  if (abstained) return 0
  const targets = [
    scenario.referenceAnswer,
    ...(scenario.expectedClaims ?? []),
    scenario.query,
  ].filter((value): value is string => Boolean(value?.trim()))
  return Math.max(...targets.map((target) => textSupportScore(target, artifact.answer)))
}

export function scoreAnswerCorrectness(
  artifact: RagAnswerEvalArtifact,
  scenario: RagAnswerEvalScenario,
  abstained: boolean,
): number {
  if (scenario.unanswerable) return abstained ? 1 : 0
  const expected = scenario.expectedClaims ?? []
  const forbidden = scenario.forbiddenClaims ?? []
  const expectedScore =
    expected.length === 0
      ? scoreAnswerRelevance(artifact, scenario, abstained)
      : average(expected.map((claim) => textSupportScore(claim, artifact.answer)))
  const forbiddenPenalty =
    forbidden.length === 0
      ? 0
      : forbidden.filter((claim) => textSupportScore(claim, artifact.answer) >= 0.7).length /
        forbidden.length
  return clamp01(expectedScore * (1 - forbiddenPenalty))
}

export function normalizeClaims(artifact: RagAnswerEvalArtifact): RagEvalClaim[] {
  if (artifact.claims?.length) return [...artifact.claims]
  return splitSentences(artifact.answer).map((text, index) => ({ id: `claim-${index + 1}`, text }))
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0 && !looksLikeAbstention(sentence))
}

export function looksLikeAbstention(answer: string): boolean {
  const normalized = answer.toLowerCase()
  return [
    "i don't know",
    'i do not know',
    'not enough information',
    'cannot answer',
    "can't answer",
    'insufficient information',
    'no reliable answer',
  ].some((phrase) => normalized.includes(phrase))
}

function textSupportScore(needle: string, haystack: string): number {
  const needleWords = contentWords(needle)
  if (needleWords.length === 0) return 0
  const haystackWords = new Set(contentWords(haystack))
  const present = needleWords.filter((word) => haystackWords.has(word))
  return present.length / needleWords.length
}

function contentWords(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .map((word) => stem(word.trim()))
    .filter((word) => (word.length >= 3 || /^\d+$/.test(word)) && !stopwords.has(word))
  return [...new Set(normalized)]
}

function stem(word: string): string {
  if (word.endsWith('ies') && word.length > 4) return `${word.slice(0, -3)}y`
  if (word.endsWith('ing') && word.length > 5) return word.slice(0, -3)
  if (word.endsWith('ed') && word.length > 4) return word.slice(0, -2)
  if (word.endsWith('s') && word.length > 3) return word.slice(0, -1)
  return word
}

export function neutralScore(condition: boolean): number {
  return condition ? 1 : 0
}

export function average(values: readonly number[]): number {
  const finite = values.filter(Number.isFinite)
  return finite.length === 0 ? 0 : finite.reduce((sum, value) => sum + value, 0) / finite.length
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

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
  'what',
  'when',
  'where',
  'who',
  'why',
  'how',
])
