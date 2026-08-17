import type { KnowledgePage } from '../types'

export interface NearDuplicateDetectionOptions {
  /** Jaccard similarity at or above which a pair is reported. Defaults to 0.82. */
  threshold?: number
  /** Minimum normalized characters before a page participates. Defaults to 80. */
  minCharacters?: number
  /** Word-shingle width. Defaults to 5. */
  wordShingleSize?: number
  /** Character-shingle width used for text with too few words. Defaults to 16. */
  characterShingleSize?: number
  /** Ignore a shingle occurring in more pages than this. Defaults to 64. */
  maxDocumentFrequency?: number
  /** Stop adding candidate pairs after this many. Defaults to 250,000. */
  maxCandidatePairs?: number
  /** Maximum duplicate pairs retained in the report. Defaults to 1,000. */
  maxReportedPairs?: number
}

export interface NearDuplicatePair {
  leftPageId: string
  leftPath: string
  rightPageId: string
  rightPath: string
  similarity: number
  intersectionSize: number
  unionSize: number
  exact: boolean
}

export interface NearDuplicateReport {
  algorithm: 'deterministic-shingle-jaccard-v1'
  threshold: number
  pageCount: number
  eligiblePageCount: number
  candidatePairCount: number
  comparedPairCount: number
  duplicatePairCount: number
  duplicatePageCount: number
  duplicatePageRate: number
  truncated: boolean
  pairs: NearDuplicatePair[]
}

interface PreparedPage {
  page: KnowledgePage
  normalized: string
  shingles: Set<string>
}

/**
 * Detect exact and near-duplicate pages without a model, embedding service, or clock.
 *
 * The detector uses word shingles when prose has enough tokens and Unicode
 * character shingles otherwise. An inverted index proposes candidate pairs;
 * high-document-frequency shingles are ignored so common boilerplate cannot
 * make candidate generation quadratic. Exact normalized copies are always
 * proposed before ordinary shingle candidates, even when every shingle is
 * common. Every limit and sort order is explicit so the same corpus produces
 * the same report on every run.
 */
export function detectNearDuplicatePages(
  pages: readonly KnowledgePage[],
  options: NearDuplicateDetectionOptions = {},
): NearDuplicateReport {
  const threshold = finiteUnitInterval(options.threshold ?? 0.82, 'threshold')
  const minCharacters = nonNegativeInteger(options.minCharacters ?? 80, 'minCharacters')
  const wordShingleSize = positiveInteger(options.wordShingleSize ?? 5, 'wordShingleSize')
  const characterShingleSize = positiveInteger(
    options.characterShingleSize ?? 16,
    'characterShingleSize',
  )
  const maxDocumentFrequency = positiveInteger(
    options.maxDocumentFrequency ?? 64,
    'maxDocumentFrequency',
  )
  const maxCandidatePairs = positiveInteger(
    options.maxCandidatePairs ?? 250_000,
    'maxCandidatePairs',
  )
  const maxReportedPairs = nonNegativeInteger(
    options.maxReportedPairs ?? 1_000,
    'maxReportedPairs',
  )

  const prepared = pages
    .map((page) => preparePage(page, wordShingleSize, characterShingleSize))
    .filter((item): item is PreparedPage => item !== null && item.normalized.length >= minCharacters)
    .sort((left, right) => left.page.path.localeCompare(right.page.path))

  const candidateKeys = new Set<string>()
  const exactGroups = new Map<string, number[]>()
  const byShingle = new Map<string, number[]>()
  for (const [index, item] of prepared.entries()) {
    exactGroups.set(item.normalized, [...(exactGroups.get(item.normalized) ?? []), index])
    for (const shingle of item.shingles) {
      byShingle.set(shingle, [...(byShingle.get(shingle) ?? []), index])
    }
  }

  let truncated = false
  const addPair = (left: number, right: number): boolean => {
    if (left === right) return true
    const key = pairKey(Math.min(left, right), Math.max(left, right))
    if (candidateKeys.has(key)) return true
    if (candidateKeys.size >= maxCandidatePairs) {
      truncated = true
      return false
    }
    candidateKeys.add(key)
    return true
  }

  for (const normalized of [...exactGroups.keys()].sort()) {
    if (!addGroupPairs(exactGroups.get(normalized)!, addPair)) break
  }
  if (!truncated) {
    for (const shingle of [...byShingle.keys()].sort()) {
      const group = byShingle.get(shingle)!
      if (group.length > maxDocumentFrequency) continue
      if (!addGroupPairs(group, addPair)) break
    }
  }

  const duplicatePageIndices = new Set<number>()
  const pairs: NearDuplicatePair[] = []
  let duplicatePairCount = 0
  let comparedPairCount = 0
  for (const key of [...candidateKeys].sort(pairKeyOrder)) {
    const [leftIndex, rightIndex] = parsePairKey(key)
    const left = prepared[leftIndex]!
    const right = prepared[rightIndex]!
    comparedPairCount += 1
    const exact = left.normalized === right.normalized
    const overlap = jaccard(left.shingles, right.shingles)
    if (!exact && overlap.similarity < threshold) continue
    duplicatePairCount += 1
    duplicatePageIndices.add(leftIndex)
    duplicatePageIndices.add(rightIndex)
    if (pairs.length >= maxReportedPairs) {
      truncated = true
      continue
    }
    pairs.push({
      leftPageId: left.page.id,
      leftPath: left.page.path,
      rightPageId: right.page.id,
      rightPath: right.page.path,
      similarity: exact ? 1 : round(overlap.similarity),
      intersectionSize: overlap.intersectionSize,
      unionSize: overlap.unionSize,
      exact,
    })
  }

  pairs.sort(
    (left, right) =>
      right.similarity - left.similarity ||
      left.leftPath.localeCompare(right.leftPath) ||
      left.rightPath.localeCompare(right.rightPath),
  )

  return {
    algorithm: 'deterministic-shingle-jaccard-v1',
    threshold,
    pageCount: pages.length,
    eligiblePageCount: prepared.length,
    candidatePairCount: candidateKeys.size,
    comparedPairCount,
    duplicatePairCount,
    duplicatePageCount: duplicatePageIndices.size,
    duplicatePageRate:
      prepared.length === 0 ? 0 : round(duplicatePageIndices.size / prepared.length),
    truncated,
    pairs,
  }
}

