import { type CampaignStorage, surfaceHash } from '@tangle-network/agent-eval/campaign'
import type { AgentCandidateJsonValue as JsonValue } from '@tangle-network/agent-interface'
import { appendDurableJournalEvent } from '../attempt-log'
import { runBoundedMemoryLifecycle } from '../lifecycle'
import { memoryConfigCodec } from './evaluation'
import type {
  AgentMemoryActivationEvent,
  AgentMemoryActivationJournalState,
  OwnedRunLease,
  RunAgentMemoryImprovementOptions,
  RunAgentMemoryImprovementResult,
} from './types'

export function appendMemoryActivationEvent(
  storage: CampaignStorage,
  path: string,
  event: AgentMemoryActivationEvent,
): void {
  appendDurableJournalEvent({
    storage,
    path,
    event,
    label: 'memory activation journal',
  })
}

export function readMemoryActivationJournal(
  storage: CampaignStorage,
  path: string,
  expected: Omit<AgentMemoryActivationEvent, 'status' | 'recordedAt' | 'outcome'>,
): AgentMemoryActivationJournalState {
  const stored = storage.read(path)
  if (stored === undefined) {
    if (storage.exists(path)) throw new Error(`cannot read memory activation journal '${path}'`)
    return { prepared: false }
  }
  let prepared = false
  let activated: AgentMemoryActivationEvent | undefined
  for (const [index, line] of stored.split('\n').entries()) {
    if (!line) continue
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch (error) {
      throw new Error(`invalid memory activation journal '${path}' line ${index + 1}`, {
        cause: error,
      })
    }
    const event = parseMemoryActivationEvent(raw, path, index + 1, expected)
    if (event.status === 'prepared') {
      if (prepared || activated) {
        throw new Error(`memory activation journal '${path}' repeats its prepared event`)
      }
      prepared = true
      continue
    }
    if (!prepared || activated) {
      throw new Error(`memory activation journal '${path}' has an out-of-order activated event`)
    }
    activated = event
  }
  return { prepared, ...(activated ? { activated } : {}) }
}

export async function assertActivatedMemoryWinner<TConfig extends JsonValue>(input: {
  options: RunAgentMemoryImprovementOptions<TConfig>
  lease: OwnedRunLease
  result: Pick<RunAgentMemoryImprovementResult<TConfig>, 'winnerSurfaceHash'>
}): Promise<void> {
  const activationDriver = input.options.activation
  if (!activationDriver) {
    throw new Error('an activated memory journal requires its activation driver')
  }
  await input.lease.assertOwned()
  const currentConfig = await runBoundedMemoryLifecycle({
    operation: `${activationDriver.ref}: confirm active memory configuration`,
    timeoutMs: input.options.activationTimeoutMs ?? 60_000,
    run: () => activationDriver.readCurrent(),
  })
  await input.lease.assertOwned()
  const currentHash = surfaceHash(memoryConfigCodec(input.options).serialize(currentConfig))
  if (currentHash !== input.result.winnerSurfaceHash) {
    throw new Error(
      `memory activation target '${activationDriver.ref}' drifted from measured winner '${input.result.winnerSurfaceHash}' to '${currentHash}'`,
    )
  }
}

