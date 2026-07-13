import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { addSourcePath, loadSourceRegistry } from '../src/sources'
import { initKnowledgeBase } from '../src/store'

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agent-knowledge-sources-'))
  try {
    await initKnowledgeBase(root)
    await fn(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('source path ingestion', () => {
  it.skipIf(process.platform === 'win32')(
    'rejects unsupported directory entries without partial raw or registry writes',
    async () => {
      await withRoot(async (root) => {
        const sourceDir = join(root, 'source-dir')
        await mkdir(sourceDir)
        await writeFile(join(sourceDir, 'good.txt'), 'good source\n')
        await symlink(join(sourceDir, 'good.txt'), join(sourceDir, 'linked.txt'))
        const originalRegistry = await readFile(
          join(root, '.agent-knowledge', 'sources.json'),
          'utf8',
        )

        await expect(addSourcePath(root, sourceDir)).rejects.toThrow(/unsupported directory entry/)

        await expect(
          readFile(join(root, '.agent-knowledge', 'sources.json'), 'utf8'),
        ).resolves.toBe(originalRegistry)
        await expect(readdir(join(root, 'raw', 'sources'))).resolves.toEqual([])
      })
    },
  )

  it.skipIf(process.platform === 'win32')(
    'preserves source file modes for single-file and directory imports',
    async () => {
      await withRoot(async (root) => {
        const singlePath = join(root, 'single.txt')
        await writeFile(singlePath, 'single source\n')
        await chmod(singlePath, 0o640)

        const dir = join(root, 'batch')
        await mkdir(dir)
        const batchPath = join(dir, 'script.txt')
        await writeFile(batchPath, 'batch source\n')
        await chmod(batchPath, 0o750)

        const [single] = await addSourcePath(root, singlePath)
        const [batch] = await addSourcePath(root, dir)

        expect((await stat(join(root, single!.uri))).mode & 0o777).toBe(0o640)
        expect((await stat(join(root, batch!.uri))).mode & 0o777).toBe(0o750)
        expect((await loadSourceRegistry(root)).sources.map((source) => source.id).sort()).toEqual(
          [single!.id, batch!.id].sort(),
        )
      })
    },
  )
})
