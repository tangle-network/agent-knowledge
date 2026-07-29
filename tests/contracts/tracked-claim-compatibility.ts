import type { ResearchClaimRecord, TrackedClaim } from '../../src/index'

/** Published live-driver callers retain the Set operations available in 6.1.11. */
export function inspectAndExtendTrackedClaim(claim: TrackedClaim): number {
  if (!claim.supportingHosts.has('example.org')) claim.supportingHosts.add('example.org')
  if (!claim.contradicts.has('c_other')) claim.contradicts.add('c_other')
  return claim.supportingHosts.size + claim.contradicts.size
}

/** Durable records remain ordinary JSON arrays. */
export function countDurableClaimEvidence(claim: ResearchClaimRecord): number {
  return claim.supportingHosts.length + claim.contradicts.length
}
