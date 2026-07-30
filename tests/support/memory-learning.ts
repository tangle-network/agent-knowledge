import { createHash } from 'node:crypto'
import { inMemoryCampaignStorage } from '@tangle-network/agent-eval/campaign'
import {
  type AgentMemoryExperimentCandidate,
  type AgentMemoryMode,
  type AgentMemoryScope,
  type AgentMemorySequence,
  runAgentMemoryExperiment,
} from '../../src/memory/index'
import { createScopedTestAdapter } from './memory'

export function continualSequences(): AgentMemorySequence[] {
  return [retentionSequence(), twoStepControlSequence()]
}

export function retentionSequence(): AgentMemorySequence {
  return {
    id: 'retention',
    family: 'first-party',
    steps: [
      {
        id: 'learn',
        scope: { agentId: 'worker' },
        writes: [{ id: 'france', kind: 'fact', text: 'The capital of France is Paris.' }],
        probes: [retentionProbe()],
      },
      {
        id: 'interference',
        scope: { agentId: 'worker' },
        writes: [{ id: 'germany', kind: 'fact', text: 'The capital of Germany is Berlin.' }],
        probes: [
          retentionProbe(),
          {
            id: 'both-capitals',
            transferKey: 'cross-capital-recall',
            query: 'Recall both learned capitals.',
            requiredFacts: [
              { id: 'france', anyOf: ['capital of France is Paris'] },
              { id: 'germany', anyOf: ['capital of Germany is Berlin'] },
            ],
          },
        ],
      },
    ],
  }
}

export function twoStepControlSequence(): AgentMemorySequence {
  return {
    id: 'control',
    family: 'first-party',
    steps: [
      {
        id: 'first',
        scope: { agentId: 'worker' },
        writes: [{ id: 'green-1', kind: 'fact', text: 'The control value is green.' }],
        probes: [controlProbe()],
      },
      {
        id: 'second',
        scope: { agentId: 'worker' },
        writes: [{ id: 'green-2', kind: 'fact', text: 'The control value is green.' }],
        probes: [controlProbe()],
      },
    ],
  }
}

export function retentionProbe() {
  return {
    id: 'capital',
    retentionKey: 'capital-of-france',
    query: 'What is the capital of France?',
    referenceAnswer: 'capital of France is Paris',
  }
}

export function controlProbe() {
  return {
    id: 'same-local-id',
    query: 'What is the control value?',
    referenceAnswer: 'control value is green',
  }
}

export function memoryCandidate(
  ref: string,
  costUsd = 0,
  onWriteScope?: (scope: AgentMemoryScope) => void,
): AgentMemoryExperimentCandidate {
  return {
    id: 'memory',
    ref: immutableRef(ref),
    externalCostUsdPerSequence: costUsd,
    externalRecoveryCostUsdPerAttempt: 0,
    externalCostAccounting: 'exact',
    createAdapter({ branchId, recordExternalCost }) {
      if (costUsd > 0) recordExternalCost(costUsd)
      return createScopedTestAdapter(`${ref}:${branchId}`, async (scope) => onWriteScope?.(scope))
    },
  }
}

export function immutableRef(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export function memoryCandidateWithoutClear(): AgentMemoryExperimentCandidate {
  return {
    id: 'memory',
    ref: 'memory:no-clear',
    createAdapter({ branchId }) {
      const { clear: _clear, ...adapter } = createScopedTestAdapter(branchId)
      return adapter
    },
    async disposeAdapter() {},
  }
}

export function runDirectArm(mode: AgentMemoryMode, ref: string, experimentRunId: string) {
  return runAgentMemoryExperiment({
    experimentId: 'unequal-memory-arms',
    experimentRunId,
    memoryMode: mode,
    sequences: [twoStepControlSequence()],
    candidates: [memoryCandidate(ref)],
    runDir: `/runs/unequal-memory-arms/${mode}`,
    storage: inMemoryCampaignStorage(),
    controllerMode: 'process-local',
    seed: 23,
  })
}

export function runInvalidSequence(steps: AgentMemorySequence['steps']) {
  return runAgentMemoryExperiment({
    experimentId: 'invalid-retention-measurement',
    sequences: [{ id: 'invalid', family: 'first-party', steps }],
    candidates: [memoryCandidate('memory:validation')],
    runDir: '/runs/invalid-retention-measurement',
    storage: inMemoryCampaignStorage(),
    controllerMode: 'process-local',
  })
}
