/**
 * The REAL two-tier roles for the Autodata loop, over the Tangle router.
 *
 * One transport seam — `routerChat` — POSTs `/chat/completions` and returns content + exact token
 * usage + a per-call USD cost (the router's own cost when it returns one, else a documented
 * rate-table estimate over the exact token counts; the source is flagged, never silently faked). It
 * retries only TRANSIENT failures (the router's "upstream capacity, retry shortly" 503s, 429/502/504,
 * network blips, per-request timeouts) with bounded backoff; a non-transient non-2xx fails loud.
 * The four roles are materialized on top of it (all models env-overridable — see the constants below):
 *   • challenger (`deepseek-v4-flash`) → an `inProcessSandboxClient` that authors ONE NON-EXTRACTIVE
 *     causal/comparative/mechanism/thesis-consistency JSON example and parses it.
 *   • weak solver (`groq/llama-3.1-8b-instant`) / strong solver (`gemini-2.5-pro`) → answer workers.
 *   • judge (`deepseek-v4-flash`) → an `llmJudge` `JudgeConfig` whose transport is a `sandbox-sdk`
 *     ChatClient wrapping `routerChat`; the judge's own spend is recorded into the same `CostLedger`
 *     (the loop only aggregates challenger + solver spend, so the judge channel is recorded here).
 *
 * A reasoning model spends its budget on hidden reasoning and returns EMPTY visible content when
 * `max_tokens` is too low (a glm/gemini footgun), so every call is floored and solvers fail loud on
 * empty content rather than scoring a non-answer as 0 (which would corrupt the gap).
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

// The proven-working tier on the live Tangle router, every id env-overridable:
//   • weak solver `groq/llama-3.1-8b-instant` — an 8B whose knowledge cutoff predates the default
//     grounding doc, so on non-memorized content it must REASON from the context (it can't recall),
//     which is what lets a hard causal question separate it from a frontier solver.
//   • strong solver `gemini-2.5-pro` — a frontier reasoner (a real wide capability gap vs the 8B).
//   • challenger + judge `deepseek-v4-flash` — a capable, fast, RELIABLE author/grader that is a
//     DIFFERENT family from both solvers (so the judge does not favour either solver's style). The
//     brief's `glm-5.2` works too when the router has GLM capacity; swap it back via env when it is up.
// The solver tier is the experiment's load-bearing knob — a real strong>weak capability gap is
// required for any example to clear the discriminative bar.
export const WEAK_SOLVER_MODEL = process.env.AUTODATA_WEAK_MODEL ?? 'groq/llama-3.1-8b-instant'
export const STRONG_SOLVER_MODEL = process.env.AUTODATA_STRONG_MODEL ?? 'gemini-2.5-pro'
export const CHALLENGER_MODEL = process.env.AUTODATA_CHALLENGER_MODEL ?? 'deepseek-v4-flash'
export const JUDGE_MODEL = process.env.AUTODATA_JUDGE_MODEL ?? 'deepseek-v4-flash'

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
  'glm-4.6': { inputPerM: 0.6, outputPerM: 2.2 },
  'glm-5.2': { inputPerM: 0.95, outputPerM: 3.0 },
  'deepseek-v4-flash': { inputPerM: 0.27, outputPerM: 0.41 },
  // Wide-tier solver pair (a genuine small-vs-frontier capability gap). Approximate router rates.
  'groq/llama-3.1-8b-instant': { inputPerM: 0.05, outputPerM: 0.08 },
  'gemini-2.5-pro': { inputPerM: 1.25, outputPerM: 10.0 },
  'gemini-2.5-flash': { inputPerM: 0.3, outputPerM: 2.5 },
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
  /** Per-request deadline so a stalled upstream can't hang the loop. Default 60s. */
  timeoutMs?: number
  /** Bounded retries on TRANSIENT failures (503/429/502/504, network, timeout). Default 4. */
  maxRetries?: number
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
/** Transient upstream statuses the router itself tells us to "retry shortly" — safe to re-issue. */
const transientStatuses = new Set([429, 502, 503, 504])

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Exponential backoff with jitter: ~1s, 2s, 4s, 8s (capped 10s) — bounded by maxRetries. */
function backoffMs(attempt: number): number {
  return Math.min(10_000, 2 ** attempt * 1000) + Math.floor(Math.random() * 250)
}

