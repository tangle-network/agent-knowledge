import type { CostReceipt, PaidCallResult } from '@tangle-network/agent-eval'
import type { DispatchContext } from '@tangle-network/agent-eval/campaign'
import type {
  AgentMemoryExecutionContext,
  AgentMemoryExecutionCostMeter,
  AgentMemoryExecutionCostReceipt,
  AgentMemoryExecutionPaidCallInput,
  AgentMemoryExecutionPaidCallResult,
  AgentMemorySequence,
} from './types'

export interface OwnedAgentMemoryExecutionContext {
  context: AgentMemoryExecutionContext
  abort(): void
  dispose(): void
}

export function createAgentMemoryExecutionContext(
  dispatch: DispatchContext,
  sequence: AgentMemorySequence,
): OwnedAgentMemoryExecutionContext {
  const privateValues = memoryEvaluationPrivateValues(dispatch.cellId, sequence)
  const signal = relayAbortWithoutReason(dispatch.signal)
  const cost: AgentMemoryExecutionCostMeter = Object.freeze({
    async runPaidCall<T>(
      input: AgentMemoryExecutionPaidCallInput<T>,
    ): Promise<AgentMemoryExecutionPaidCallResult<T>> {
      const result = await dispatch.cost.runPaidCall({
        ...input,
        execute: (sourceSignal, callId) =>
          withRedactedAbortSignal(sourceSignal, (redactedSignal) =>
            input.execute(redactedSignal, callId),
          ),
      })
      return sanitizePaidCallResult(result, privateValues)
    },
  })
  return {
    context: Object.freeze({ signal: signal.signal, cost }),
    abort: signal.abort,
    dispose: signal.dispose,
  }
}

function sanitizePaidCallResult<T>(
  result: PaidCallResult<T>,
  privateValues: readonly string[],
): AgentMemoryExecutionPaidCallResult<T> {
  if (result.succeeded) {
    return Object.freeze({
      succeeded: true,
      callId: result.callId,
      value: result.value,
      receipt: sanitizeCostReceipt(result.receipt, privateValues),
    })
  }
  return Object.freeze({
    succeeded: false,
    ...(result.callId === undefined ? {} : { callId: result.callId }),
    error: sanitizeError(result.error, privateValues),
    ...(result.receipt === undefined
      ? {}
      : { receipt: sanitizeCostReceipt(result.receipt, privateValues) }),
  })
}

function sanitizeCostReceipt(
  receipt: CostReceipt,
  privateValues: readonly string[],
): AgentMemoryExecutionCostReceipt {
  const { tags: _tags, phase: _phase, error, ...visible } = receipt
  return Object.freeze({
    ...visible,
    ...(error === undefined ? {} : { error: redactPrivateValues(error, privateValues) }),
  })
}

function sanitizeError(error: Error, privateValues: readonly string[]): Error {
  const sanitized = new Error(redactPrivateValues(error.message, privateValues))
  sanitized.name = redactPrivateValues(error.name, privateValues)
  return sanitized
}

async function withRedactedAbortSignal<T>(
  source: AbortSignal,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const relay = relayAbortWithoutReason(source)
  try {
    return await run(relay.signal)
  } finally {
    relay.dispose()
  }
}

function relayAbortWithoutReason(source: AbortSignal): {
  signal: AbortSignal
  abort(): void
  dispose(): void
} {
  const controller = new AbortController()
  const abort = () => controller.abort(memoryExecutionAbortError())
  if (source.aborted) abort()
  else source.addEventListener('abort', abort, { once: true })
  return {
    signal: controller.signal,
    abort,
    dispose() {
      source.removeEventListener('abort', abort)
    },
  }
}

function memoryExecutionAbortError(): Error {
  const error = new Error('memory execution aborted')
  error.name = 'AbortError'
  return error
}

function memoryEvaluationPrivateValues(
  cellId: string,
  sequence: AgentMemorySequence,
): readonly string[] {
  const values = new Set<string>([cellId, sequence.id])
  collectUnknownStrings(sequence.metadata, values)
  for (const step of sequence.steps) {
    values.add(step.id)
    collectUnknownStrings(step.metadata, values)
    for (const probe of step.probes ?? []) {
      values.add(probe.id)
      values.add(probe.query)
      if (probe.referenceAnswer !== undefined) values.add(probe.referenceAnswer)
      for (const matcher of [...(probe.requiredFacts ?? []), ...(probe.forbiddenFacts ?? [])]) {
        values.add(matcher.id)
        for (const expected of matcher.anyOf) values.add(expected)
      }
      for (const expected of probe.expectedEventIds ?? []) values.add(expected)
      for (const expected of probe.expectedActorIds ?? []) values.add(expected)
    }
  }
  return [...values].filter(Boolean).sort((left, right) => right.length - left.length)
}

function collectUnknownStrings(
  value: unknown,
  output: Set<string>,
  seen = new WeakSet<object>(),
): void {
  if (typeof value === 'string') {
    output.add(value)
    return
  }
  if (!value || typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    for (const item of value) collectUnknownStrings(item, output, seen)
    return
  }
  for (const [key, item] of Object.entries(value)) {
    output.add(key)
    collectUnknownStrings(item, output, seen)
  }
}

function redactPrivateValues(value: string, privateValues: readonly string[]): string {
  let redacted = value
  for (const privateValue of privateValues) {
    redacted = redacted.split(privateValue).join('[redacted]')
  }
  return redacted
}
