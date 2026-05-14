import { lintKnowledgeIndex } from './lint'
import { KnowledgeIndexSchema } from './schemas'
import type { KnowledgeIndex, KnowledgeLintFinding } from './types'

export interface ValidateKnowledgeOptions {
  strict?: boolean
}

export interface ValidateKnowledgeResult {
  ok: boolean
  findings: KnowledgeLintFinding[]
}

export function validateKnowledgeIndex(
  index: KnowledgeIndex,
  options: ValidateKnowledgeOptions = {},
): ValidateKnowledgeResult {
  const findings = [...lintKnowledgeIndex(index)]
  const parsed = KnowledgeIndexSchema.safeParse(index)
  if (!parsed.success) {
    findings.push({
      type: 'missing-frontmatter',
      severity: 'error',
      message: parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    })
  }
  if (options.strict) {
    for (const page of index.pages) {
      if (isStructuralPage(page.path)) continue
      if (!page.frontmatter.id || !page.frontmatter.title) {
        findings.push({
          type: 'missing-frontmatter',
          severity: 'error',
          page: page.path,
          message: 'Strict mode requires id and title frontmatter.',
        })
      }
    }
  }
  return { ok: !findings.some((finding) => finding.severity === 'error'), findings }
}

function isStructuralPage(path: string): boolean {
  return (
    path === 'knowledge/index.md' ||
    path === 'knowledge/log.md' ||
    path.endsWith('/index.md') ||
    path.endsWith('/log.md')
  )
}
