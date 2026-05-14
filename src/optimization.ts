import {
  type MultiShotMutateAdapter,
  type MultiShotOptimizationConfig,
  type MultiShotOptimizationResult,
  type MultiShotRunner,
  type MultiShotScorer,
  type MultiShotVariant,
  runMultiShotOptimization,
} from '@tangle-network/agent-eval'
import type { KnowledgeBaseCandidate } from './types'

export type KnowledgeBaseVariant = MultiShotVariant<KnowledgeBaseCandidate>

export interface KnowledgeOptimizationConfig
  extends Omit<
    MultiShotOptimizationConfig<KnowledgeBaseCandidate>,
    'runner' | 'scorer' | 'mutateAdapter' | 'target'
  > {
  target?: string
  runner: MultiShotRunner<KnowledgeBaseCandidate>
  scorer: MultiShotScorer<KnowledgeBaseCandidate>
  mutateAdapter: MultiShotMutateAdapter<KnowledgeBaseCandidate>
}

export async function runKnowledgeBaseOptimization(
  config: KnowledgeOptimizationConfig,
): Promise<MultiShotOptimizationResult<KnowledgeBaseCandidate>> {
  return runMultiShotOptimization<KnowledgeBaseCandidate>({
    ...config,
    target: config.target ?? 'agent-knowledge-base',
  })
}

export function knowledgeVariantFromCandidate(
  candidate: KnowledgeBaseCandidate,
  options: { id?: string; label?: string; generation?: number } = {},
): KnowledgeBaseVariant {
  return {
    id: options.id ?? candidate.id,
    label: options.label ?? candidate.id,
    generation: options.generation ?? 0,
    payload: candidate,
  }
}
