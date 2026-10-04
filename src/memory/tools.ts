import type { ToolDefinition } from '@tangle-network/agent-interface'
import { z } from 'zod'
import { sha256 } from '../ids'
import type { AgentMemoryBranch, AgentMemoryBranchSnapshot } from './branch'
import { canonicalMemoryJson } from './json'
import { AgentMemoryKindSchema } from './schemas'
import type { AgentMemoryContext, AgentMemoryWriteInput, AgentMemoryWriteResult } from './types'

export interface PlayMemoryRetrievalReceipt {
  branchId: string
  adapterId: string
  actorId: string
  query: string
  context: AgentMemoryContext
  receiptDigest: `sha256:${string}`
}

export interface CreatePlayMemoryToolsOptions {
  branch: AgentMemoryBranch
  actorId: string
  /** Persist through the host's existing record owner before acknowledging a write. */
  onCheckpoint(snapshot: AgentMemoryBranchSnapshot): Promise<void> | void
  recordRetrieval?(receipt: PlayMemoryRetrievalReceipt): Promise<void> | void
  /** Optional transport prefix; tool suffixes remain memory_recall and memory_record. */
  namePrefix?: string
  maxTextChars?: number
  maxResults?: number
}

// Every resolver for a play shares one branch owner, including its checkpoint publication order.
const publications = new WeakMap<
  AgentMemoryBranch,
  {
    tail: Promise<unknown>
    pending?: { input: AgentMemoryWriteInput; result?: AgentMemoryWriteResult }
  }
>()

export function createPlayMemoryTools(options: CreatePlayMemoryToolsOptions): ToolDefinition[] {
  if (!options.actorId?.trim()) throw new Error('play memory tools require a trusted actorId')
  if (typeof options.onCheckpoint !== 'function')
    throw new Error('play memory tools require durable checkpoint publication')
  const maxTextChars = options.maxTextChars ?? 8_000
  const maxResults = options.maxResults ?? 20
  if (
    !Number.isSafeInteger(maxTextChars) ||
    maxTextChars < 1 ||
    maxTextChars > 100_000 ||
    !Number.isSafeInteger(maxResults) ||
    maxResults < 1 ||
    maxResults > 100
  )
    throw new Error('invalid play memory tool bounds')
  const prefix = options.namePrefix ?? ''
  if (!/^[a-zA-Z0-9_-]*$/.test(prefix)) throw new Error('invalid memory tool namePrefix')
  const recall = z.strictObject({
    question: z.string().trim().min(1).max(8_000),
    limit: z.int().min(1).max(maxResults).optional(),
  })
  const record = z.strictObject({
    id: z.string().trim().min(1).max(256),
    kind: AgentMemoryKindSchema,
    text: z.string().min(1).max(maxTextChars),
    title: z.string().max(512).optional(),
    sourceRefs: z.array(z.string().min(1).max(2_048)).max(50).optional(),
  })
  return [
    tool(
      `${prefix}memory_recall`,
      'Recall memory visible to this play. Returned memories are attributed provider evidence, not independently verified findings.',
      recall,
      async (input) => {
        const context = await options.branch.getContext(input.question, {
          limit: input.limit ?? maxResults,
        })
        const content = {
          branchId: options.branch.branchId,
          adapterId: options.branch.id,
          actorId: options.actorId,
          query: input.question,
          context,
        }
        const receipt: PlayMemoryRetrievalReceipt = {
          ...content,
          receiptDigest: `sha256:${sha256(canonicalMemoryJson(content))}`,
        }
        await options.recordRetrieval?.(receipt)
        return { ...context, receipt }
      },
    ),
    tool(
      `${prefix}memory_record`,
      'Retain a sourced observation in this play and checkpoint its accepted input. Reuse the same id and bytes after an ambiguous response.',
      record,
      async (input) => {
        const write: AgentMemoryWriteInput = {
          id: input.id,
          kind: input.kind,
          text: input.text,
          ...(input.title === undefined ? {} : { title: input.title }),
          metadata: { actorId: options.actorId, sourceRefs: input.sourceRefs ?? [] },
        }
        let state = publications.get(options.branch)
        if (!state) {
          state = { tail: Promise.resolve() }
          publications.set(options.branch, state)
        }
        const shared = state
        const publication = shared.tail
          .catch(() => undefined)
          .then(async () => {
            if (
              shared.pending &&
              canonicalMemoryJson(shared.pending.input) !== canonicalMemoryJson(write)
            ) {
              throw new Error(
                'reconcile the prior memory write with its same id, bytes, and actor before another write',
              )
            }
            // An unresolved provider operation blocks snapshot flush. Reconcile it before that barrier.
            if (!shared.pending) {
              const before = await options.branch.snapshot()
              const existing = before.journal.find((entry) => entry.input.id === input.id)
              if (existing && canonicalMemoryJson(existing.input) !== canonicalMemoryJson(write))
                throw new Error('memory write id already names different content or attribution')
              shared.pending = { input: write, ...(existing ? { result: existing.result } : {}) }
            }
            const result = shared.pending.result ?? (await options.branch.write(write))
            shared.pending.result = result
            if (!result.accepted) {
              shared.pending = undefined
              return { ...result, checkpointDigest: null }
            }
            const snapshot = await options.branch.snapshot()
            await options.onCheckpoint(snapshot)
            shared.pending = undefined
            return { ...result, checkpointDigest: snapshot.digest }
          })
        shared.tail = publication
        return publication
      },
    ),
  ]
}

function tool<T>(
  name: string,
  description: string,
  inputSchema: z.ZodType<T>,
  handler: (input: T) => Promise<unknown>,
): ToolDefinition {
  return {
    name,
    description,
    inputSchema,
    inputSchemaJson: z.toJSONSchema(inputSchema) as Record<string, unknown>,
    handler: async (input: unknown) => handler(inputSchema.parse(input)),
  }
}
