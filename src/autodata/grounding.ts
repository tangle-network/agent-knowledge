/**
 * Ground the Autodata loop on a REAL source document, reusing agent-knowledge's ingestion utils
 * (`politeFetch` → `htmlToText` → `chunkMarkdown`). Fetches the page, strips it to text, chunks it,
 * and selects ONE content-rich chunk as the grounding excerpt the challenger writes questions from.
 *
 * The default source is the "Attention Is All You Need" paper via ar5iv (arXiv's LaTeX→HTML service),
 * a stable real paper with multi-step-reasoning content that affords genuinely discriminating
 * questions. Any arXiv / ar5iv URL works; pass a `focus` term to bias chunk selection toward a section.
 */

import { chunkMarkdown } from '../chunking'
import { htmlToText } from '../sources/html'
import { politeFetch } from '../sources/http'

/** A stable real arXiv paper (Transformer / "Attention Is All You Need") rendered to HTML by ar5iv. */
export const DEFAULT_SOURCE_URL = 'https://ar5iv.labs.arxiv.org/html/1706.03762'

export interface GroundDocOptions {
  url: string
  cacheDir?: string
  /** Bias chunk selection toward chunks mentioning this term (case-insensitive). */
  focus?: string
  /** Chunk size ceiling. Default 1800 chars — a paragraph or two of grounding context. */
  maxChars?: number
  /** Minimum letters a chunk must have to be eligible (skips nav / citation scraps). Default 400. */
  minLetters?: number
  signal?: AbortSignal
}

export interface GroundedDoc {
  url: string
  sourceUpdatedAt: string
  /** The selected grounding excerpt — the `doc` passed to the loop. */
  doc: string
  chunkIndex: number
  headingPath: string
  totalChunks: number
}

function letterCount(s: string): number {
  return (s.match(/[a-zA-Z]/g) ?? []).length
}

/** Reference/bibliography chunks are citation soup — never good question material. */
function looksLikeReferences(headingPath: string, text: string): boolean {
  if (/references|bibliography|acknowledg/i.test(headingPath)) return true
  // A chunk that is mostly "[n]" / "et al." / years is a reference list.
  const refMarkers = (text.match(/\[\d+\]|et al\.|arXiv:|doi:/gi) ?? []).length
  return refMarkers >= 5
}

/**
 * Fetch + chunk + select a grounding excerpt from a real document. Fails loud if the fetch is
 * unverifiable or yields no usable prose chunk.
 */
export async function groundDoc(opts: GroundDocOptions): Promise<GroundedDoc> {
  const res = await politeFetch(opts.url, { cacheDir: opts.cacheDir, signal: opts.signal })
  if (!res.verifiable) {
    throw new Error(`source not verifiable (${opts.url}): ${res.unverifiableReason ?? 'unknown'}`)
  }
  const text = htmlToText(res.body)
  const maxChars = opts.maxChars ?? 1800
  const chunks = chunkMarkdown(text, { maxChars, targetChars: Math.round(maxChars * 0.8) })
  const minLetters = opts.minLetters ?? 400

  const eligible = chunks.filter(
    (c) =>
      !c.oversized &&
      letterCount(c.text) >= minLetters &&
      !looksLikeReferences(c.headingPath, c.text),
  )
  if (eligible.length === 0) {
    throw new Error(
      `no usable prose chunk from ${opts.url} (${chunks.length} chunks, none eligible)`,
    )
  }

  const focus = opts.focus?.toLowerCase()
  const score = (text: string): number => {
    const letters = letterCount(text)
    if (!focus) return letters
    const hits = (
      text.toLowerCase().match(new RegExp(focus.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []
    ).length
    return hits * 2000 + letters
  }
  const selected = eligible.reduce((best, c) => (score(c.text) > score(best.text) ? c : best))

  return {
    url: opts.url,
    sourceUpdatedAt: res.sourceUpdatedAt,
    doc: selected.text,
    chunkIndex: selected.index,
    headingPath: selected.headingPath,
    totalChunks: chunks.length,
  }
}
