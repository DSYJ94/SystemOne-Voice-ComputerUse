# CLM serving and preparation

No owner setup is needed yet. CLM will be served through an owned private HTTP
API; the repository has a [bounded decision client](CLM_DECISION_BOUNDARY.md),
an opt-in synthetic native selector and a separate fixture probe. It has no
deployed server or live CLM-backed owner-app executor. Having AWS, GCP, Modal or Runpod access is
sufficient for later deployment planning. Do not put credentials in chat or
tracked files. No GPU, weights or paid service was provisioned for this slice.

The intended reference path is:

```text
SystemOne's approved semantic state and legal candidate descriptions
  -> private HTTPS POST /v1/systemone
  -> Qwen3-8B embeddings + CLM projection heads
  -> validated candidate choice/probabilities
  -> host revalidation, permission, dispatch and independent verification
```

This is a candidate-ranking service. A generic chat-completion endpoint does
not establish compatibility: the reference requires the exact embedding,
tokenizer, last-token pooling, normalization and head calculations. Model
choice cannot grant permission, change task limits or prove completion. CLM
does not control the desktop directly.

The owner reports a **14-inch MacBook Pro, M5, 2026, 32 GB memory**, and no
owned Linux/NVIDIA machine. That Mac is a candidate for the later B06 local
feasibility experiment; capacity alone does not prove reference compatibility,
latency or coexistence with speech recognition. Validate the Linux/NVIDIA
reference first, then compare a Metal/MLX backend against its embeddings and
rankings before treating local inference as supported. Quantization needs a
separate fidelity check.

For a short reference experiment, Modal or Runpod is a practical starting
point; AWS or GCP is also acceptable if existing quotas and deployment tooling
make it easier. Choose one service for the first run. An initial **24–48 GB
NVIDIA GPU** is a planning range to investigate, not a qualified requirement:
an 8B encoder in two-byte precision alone is roughly 16 GB of weights, with
additional head, activation, batching and runtime memory. Measure actual peak
memory and latency before choosing the production instance. Use an explicit
spending cap, limited lifetime and teardown plan.

Before asking the owner to approve a paid deployment, prepare a reviewable
container/launch configuration covering these requirements:

1. Pin the [reference source](https://github.com/Contrastive-LM/CLM/tree/bb42c6c5bf914fd449bed2f6ca65be80602cb1f7),
   encoder/tokenizer revisions and actual head bytes. Verify the published head
   hash recorded in [dependencies](DEPENDENCIES.md); review exact artifact
   licenses and safe checkpoint loading. No immutable encoder/tokenizer pin or
   downloaded artifact verification has been completed yet.
2. Reproduce the reference embedding and head computation, including the
   2048-token per-text budget, normalization and cache identity. The upstream
   embedder silently truncates; the owned deployment must reject overflow
   before truncation and verify it with the exact tokenizer. Serve the
   pinned `/v1/systemone` schema rather than translating it into a chat API.
   The probe's `clm-latest` alias is not model identity; save artifact attestation
   alongside benchmark results.
3. Put remote access behind TLS and authentication. The probe sends
   `Authorization: Bearer ...` from `CLM_PROBE_API_KEY` (required remotely); the
   deployment must enforce it. Keep an internal encoder endpoint private and
   disable request-body/access-token logging. Start with synthetic fixtures.
4. Record provider, GPU, region, hourly/storage costs, maximum experiment spend,
   access method and teardown steps. Review this concrete configuration with
   the owner before provisioning billable resources.
5. Run the fixture probe below; then expand to at least 50 representative,
   task-disjoint cases. Record cold/warm latency, resource use, candidate recall
   separately from ranking accuracy, overflow, timeouts and malformed output.
   The three committed cases are only a smoke test.

Once an owned endpoint and artifact checks exist, run from the activated
repository environment, with any API key supplied through a secret manager or
private environment variable:

```sh
mkdir -p private-traces
node scripts/probe-clm.ts \
  --allow-owned-service \
  --endpoint https://YOUR-OWNED-HOST/v1/systemone \
  --fixtures packages/providers/fixtures/clm-probe-synthetic.json \
  --output private-traces/clm-probe.json
```

This command is intentionally not runnable until the endpoint is deployed.
It has a 30-second request timeout, rejects redirects, validates replies and
creates the private report once with mode 0600. No report was generated against
a live service here. See [probe details](CLM_REFERENCE_PROBE.md).

Source development can continue before this experiment. Portal reconciliation,
scripted native/browser recovery and completion checks pass in Linux fixtures.
The decision boundary is exercised with synthetic CLM replies; B14 still needs
qualified inference and controller integration. Mac signing/Accessibility setup remains a
separate owner step; it is not a CLM prerequisite.

On 1 October, this task had no owned endpoint or provider credential binding.
The cloud network policy returned HTTP 403 for Hugging Face model metadata, so
immutable encoder/tokenizer resolution and artifact verification remain pending.
The package-manager network preset was preserved; no GPU or paid deployment ran.
