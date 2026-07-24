import type { JsonValue } from '@tangle-network/agent-eval/campaign'
import {
  type AgentMemoryAdapter,
  type AgentMemoryHit,
  type AgentMemoryScope,
  type RunAgentMemoryExperimentOptions,
  type RunAgentMemoryImprovementOptions,
  runAgentMemoryExperiment as runAgentMemoryExperimentRaw,
  runAgentMemoryImprovement as runAgentMemoryImprovementRaw,
} from '../../src/memory/index'

function withProcessLocalController<
  T extends {
    storage?: unknown
    controllerMode?: 'process-local'
    acquireRunLease?: unknown
  },
>(options: T): T {
  if (!options.storage || options.controllerMode || options.acquireRunLease) return options
  return { ...options, controllerMode: 'process-local' }
}

export function runAgentMemoryExperiment(options: RunAgentMemoryExperimentOptions) {
  return runAgentMemoryExperimentRaw(withProcessLocalController(options))
}

export function runAgentMemoryImprovement<TConfig extends JsonValue>(
  options: RunAgentMemoryImprovementOptions<TConfig>,
) {
  return runAgentMemoryImprovementRaw(withProcessLocalController(options))
}

export function hitText(hit: AgentMemoryHit): string {
  return hit.text
}

export function createScopedTestAdapter(
  id: string,
  beforeWrite?: (scope: AgentMemoryScope, text: string) => Promise<void>,
): AgentMemoryAdapter {
  const rows: Array<{ scope: AgentMemoryScope; hit: AgentMemoryHit }> = []
  let sequence = 0
  return {
    id,
    branchIsolation: { mode: 'scoped' },
    async search(_query, options = {}) {
      return rows.filter((row) => sameScope(row.scope, options.scope)).map((row) => row.hit)
    },
    async getContext(query, options = {}) {
      const hits = await this.search(query, options)
      return { query, hits, text: hits.map(hitText).join('\n'), sourceRecords: [] }
    },
    async write(input) {
      const scope = input.scope ?? {}
      await beforeWrite?.(scope, input.text)
      sequence += 1
      const memoryId = input.id ?? `${id}-${sequence}`
      const hit: AgentMemoryHit = {
        id: memoryId,
        uri: `memory://${id}/${memoryId}`,
        kind: input.kind,
        text: input.text,
        metadata: input.metadata,
      }
      rows.push({ scope, hit })
      return { accepted: true, id: memoryId, uri: hit.uri, kind: input.kind }
    },
    async clear(scope) {
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (sameScope(rows[index]!.scope, scope)) rows.splice(index, 1)
      }
    },
  }
}

function sameScope(left: AgentMemoryScope, right: AgentMemoryScope = {}): boolean {
  for (const key of [
    'tenantId',
    'userId',
    'agentId',
    'teamId',
    'runId',
    'sessionId',
    'namespace',
  ] as const) {
    if (right[key] !== undefined && left[key] !== right[key]) return false
  }
  for (const [key, value] of Object.entries(right.tags ?? {})) {
    if (left.tags?.[key] !== value) return false
  }
  return true
}
