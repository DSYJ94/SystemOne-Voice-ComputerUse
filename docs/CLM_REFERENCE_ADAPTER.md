# Owned reference tensor adapter

`createVerifiedCLMReferenceBackend` connects the serving boundary to an owned
Python worker over bounded private pipes. Production preflight verifies local
artifact bytes before spawning Python. The worker rechecks bytes, rejects
undeclared files, uses offline-only loaders and detects later artifact changes.
No production fixture mode, remote encoder, download helper, hot reload, pickle
encoder, or automatic CPU fallback exists.

The tokenizer is the pinned Qwen tokenizer with special tokens and explicit
`truncation=False`. Both ingress and the worker reject any text above 2048 tokens
before encoder execution. State/instructions use reference Python stripping and
blank-line joining; candidate descriptions retain their bytes. The local encoder
uses BF16 Qwen3 hidden states, last-token pooling without padding, and no KV cache.
Encoder normalization uses the reference NumPy float32 reduction; the two exact
checkpoint-defined heads run in float32, normalize separately, and score scaled
cosines with the reference float32 arithmetic and Python softmax. Checkpoint
loading specifies `weights_only=True`, strict parameter matching and finite
weights. Logit scale is exponentiated and clamped to 100.

The supervisor requires exact startup manifest/tokenizer identity and one reply
per operation, bounds frames, discards stderr, and returns fixed errors. Abort
kills only the owned worker and waits for actual process closure before settling
the request. Startup/request deadlines, wrong IDs, malformed output, late replies
and unsolicited frames fail closed. The worker receives no serving API key,
personal environment or credentials. Gateway replies omit local benchmark metrics.

The [laptop experiment](CLM_LOCAL_GPU_EXPERIMENT.md) uses a hash-locked native
macOS arm64 runtime declaration (manifest v2). Container declarations remain v1.
The pending native artifact plan resolves encoder/tokenizer/head hashes but still
requires the exact tested server commit. Runtime declarations are not attestation.

Linux evidence: nine process/CLI tests, one native-runtime declaration
regression and ten Python tests. The Python suite exercises a real tiny Qwen3
model and fast-tokenizer fixture, checkpoint configurations, safety and overflow;
its synthetic weights are not production inference. Separately, the downloaded
pinned tokenizer passes thirteen fast/slow cases, including exact 2048/2049
counts. The published head passes twelve CPU comparisons to pinned upstream
heads; maximum probability difference is 2.22045e-16. An initial comparison found
a 1.1e-6 difference from Torch encoder normalization; preserving NumPy's reference
reduction corrected it without relaxing tolerance.

No full encoder inference, MPS/CUDA run, deployed model, Mac compilation or live
application action is established here. Transformers last-token pooling follows
the reference recipe; full-weight numerical equivalence with its vLLM encoder
remains a qualification gate. V1 is not ready.