function preparePage(
  page: KnowledgePage,
  wordShingleSize: number,
  characterShingleSize: number,
): PreparedPage | null {
  const normalized = normalizePageText(`${page.title}\n${page.text}`)
  if (normalized.length === 0) return null
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? []
  const shingles =
    words.length >= wordShingleSize + 2
      ? sequenceShingles(words, wordShingleSize)
      : characterShingles(normalized.replace(/\s+/g, ''), characterShingleSize)
  if (shingles.size === 0) shingles.add(normalized)
  return { page, normalized, shingles }
}

export function normalizePageText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\s+/g, ' ')
    .trim()
}

function sequenceShingles(items: readonly string[], width: number): Set<string> {
  const out = new Set<string>()
  if (items.length < width) return out
  for (let index = 0; index <= items.length - width; index += 1) {
    out.add(items.slice(index, index + width).join('\u001f'))
  }
  return out
}

function characterShingles(value: string, width: number): Set<string> {
  const chars = [...value]
  const out = new Set<string>()
  if (chars.length < width) return out
  for (let index = 0; index <= chars.length - width; index += 1) {
    out.add(chars.slice(index, index + width).join(''))
  }
  return out
}

function addGroupPairs(
  group: readonly number[],
  add: (left: number, right: number) => boolean,
): boolean {
  for (let left = 0; left < group.length; left += 1) {
    for (let right = left + 1; right < group.length; right += 1) {
      if (!add(group[left]!, group[right]!)) return false
    }
  }
  return true
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): {
  similarity: number
  intersectionSize: number
  unionSize: number
} {
  const [small, large] = left.size <= right.size ? [left, right] : [right, left]
  let intersectionSize = 0
  for (const item of small) if (large.has(item)) intersectionSize += 1
  const unionSize = left.size + right.size - intersectionSize
  return {
    similarity: unionSize === 0 ? 1 : intersectionSize / unionSize,
    intersectionSize,
    unionSize,
  }
}

function pairKey(left: number, right: number): string {
  return `${left}:${right}`
}

function parsePairKey(value: string): [number, number] {
  const [left, right] = value.split(':')
  return [Number(left), Number(right)]
}

function pairKeyOrder(left: string, right: string): number {
  const [leftA, leftB] = parsePairKey(left)
  const [rightA, rightB] = parsePairKey(right)
  return leftA - rightA || leftB - rightB
}

function finiteUnitInterval(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a finite number in [0, 1]`)
  }
  return value
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
  return value
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`)
  }
  return value
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
