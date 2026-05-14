import type { SourceRecord } from './types'

export interface SourceAdapterInput {
  uri: string
  bytes?: Uint8Array
  text?: string
  metadata?: Record<string, unknown>
}

export interface SourceAdapterOutput {
  title?: string
  mediaType?: string
  text?: string
  anchors?: SourceRecord['anchors']
  metadata?: Record<string, unknown>
}

export interface SourceAdapter {
  id: string
  canLoad(input: SourceAdapterInput): boolean
  load(input: SourceAdapterInput): Promise<SourceAdapterOutput> | SourceAdapterOutput
}

export const textSourceAdapter: SourceAdapter = {
  id: 'text',
  canLoad: (input) => Boolean(input.text) || /\.(md|txt|json|csv)$/i.test(input.uri),
  load: (input) => ({
    title: input.uri.split('/').pop(),
    mediaType: mediaTypeFor(input.uri),
    text: decodeText(input),
    anchors: anchorsForText(input.uri, decodeText(input)),
    metadata: input.metadata,
  }),
}

export function mediaTypeFor(uri: string): string {
  const lower = uri.toLowerCase()
  if (lower.endsWith('.md')) return 'text/markdown'
  if (lower.endsWith('.txt')) return 'text/plain'
  if (lower.endsWith('.json')) return 'application/json'
  if (lower.endsWith('.csv')) return 'text/csv'
  if (lower.endsWith('.pdf')) return 'application/pdf'
  return 'application/octet-stream'
}

function decodeText(input: SourceAdapterInput): string | undefined {
  return (
    input.text ??
    (input.bytes ? new TextDecoder().decode(input.bytes).slice(0, 200_000) : undefined)
  )
}

function anchorsForText(uri: string, text: string | undefined): SourceAdapterOutput['anchors'] {
  if (!text) return []
  const lines = text.split('\n')
  const anchors: NonNullable<SourceAdapterOutput['anchors']> = [
    { id: 'all', sourceId: '', label: 'Full source', lineStart: 1, lineEnd: lines.length },
  ]
  for (let i = 0; i < lines.length; i += 50) {
    anchors.push({
      id: `l${i + 1}`,
      sourceId: '',
      label: `${uri}:${i + 1}`,
      lineStart: i + 1,
      lineEnd: Math.min(lines.length, i + 50),
    })
  }
  return anchors
}
