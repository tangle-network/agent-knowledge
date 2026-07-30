/** Converts existing ordered memory benchmark cases into executable histories. */
import type { JudgeConfig, Scenario } from '@tangle-network/agent-eval/campaign'
import type { KnowledgeMemoryBenchmarkCase } from '../../benchmarks/index'
import { stableId } from '../../ids'
import type {
  AgentMemoryExperimentCandidate,
  AgentMemorySequence,
  AgentMemorySequenceArtifact,
  AgentMemorySequenceScenario,
  BuildAgentMemorySequencesFromBenchmarkCasesOptions,
} from './types'
import { compactRecord, compactScope } from './validation'

export function buildAgentMemorySequencesFromBenchmarkCases(
  cases: readonly KnowledgeMemoryBenchmarkCase[],
  options: BuildAgentMemorySequencesFromBenchmarkCasesOptions = {},
): AgentMemorySequence[] {
  const memoryAgentId = options.memoryAgentId ?? 'benchmark-agent'
  return cases.map((testCase) => ({
    id: testCase.id,
    family: testCase.family,
    ...(testCase.split !== undefined ? { split: testCase.split } : {}),
    ...(testCase.tags !== undefined ? { tags: testCase.tags } : {}),
    metadata: compactRecord({
      ...(testCase.metadata ?? {}),
      taskKind: testCase.taskKind,
      source: testCase.source,
    }),
    steps: [
      ...testCase.events.map((event, eventIndex) => ({
        id: `event:${event.id}`,
        scope: compactScope(
          options.eventScope?.({ event, case: testCase, eventIndex }) ?? {
            agentId: memoryAgentId,
            sessionId: 'benchmark-session',
          },
        ),
        writes: [
          {
            id: event.id,
            kind: 'observation' as const,
            text: event.text,
            metadata: compactRecord({
              ...(event.metadata ?? {}),
              eventId: event.id,
              actorId: event.actorId,
              sessionId: event.sessionId,
              timestamp: event.timestamp,
            }),
          },
        ],
        metadata: { eventIndex },
      })),
      {
        id: 'probe',
        scope: compactScope(
          options.probeScope?.(testCase) ?? {
            agentId: memoryAgentId,
            sessionId: 'benchmark-session',
          },
        ),
        probes: [
          {
            id: 'answer',
            query: testCase.prompt,
            taskKind: testCase.taskKind,
            ...(testCase.requiredFacts !== undefined
              ? { requiredFacts: testCase.requiredFacts }
              : {}),
            ...(testCase.forbiddenFacts !== undefined
              ? { forbiddenFacts: testCase.forbiddenFacts }
              : {}),
            ...(testCase.expectedEventIds !== undefined
              ? { expectedEventIds: testCase.expectedEventIds }
              : {}),
            ...(testCase.expectedActorIds !== undefined
              ? { expectedActorIds: testCase.expectedActorIds }
              : {}),
            ...(testCase.referenceAnswer !== undefined
              ? { referenceAnswer: testCase.referenceAnswer }
              : {}),
          },
        ],
      },
    ],
  }))
}

export function buildAgentMemorySequenceScenarios(
  sequences: readonly AgentMemorySequence[],
  candidates: readonly Pick<AgentMemoryExperimentCandidate, 'id'>[],
): AgentMemorySequenceScenario[] {
  return candidates.flatMap((candidate) =>
    sequences.map((sequence) => ({
      id: `${stableId('candidate', candidate.id)}:${sequence.id}`,
      kind: 'agent-memory-sequence' as const,
      candidateId: candidate.id,
      sequenceId: sequence.id,
      sequence,
      seedGroup: sequence.id,
      tags: [...new Set([sequence.split ?? 'dev', ...(sequence.tags ?? []), candidate.id])],
    })),
  )
}

export function agentMemorySequenceJudge<
  TScenario extends Scenario = AgentMemorySequenceScenario,
>(): JudgeConfig<AgentMemorySequenceArtifact, TScenario> {
  return {
    name: 'agent-memory-sequence',
    judgeVersion: 'agent-knowledge:memory-sequence:v2',
    dimensions: [
      { key: 'score', description: 'mean memory probe score' },
      { key: 'passed', description: '1 when every memory probe passes' },
      { key: 'memory_fact_recall', description: 'current memory fact coverage' },
      { key: 'memory_event_recall', description: 'memory source event coverage' },
      { key: 'memory_actor_recall', description: 'memory actor attribution coverage' },
      { key: 'memory_stale_safe', description: '1 when obsolete memory is not reused' },
    ],
    score({ artifact }) {
      return {
        composite: artifact.score,
        dimensions: {
          score: artifact.score,
          passed: artifact.passed ? 1 : 0,
          ...artifact.dimensions,
        },
        notes: `${artifact.probes.filter((probe) => probe.passed).length}/${artifact.probes.length} probes passed`,
      }
    },
  }
}
