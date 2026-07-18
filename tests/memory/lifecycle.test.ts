import { describe, expect, it } from 'vitest'
import { type AgentMemoryHit, runBoundedMemoryLifecycle } from '../../src/memory/index'
import { mergeRankedMemoryHits } from '../../src/memory/rank'

describe('memory lifecycle', () => {
  it('blocks later operations until timed-out work on the same adapter settles', async () => {
    const resource = {}
    const abortController = new AbortController()
    let release: (() => void) | undefined
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    let laterRuns = 0

    await expect(
      runBoundedMemoryLifecycle({
        operation: 'slow clear',
        timeoutMs: 5,
        resource,
        abortController,
        run: () => pending,
      }),
    ).rejects.toThrow('slow clear did not finish within 5ms')
    expect(abortController.signal.aborted).toBe(true)
    await expect(
      runBoundedMemoryLifecycle({
        operation: 'unsafe close',
        timeoutMs: 5,
        resource,
        run: () => {
          laterRuns += 1
        },
      }),
    ).rejects.toThrow("unsafe close cannot start because 'slow clear' is still running")
    expect(laterRuns).toBe(0)

    release?.()
    await pending
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await runBoundedMemoryLifecycle({
      operation: 'settled close',
      timeoutMs: 5,
      resource,
      run: () => {
        laterRuns += 1
      },
    })
    expect(laterRuns).toBe(1)
  })

  it('keeps URI and text pairs distinct when newline-delimited identities collide', () => {
    const first: AgentMemoryHit = {
      id: 'first',
      uri: 'memory://provider/a\nb',
      kind: 'fact',
      text: 'c',
    }
    const second: AgentMemoryHit = {
      id: 'second',
      uri: 'memory://provider/a',
      kind: 'fact',
      text: 'b\nc',
    }

    expect(mergeRankedMemoryHits([[first], [second]]).map((hit) => hit.id)).toEqual([
      'first',
      'second',
    ])
  })
})
