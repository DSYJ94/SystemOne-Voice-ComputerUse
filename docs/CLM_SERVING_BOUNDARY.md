# Owned CLM serving boundary

`packages/providers/src/clm-serving-boundary.ts` supplies an authenticated,
bounded ingress component for the owned reference service. It performs no model
download, tensor loading, deployment or billable provisioning. The owner's
requested targets are on premise or AWS/GCP; no commercial inference API is
required. No usable Mac/GPU host or provider binding exists in this session.

## Request and execution contract

Only authenticated `POST /v1/systemone` with the exact SystemOne choice envelope
is accepted. Bearer authentication is mandatory even on loopback; fixed-length
SHA-256 comparisons use `timingSafeEqual`. Duplicate Authorization/Content-Type
headers, compressed bodies, generic model questions, extra authority fields,
malformed/duplicate-key JSON and requests exceeding 65,536 bytes are rejected.
There are no UI, model listing, health metadata, CORS or request logging routes.
Errors return fixed text, never backend exception bodies. Replies expose only
validated choice/probabilities and bounded token usage.

The trusted local backend must provide counts from the exact pinned tokenizer,
including encoder special tokens, before ranking. The state and instructions are
joined exactly as reference `schema.py:62` at
`bb42c6c5bf914fd449bed2f6ca65be80602cb1f7`; candidate descriptions are unchanged.
Python whitespace stripping includes U+0085 and retains BOM, unlike JS `trim`.
Any text exceeding 2048 tokens rejects the request before ranking. No truncation
is allowed. Cached inference can report zero spent tokens, but usage cannot
exceed the complete checked uncached batch. Counts and request parameters are
copied into immutable local state before later backend work.

Default capacity is one request, configurable up to eight, with no queue. The
whole request deadline is at most 30 seconds, including body reads and tokenizing.
Deadline/disconnect aborts the supplied backend signal and revokes delivery.
Capacity remains owned until the actual backend promise settles even when it
ignores cancellation. Late token counts cannot start ranking. Stalled body reads
close their socket at deadline; chunked bodies also enforce the byte bound.

## Startup and remaining adapter work

`createCLMServingBoundary` is a pure component for integration/testing. It validates
immutable manifest declarations and matches backend manifest/tokenizer identity;
it does **not** prove local bytes or loaded model identity. Production startup
must use `listenVerifiedCLMServingGateway`, which snapshots those declarations,
performs read-only local artifact preflight, and only then opens HTTP on
`127.0.0.1`. Put remote access behind an owned TLS proxy with its own connection,
header and access-log controls. Ignore forwarded headers as authority. The
manifest response header names the validated declaration; it is not remote
attestation of the executing GPU or proof of inference fidelity.

The [reference tensor adapter](CLM_REFERENCE_ADAPTER.md) now binds verified local
bytes to offline tokenizer/encoder/head loading and implements reference
pooling/normalization/head computation. It disables downloads, hot reload,
remote code and persistent inference caches, and loads the head with explicit
weights-only safety. Full encoder/runtime qualification remains required.
The unmodified upstream service is insufficient: authentication is
optional and its embedder silently truncates. Do not substitute an approximate
token count or return synthetic rankings from a production adapter.

The original container manifest deliberately fails startup. The native Metal
artifact plan now resolves the encoder/tokenizer revision and artifact hashes;
its exact server commit must still be materialized before the local experiment.
Model license texts are recorded, while runtime/release license review and GPU
memory/latency qualification remain open. The [deployment plan](CLM_DEPLOYMENT_PLAN.md) and
[offline preflight](CLM_ARTIFACT_PREFLIGHT.md) remain mandatory before live use.

Fifteen synthetic ingress/transport tests cover authentication, identities,
startup refusal, schema/body/token limits, exact text formatting, reply redaction,
timeouts, outstanding ownership, disconnect and stalled/chunked bodies. These
are source boundary tests, not reference inference or v1 acceptance evidence.
