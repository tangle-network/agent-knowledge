// Exact public arguments from mech-interp-foundations-pi-20260915k's first result,
// blob sha256:0cce0601a94050e27acd4c918b2b7bb9037265f43bfc5a38408140b3a177882b.
export const malformedKnowledgeRecordCalls = [
  {
    callId: 'call_c7f00a4f364547e689127ba0',
    proposal: '---FILE: pages/glm-b/tmp-format-probe.md---\nprobe line one\n---END---',
  },
  {
    callId: 'call_c41bc0d3c0644fb0936b78f3',
    proposal:
      '---FILE: pages/glm-b/tmp-format-probe-a.md---\nprobe a\n---FILE-END---\n---FILE: pages/glm-b/tmp-format-probe-b.md---\nprobe b\n---END FILE---\n---FILE: pages/glm-b/tmp-format-probe-c.md---\nprobe c\n---EOF---',
  },
] as const
