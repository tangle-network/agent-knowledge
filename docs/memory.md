# Integrate memory systems

> Extracted from the README — see the [README](../README.md) for the package overview.

## Integrate memory systems

`@tangle-network/agent-knowledge/memory` defines `AgentMemoryAdapter` and adapters for Mem0, Graphiti, and Neo4j Agent Memory.
The package is not a memory database.
Install the provider you use, create its client, and pass that client to the adapter.

The memory APIs support scoped reads and writes and isolated branches.
Compare providers on product tasks with `@tangle-network/agent-eval` before changing production behavior.