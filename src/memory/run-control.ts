import { join } from 'node:path'
import { acquireSingleRunLock, type CampaignStorage } from '@tangle-network/agent-eval/campaign'

export interface AgentMemoryRunLease {
  assertOwned(): Promise<void> | void
  release(): Promise<void> | void
}

export type AgentMemoryAcquireRunLease = (input: {
  experimentId: string
  runDir: string
}) => AgentMemoryRunLease | Promise<AgentMemoryRunLease>

export type AgentMemoryControllerMode = 'process-local'

export interface OwnedAgentMemoryRunLease {
  assertOwned(): Promise<void>
  release(): Promise<void>
}

const activeProcessLocalRuns = new Set<string>()

export async function acquireAgentMemoryRunLease(input: {
  experimentId: string
  runDir: string
  storage: CampaignStorage
  customStorage: boolean
  lockFileName: string
  label: string
  controllerMode?: AgentMemoryControllerMode
  acquireRunLease?: AgentMemoryAcquireRunLease
}): Promise<OwnedAgentMemoryRunLease> {
  if (input.acquireRunLease && input.controllerMode) {
    throw new Error(`${input.label} cannot combine acquireRunLease with controllerMode`)
  }
  if (input.acquireRunLease) {
    const lease = await input.acquireRunLease({
      experimentId: input.experimentId,
      runDir: input.runDir,
    })
    if (!lease || typeof lease.assertOwned !== 'function' || typeof lease.release !== 'function') {
      throw new Error(`${input.label} acquireRunLease must return assertOwned and release`)
    }
    return {
      async assertOwned() {
        await lease.assertOwned()
      },
      async release() {
        await lease.release()
      },
    }
  }

  if (!input.customStorage) {
    if (input.controllerMode) {
      throw new Error(`${input.label} controllerMode is only valid with custom storage`)
    }
    const lock = acquireSingleRunLock({
      lockPath: join(input.runDir, input.lockFileName),
      releaseOnExit: false,
    })
    return {
      async assertOwned() {},
      async release() {
        lock.release()
      },
    }
  }

  if (input.controllerMode !== 'process-local') {
    throw new Error(
      `${input.label} custom storage requires acquireRunLease or controllerMode='process-local'`,
    )
  }
  const runKey = `${input.label}:${input.runDir}`
  if (activeProcessLocalRuns.has(runKey)) {
    throw new Error(`${input.label} run '${input.runDir}' already has an active controller`)
  }
  activeProcessLocalRuns.add(runKey)
  let released = false
  return {
    async assertOwned() {
      if (released || !activeProcessLocalRuns.has(runKey)) {
        throw new Error(`${input.label} run '${input.runDir}' controller lease was lost`)
      }
    },
    async release() {
      if (released) return
      released = true
      activeProcessLocalRuns.delete(runKey)
    },
  }
}
