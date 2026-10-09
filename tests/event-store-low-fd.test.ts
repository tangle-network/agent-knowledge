import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { FileSystemKbStore } from '../src/kb-store'

it.skipIf(process.platform !== 'linux')(
  'migrates and fully reads 1000 events under 256 descriptors',
  async () => {
    if (process.env.KNOWLEDGE_LOW_FD_TEST !== '1') {
      const result = await promisify(execFile)(
        'bash',
        [
          '-c',
          'ulimit -n 256; exec "$1" "$2" run tests/event-store-low-fd.test.ts --maxWorkers 1 --testTimeout 60000',
          'bash',
          process.execPath,
          resolve('node_modules/vitest/vitest.mjs'),
        ],
        {
          env: { ...process.env, KNOWLEDGE_LOW_FD_TEST: '1' },
          timeout: 70000,
          maxBuffer: 1024 * 1024,
        },
      )
      expect(result.stdout).toContain('1 passed')
      return
    }
    const root = await mkdtemp(join(tmpdir(), 'knowledge-low-fd-'))
    try {
      await mkdir(join(root, '.agent-knowledge'))
      const events = Array.from({ length: 1000 }, (_, i) => ({
        id: `event-${i}`,
        type: 'index.built' as const,
        createdAt: String(i).padStart(5, '0'),
      }))
      await writeFile(join(root, '.agent-knowledge/events.json'), JSON.stringify(events))
      const store = new FileSystemKbStore({ root })
      const added = { id: 'added', type: 'index.built' as const, createdAt: '99999' }
      await store.putEvent(added)
      expect(await store.listEvents({ limit: 5 })).toEqual([...events.slice(-4), added])
      expect(await store.listEvents()).toEqual([...events, added])
      const reopened = new FileSystemKbStore({ root })
      await reopened.putEvent({ ...added, createdAt: '00000' })
      expect(await reopened.listEvents()).toHaveLength(1001)
      expect((await reopened.listEvents({ limit: 1 }))[0]?.id).toBe('event-999')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  75000,
)
