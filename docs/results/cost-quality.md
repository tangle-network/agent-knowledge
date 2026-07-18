# Cost/quality: the two-agent loop's inference premium

Live 9-topic A/B (glm-5.2, budget B ≤ 4 passes/arm), measured per arm with the
router-client instrumentation. The original A/B reported only admitted-sources at
"equal passes", which charged the two-agent verify step as one pass while it is
actually N `verifySource` LLM calls. Pricing the calls shows what that hid.

| per topic (mean) | two-agent | single-agent | ratio |
|---|---|---|---|
| LLM chat calls | 5.4 | 1.0 | ~5.4× |
| tokens (in+out) | ~4,900 | ~530 | ~9× |
| cost (USD) | ~$0.0072 | ~$0.0013 | ~5.5× |
| latency (wall) | ~37 s | ~11 s | ~3.4× |
| cleanliness Δ (single − two admitted) | n/a | n/a | +1.56, 95% CI [0.33, 2.67] |

Per-topic Δ (single − two admitted) this run: self-speculative decoding +4,
grouped-query attention 0, rotary position embeddings +1, KV-cache quantization
**−1**, LoRA +4, ring attention +2, constitutional AI +3, transformer +2, gradient
descent **−1**. Coverage 1.00 every topic, both arms.

**Reading.** The verifier buys ~1.5–2.7 fewer junk sources for roughly **5× the
dollars, 9× the tokens, and 3× the latency**, and on two topics it admitted *more*
than the single agent (the cleanliness signal is real but noisier than the +2.3 /
+2.7 of earlier runs). The cleanliness gain is dominated by de-duplication, so the
production move is a deterministic content-hash / canonical-URL dedup, which
captures most of the cleanliness at ~none of this premium; reserve an LLM check for
the off-scope tail. This is the cost half the "equal passes" framing left out.
