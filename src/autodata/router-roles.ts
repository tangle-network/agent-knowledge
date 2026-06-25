/**
 * The REAL two-tier roles for the Autodata loop, over the Tangle router.
 *
 * One transport seam — `routerChat` — POSTs `/chat/completions` and returns content + exact token
 * usage + a per-call USD cost (the router's own cost when it returns one, else a documented
 * rate-table estimate over the exact token counts; the source is flagged, never silently faked).
 * The four roles are materialized on top of it:
 *   • challenger (glm-5.2) → an `inProcessSandboxClient` that asks for ONE JSON example and parses it
 *   • weak solver (qwen-2.5-7b) / strong solver (qwen3-235b) → `inProcessSandboxClient` answer workers
 *   • judge (glm-5.2) → an `llmJudge` `JudgeConfig` whose transport is a `sandbox-sdk` ChatClient
 *     wrapping `routerChat`; the judge's own spend is recorded into the same `CostLedger` (the loop
 *     only aggregates challenger + solver spend, so the judge channel would otherwise be invisible).
 *
 * glm-5.2 returns empty content unless `max_tokens` is generous, so every glm call is floored and the
 * judge is built with an explicit `maxTokens`.
 */

import {
  type ChatCallOpts,
  type ChatRequest,
  type ChatResponse,
  type CostLedger,
  createChatClient,
  llmJudge,
} from '@tangle-network/agent-eval'
import type { JudgeConfig } from '@tangle-network/agent-eval/campaign'
import { inProcessSandboxClient, type SandboxClient } from '@tangle-network/agent-runtime/loops'
import type { SandboxEvent } from '@tangle-network/sandbox'
import type { DataExample, SolverArtifact } from './data-creation-loop'

export const DEFAULT_BASE_URL = 'https://router.tangle.tools/v1'

// A genuine small-vs-large tier in one model family. The brief specified the Qwen tier
// (`qwen/qwen-2.5-7b-instruct` weak, `qwen/qwen3-235b-a22b` strong), but on the live Tangle router
// EVERY Qwen id 401s `No API key configured for model` for this key — the Qwen upstream is not
// provisioned (verified by probing `/v1/chat/completions` across the `/v1/models` catalog). The
// GLM family IS served, so the real tier here is the smallest GLM (`glm-4.5-air`) as the weak solver
// vs the latest (`glm-5.2`) as the strong solver. Same family, a real generational/size gap; swap
// these constants back to the Qwen ids once the router provisions that upstream.
export const WEAK_SOLVER_MODEL = 'glm-4.5-air'
export const STRONG_SOLVER_MODEL = 'glm-5.2'
export const CHALLENGER_MODEL = 'glm-5.2'
export const JUDGE_MODEL = 'glm-5.2'

interface ModelPrice {
  /** USD per 1M input tokens. */
  inputPerM: number
  /** USD per 1M output tokens. */
  outputPerM: number
}

/**
 * Rate table for the $ estimate. The TOKEN COUNTS are exact (read from the router's `usage`); these
 * rates are the documented basis for converting them to dollars WHEN the router returns no per-call
 * cost. They are estimates, not invoices — `routerChat` flags every call's `costSource` so a report
 * can say how many calls were router-priced vs rate-estimated.
 */
const PRICE_TABLE: Record<string, ModelPrice> = {
  'glm-4.5-air': { inputPerM: 0.2, outputPerM: 0.6 },
  'glm-5.2': { inputPerM: 0.95, outputPerM: 3.0 },
}

/** Per-call usage record surfaced to an optional sink for cost-provenance reporting. */
export interface RouterCallRecord {
  model: string
  promptTokens: number
  completionTokens: number
  costUsd: number
  costSource: 'router' | 'estimated'
  finishReason: string | null
}

export interface RouterChatInput {
  apiKey: string
  baseUrl?: string
  model: string
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  maxTokens: number
  temperature?: number
  jsonMode?: boolean
  signal?: AbortSignal
  onCall?: (rec: RouterCallRecord) => void
}

export interface RouterChatResult {
  content: string
  promptTokens: number
  completionTokens: number
  costUsd: number
  costSource: 'router' | 'estimated'
  finishReason: string | null
  raw: Record<string, unknown>
}

/** glm spends its budget on hidden reasoning and returns empty content unless max_tokens is high. */
function maxTokensFloor(model: string): number {
  return /glm/i.test(model) ? 1500 : 512
}

/** Read a per-call cost the router may return, across the field names proxies use. */
function routerReportedCost(body: Record<string, unknown>): number | null {
  const usage = (body.usage ?? {}) as Record<string, unknown>
  const candidates = [body._response_cost, body.cost, usage.cost, usage.total_cost]
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c) && c > 0) return c
  }
  return null
}

function estimateCostUsd(model: string, promptTokens: number, completionTokens: number): number {
  const price = PRICE_TABLE[model]
  if (!price) {
    // Fail loud: a model we route to but cannot price would emit a 0 that masquerades as "free".
    throw new Error(`no price-table entry for model '${model}' — add it before routing live spend`)
  }
  return (promptTokens * price.inputPerM + completionTokens * price.outputPerM) / 1_000_000
}

