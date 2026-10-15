import { lintKnowledgeIndex } from './lint'
import { KnowledgeIndexSchema } from './schemas'
import { isScaffoldPath } from './store'
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
  return prepareKnowledgeValidation(index).validate(options)
}

/** One observation's lint/schema findings; strictness is a caller-owned policy. */
export function prepareKnowledgeValidation(index: KnowledgeIndex) {
  const lintFindings = lintKnowledgeIndex(index)
  const findings = [...lintFindings]
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
  return {
    lintFindings,
    validate(options: ValidateKnowledgeOptions = {}): ValidateKnowledgeResult {
      const result = [...findings]
      if (options.strict) {
        for (const page of index.pages) {
          if (isScaffoldPath(page.path)) continue
          if (!page.frontmatter.id || !page.frontmatter.title) {
            result.push({
              type: 'missing-frontmatter',
              severity: 'error',
              page: page.path,
              message: 'Strict mode requires id and title frontmatter.',
            })
          }
        }
      }
      return { ok: !result.some((finding) => finding.severity === 'error'), findings: result }
    },
  }
}
