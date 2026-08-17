import {
  auditCurrentRunCitations,
  type KnowledgeCitationAuditIssue,
  type KnowledgeCitationAuditReport,
} from './citation-resolution'
import type { RunScopedStores } from './run-scoped'
import type { KnowledgeLintFinding } from './types'

/** Convert a chain-aware citation audit into the package lint vocabulary. */
export function knowledgeCitationAuditFindings(
  report: KnowledgeCitationAuditReport,
): KnowledgeLintFinding[] {
  return report.issues.map(issueToFinding)
}

/** Lint only current-run pages against their complete declared visibility chain. */
export async function lintCurrentRunCitations(
  stores: RunScopedStores,
  runId: string,
): Promise<KnowledgeLintFinding[]> {
  return knowledgeCitationAuditFindings(await auditCurrentRunCitations(stores, runId))
}

function issueToFinding(issue: KnowledgeCitationAuditIssue): KnowledgeLintFinding {
  const candidates = issue.candidates.map((candidate) => ({
    pageId: candidate.pageId,
    path: candidate.page.path,
    origin: candidate.origin,
  }))
  if (issue.kind === 'ambiguous') {
    return {
      type: 'ambiguous-citation',
      severity: 'error',
      page: issue.sourcePath,
      message:
        `Citation "${issue.persistedCitation}" resolves to ${issue.candidates.length} visible pages; ` +
        'qualify it as here::<pageId>, inherited:<runId>::<pageId>, or shared::<pageId>.',
      metadata: {
        sourcePageId: issue.sourcePageId,
        sourceOrigin: issue.sourceOrigin,
        candidates,
      },
    }
  }
  return {
    type: 'broken-citation',
    severity: 'error',
    page: issue.sourcePath,
    message:
      issue.kind === 'self'
        ? `Page "${issue.sourcePageId}" cites itself through "${issue.persistedCitation}".`
        : `Citation "${issue.persistedCitation}" resolves to no visible page.`,
    metadata: {
      sourcePageId: issue.sourcePageId,
      sourceOrigin: issue.sourceOrigin,
      candidates,
    },
  }
}
