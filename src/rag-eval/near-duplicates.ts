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
  const { threshold, minCharacters, wordShingleSize, characterShingleSize, maxDocumentFrequency } =
    settings(options)
  const maxCandidatePairs = positiveInteger(
    options.maxCandidatePairs ?? 250_000,
    'maxCandidatePairs',
  )
  const maxReportedPairs = nonNegativeInteger(options.maxReportedPairs ?? 1_000, 'maxReportedPairs')

  const prepared = pages
    .map((page) => preparePage(page, wordShingleSize, characterShingleSize))
    .filter(
      (item): item is PreparedPage => item !== null && item.normalized.length >= minCharacters,
    )
    .sort((left, right) => left.page.path.localeCompare(right.page.path))

  // Pair keys are left * pageCount + right, so numeric order is (left, right) order.
  const candidateKeys = new Set<number>()
  const exactGroups = new Map<string, number[]>()
  const byShingle = new Map<string, number[]>()
  const group = (groups: Map<string, number[]>, key: string) =>
    groups.get(key) ?? groups.set(key, []).get(key)!
  for (const [index, item] of prepared.entries()) {
    group(exactGroups, item.normalized).push(index)
    for (const shingle of item.shingles) group(byShingle, shingle).push(index)
  }

  let truncated = false
  const addPair = (left: number, right: number): boolean => {
    if (left === right) return true
    const key = Math.min(left, right) * prepared.length + Math.max(left, right)
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
  for (const key of [...candidateKeys].sort((left, right) => left - right)) {
    const leftIndex = Math.floor(key / prepared.length)
    const rightIndex = key % prepared.length
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

function settings(options: NearDuplicateDetectionOptions) {
  return {
    threshold: finiteUnitInterval(options.threshold ?? 0.82, 'threshold'),
    minCharacters: nonNegativeInteger(options.minCharacters ?? 80, 'minCharacters'),
    wordShingleSize: positiveInteger(options.wordShingleSize ?? 5, 'wordShingleSize'),
    characterShingleSize: positiveInteger(
      options.characterShingleSize ?? 16,
      'characterShingleSize',
    ),
    maxDocumentFrequency: positiveInteger(
      options.maxDocumentFrequency ?? 64,
      'maxDocumentFrequency',
    ),
  }
}

type Sketch = { length: number; exact: number; hashes: Uint32Array }
const sketches = new Map<string, WeakMap<KnowledgePage, Sketch | null>>()

/**
 * Every pair between a candidate and another page of `pages` (which holds the candidates) at or
 * above the threshold. A pair qualifies as in `detectNearDuplicatePages`, an exact normalized copy
 * or a shared shingle held by at most `maxDocumentFrequency` pages, but no pair cap applies: only
 * the candidates' shingles index the corpus, as sorted 32-bit shingle hashes kept per frozen page.
 */
export function detectCandidateNearDuplicates(
  candidates: readonly KnowledgePage[],
  pages: readonly KnowledgePage[],
  options: NearDuplicateDetectionOptions = {},
) {
  const config = settings(options)
  const key = `${config.wordShingleSize}:${config.characterShingleSize}`
  const cache = sketches.get(key) ?? sketches.set(key, new WeakMap()).get(key)!
  const sketchOf = (page: KnowledgePage): Sketch | null => {
    let sketch = cache.get(page)
    if (sketch === undefined) {
      const item = preparePage(page, config.wordShingleSize, config.characterShingleSize)
      const sorted = Uint32Array.from(item?.shingles ?? [], hash32).sort()
      sketch = item && {
        length: item.normalized.length,
        exact: hash32(item.normalized),
        hashes: sorted.filter((value, index) => index === 0 || sorted[index - 1] !== value),
      }
      if (Object.isFrozen(page)) cache.set(page, sketch)
    }
    return sketch && sketch.length >= config.minCharacters ? sketch : null
  }
  const eligible = pages
    .flatMap((page) => {
      const sketch = sketchOf(page)
      return sketch ? [{ page, sketch }] : []
    })
    .sort((left, right) => left.page.path.localeCompare(right.page.path))
  const position = new Map(eligible.map((entry, index) => [entry.page, index]))
  // Pages holding each candidate shingle, and, under its complement, each candidate's exact text.
  const holders = new Map<number, number[]>()
  for (const candidate of candidates.filter((page) => position.has(page))) {
    const sketch = eligible[position.get(candidate)!]!.sketch
    for (const hash of [~sketch.exact, ...sketch.hashes]) holders.set(hash, [])
  }
  for (const [index, { sketch }] of eligible.entries()) {
    holders.get(~sketch.exact)?.push(index)
    for (const hash of sketch.hashes) {
      const group = holders.get(hash)
      if (group && group.length <= config.maxDocumentFrequency) group.push(index)
    }
  }
  const text = (page: KnowledgePage) => normalizePageText(`${page.title}\n${page.text}`)
  const pairs = candidates.flatMap((candidate) => {
    const self = position.get(candidate)
    if (self === undefined) return []
    const { sketch } = eligible[self]!
    const matches = new Set(holders.get(~sketch.exact))
    for (const hash of sketch.hashes) {
      const group = holders.get(hash)!
      if (group.length <= config.maxDocumentFrequency) for (const index of group) matches.add(index)
    }
    // A pair of two candidates is reported once, from the candidate whose path sorts first.
    return [...matches].flatMap((index) => {
      const matched = eligible[index]!
      if (index === self || (index < self && candidates.includes(matched.page))) return []
      const exact = matched.sketch.exact === sketch.exact && text(matched.page) === text(candidate)
      const { similarity } = sortedJaccard(sketch.hashes, matched.sketch.hashes)
      if (!exact && similarity < config.threshold) return []
      return [
        { candidate, matched: matched.page, similarity: exact ? 1 : round(similarity), exact },
      ]
    })
  })
  return { threshold: config.threshold, pairs }
}

function hash32(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193)
  }
  return hash >>> 0
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

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>) {
  const [small, large] = left.size <= right.size ? [left, right] : [right, left]
  let intersectionSize = 0
  for (const item of small) if (large.has(item)) intersectionSize += 1
  return overlap(left.size, right.size, intersectionSize)
}

function sortedJaccard(left: Uint32Array, right: Uint32Array) {
  let shared = 0
  for (let i = 0, j = 0; i < left.length && j < right.length; ) {
    if (left[i] === right[j]) shared += 1
    const step = left[i]! - right[j]!
    if (step <= 0) i += 1
    if (step >= 0) j += 1
  }
  return overlap(left.length, right.length, shared)
}

function overlap(left: number, right: number, intersectionSize: number) {
  const unionSize = left + right - intersectionSize
  return {
    similarity: unionSize === 0 ? 1 : intersectionSize / unionSize,
    intersectionSize,
    unionSize,
  }
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
