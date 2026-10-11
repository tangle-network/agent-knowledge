import { expect, it } from 'vitest'
import { mapFileIo } from '../src/bounded-file-io'

it('preserves input order while bounding filesystem work', async () => {
  let active = 0
  let maximum = 0
  const values = Array.from({ length: 30 }, (_, i) => i)
  const result = await mapFileIo(values, async (value) => {
    active++
    maximum = Math.max(maximum, active)
    await new Promise((resolve) => setTimeout(resolve, value % 3))
    active--
    return value
  })
  expect(result).toEqual(values)
  expect(maximum).toBeLessThanOrEqual(8)
})

it('drains admitted operations before throwing and never admits the next batch', async () => {
  const admitted: number[] = []
  const finished: number[] = []
  await expect(
    mapFileIo(
      Array.from({ length: 20 }, (_, i) => i),
      async (value) => {
        admitted.push(value)
        if (value === 0) throw new Error('failed')
        await new Promise((resolve) => setTimeout(resolve, 10))
        finished.push(value)
        return value
      },
    ),
  ).rejects.toThrow('failed')
  expect(admitted).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  expect(finished.sort()).toEqual([1, 2, 3, 4, 5, 6, 7])
})
