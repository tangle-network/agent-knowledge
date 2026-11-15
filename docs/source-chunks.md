# Source-faithful chunks

`chunkMarkdown` returns exact UTF-16 slices of the original input, including CRLF.
`content.slice(chunk.charStart, chunk.charEnd) === chunk.text` is the citation invariant.
The separately exported `stripFrontmatter` normalization behavior is unchanged.
Tiny trailing chunks merge source intervals, never synthetic separators or duplicate overlap.

The default still preserves indivisible paragraphs and marks oversized chunks.
Opt in to `{ splitOversized: true }` for bounded, overlapping slices of long paragraphs.
Bounded budgets must be safe integers, at least two characters for target/maximum,
with nonnegative minimum/overlap. Boundaries do not divide surrogate pairs or CRLF.
These are text coordinates, not PDF byte offsets or token counts.

Consumers own authorization, source snapshots, passage budgets and full-source fallback.
Retrieval omission is not evidence of absence. Never clip a chunk's text while retaining
its original full-interval citation. Reuse an index only while the authorized source view
and retrieval settings are unchanged. This change does not select or promote a legal model.

Source qualification and package publication remain separate. The existing publication
workflow owns versioning, packed-package compatibility, optimizer checks and publishing.
