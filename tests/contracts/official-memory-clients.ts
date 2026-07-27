import type { MemoryClient as Neo4jMemoryClient } from '@neo4j-labs/agent-memory'
import type { MemoryClient } from 'mem0ai'
import type { Memory as OssMemory } from 'mem0ai/oss'
import {
  createMem0MemoryAdapter,
  createNeo4jAgentMemoryAdapter,
  type Mem0HostedClient,
  type Mem0OssClient,
} from '../../src/memory/index'

export function acceptHostedMem0Client(client: MemoryClient): Mem0HostedClient {
  createMem0MemoryAdapter({ client, mode: 'hosted' })
  return client
}

export function acceptOssMem0Client(client: OssMemory): Mem0OssClient {
  createMem0MemoryAdapter({ client, mode: 'oss' })
  return client
}

export function acceptNeo4jMemoryClient(client: Neo4jMemoryClient): object {
  createNeo4jAgentMemoryAdapter({ client, transport: 'rest', branchId: 'contract-test' })
  return client
}
