/**
 * Credentialless offline stand-ins so the Autodata loop runs in CI with ZERO creds and reproducible
 * numbers: scripted challenger/solvers + a mock-transport judge. None of this is the lesson — it is
 * the minimum that lets the wiring be tested offline. The LIVE roles (real router models) live in
 * `router-roles.ts`; the scores here are tuned to reproduce the paper's Table 1 separation (an EASY
 * first-draft example barely separates the two solvers, a HARD loop-accepted one separates widely).
 *
 * Ported from agent-runtime `examples/agentic-data-creation/offline-fixtures.ts`.
 */

import { createChatClient, llmJudge } from '@tangle-network/agent-eval'
import type { JudgeConfig } from '@tangle-network/agent-eval/campaign'
import { inProcessSandboxClient, type SandboxClient } from '@tangle-network/agent-runtime/loops'
import type { SandboxEvent } from '@tangle-network/sandbox'
import type { DataExample, SolverArtifact } from './data-creation-loop'

export const groundingDoc = `Idempotency in the Payments API

Every write to POST /charges may carry an Idempotency-Key header. The server stores the first
response under that key for 24 hours. A retry with the SAME key and the SAME request body replays
the stored response instead of charging again. A retry with the SAME key but a DIFFERENT body is a
conflict: the server rejects it with 422 Unprocessable Entity and creates no second charge.
Idempotency keys are scoped per merchant account.`

export const baseInstruction = (doc: string): string =>
  `You are writing ONE training example from the document below. Produce a context excerpt, a ` +
  `question answerable from it, a reference answer, and a 2-3 item rubric.\n\nDOCUMENT:\n${doc}`

const easyExample: DataExample = {
  context: 'Every write to POST /charges may carry an Idempotency-Key header.',
  question: 'Which HTTP header carries the idempotency key on a POST /charges write?',
  reference: 'The request uses an Idempotency-Key header.',
  rubric: ['Names the Idempotency-Key header', 'Ties it to a POST /charges write'],
}

const hardExamples: DataExample[] = [
  {
    context:
      'A retry with the same key but a different body is a conflict: the server rejects it with 422 ' +
      'Unprocessable Entity and creates no second charge.',
    question:
      'Why must the server reject a same-key, different-body retry with 422 instead of replaying the ' +
      'stored response, and what failure does that prevent?',
    reference:
      'Replaying the stored response would apply it to a different request; rejecting with 422 surfaces ' +
      'the mismatch and prevents a double or incorrect charge.',
    rubric: [
      'States the server rejects the retry with 422',
      'Explains replaying the stored response would be wrong for a different body',
      'Identifies the prevented failure: a double or incorrect charge',
    ],
  },
  {
    context:
      'The server stores the first response under the idempotency key for 24 hours and replays it on a ' +
      'retry with the same key and the same body.',
    question:
      'Why does replaying the stored response on a same-key, same-body retry matter, and what failure ' +
      'does it prevent when a client retries after a dropped connection?',
    reference:
      'The original request may already have charged; replaying returns that one result so a network ' +
      'retry does not create a second charge.',
    rubric: [
      'Explains the first request may have already succeeded',
      'States the stored response is replayed instead of re-charging',
      'Identifies the prevented failure: a duplicate charge on retry',
    ],
  },
  {
    context: 'Idempotency keys are scoped per merchant account.',
    question:
      'Why are idempotency keys scoped per merchant account, and what would break if they were global ' +
      'across all merchants?',
    reference:
      'Per-merchant scoping isolates key spaces; a global scope would let one merchant key collide ' +
      'with another and replay the wrong merchant charge.',
    rubric: [
      'States keys are isolated per merchant account',
      'Explains a global scope risks cross-merchant key collisions',
      'Identifies the failure: replaying the wrong merchant charge',
    ],
  },
]

const hardQuestionPattern = /\b(why|explain|under what|what happens if|reason)\b/i

/**
 * Scripted challenger: first draft (no "REJECTED" in the prompt) → the EASY example; once the refine
 * driver folds a "too easy" reject into the prompt, it ships the next HARD example — proving the
 * loop's behavior changed because of the fold. Stateful so successive targets get DISTINCT examples.
 */
