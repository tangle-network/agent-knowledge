import { describe, expect, it } from 'vitest'
import { controlProbe, retentionProbe, runInvalidSequence } from '../support/memory-learning'

describe('memory learning measurement validation', () => {
  it('requires a retention key to repeat across distinct steps', async () => {
    await expect(runInvalidSequence([{ id: 'only', probes: [retentionProbe()] }])).rejects.toThrow(
      'must appear in at least two distinct steps',
    )
  })

  it('requires repeated retention probes to be the exact same measurement', async () => {
    await expect(
      runInvalidSequence([
        { id: 'first', probes: [retentionProbe()] },
        {
          id: 'second',
          probes: [{ ...retentionProbe(), query: 'A different query' }],
        },
      ]),
    ).rejects.toThrow('must repeat the exact same measurement')
  })

  it('allows at most one observation of a retention target per step', async () => {
    await expect(
      runInvalidSequence([
        {
          id: 'first',
          probes: [retentionProbe(), { ...retentionProbe(), id: 'duplicate' }],
        },
        { id: 'second', probes: [retentionProbe()] },
      ]),
    ).rejects.toThrow('may appear only once per step')
  })

  it('requires transfer probes to be explicit, later, and distinct from retention', async () => {
    await expect(
      runInvalidSequence([
        {
          id: 'first',
          probes: [{ ...controlProbe(), transferKey: 'transfer' }],
        },
      ]),
    ).rejects.toThrow('must run after the first step')

    await expect(
      runInvalidSequence([
        { id: 'first', probes: [retentionProbe()] },
        {
          id: 'second',
          probes: [{ ...retentionProbe(), transferKey: 'transfer' }],
        },
      ]),
    ).rejects.toThrow('cannot be both transfer and retention')
  })
})
