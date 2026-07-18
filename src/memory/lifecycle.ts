import type { AgentMemoryAdapter } from './types'

export const DEFAULT_MEMORY_CLEANUP_TIMEOUT_MS = 180_000

export class AgentMemoryLifecycleTimeoutError extends Error {
  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`${operation} did not finish within ${timeoutMs}ms`)
    this.name = 'AgentMemoryLifecycleTimeoutError'
  }
}

export function resolveMemoryCleanupTimeoutMs(value: number | undefined, label: string): number {
  const timeoutMs = value ?? DEFAULT_MEMORY_CLEANUP_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`${label} cleanupTimeoutMs must be a positive safe integer`)
  }
  return timeoutMs
}

export async function runBoundedMemoryLifecycle<T>(input: {
  operation: string
  timeoutMs: number
  run(): Promise<T> | T
}): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  const work = Promise.resolve().then(input.run)
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new AgentMemoryLifecycleTimeoutError(input.operation, input.timeoutMs)),
      input.timeoutMs,
    )
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export function memoryRecoveryDelayMs(adapter: AgentMemoryAdapter): number {
  const isolation = adapter.branchIsolation
  if (isolation?.mode !== 'scoped' || isolation.processExitSafe !== false) return 0
  const delayMs = isolation.recoveryDelayMs
  if (typeof delayMs !== 'number' || !Number.isSafeInteger(delayMs) || delayMs <= 0) {
    throw new Error(
      `${adapter.id}: processExitSafe=false requires a positive recoveryDelayMs for abandoned writes`,
    )
  }
  return delayMs
}

export async function sleepForMemoryRecovery(
  delayMs: number,
  assertOwned: () => Promise<void>,
  timeoutMs = delayMs,
  operation = 'memory recovery visibility wait',
): Promise<void> {
  if (delayMs <= 0) return
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`${operation} timeout must be a positive safe integer`)
  }
  await new Promise<void>((resolve) => setTimeout(resolve, Math.min(delayMs, timeoutMs)))
  await assertOwned()
  if (delayMs > timeoutMs) throw new AgentMemoryLifecycleTimeoutError(operation, timeoutMs)
}

export function createMemoryExecutionPool(limit: number): {
  run<T>(operation: () => Promise<T>): Promise<T>
} {
  let active = 0
  const waiters: Array<() => void> = []
  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      if (active >= limit) await new Promise<void>((resolve) => waiters.push(resolve))
      active += 1
      try {
        return await operation()
      } finally {
        active -= 1
        waiters.shift()?.()
      }
    },
  }
}