export async function activateMemoryWinner<TConfig extends JsonValue>(input: {
  options: RunAgentMemoryImprovementOptions<TConfig>
  storage: CampaignStorage
  lease: OwnedRunLease
  result: RunAgentMemoryImprovementResult<TConfig>
  activationEventIdentity: Omit<AgentMemoryActivationEvent, 'status' | 'recordedAt' | 'outcome'>
  activationJournalDir: string
  activationJournalPath: string
  hadPreparedEvent: boolean
}): Promise<void> {
  const activationDriver = input.options.activation!
  const activationTimeoutMs = input.options.activationTimeoutMs ?? 60_000
  if (!input.hadPreparedEvent) {
    await input.lease.assertOwned()
    input.storage.ensureDir(input.activationJournalDir)
    appendMemoryActivationEvent(input.storage, input.activationJournalPath, {
      ...input.activationEventIdentity,
      status: 'prepared',
      recordedAt: (input.options.now ?? (() => new Date()))().toISOString(),
    })
  }

  await input.lease.assertOwned()
  const currentConfig = await runBoundedMemoryLifecycle({
    operation: `${activationDriver.ref}: read current memory configuration`,
    timeoutMs: activationTimeoutMs,
    run: () => activationDriver.readCurrent(),
  })
  await input.lease.assertOwned()
  const codec = memoryConfigCodec(input.options)
  const currentHash = surfaceHash(codec.serialize(currentConfig))
  if (
    currentHash !== input.result.baselineSurfaceHash &&
    currentHash !== input.result.winnerSurfaceHash
  ) {
    throw new Error(
      `memory activation target '${activationDriver.ref}' changed concurrently; expected '${input.result.baselineSurfaceHash}' or '${input.result.winnerSurfaceHash}', found '${currentHash}'`,
    )
  }

  let outcome: NonNullable<AgentMemoryActivationEvent['outcome']>
  if (currentHash === input.result.winnerSurfaceHash) {
    outcome = input.hadPreparedEvent ? 'recovered' : 'already-current'
    input.result.activation.status = 'recovered'
  } else {
    let compareError: unknown
    try {
      await runBoundedMemoryLifecycle({
        operation: `${activationDriver.ref}: activate memory configuration`,
        timeoutMs: activationTimeoutMs,
        run: () =>
          activationDriver.compareAndSet({
            activationId: input.result.activation.id,
            expectedConfig: input.result.baselineConfig,
            expectedSurfaceHash: input.result.baselineSurfaceHash,
            config: input.result.winnerConfig,
            surfaceHash: input.result.winnerSurfaceHash,
            decision: input.result.decision,
            optimization: input.result.optimization,
            finalEvaluation: input.result.finalEvaluation,
          }),
      })
    } catch (error) {
      compareError = error
    }
    await input.lease.assertOwned()

    let observedConfig: TConfig
    try {
      observedConfig = await runBoundedMemoryLifecycle({
        operation: `${activationDriver.ref}: confirm memory configuration`,
        timeoutMs: activationTimeoutMs,
        run: () => activationDriver.readCurrent(),
      })
    } catch (error) {
      if (compareError) {
        throw new AggregateError(
          [compareError, error],
          `memory activation '${input.result.activation.id}' failed and its live state could not be confirmed`,
        )
      }
      throw error
    }
    await input.lease.assertOwned()
    const observedHash = surfaceHash(codec.serialize(observedConfig))
    if (observedHash !== input.result.winnerSurfaceHash) {
      const mismatch = new Error(
        `memory activation '${input.result.activation.id}' did not install the measured winner; found '${observedHash}'`,
      )
      if (compareError) {
        throw new AggregateError(
          [compareError, mismatch],
          `memory activation '${input.result.activation.id}' failed without applying the measured winner`,
        )
      }
      throw mismatch
    }
    outcome = compareError ? 'recovered' : 'applied'
    input.result.activation.status = compareError ? 'recovered' : 'activated'
  }

  await input.lease.assertOwned()
  appendMemoryActivationEvent(input.storage, input.activationJournalPath, {
    ...input.activationEventIdentity,
    status: 'activated',
    outcome,
    recordedAt: (input.options.now ?? (() => new Date()))().toISOString(),
  })
}

function parseMemoryActivationEvent(
  value: unknown,
  path: string,
  line: number,
  expected: Omit<AgentMemoryActivationEvent, 'status' | 'recordedAt' | 'outcome'>,
): AgentMemoryActivationEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`invalid memory activation journal '${path}' line ${line}`)
  }
  const event = value as Record<string, unknown>
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (event[key] !== expectedValue) {
      throw new Error(
        `memory activation journal '${path}' line ${line} does not match the measured winner`,
      )
    }
  }
  if (event.status !== 'prepared' && event.status !== 'activated') {
    throw new Error(`invalid memory activation journal '${path}' line ${line} status`)
  }
  const expectedKeys = [
    ...Object.keys(expected),
    'status',
    'recordedAt',
    ...(event.status === 'activated' ? ['outcome'] : []),
  ]
  const actualKeys = Object.keys(event)
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key) => !expectedKeys.includes(key))
  ) {
    throw new Error(`invalid memory activation journal '${path}' line ${line} fields`)
  }
  if (typeof event.recordedAt !== 'string' || !Number.isFinite(Date.parse(event.recordedAt))) {
    throw new Error(`invalid memory activation journal '${path}' line ${line} recordedAt`)
  }
  if (
    event.status === 'activated' &&
    event.outcome !== 'applied' &&
    event.outcome !== 'recovered' &&
    event.outcome !== 'already-current'
  ) {
    throw new Error(`invalid memory activation journal '${path}' line ${line} outcome`)
  }
  if (event.status === 'prepared' && event.outcome !== undefined) {
    throw new Error(`invalid memory activation journal '${path}' line ${line} prepared outcome`)
  }
  return value as AgentMemoryActivationEvent
}
