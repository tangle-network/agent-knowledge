/**
 * Bridge from `AnalystFinding` (agent-eval) to knowledge proposals.
 *
 * Closes the failure → wiki side of the recursive-self-improvement
 * loop: a knowledge-gap or knowledge-poisoning finding produced by an
 * analyst becomes a concrete proposal an operator (or auto-merge bot)
 * can review and apply. The bridge is intentionally lossless on the
 * fail-loud side — a finding the parser can't classify returns a
 * `KnowledgeProposalParseError` rather than a silent skip, so the
 * loop never accepts an underspecified edit.
 *
 * Subject grammar this bridge understands (analyst-side convention,
 * stamped in the kind prompts):
 *
 *   agent-knowledge:wiki:<page-slug>            create / update page
 *   agent-knowledge:wiki:<page-slug>#<heading>  insert section under page
 *   agent-knowledge:claim:<topic>               draft claim row
 *   agent-knowledge:raw:<source-id>             lift raw → curated
 *   agent-knowledge:stale:<page-slug>           mark page superseded
 *
 * Anything else (websearch:outdated:*, tool-doc:*, system-prompt:*,
 * memory:*) is NOT a knowledge-base concern and returns `null` so the
 * loop's improvement-applier handles it.
 */

import type { AnalystFinding, AnalystSeverity } from '@tangle-network/agent-eval'
import type { ClaimRef, KnowledgeClaim, KnowledgeWriteBlock } from './types'

export interface KnowledgeProposal {
  /**
   * Stable id derived from the finding so cross-run diffs share an
   * identity. Re-proposing the same finding produces the same id.
   */
  id: string
  /** The finding that generated this proposal — useful for audit + revert. */
  sourceFindingId: string
  /** What the proposal does. */
  kind:
    | 'create-page'
    | 'update-page'
    | 'append-section'
    | 'create-claim'
    | 'lift-raw'
    | 'mark-stale'
  /** Locus on disk (page slug or claim topic). */
  locus: string
  /**
   * Page write blocks the standard `applyKnowledgeWriteBlocks` consumer
   * accepts. Empty for proposals that don't change page text (e.g.
   * `create-claim` produces a `claim` field instead).
   */
  writeBlocks: KnowledgeWriteBlock[]
  /**
   * Granular claim draft for proposals whose unit-of-change is a claim
   * row rather than a whole page. `status: 'draft'` until reviewed.
   */
  claim?: KnowledgeClaim
  /** Per-proposal metadata: severity, confidence, source span. */
  metadata: {
    severity: AnalystSeverity
    confidence: number
    evidence_uri?: string
    analyst_id: string
  }
}

export class KnowledgeProposalParseError extends Error {
  constructor(
    public readonly findingId: string,
    public readonly subject: string,
    message: string,
  ) {
    super(`proposeFromFinding(${findingId}, subject=${subject}): ${message}`)
    this.name = 'KnowledgeProposalParseError'
  }
}

/**
 * Convert one `AnalystFinding` into a knowledge proposal. Returns
 * `null` when the finding's locus isn't a knowledge-base concern
 * (`websearch:outdated:*`, `tool-doc:*`, `system-prompt:*`,
 * `memory:*`, missing subject). Throws when the locus IS a
 * knowledge-base concern but is malformed — that's a bug in the
 * analyst prompt and should fail loud.
 *
 * Caller convention: feed the function the analyst's full findings
 * list and filter out the `null`s; the orchestrator passes the
 * remaining proposals to the existing review / apply pipeline.
 */
export function proposeFromFinding(finding: AnalystFinding): KnowledgeProposal | null {
  if (!finding.subject) return null
  if (!finding.subject.startsWith('agent-knowledge:')) return null

  const rest = finding.subject.slice('agent-knowledge:'.length)
  const [kindPart, ...locusParts] = rest.split(':')
  const locus = locusParts.join(':')
  if (!kindPart || !locus) {
    throw new KnowledgeProposalParseError(
      finding.finding_id,
      finding.subject,
      'expected `agent-knowledge:<kind>:<locus>` shape',
    )
  }

  const baseMeta: KnowledgeProposal['metadata'] = {
    severity: finding.severity,
    confidence: finding.confidence,
    evidence_uri: finding.evidence_refs[0]?.uri,
    analyst_id: finding.analyst_id,
  }

  switch (kindPart) {
    case 'wiki':
      return wikiProposal(finding, locus, baseMeta)
    case 'claim':
      return claimProposal(finding, locus, baseMeta)
    case 'raw':
      return liftRawProposal(finding, locus, baseMeta)
    case 'stale':
      return markStaleProposal(finding, locus, baseMeta)
    default:
      throw new KnowledgeProposalParseError(
        finding.finding_id,
        finding.subject,
        `unknown kind "${kindPart}" (expected one of: wiki | claim | raw | stale)`,
      )
  }
}

function wikiProposal(
  finding: AnalystFinding,
  locus: string,
  metadata: KnowledgeProposal['metadata'],
): KnowledgeProposal {
  const hashIdx = locus.indexOf('#')
  const pageSlug = hashIdx >= 0 ? locus.slice(0, hashIdx) : locus
  const heading = hashIdx >= 0 ? locus.slice(hashIdx + 1) : null
  const path = `knowledge/${ensureSlug(pageSlug)}.md`

  const body = renderWikiBody(finding, pageSlug, heading)
  return {
    id: `prop-${finding.finding_id}`,
    sourceFindingId: finding.finding_id,
    kind: heading ? 'append-section' : 'create-page',
    locus: pageSlug,
    writeBlocks: [{ path, content: body }],
    metadata,
  }
}

