import type { AgentMemoryHit } from './types'

/** Merges independently ranked memory lists without letting the first unscored list dominate. */
export function mergeRankedMemoryHits(
  groups: readonly (readonly AgentMemoryHit[])[],
  limit?: number,
): AgentMemoryHit[] {
  const byIdentity = new Map<
    string,
    {
      hit: AgentMemoryHit
      score?: number
      reciprocalRank: number
      bestRank: number
      firstGroup: number
      encounter: number
    }
  >()
  let encounter = 0
  for (const [groupIndex, group] of groups.entries()) {
    for (const [rank, hit] of group.entries()) {
      const key = `${hit.uri}\n${hit.text}`
      const score = memoryHitScore(hit)
      const prior = byIdentity.get(key)
      if (!prior) {
        byIdentity.set(key, {
          hit,
          score,
          reciprocalRank: 1 / (60 + rank + 1),
          bestRank: rank,
          firstGroup: groupIndex,
          encounter,
        })
      } else {
        prior.reciprocalRank += 1 / (60 + rank + 1)
        prior.bestRank = Math.min(prior.bestRank, rank)
        if (score !== undefined && (prior.score === undefined || score > prior.score)) {
          prior.hit = hit
          prior.score = score
        }
      }
      encounter += 1
    }
  }
  return [...byIdentity.values()]
    .sort(
      (left, right) =>
        right.reciprocalRank - left.reciprocalRank ||
        Number(right.score !== undefined) - Number(left.score !== undefined) ||
        (right.score ?? 0) - (left.score ?? 0) ||
        left.bestRank - right.bestRank ||
        left.firstGroup - right.firstGroup ||
        left.encounter - right.encounter,
    )
    .map(({ hit }) => hit)
    .slice(0, limit ?? Number.POSITIVE_INFINITY)
}

function memoryHitScore(hit: AgentMemoryHit): number | undefined {
  const score = hit.normalizedScore ?? hit.score
  return score !== undefined && Number.isFinite(score) ? score : undefined
}
