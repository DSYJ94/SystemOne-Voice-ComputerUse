# CLM artifact preflight

`scripts/preflight-clm-artifacts.ts` checks a completed immutable manifest and
already-present artifact files. It makes no network request, downloads nothing,
loads no model/checkpoint, deploys nothing and cannot approve a paid experiment.

The committed [pending manifest](../packages/providers/fixtures/clm-artifact-manifest.pending.json)
is intentionally incomplete and must fail. Encoder/tokenizer revision, file
identities, owned server revision, container digest and license review remain
unresolved. Do not replace these fields with invented or moving pins.

The manifest requires:

- The audited CLM source and published head revision/hash; encoder files share
  one immutable Qwen3-8B snapshot, with safetensors weights, tokenizer/config
  and license records. Both components require license-file identities.
- A container reference pinned by SHA-256 and an immutable owned server revision.
  These are declarations; the preflight does not verify a container registry or
  prove that a process loaded these artifacts.
- The baseline last-token 4096-dimensional recipe, encoder/head normalization,
  maximum logit scale 100 and 2048-token per-text budget with overflow rejection.
  The initial declared precision is bfloat16; backend/precision changes require
  their own compatibility qualification.
- Mandatory TLS/authentication remotely, private encoder access, disabled
  request logging/downloads/hot reload/remote code, and `weights_only` checkpoint
  loading. The owned server must enforce these settings, validate checkpoint
  tensor/config fields and check token lengths before upstream truncation.

Each file entry has `path`, `role`, `sha256` and `bytes`. Paths are relative to
the artifact root, under `encoder/` or `heads/`. Roles are `weights`, `tokenizer`,
`config` and `license`; the head checkpoint path is `heads/CLM_v0.1-8B.pt`.
The published head checksum is recorded in [dependencies](DEPENDENCIES.md).
Declared hashes/revisions still need authenticated provenance and exact license
review; a correctly shaped manifest alone proves neither.

After resolving the missing pins, verifying provenance and placing the reviewed
artifacts in a private local directory, run in the activated repository:

```sh
node scripts/preflight-clm-artifacts.ts \
  --manifest private-traces/clm-artifacts.json \
  --artifacts /YOUR/ARTIFACT/ROOT \
  --output private-traces/clm-artifact-preflight.json
```

The verifier bounds file declarations, refuses traversal/symlinks/nonregular
files and streams SHA-256 checks with exact byte counts and change detection.
It rejects missing/mismatched files. The successful report is created once with
mode 0600 and includes the canonical manifest digest. Do not modify artifact
directories concurrently. Use read-only mounts and repeat verification at server
startup immediately before safe loading; this offline read cannot prevent later
file replacement or attest a running service.

The report keeps loaded artifact identity, inference qualification, license
clearance and paid deployment authorization false. Live reference comparisons,
token overflow tests, runtime authentication checks and calibration remain
separate gates. A matching HTTP manifest header is only an owned-service
consistency check. See [decision boundary](CLM_DECISION_BOUNDARY.md),
[serving preparation](CLM_DEPLOYMENT_PLAN.md) and [v1 gates](V1_READINESS.md).
