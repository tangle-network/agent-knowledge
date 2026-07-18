import type { AgentMemoryBranch } from '../branch'
import type { AgentMemoryAdapter, AgentMemoryScope } from '../types'
import type {
  AgentMemoryExperimentCandidate,
  AgentMemorySequence,
  RunAgentMemoryExperimentOptions,
} from './types'
import { normalizeCleanupScope } from './validation'

export class AgentMemoryCleanupError extends AggregateError {
  constructor(errors: Iterable<unknown>, message: string) {
    super(errors, message)
    this.name = 'AgentMemoryCleanupError'
  }
}

export function trackExternalMemoryCalls(
  adapter: AgentMemoryAdapter,
  onExternalCall: () => void,
): AgentMemoryAdapter {
  return {
    id: adapter.id,
    branchIsolation: adapter.branchIsolation,
    search(query, options) {
      onExternalCall()
      return adapter.search.call(adapter, query, options)
    },
    getContext(query, options) {
      onExternalCall()
      return adapter.getContext.call(adapter, query, options)
    },
    write(input) {
      onExternalCall()
      return adapter.write.call(adapter, input)
    },
    ...(adapter.clear
      ? {
          clear(scope?: AgentMemoryScope) {
            onExternalCall()
            return adapter.clear!.call(adapter, scope)
          },
        }
      : {}),
    ...(adapter.flush
      ? {
          flush() {
            onExternalCall()
            return adapter.flush!.call(adapter)
          },
        }
      : {}),
    ...(adapter.close
      ? {
          close() {
            onExternalCall()
            return adapter.close!.call(adapter)
          },
        }
      : {}),
  }
}

export function mergeScopes(base?: AgentMemoryScope, extra?: AgentMemoryScope): AgentMemoryScope {
  return {
    ...(base ?? {}),
    ...(extra ?? {}),
    tags: { ...(base?.tags ?? {}), ...(extra?.tags ?? {}) },
  }
}

export function memoryExperimentBaseScope(
  options: Pick<RunAgentMemoryExperimentOptions, 'experimentId'>,
  candidate: Pick<AgentMemoryExperimentCandidate, 'id' | 'baseScope'>,
  sequenceId: string,
): AgentMemoryScope {
  return mergeScopes(candidate.baseScope, {
    tags: {
      memoryExperimentId: options.experimentId,
      memoryCandidateId: candidate.id,
      memorySequenceId: sequenceId,
    },
  })
}

export function sequenceCleanupScopes(sequence: AgentMemorySequence): AgentMemoryScope[] {
  const scopes = new Map<string, AgentMemoryScope>()
  for (const scope of sequence.cleanupScopes ?? []) {
    const normalized = normalizeCleanupScope(scope)
    scopes.set(JSON.stringify(normalized), normalized)
  }
  for (const step of sequence.steps) {
    const candidates = [
      ...(step.scope ? [step.scope] : []),
      ...(step.writes ?? []).map((write) => mergeScopes(step.scope, write.scope)),
      ...(step.probes ?? []).map((probe) => mergeScopes(step.scope, probe.scope)),
    ]
    for (const scope of candidates) {
      const normalized = normalizeCleanupScope(scope)
      scopes.set(JSON.stringify(normalized), normalized)
    }
  }
  return [...scopes.values()]
}

export async function clearSequenceScopes(
  memory: AgentMemoryBranch,
  sequence: AgentMemorySequence,
): Promise<void> {
  for (const scope of sequenceCleanupScopes(sequence)) await memory.clear?.(scope)
}
