# CLM full-encoder parity and calibration corpus

Added 2 October 2026 for step 1 of the [Mac GPU handoff](MAC_GPU_HANDOFF.md).
This is the harness and its corpora. A pass needs a real Linux/vLLM reference
capture, which has **not** been produced; until it exists and the owner accepts
the tolerances, `fullReferenceParityQualified` stays false. V1 is not ready.

## What is compared

`packages/providers/python/parity.py` has three subcommands. They produce the
same report shape, created once with mode 0600:

| Side | Command | Code that computes the numbers |
|---|---|---|
| Owner Mac (MPS) | `capture-mps` | `ReferenceBackend` itself: same pins, inventory, `encode_last_token` and `rank_embeddings` as the serving worker |
| Reference (Linux/CUDA) | `capture-reference` | Pinned upstream `clm.Engine`/`clm.Embedder` at `bb42c6c5…` against a vLLM pooling server started with the pinned recipe |
| Either | `compare` | Applies [`clm-parity-tolerances.json`](../packages/providers/fixtures/clm-parity-tolerances.json) |

For each unique text it records the exact token count and the L2-normalized
last-token vector. For each case it records the distribution twice, which shows
whether a repeat gives the same bytes, plus SHA-256 hashes of the state and
candidate texts. Those hashes catch any difference in the prose template
between this repository and upstream `build_pairs`. The MPS side also checks
that the captured vectors reproduce the served distribution exactly, and it
records projected-space cosines for diagnosis. With `--heads`, `compare` ranks
both sides' vectors through the same CPU head. That splits drift into a
head/arithmetic part (reference vectors through our head versus the
reference's own distribution) and an encoder-only part.

## Known recipe differences, stated before any comparison

1. **Pooling normalization.** vLLM's pooling runner normalizes inside the
   server, then upstream normalizes again in NumPy float32. The owned path
   converts the bf16 hidden state to float32 and normalizes once.
2. **Kernels.** vLLM uses CUDA attention with `--enforce-eager`. The owned path
   uses Transformers `eager` attention on MPS. Both run the encoder in bf16.
3. **Batching and caching.** vLLM batches up to 32 texts per request with
   prefix caching. The owned path runs one unpadded text per forward pass, with
   no KV cache.
4. **Overflow.** Upstream truncates at 2048 tokens without warning. The owned
   path rejects longer input. Every corpus text is far below 2048 tokens, so
   the two paths see the same tokens.
5. **Head device.** Upstream runs the heads on CUDA in float32. The owned path
   uses MPS float32 after the NumPy reduction. The head/arithmetic split above
   measures this difference by itself.

## Candidate tolerances (pre-registered, not yet accepted)

The plan names the parity gate but sets no numbers. These numbers were fixed
in revision `parity-tolerances.v1`, before any reference output existed. They
must never be loosened after a comparison. A failure is a finding to explain.

| Quantity | Bound | Reason |
|---|---|---|
| Token count per text | exact | Same tokenizer bytes; any difference is a template or tokenizer bug |
| Embedding cosine | ≥ 0.999 | bf16 with different kernels should agree far closer than this; a lower value suggests a pooling or position bug |
| Max element difference | ≤ 0.01 | Catches localized corruption that cosine averages away |
| Probability difference | ≤ 0.02 per candidate | The decision boundary works on distributions; 2 points is below any threshold step worth calibrating |
| Top choice | must agree when the reference margin is ≥ 0.05 | Near-ties may flip; the host abstains on ties anyway |
| Repetition | byte-identical on each host | Already observed on MPS in the smoke |
| Head/arithmetic | ≤ 1e-5 | Float32 heads; component parity measured 2.2e-16 |

## Running it

**Owner Mac.** Use a clean commit and a freshly materialized manifest (the
snippet is in the [handoff](MAC_GPU_HANDOFF.md)), then:

```sh
.build/clm-macos-venv/bin/python packages/providers/python/parity.py capture-mps \
  .build/clm-macos-manifest.json .build/clm-artifacts private-traces/clm-parity-mps.json \
  packages/providers/fixtures/clm-calibration-synthetic.json \
  packages/providers/fixtures/clm-diagnostic-documents.json \
  packages/providers/fixtures/clm-probe-synthetic.json
```

**Reference host.** This needs a Linux/NVIDIA host the owner already has, or a
billable instance under an approved, cost-capped plan. Neither exists today.
On that host, check out this commit and fetch and verify artifacts with
`fetch_artifacts.py`. Clone `Contrastive-LM/CLM` at `bb42c6c5…` without
changes. Install a vLLM version that supports `--runner pooling` and record it.
Serve the **verified local** encoder directory with the pinned recipe flags:

```sh
vllm serve .build/clm-artifacts/encoder --served-model-name qwen3-8b --runner pooling \
  --enforce-eager --enable-prefix-caching --max-model-len 2048 \
  --gpu-memory-utilization 0.35 --max-num-seqs 32 --port 8090
python packages/providers/python/parity.py capture-reference CLM_CHECKOUT .build/clm-artifacts \
  http://127.0.0.1:8090/v1/embeddings private-traces/clm-parity-reference.json \
  packages/providers/fixtures/clm-calibration-synthetic.json \
  packages/providers/fixtures/clm-diagnostic-documents.json \
  packages/providers/fixtures/clm-probe-synthetic.json
```

Then bring the reference report to the Mac and compare:

```sh
.build/clm-macos-venv/bin/python packages/providers/python/parity.py compare \
  private-traces/clm-parity-reference.json private-traces/clm-parity-mps.json \
  private-traces/clm-parity-comparison.json --heads .build/clm-artifacts/heads/CLM_v0.1-8B.pt
```

The reference capture is source evidence about upstream behavior. It never
qualifies the Mac by itself.

## Corpora

- [`clm-calibration-synthetic.json`](../packages/providers/fixtures/clm-calibration-synthetic.json):
  **60 task-disjoint synthetic cases** (`calibration.v1`). By category:
  advance 26, identity 10, missing-target 10, scope 8, wait 6. Surfaces are
  native and the managed browser. The candidates use the host's real invoke,
  navigate and set-value templates. Every case ends with the host's exact
  `wait` and `request_help` fallbacks, which the smoke fixtures lack. No goal
  repeats, and none touches the smoke tasks. `clm-calibration-corpus.test.ts`
  enforces this.
- [`clm-diagnostic-documents.json`](../packages/providers/fixtures/clm-diagnostic-documents.json):
  11 single-factor edits of `native-locate-documents`. They test the
  question's "pause" wording, the help and fallback text, the Recents
  distractor, the host template, and the scope and progress sentences. They
  share the smoke task, so they **never** calibrate thresholds. They exist only
  to explain the miss.

No threshold is fitted in this slice. Thresholds are fitted on the calibration
corpus only, after parity. They are never fitted on the smoke or diagnostic
cases, and a held-out task-disjoint evaluation set is still needed before any
B02/B14 claim.