/**
 * One Tangle-router chat call. Fails loud on a non-2xx status. Returns the visible content, the
 * exact prompt/completion token counts, and a USD cost (router-reported when present, else
 * rate-estimated over the real token counts) with its source flagged.
 */
export async function routerChat(input: RouterChatInput): Promise<RouterChatResult> {
  const baseUrl = (input.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const max_tokens = Math.max(input.maxTokens, maxTokensFloor(input.model))
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.apiKey}` },
    signal: input.signal,
    body: JSON.stringify({
      model: input.model,
      messages: input.messages,
      max_tokens,
      temperature: input.temperature ?? 0.2,
      stream: false,
      ...(input.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText)
    throw new Error(`router ${res.status} for ${input.model}: ${detail.slice(0, 400)}`)
  }
  const body = (await res.json()) as Record<string, unknown>
  const choice = (body.choices as { message?: { content?: string }; finish_reason?: string }[])?.[0]
  const usage = (body.usage ?? {}) as { prompt_tokens?: number; completion_tokens?: number }
  const promptTokens = usage.prompt_tokens ?? 0
  const completionTokens = usage.completion_tokens ?? 0
  const reported = routerReportedCost(body)
  const costUsd = reported ?? estimateCostUsd(input.model, promptTokens, completionTokens)
  const costSource: 'router' | 'estimated' = reported !== null ? 'router' : 'estimated'
  const finishReason = choice?.finish_reason ?? null
  input.onCall?.({
    model: input.model,
    promptTokens,
    completionTokens,
    costUsd,
    costSource,
    finishReason,
  })
  return {
    content: choice?.message?.content ?? '',
    promptTokens,
    completionTokens,
    costUsd,
    costSource,
    finishReason,
    raw: body,
  }
}

// ── Parsing the challenger's JSON example ─────────────────────────────────────────────────────

/** Extract the first balanced top-level JSON object from a model response (handles ```json fences). */
function extractJsonObject(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = fenced ? (fenced[1] ?? '') : text
  const start = body.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < body.length; i++) {
    const ch = body[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') inString = !inString
    if (inString) continue
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return body.slice(start, i + 1)
    }
  }
  return null
}

/** Parse a challenger response into a `DataExample`, or throw loud (the loop refines on the error). */
export function parseDataExample(text: string): DataExample {
  const json = extractJsonObject(text)
  if (!json) throw new Error('challenger response contained no JSON object')
  const parsed = JSON.parse(json) as Record<string, unknown>
  const rubric = parsed.rubric
  if (
    typeof parsed.context !== 'string' ||
    typeof parsed.question !== 'string' ||
    typeof parsed.reference !== 'string' ||
    !Array.isArray(rubric)
  ) {
    throw new Error('challenger JSON missing a required field (context/question/reference/rubric)')
  }
  return {
    context: parsed.context,
    question: parsed.question,
    reference: parsed.reference,
    rubric: rubric.map((r) => String(r)),
  }
}

// ── The roles ─────────────────────────────────────────────────────────────────────────────────

const challengerSystem =
  'You write ONE hard exam question from a source document. The question must require multi-step ' +
  'reasoning a small model would get wrong but a strong model would get right — never a verbatim ' +
  'lookup. Return STRICT JSON and nothing else: ' +
  '{"context": string, "question": string, "reference": string, "rubric": string[] }. ' +
  'The context is a short excerpt from the document; the question must NOT be answerable by copying ' +
  'a sentence; the reference is the correct answer; the rubric is 2-3 scoring criteria. ' +
  'Do NOT put the reference answer verbatim inside the context.'

const judgeSystem =
  'You are grading a candidate ANSWER to a question against a RUBRIC and a REFERENCE answer. ' +
  'Return JSON {"dimensions":{"rubric_coverage":N,"correctness":N},"notes":"..."} with each score ' +
  'in [0,1]. rubric_coverage = the fraction of rubric criteria the answer satisfies; correctness = ' +
  'how well the answer agrees with the reference. Be strict: a vague or partial answer scores low.'

export interface RouterRolesConfig {
  apiKey: string
  baseUrl?: string
  challengerModel?: string
  weakModel?: string
  strongModel?: string
  judgeModel?: string
  /** Judge spend is recorded here directly (the loop captures only challenger + solver spend). */
  ledger: CostLedger
  /** Optional sink for every router call's cost provenance. */
  onCall?: (rec: RouterCallRecord) => void
}

export interface AutodataRoles {
  challenger: SandboxClient
  weakSolver: SandboxClient
  strongSolver: SandboxClient
  judge: JudgeConfig<SolverArtifact>
}

