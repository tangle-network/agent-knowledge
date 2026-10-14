import { execFile } from 'node:child_process'
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import lockfile from 'proper-lockfile'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readRegularFileWithinRoot,
  withSafeDirectory,
  writeJsonDurableWithinRoot,
} from '../src/durable-fs'
import { withKnowledgeMutation, withKnowledgeRead } from '../src/mutation-lock'

const OWNER = 'mutation.lock.owner.json'
const owner = { label: 'external holder', pid: 123, host: 'test-host', since: 0 }
let directory: string
let root: string
let cache: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'knowledge-owner-confinement-'))
  root = join(directory, 'root')
  cache = join(root, '.agent-knowledge')
  await mkdir(cache, { recursive: true })
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function withExternalLock(body: () => Promise<void>): Promise<void> {
  const release = await lockfile.lock(root, {
    realpath: false,
    lockfilePath: join(cache, 'mutation.lock.durable'),
  })
  try {
    await writeFile(join(cache, 'mutation-epoch.json'), JSON.stringify({ epoch: 1 }))
    await body()
  } finally {
    await release()
  }
}

async function expectAnonymousTimeouts(): Promise<void> {
  await expect(
    withKnowledgeMutation(root, () => 'must not enter', { retries: 0 }),
  ).rejects.toMatchObject({
    code: 'ELOCKED',
    message: expect.stringContaining('recorded no owner'),
  })
  await expect(withKnowledgeRead(root, () => 'must not enter', { retries: 0 })).rejects.toThrow(
    /knowledge read could not observe a stable mutation epoch: .*recorded no owner/,
  )
}

describe('advisory lock owner confinement', () => {
  it.skipIf(process.platform === 'win32')(
    'does not overwrite a sibling sentinel through an owner symlink',
    async () => {
      const sentinel = join(directory, 'sentinel.json')
      await writeFile(sentinel, 'unchanged sentinel\n')
      await symlink(sentinel, join(cache, OWNER))

      await expect(withKnowledgeMutation(root, () => 'written')).resolves.toBe('written')

      expect(await readFile(sentinel, 'utf8')).toBe('unchanged sentinel\n')
      expect((await lstat(join(cache, OWNER))).isSymbolicLink()).toBe(true)
      expect((await readdir(directory)).sort()).toEqual(['root', 'sentinel.json'])
      expect(JSON.parse(await readFile(join(cache, 'mutation-epoch.json'), 'utf8')).epoch).toBe(2)
      await expect(withKnowledgeMutation(root, () => 'reacquired')).resolves.toBe('reacquired')
      expect(await readFile(sentinel, 'utf8')).toBe('unchanged sentinel\n')
    },
  )

  it.skipIf(process.platform === 'win32')(
    'does not attribute timeouts to a symlinked owner',
    async () => {
      const sentinel = join(directory, 'sentinel.json')
      const bytes = JSON.stringify(owner)
      await writeFile(sentinel, bytes)
      await symlink(sentinel, join(cache, OWNER))
      await withExternalLock(expectAnonymousTimeouts)
      expect(await readFile(sentinel, 'utf8')).toBe(bytes)
    },
  )

  it.each([
    '{',
    'null',
    JSON.stringify({ ...owner, since: 1e100 }),
    JSON.stringify({ ...owner, since: -1e100 }),
  ])('keeps the intended lock errors for invalid owner JSON %s', async (bytes) => {
    await writeFile(join(cache, OWNER), bytes)
    await withExternalLock(expectAnonymousTimeouts)
  })

  it('still names a valid cross-process owner', async () => {
    await writeFile(join(cache, OWNER), JSON.stringify(owner))
    await withExternalLock(async () => {
      await expect(
        withKnowledgeMutation(root, () => undefined, { retries: 0 }),
      ).rejects.toMatchObject({
        code: 'ELOCKED',
        message: expect.stringContaining(
          'external holder (pid 123 on test-host, holding since 1970-01-01T00:00:00.000Z',
        ),
      })
    })
  })

  it('keeps an unwritable owner diagnostic nonfatal', async () => {
    await mkdir(join(cache, OWNER))
    await expect(withKnowledgeMutation(root, () => 'written')).resolves.toBe('written')
    await withExternalLock(expectAnonymousTimeouts)
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a symlinked cache parent without touching its target',
    async () => {
      const outside = join(directory, 'outside')
      await mkdir(outside)
      await writeFile(join(outside, OWNER), 'unchanged sentinel\n')
      await rm(cache, { recursive: true })
      await symlink(outside, cache)
      await expect(withKnowledgeMutation(root, () => undefined)).rejects.toThrow(/unsafe directory/)
      expect(await readFile(join(outside, OWNER), 'utf8')).toBe('unchanged sentinel\n')
    },
  )

  it.skipIf(process.platform === 'win32')(
    'retains the canonical-root contract for a symlinked root',
    async () => {
      const alias = join(directory, 'root-alias')
      await symlink(root, alias)
      await expect(withKnowledgeMutation(alias, () => 'written')).resolves.toBe('written')
      expect(JSON.parse(await readFile(join(cache, OWNER), 'utf8')).pid).toBe(process.pid)
    },
  )

  it.skipIf(process.platform !== 'linux')(
    'retains an opened cache anchor when its parent is swapped',
    async () => {
      const outside = join(directory, 'outside')
      const moved = join(root, 'original-cache')
      await mkdir(outside)
      await writeFile(join(outside, OWNER), 'unchanged sentinel\n')
      await withSafeDirectory(root, '.agent-knowledge', false, async (anchored) => {
        await rename(cache, moved)
        await symlink(outside, cache)
        await writeJsonDurableWithinRoot(anchored, OWNER, owner)
        expect(
          JSON.parse((await readRegularFileWithinRoot(anchored, OWNER)).bytes.toString('utf8')),
        ).toEqual(owner)
      })
      expect(await readFile(join(outside, OWNER), 'utf8')).toBe('unchanged sentinel\n')
      expect(JSON.parse(await readFile(join(moved, OWNER), 'utf8'))).toEqual(owner)
    },
  )

  it.skipIf(process.platform === 'win32')(
    'rejects a FIFO diagnostic without blocking a timeout or mutation',
    async () => {
      await promisify(execFile)('mkfifo', [join(cache, OWNER)])
      const script = fileURLToPath(new URL('./support/lock-owner-process.mjs', import.meta.url))
      // The OS process is bounded so a regression in open(2) cannot wedge the test runner's pool.
      const result = await promisify(execFile)(
        process.execPath,
        ['--experimental-transform-types', '--no-warnings', script, root],
        {
          timeout: 5_000,
        },
      )
      expect(result.stdout).toContain('owner checks passed')
    },
    10_000,
  )
})
