import { describe, expect, it } from 'vitest'
import {
  createLocalDiscoveryDispatcher,
  type DiscoveryTask,
  runDiscoveryLoop,
} from '../src/discovery'

describe('runDiscoveryLoop', () => {
  it('pursues follow-up tasks across bounded concurrent rounds', async () => {
    const dispatcher = createLocalDiscoveryDispatcher({
      run: async (task) => ({
        taskId: task.id,
        summary: `researched ${task.goal}`,
        sourceUris: [`https://example.test/${task.id}`],
        followUpTasks:
          task.id === 'root'
            ? [
                { id: 'tools', goal: 'Find tools' },
                { id: 'mcp', goal: 'Find MCP servers' },
              ]
            : task.id === 'tools'
              ? [{ id: 'licenses', goal: 'Verify licenses' }]
              : undefined,
      }),
    })

    const result = await runDiscoveryLoop({
      dispatcher,
      initialTasks: [{ id: 'root', goal: 'Find open-source options' }],
      maxRounds: 3,
      maxTasks: 10,
      concurrency: 2,
    })

    expect(result.stopReason).toBe('complete')
    expect(result.tasksDispatched).toBe(4)
    expect(result.rounds.map((round) => round.tasks.map((task) => task.id))).toEqual([
      ['root'],
      ['tools', 'mcp'],
      ['licenses'],
    ])
    expect(result.results.flatMap((entry) => entry.sourceUris ?? [])).toHaveLength(4)
    expect(result.pendingTasks).toEqual([])
  })

  it('returns every undispatched task when a round or task limit stops the search', async () => {
    const followUps: DiscoveryTask[] = [
      { id: 'a', goal: 'A' },
      { id: 'b', goal: 'B' },
    ]
    const dispatcher = createLocalDiscoveryDispatcher({
      run: (task) => ({
        taskId: task.id,
        summary: task.goal,
        followUpTasks: task.id === 'root' ? followUps : undefined,
      }),
    })

    const roundLimited = await runDiscoveryLoop({
      dispatcher,
      initialTasks: [{ id: 'root', goal: 'Root' }],
      maxRounds: 1,
    })
    expect(roundLimited.stopReason).toBe('max-rounds')
    expect(roundLimited.pendingTasks).toEqual(followUps)

    const taskLimited = await runDiscoveryLoop({
      dispatcher,
      initialTasks: [{ id: 'root', goal: 'Root' }],
      maxTasks: 2,
    })
    expect(taskLimited.stopReason).toBe('max-tasks')
    expect(taskLimited.results.map((entry) => entry.taskId)).toEqual(['root', 'a'])
    expect(taskLimited.pendingTasks).toEqual([{ id: 'b', goal: 'B' }])
  })

  it('deduplicates exact cycles and rejects conflicting task identities', async () => {
    const task = { id: 'same', goal: 'Same' }
    const exact = await runDiscoveryLoop({
      dispatcher: createLocalDiscoveryDispatcher({
        run: (current) => ({
          taskId: current.id,
          summary: current.goal,
          followUpTasks: [task],
        }),
      }),
      initialTasks: [task],
    })
    expect(exact.stopReason).toBe('complete')
    expect(exact.duplicateTaskIds).toEqual(['same'])

    await expect(
      runDiscoveryLoop({
        dispatcher: createLocalDiscoveryDispatcher({
          run: (current) => ({
            taskId: current.id,
            summary: current.goal,
            followUpTasks: [{ id: current.id, goal: 'Different' }],
          }),
        }),
        initialTasks: [task],
      }),
    ).rejects.toThrow(/conflicting tasks/)
  })

  it('rejects incomplete dispatcher output instead of losing a task', async () => {
    await expect(
      runDiscoveryLoop({
        dispatcher: {
          dispatch: async () => [{ taskId: 'a', summary: 'only one' }],
        },
        initialTasks: [
          { id: 'a', goal: 'A' },
          { id: 'b', goal: 'B' },
        ],
      }),
    ).rejects.toThrow(/omitted tasks: b/)
  })

  it('returns completed work and pending tasks when cancelled', async () => {
    const controller = new AbortController()
    const result = await runDiscoveryLoop({
      dispatcher: createLocalDiscoveryDispatcher({
        run: (task) => ({
          taskId: task.id,
          summary: task.goal,
          followUpTasks: task.id === 'root' ? [{ id: 'next', goal: 'Next' }] : undefined,
        }),
      }),
      initialTasks: [{ id: 'root', goal: 'Root' }],
      signal: controller.signal,
      onRound: () => controller.abort(),
    })

    expect(result.stopReason).toBe('aborted')
    expect(result.results.map((entry) => entry.taskId)).toEqual(['root'])
    expect(result.pendingTasks).toEqual([{ id: 'next', goal: 'Next' }])
  })

  it('validates local dispatcher output when used without the loop', async () => {
    const dispatcher = createLocalDiscoveryDispatcher({
      run: () => ({ taskId: 'unknown', summary: 'wrong identity' }),
    })
    await expect(dispatcher.dispatch([{ id: 'expected', goal: 'Expected' }])).rejects.toThrow(
      /unknown task 'unknown'/,
    )
  })
})
