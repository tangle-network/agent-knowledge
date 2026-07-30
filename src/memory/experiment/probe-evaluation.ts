import {
  type KnowledgeBenchmarkArtifact,
  type KnowledgeBenchmarkEvaluation,
  type KnowledgeMemoryBenchmarkCase,
  scoreMemoryBenchmarkArtifact,
} from '../../benchmarks/index'
import type {
  AgentMemorySequence,
  AgentMemorySequenceProbe,
  AgentMemorySequenceStep,
} from './types'

export interface AgentMemoryProbeScoringEvidence extends KnowledgeBenchmarkArtifact {
  answer: string
  rememberedFacts: readonly string[]
  citedEventIds: readonly string[]
  usedMemoryIds: readonly string[]
  actorIds: readonly string[]
}

export function scoreAgentMemoryProbe(
  sequence: AgentMemorySequence,
  step: AgentMemorySequenceStep,
  probe: AgentMemorySequenceProbe,
  evidence: AgentMemoryProbeScoringEvidence,
): KnowledgeBenchmarkEvaluation {
  return scoreMemoryBenchmarkArtifact(memoryProbeBenchmarkCase(sequence, step, probe), evidence)
}

function memoryProbeBenchmarkCase(
  sequence: AgentMemorySequence,
  step: AgentMemorySequenceStep,
  probe: AgentMemorySequenceProbe,
): KnowledgeMemoryBenchmarkCase {
  return {
    id: `${sequence.id}:${step.id}:${probe.id}`,
    family: sequence.family,
    taskKind: probe.taskKind ?? 'memory-recall',
    split: sequence.split,
    events: [],
    prompt: probe.query,
    requiredFacts:
      probe.requiredFacts && probe.requiredFacts.length > 0
        ? probe.requiredFacts
        : probe.referenceAnswer
          ? [{ id: `${probe.id}:reference`, anyOf: [probe.referenceAnswer] }]
          : undefined,
    forbiddenFacts: probe.forbiddenFacts,
    expectedEventIds: probe.expectedEventIds,
    expectedActorIds: probe.expectedActorIds,
    referenceAnswer: probe.referenceAnswer,
  }
}
