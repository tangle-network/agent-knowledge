import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseKnowledgeWriteBlocks } from './write-protocol'

export interface ApplyWriteBlocksResult {
  written: string[]
  warnings: string[]
}

export async function applyKnowledgeWriteBlocks(
  root: string,
  proposalText: string,
): Promise<ApplyWriteBlocksResult> {
  const parsed = parseKnowledgeWriteBlocks(proposalText)
  const written: string[] = []
  for (const block of parsed.blocks) {
    const path = join(root, block.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      block.content.endsWith('\n') ? block.content : `${block.content}\n`,
      'utf8',
    )
    written.push(block.path)
  }
  return { written, warnings: parsed.warnings }
}

export async function applyKnowledgeWriteBlocksFile(
  root: string,
  proposalPath: string,
): Promise<ApplyWriteBlocksResult> {
  return applyKnowledgeWriteBlocks(root, await readFile(proposalPath, 'utf8'))
}
