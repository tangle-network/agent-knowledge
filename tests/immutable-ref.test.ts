import { describe, expect, it } from 'vitest'
import { assertImmutableRef } from '../src/immutable-ref'

describe('assertImmutableRef', () => {
  it.each([`sha256:${'a'.repeat(64)}`, `git:${'b'.repeat(40)}`])(
    'accepts canonical immutable ref %s',
    (value) => {
      expect(() => assertImmutableRef(value, 'ref')).not.toThrow()
    },
  )

  it.each([`sha256:${'A'.repeat(64)}`, `git:${'B'.repeat(40)}`])(
    'rejects non-canonical immutable ref %s',
    (value) => {
      expect(() => assertImmutableRef(value, 'ref')).toThrow(/must be lowercase/)
    },
  )
})