function solverClient(cfg: RouterRolesConfig, model: string): SandboxClient {
  return inProcessSandboxClient({
    onPrompt: async (prompt, ctx): Promise<SandboxEvent[]> => {
      const r = await routerChat({
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        model,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: 1024,
        signal: ctx.signal,
        onCall: cfg.onCall,
      })
      return [
        {
          type: 'llm_call',
          data: {
            model,
            tokensIn: r.promptTokens,
            tokensOut: r.completionTokens,
            costUsd: r.costUsd,
          },
        },
        { type: 'result', data: { result: { answer: r.content } } },
      ]
    },
  })
}

function challengerClient(cfg: RouterRolesConfig): SandboxClient {
  const model = cfg.challengerModel ?? CHALLENGER_MODEL
  return inProcessSandboxClient({
    onPrompt: async (prompt, ctx): Promise<SandboxEvent[]> => {
      const r = await routerChat({
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        model,
        messages: [
          { role: 'system', content: challengerSystem },
          { role: 'user', content: prompt },
        ],
        maxTokens: 1500,
        jsonMode: true,
        signal: ctx.signal,
        onCall: cfg.onCall,
      })
      const example = parseDataExample(r.content)
      return [
        {
          type: 'llm_call',
          data: {
            model,
            tokensIn: r.promptTokens,
            tokensOut: r.completionTokens,
            costUsd: r.costUsd,
          },
        },
        { type: 'result', data: { result: example } },
      ]
    },
  })
}

function rubricJudge(cfg: RouterRolesConfig): JudgeConfig<SolverArtifact> {
  const judgeModel = cfg.judgeModel ?? JUDGE_MODEL
  const chat = createChatClient({
    transport: 'sandbox-sdk',
    defaultModel: judgeModel,
    chat: async (req: ChatRequest, opts?: ChatCallOpts): Promise<ChatResponse> => {
      const model = req.model ?? judgeModel
      const messages = req.messages.map((m) => ({
        role: m.role,
        content:
          typeof m.content === 'string'
            ? m.content
            : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n'),
      }))
      const r = await routerChat({
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        model,
        messages,
        maxTokens: req.maxTokens ?? 1500,
        temperature: req.temperature,
        jsonMode: req.jsonMode,
        signal: opts?.signal,
        onCall: cfg.onCall,
      })
      cfg.ledger.record({
        model,
        channel: 'judge',
        usage: { inputTokens: r.promptTokens, outputTokens: r.completionTokens },
        actualCostUsd: r.costUsd,
        tags: { role: 'judge' },
      })
      return {
        content: r.content,
        usage: {
          promptTokens: r.promptTokens,
          completionTokens: r.completionTokens,
          totalTokens: r.promptTokens + r.completionTokens,
        },
        costUsd: r.costUsd,
        model,
        durationMs: 0,
        finishReason: r.finishReason,
        contentEmpty: r.content.trim() === '',
        raw: r.raw,
      }
    },
  })

  return llmJudge<SolverArtifact>('autodata-rubric-judge', judgeSystem, {
    chat,
    maxTokens: 1500,
    dimensions: [
      {
        key: 'rubric_coverage',
        description: 'fraction of the rubric criteria the answer satisfies',
      },
      { key: 'correctness', description: 'agreement with the reference answer' },
    ],
    scale: 'unit',
    renderUser: ({ artifact }) =>
      `REFERENCE ANSWER:\n${artifact.example.reference}\n\n` +
      `RUBRIC:\n${artifact.example.rubric.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\n` +
      `CANDIDATE ANSWER:\n${artifact.answer}`,
  })
}

/** Materialize all four live roles over the Tangle router. */
export function buildAutodataRoles(cfg: RouterRolesConfig): AutodataRoles {
  return {
    challenger: challengerClient(cfg),
    weakSolver: solverClient(cfg, cfg.weakModel ?? WEAK_SOLVER_MODEL),
    strongSolver: solverClient(cfg, cfg.strongModel ?? STRONG_SOLVER_MODEL),
    judge: rubricJudge(cfg),
  }
}

export interface SmokeResult {
  model: string
  ok: boolean
  contentChars: number
  finishReason: string | null
  costUsd: number
  costSource: 'router' | 'estimated'
}

/**
 * The cost gate: one cheap call per model, asserting non-empty content, BEFORE the loop burn.
 * Returns a row per model so the caller can fail loud if any tier is dead.
 */
export async function smokeTestModels(cfg: {
  apiKey: string
  baseUrl?: string
  models?: string[]
  signal?: AbortSignal
}): Promise<SmokeResult[]> {
  const models = cfg.models ?? [CHALLENGER_MODEL, WEAK_SOLVER_MODEL, STRONG_SOLVER_MODEL]
  const rows: SmokeResult[] = []
  for (const model of models) {
    const r = await routerChat({
      apiKey: cfg.apiKey,
      baseUrl: cfg.baseUrl,
      model,
      messages: [{ role: 'user', content: 'Reply with the single word: ready.' }],
      maxTokens: 32,
      signal: cfg.signal,
    })
    rows.push({
      model,
      ok: r.content.trim().length > 0,
      contentChars: r.content.trim().length,
      finishReason: r.finishReason,
      costUsd: r.costUsd,
      costSource: r.costSource,
    })
  }
  return rows
}