function claimProposal(
  finding: AnalystFinding,
  locus: string,
  metadata: KnowledgeProposal['metadata'],
): KnowledgeProposal {
  const refs: ClaimRef[] = finding.evidence_refs
    .filter((r) => r.uri)
    .map((r) => ({
      sourceId: `analyst-finding:${finding.finding_id}`,
      anchorId: r.uri,
      quote: r.excerpt,
    }))
  const claim: KnowledgeClaim = {
    id: `claim-${finding.finding_id}`,
    text: finding.recommended_action ?? finding.claim,
    refs,
    confidence: finding.confidence,
    status: 'draft',
    metadata: {
      analyst_id: finding.analyst_id,
      source_finding_id: finding.finding_id,
      topic: locus,
    },
  }
  return {
    id: `prop-${finding.finding_id}`,
    sourceFindingId: finding.finding_id,
    kind: 'create-claim',
    locus,
    writeBlocks: [],
    claim,
    metadata,
  }
}

function liftRawProposal(
  finding: AnalystFinding,
  sourceId: string,
  metadata: KnowledgeProposal['metadata'],
): KnowledgeProposal {
  const path = `knowledge/${ensureSlug(sourceId)}.md`
  const body = [
    '---',
    `title: ${sourceId}`,
    `source: ${sourceId}`,
    `status: draft`,
    `lifted_from_finding: ${finding.finding_id}`,
    '---',
    '',
    '## Why this page exists',
    '',
    finding.claim,
    '',
    ...(finding.rationale ? ['## Rationale', '', finding.rationale, ''] : []),
    ...(finding.recommended_action
      ? ['## Recommended action', '', finding.recommended_action, '']
      : []),
  ].join('\n')
  return {
    id: `prop-${finding.finding_id}`,
    sourceFindingId: finding.finding_id,
    kind: 'lift-raw',
    locus: sourceId,
    writeBlocks: [{ path, content: body }],
    metadata,
  }
}

function markStaleProposal(
  finding: AnalystFinding,
  pageSlug: string,
  metadata: KnowledgeProposal['metadata'],
): KnowledgeProposal {
  const path = `knowledge/${ensureSlug(pageSlug)}.stale.md`
  const body = [
    '---',
    `title: ${pageSlug} (marked stale)`,
    `status: superseded`,
    `superseded_by_finding: ${finding.finding_id}`,
    `confidence: ${finding.confidence}`,
    '---',
    '',
    '## Why marked stale',
    '',
    finding.claim,
    '',
    ...(finding.rationale ? ['## Evidence', '', finding.rationale, ''] : []),
    ...(finding.recommended_action ? ['## Action', '', finding.recommended_action, ''] : []),
  ].join('\n')
  return {
    id: `prop-${finding.finding_id}`,
    sourceFindingId: finding.finding_id,
    kind: 'mark-stale',
    locus: pageSlug,
    writeBlocks: [{ path, content: body }],
    metadata,
  }
}

/**
 * Plural convenience: filter + map across an entire findings batch
 * with one call. Parse errors collect into `errors[]`; the loop
 * decides per-error whether to abort or continue.
 */
export interface ProposeFromFindingsResult {
  proposals: KnowledgeProposal[]
  skipped: number
  errors: KnowledgeProposalParseError[]
}

export function proposeFromFindings(
  findings: ReadonlyArray<AnalystFinding>,
): ProposeFromFindingsResult {
  const proposals: KnowledgeProposal[] = []
  const errors: KnowledgeProposalParseError[] = []
  let skipped = 0
  for (const f of findings) {
    try {
      const p = proposeFromFinding(f)
      if (p) proposals.push(p)
      else skipped += 1
    } catch (err) {
      if (err instanceof KnowledgeProposalParseError) errors.push(err)
      else throw err
    }
  }
  return { proposals, skipped, errors }
}

function ensureSlug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 200) || 'untitled'
  )
}

function renderWikiBody(finding: AnalystFinding, slug: string, heading: string | null): string {
  const title = humanize(slug)
  if (heading) {
    return [
      `## ${heading}`,
      '',
      finding.claim,
      '',
      ...(finding.rationale ? ['### Rationale', '', finding.rationale, ''] : []),
      ...(finding.recommended_action ? ['### Action', '', finding.recommended_action, ''] : []),
      `_Drafted from finding ${finding.finding_id} (confidence ${finding.confidence.toFixed(2)})._`,
    ].join('\n')
  }
  return [
    '---',
    `title: ${title}`,
    `status: draft`,
    `drafted_from_finding: ${finding.finding_id}`,
    `confidence: ${finding.confidence}`,
    '---',
    '',
    `# ${title}`,
    '',
    finding.claim,
    '',
    ...(finding.rationale ? ['## Rationale', '', finding.rationale, ''] : []),
    ...(finding.recommended_action
      ? ['## Recommended action', '', finding.recommended_action, '']
      : []),
  ].join('\n')
}

function humanize(slug: string): string {
  return (
    slug
      .split('-')
      .filter(Boolean)
      .map((w) => w[0]?.toUpperCase() + w.slice(1))
      .join(' ') || slug
  )
}
