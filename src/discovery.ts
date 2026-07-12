import { isDeepStrictEqual } from 'node:util'

export interface DiscoveryTask {
  id: string
  goal: string
  query?: string
  sourceHints?: string[]
  metadata?: Record<string, unknown>
}

export interface DiscoveryResult {
  taskId: string
  summary: string
  sourceUris?: string[]
  claims?: Array<{ text: string; sourceUri?: string; confidence?: number }>
  followUpTasks?: DiscoveryTask[]
  metadata?: Record<string, unknown>
}

export interface KnowledgeDiscoveryWorker {
  run(task: DiscoveryTask, signal?: AbortSignal): Promise<DiscoveryResult> | DiscoveryResult
}

export interface KnowledgeDiscoveryDispatcher {
  dispatch(
    tasks: DiscoveryTask[],
    options?: {
      concurrency?: number
      signal?: AbortSignal
    },
  ): Promise<DiscoveryResult[]>
}

export type DiscoveryLoopStopReason = 'complete' | 'max-rounds' | 'max-tasks' | 'aborted'

export interface DiscoveryLoopRound {
  round: number
  tasks: DiscoveryTask[]
  results: DiscoveryResult[]
  queuedFollowUps: DiscoveryTask[]
}

export interface DiscoveryLoopResult {
  stopReason: DiscoveryLoopStopReason
  tasksDispatched: number
  results: DiscoveryResult[]
  rounds: DiscoveryLoopRound[]
  /** Tasks retained, not dropped, when a configured limit stops the loop. */
  pendingTasks: DiscoveryTask[]
  /** Structurally identical task identities ignored to prevent cycles. */
  duplicateTaskIds: string[]
}

export interface RunDiscoveryLoopOptions {
  dispatcher: KnowledgeDiscoveryDispatcher
  initialTasks: readonly DiscoveryTask[]
  /** Maximum follow-up depth including the initial dispatch. Default 3. */
  maxRounds?: number
  /** Maximum tasks dispatched across all rounds. Default 24. */
  maxTasks?: number
  /** Forwarded to the dispatcher. Default 4. */
  concurrency?: number
  signal?: AbortSignal
  onRound?: (round: DiscoveryLoopRound) => Promise<void> | void
}

/**
 * Dispatch discovery tasks and recursively pursue worker-proposed follow-ups.
 *
 * The runner owns only bounded scheduling and accounting. Workers own search,
 * source verification, and domain-specific candidate shapes.
 */
export async function runDiscoveryLoop(
  options: RunDiscoveryLoopOptions,
): Promise<DiscoveryLoopResult> {
  const maxRounds = positiveInteger(options.maxRounds ?? 3, 'maxRounds')
  const maxTasks = positiveInteger(options.maxTasks ?? 24, 'maxTasks')
  const concurrency = positiveInteger(options.concurrency ?? 4, 'concurrency')
  const known = new Map<string, DiscoveryTask>()
  const pending: DiscoveryTask[] = []
  const duplicateTaskIds = new Set<string>()
  enqueueTasks(options.initialTasks, known, pending, duplicateTaskIds)

  const rounds: DiscoveryLoopRound[] = []
  const results: DiscoveryResult[] = []
  let tasksDispatched = 0
  let aborted = false

  while (pending.length > 0 && rounds.length < maxRounds && tasksDispatched < maxTasks) {
    if (options.signal?.aborted) {
      aborted = true
      break
    }
    const capacity = maxTasks - tasksDispatched
    const tasks = pending.splice(0, capacity)
    let dispatched: DiscoveryResult[]
    try {
      dispatched = orderCompleteDispatch(
        tasks,
        await options.dispatcher.dispatch(tasks, {
          concurrency,
          signal: options.signal,
        }),
      )
    } catch (cause) {
      if (!options.signal?.aborted) throw cause
      pending.unshift(...tasks)
      aborted = true
      break
    }
    tasksDispatched += tasks.length
    results.push(...dispatched)

    const queuedFollowUps: DiscoveryTask[] = []
    for (const result of dispatched) {
      enqueueTasks(result.followUpTasks ?? [], known, queuedFollowUps, duplicateTaskIds)
    }
    pending.push(...queuedFollowUps)
    const round: DiscoveryLoopRound = {
      round: rounds.length + 1,
      tasks,
      results: dispatched,
      queuedFollowUps,
    }
    rounds.push(round)
    await options.onRound?.(round)
    if (options.signal?.aborted) {
      aborted = true
      break
    }
  }

  const stopReason: DiscoveryLoopStopReason = aborted
    ? 'aborted'
    : pending.length === 0
      ? 'complete'
      : tasksDispatched >= maxTasks
        ? 'max-tasks'
        : 'max-rounds'
  return {
    stopReason,
    tasksDispatched,
    results,
    rounds,
    pendingTasks: pending,
    duplicateTaskIds: [...duplicateTaskIds],
  }
}

export function createLocalDiscoveryDispatcher(
  worker: KnowledgeDiscoveryWorker,
): KnowledgeDiscoveryDispatcher {
  return {
    async dispatch(tasks, options = {}) {
      const concurrency = Math.max(1, options.concurrency ?? 4)
      const results: DiscoveryResult[] = []
      let cursor = 0
      async function runNext(): Promise<void> {
        while (cursor < tasks.length) {
          if (options.signal?.aborted) throw new Error('Discovery dispatch aborted')
          const task = tasks[cursor++]!
          results.push(await worker.run(task, options.signal))
        }
      }
      await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, runNext))
      return orderCompleteDispatch(tasks, results)
    },
  }
}

function enqueueTasks(
  tasks: readonly DiscoveryTask[],
  known: Map<string, DiscoveryTask>,
  destination: DiscoveryTask[],
  duplicateTaskIds: Set<string>,
): void {
  for (const task of tasks) {
    assertTask(task)
    const prior = known.get(task.id)
    if (!prior) {
      known.set(task.id, task)
      destination.push(task)
      continue
    }
    if (!isDeepStrictEqual(prior, task)) {
      throw new Error(`Discovery task id '${task.id}' refers to conflicting tasks`)
    }
    duplicateTaskIds.add(task.id)
  }
}

function assertTask(task: DiscoveryTask): void {
  if (!task.id.trim()) throw new Error('Discovery task id must not be empty')
  if (!task.goal.trim()) throw new Error(`Discovery task '${task.id}' goal must not be empty`)
}

function orderCompleteDispatch(
  tasks: readonly DiscoveryTask[],
  results: readonly DiscoveryResult[],
): DiscoveryResult[] {
  const order = new Map(tasks.map((task, index) => [task.id, index]))
  const received = new Set<string>()
  for (const result of results) {
    if (!order.has(result.taskId)) {
      throw new Error(`Discovery dispatcher returned unknown task '${result.taskId}'`)
    }
    if (received.has(result.taskId)) {
      throw new Error(`Discovery dispatcher returned task '${result.taskId}' more than once`)
    }
    received.add(result.taskId)
  }
  const missing = tasks.filter((task) => !received.has(task.id)).map((task) => task.id)
  if (missing.length > 0) {
    throw new Error(`Discovery dispatcher omitted tasks: ${missing.join(', ')}`)
  }
  return [...results].sort(
    (a, b) => (order.get(a.taskId) as number) - (order.get(b.taskId) as number),
  )
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Discovery loop ${name} must be a positive integer`)
  }
  return value
}
