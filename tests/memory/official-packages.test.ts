import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('official memory packages', () => {
  it('loads each supported package entrypoint', async () => {
    vi.stubEnv('MEM0_TELEMETRY', 'false')

    const [hosted, oss, neo4j] = await Promise.all([
      import('mem0ai'),
      import('mem0ai/oss'),
      import('@neo4j-labs/agent-memory'),
    ])

    expect(hosted.MemoryClient).toBeTypeOf('function')
    expect(oss.Memory).toBeTypeOf('function')
    expect(neo4j.MemoryClient).toBeTypeOf('function')
  })
})