export async function routerChat(input: RouterChatInput): Promise<RouterChatResult> {
  const baseUrl = (input.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
  const max_tokens = Math.max(input.maxTokens, maxTokensFloor(input.model))
  const timeoutMs = input.timeoutMs ?? 60_000
  const maxRetries = input.maxRetries ?? 4
  const payload = JSON.stringify({
    model: input.model,
    messages: input.messages,
    max_tokens,
    temperature: input.temperature ?? 0.2,
    stream: false,
    ...(input.jsonMode ? { response_format: { type: 'json_object' } } : {}),
  })

  // One non-streaming chat call, retried only on TRANSIENT failures (the router's own
  // "upstream capacity, retry shortly" 503s, plus 429/502/504, network errors, and per-request
  // timeouts). A non-transient non-2xx (401/400/404) fails loud immediately — never silently.
  let body: Record<string, unknown> | undefined
  let lastTransient = ''
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Combine the caller's abort with a per-request deadline so a stalled upstream can't hang us.
    const deadline = AbortSignal.timeout(timeoutMs)
    const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline
    let res: Response
    try {
      res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.apiKey}` },
        signal,
        body: payload,
      })
    } catch (err) {
      // The caller's own abort is final; a timeout/network blip is transient and retryable.
      if (input.signal?.aborted) throw err
      lastTransient = `network/timeout: ${String(err).slice(0, 120)}`
      if (attempt < maxRetries) {
        await sleep(backoffMs(attempt))
        continue
      }
      throw new Error(
        `router call for ${input.model} failed after ${attempt + 1} tries — ${lastTransient}`,
      )
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText)
      if (transientStatuses.has(res.status) && attempt < maxRetries) {
        lastTransient = `${res.status}: ${detail.slice(0, 120)}`
        await sleep(backoffMs(attempt))
        continue
      }
      throw new Error(`router ${res.status} for ${input.model}: ${detail.slice(0, 400)}`)
    }
    body = (await res.json()) as Record<string, unknown>
    break
  }
  if (!body) {
    throw new Error(
      `router call for ${input.model} exhausted ${maxRetries + 1} tries — ${lastTransient}`,
    )
  }
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

// The non-extractive challenger. The prior loop nulled because the context LEAKED the answer:
// the question was recall/lookup, so an 8B read it out as well as a frontier model and the gap
// collapsed to ~0. The fix is the paper's: ask CAUSAL / COMPARATIVE / MECHANISM / THESIS-CONSISTENCY
// questions whose answer is an INFERENCE, and withhold the conclusion from the context the solver
// sees ("problems only, no solution") so the answer must be DERIVED, never quoted.
const challengerSystem =
  'You are an exam author. From a source excerpt, write ONE hard question that tests REASONING, ' +
  'not recall.\n\n' +
  'The question MUST be exactly one of these kinds:\n' +
  '  • CAUSAL — "why does X fail / what breaks if Y is omitted".\n' +
  '  • COMPARATIVE — "how does the tradeoff of X differ from Y, and why".\n' +
  '  • MECHANISM — "walk through how X produces Y; what fails if a step is skipped".\n' +
  '  • THESIS-CONSISTENCY — "which of two explanations the text offers is more consistent with its ' +
  'overall conclusion, and how would the other undermine it".\n' +
  'It must NEVER be recall / lookup / definition / enumeration ("what is X", "which header", ' +
  '"list the steps", "name the ...").\n\n' +
  'ANTI-LEAKAGE (mandatory):\n' +
  '  • The CONTEXT must contain ONLY the premises/evidence the solver needs. It MUST NOT contain a ' +
  'sentence that states the answer or the conclusion — the answer has to be DERIVED from the ' +
  'premises, not quotable from the context.\n' +
  '  • The REFERENCE is the correct DERIVED conclusion plus its reasoning chain. It must NOT appear ' +
  'verbatim in the context.\n\n' +
  'The RUBRIC is 2-3 criteria that reward the REASONING STEPS (e.g. "identifies that X depends on ' +
  'Y", "explains why removing Y causes the failure", "ties it to the stated conclusion") — never ' +
  '"mentions the keyword".\n\n' +
  'Return STRICT JSON and nothing else: ' +
  '{"context": string, "question": string, "reference": string, "rubric": string[] }.'

// The recall / extractive challenger — the prior (nulling) behavior, kept ONLY as the calibration
// baseline. It writes a normal question answerable straight from the excerpt, so the answer is in
// the context and a small model reads it out as well as a frontier one. The causal vs recall gap is
// the calibration that proves the lever.
const recallChallengerSystem =
  'You write ONE exam question from a source excerpt. Provide a short CONTEXT excerpt the question ' +
  'is answerable from, the QUESTION, the REFERENCE answer, and a 2-3 item RUBRIC. ' +
  'Return STRICT JSON and nothing else: ' +
  '{"context": string, "question": string, "reference": string, "rubric": string[] }.'

/** Which challenger prompt to materialize: the non-extractive causal author, or the recall baseline. */
export type ChallengerStyle = 'causal' | 'recall'

function challengerSystemFor(style: ChallengerStyle): string {
  return style === 'recall' ? recallChallengerSystem : challengerSystem
}

// The reasoning judge. It sees the CONTEXT the solver saw, so it can tell a derived answer from one
// that merely restates the context. The `reasoning` dimension IS the negative criterion: an answer
// that paraphrases the context without deriving the conclusion scores near 0 there — which is what
// pulls a recall-style weak answer below the strong model's derivation and opens the gap.
const judgeSystem =
  'You grade a candidate ANSWER to a REASONING question. You are given the CONTEXT the solver was ' +
  'shown, the REFERENCE answer, and the RUBRIC.\n' +
  'Return JSON {"dimensions":{"rubric_coverage":N,"correctness":N,"reasoning":N},"notes":"..."} ' +
  'with each score in [0,1].\n' +
  '  • rubric_coverage = fraction of the rubric criteria the answer genuinely satisfies.\n' +
  '  • correctness = how well the DERIVED conclusion agrees with the reference.\n' +
  '  • reasoning = quality of the DERIVATION. Score HIGH only if the answer works through WHY/HOW ' +
  'from the premises. Score near 0 if it merely RESTATES or QUOTES the context, asserts the ' +
  'conclusion without justifying it, or is vague.\n' +
  'NEGATIVE CRITERION: an answer that just paraphrases the context without deriving the conclusion ' +
  'is a recall answer — it must score LOW on reasoning AND correctness, no matter how many keywords ' +
  'it echoes. Be strict.'

export interface RouterRolesConfig {
  apiKey: string
  baseUrl?: string
  challengerModel?: string
  weakModel?: string
  strongModel?: string
  judgeModel?: string
  /** Challenger prompt: 'causal' (non-extractive, default) or 'recall' (the calibration baseline). */
  challengerStyle?: ChallengerStyle
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
        // Reasoning models (gemini-2.5-pro, glm-5.2, …) spend their budget on hidden reasoning and
        // emit EMPTY visible content when it is too low — at 1024 a "strong" solver returned nothing
        // and was scored 0, manufacturing a false negative strong−weak gap. Give every solver room
        // for reasoning + a full answer.
        maxTokens: 8000,
        signal: ctx.signal,
        onCall: cfg.onCall,
      })
      // Fail loud: an empty answer is a measurement failure, not a score of 0. Letting empty → 0
      // silently corrupts the strong/weak gap (the whole signal), so refuse to score it.
      if (r.content.trim() === '') {
        throw new Error(
          `solver '${model}' returned empty visible content (likely all tokens spent on hidden ` +
            `reasoning) — raise maxTokens or pick a non-reasoning solver; refusing to score it as 0`,
        )
      }
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
  const system = challengerSystemFor(cfg.challengerStyle ?? 'causal')
  return inProcessSandboxClient({
    onPrompt: async (prompt, ctx): Promise<SandboxEvent[]> => {
      const r = await routerChat({
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        model,
        messages: [
          { role: 'system', content: system },
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
      {
        key: 'reasoning',
        description:
          'quality of the derivation; near 0 if the answer merely restates/quotes the context',
      },
    ],
    scale: 'unit',
    // The judge sees the CONTEXT so it can distinguish a derived answer from a restated one (the
    // negative criterion). Without it, a paraphrase of the context is indistinguishable from real
    // reasoning and the gap stays closed.
    renderUser: ({ artifact }) =>
      `CONTEXT THE SOLVER WAS GIVEN:\n${artifact.example.context}\n\n` +
      `REFERENCE ANSWER:\n${artifact.example.reference}\n\n` +
      `RUBRIC:\n${artifact.example.rubric.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\n` +
      `CANDIDATE ANSWER:\n${artifact.answer}`,
  })
}

/** Materialize all four live roles over the Tangle router. */
export function buildAutodataRoles(cfg: RouterRolesConfig): AutodataRoles {
  return {
    challenger: challengerClient(cfg),
    // weak/strong solvers + judge are style-independent; only the challenger prompt changes.
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