export function challengerClient(): SandboxClient {
  let hardServed = 0
  return inProcessSandboxClient({
    onPrompt: (prompt): SandboxEvent[] => {
      const wantsHarder = /rejected|too easy/i.test(prompt)
      const example = wantsHarder
        ? (hardExamples[hardServed++ % hardExamples.length] ?? easyExample)
        : easyExample
      return [
        {
          type: 'llm_call',
          data: { model: 'offline-challenger', tokensIn: 320, tokensOut: 90, costUsd: 0.0006 },
        },
        { type: 'result', data: { result: example } },
      ]
    },
  })
}

/**
 * Scripted solver: answers the rendered example and tags the answer with a grade marker the offline
 * judge reads. The weak solver produces a thin answer; the strong solver a complete one.
 */
export function solverClient(strength: 'weak' | 'strong'): SandboxClient {
  return inProcessSandboxClient({
    onPrompt: (prompt): SandboxEvent[] => {
      const hard = hardQuestionPattern.test(prompt)
      const sample = Number(/\[sample (\d+)\]/.exec(prompt)?.[1] ?? '0')
      const body =
        strength === 'strong'
          ? 'A complete, rubric-covering answer grounded in the context.'
          : 'A short, partial answer.'
      const answer = `${body} <<grade:${strength}:${hard ? 'hard' : 'easy'}:s${sample}>>`
      return [
        {
          type: 'llm_call',
          data: {
            model: `offline-${strength}-solver`,
            tokensIn: 140,
            tokensOut: 30,
            costUsd: 0.0003,
          },
        },
        { type: 'result', data: { result: { answer } } },
      ]
    },
  })
}

/** A REAL `llmJudge` over a MOCK transport: returns a scripted [0,1] score from the grade marker. */
export function buildRubricJudge(): JudgeConfig<SolverArtifact> {
  const chat = createChatClient({
    transport: 'mock',
    defaultModel: 'offline-judge',
    handler: async (req) => {
      const text = req.messages
        .map((m) => (typeof m.content === 'string' ? m.content : ''))
        .join('\n')
      const m = /<<grade:(strong|weak):(hard|easy):s(\d+)>>/.exec(text)
      const strength = m?.[1]
      const difficulty = m?.[2]
      const sampleIndex = m?.[3]
      if (!strength || !difficulty || sampleIndex === undefined) {
        throw new Error('offline judge: answer carried no grade marker')
      }
      const base =
        difficulty === 'hard'
          ? strength === 'strong'
            ? 0.77
            : 0.46
          : strength === 'strong'
            ? 0.86
            : 0.84
      // Per-sample jitter over samples 0,1,2 → −0.02, 0, +0.02, so the N× mean lands back on `base`.
      const jitter = (Number(sampleIndex) - 1) * 0.02
      const score = Math.min(1, Math.max(0, base + jitter))
      return {
        content: JSON.stringify({
          dimensions: { rubric_coverage: score, correctness: score },
          notes: `offline: ${strength} solver on ${difficulty} example (sample ${sampleIndex})`,
        }),
        usage: { promptTokens: 130, completionTokens: 25, totalTokens: 155 },
        costUsd: 0.0001,
        model: 'offline-judge',
        durationMs: 1,
        raw: {},
      }
    },
  })

  return llmJudge<SolverArtifact>(
    'rubric-judge',
    'Score the candidate ANSWER against the example RUBRIC. Return JSON ' +
      '{"dimensions":{"rubric_coverage":N,"correctness":N},"notes":"..."} with each score in [0,1].',
    {
      chat,
      dimensions: [
        {
          key: 'rubric_coverage',
          description: 'fraction of the rubric criteria the answer satisfies',
        },
        { key: 'correctness', description: 'agreement with the reference answer' },
      ],
      scale: 'unit',
      renderUser: ({ artifact }) =>
        `RUBRIC:\n${artifact.example.rubric.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\nANSWER:\n${artifact.answer}`,
    },
  )
}
