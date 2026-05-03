import type { KnowledgeWriteParseResult } from './types'

const OPENER_LINE = /^---\s*FILE:\s*(.+?)\s*---\s*$/i
const CLOSER_LINE = /^---\s*END\s+FILE\s*---\s*$/i
const FENCE_LINE = /^\s{0,3}(```+|~~~+)/

export function isSafeKnowledgePath(path: string, allowedPrefixes = ['knowledge/']): boolean {
  if (typeof path !== 'string' || path.trim() === '') return false
  if (/[\x00-\x1f]/.test(path)) return false
  if (path.startsWith('/') || path.startsWith('\\')) return false
  if (/^[a-zA-Z]:/.test(path)) return false
  const normalized = path.replace(/\\/g, '/')
  if (normalized.split('/').some((part) => part === '..')) return false
  return allowedPrefixes.some((prefix) => normalized.startsWith(prefix))
}

export function parseKnowledgeWriteBlocks(text: string, allowedPrefixes = ['knowledge/']): KnowledgeWriteParseResult {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: KnowledgeWriteParseResult['blocks'] = []
  const warnings: string[] = []
  let i = 0

  while (i < lines.length) {
    const opener = OPENER_LINE.exec(lines[i]!)
    if (!opener) {
      i++
      continue
    }
    const path = opener[1]!.trim()
    i++
    const contentLines: string[] = []
    let fenceMarker: string | null = null
    let fenceLen = 0
    let closed = false

    while (i < lines.length) {
      const line = lines[i]!
      const fence = FENCE_LINE.exec(line)
      if (fence) {
        const run = fence[1]!
        const char = run[0]!
        if (fenceMarker === null) {
          fenceMarker = char
          fenceLen = run.length
        } else if (char === fenceMarker && run.length >= fenceLen) {
          fenceMarker = null
          fenceLen = 0
        }
        contentLines.push(line)
        i++
        continue
      }
      if (fenceMarker === null && CLOSER_LINE.test(line)) {
        closed = true
        i++
        break
      }
      contentLines.push(line)
      i++
    }

    if (!closed) {
      warnings.push(`FILE block "${path || '(empty)'}" was not closed before end of stream.`)
      continue
    }
    if (!isSafeKnowledgePath(path, allowedPrefixes)) {
      warnings.push(`FILE block with unsafe path "${path}" rejected.`)
      continue
    }
    blocks.push({ path, content: contentLines.join('\n') })
  }

  return { blocks, warnings }
}
