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
      return results.sort(
        (a, b) =>
          tasks.findIndex((task) => task.id === a.taskId) -
          tasks.findIndex((task) => task.id === b.taskId),
      )
    },
  }
}
