# Laptop-first CLM experiment

The owner selected the laptop GPU on 2 October 2026. The reported machine is
an M5 MacBook Pro with 32 GB unified memory. This Linux session has no Mac
connection or GPU. No owner app, Chrome profile, microphone, TCC or Keychain is
part of this experiment. No cloud infrastructure or paid service is needed.

## Pinned source and artifacts

The candidate artifact plan is
`packages/providers/fixtures/clm-artifact-manifest.macos.pending.json`:

- Qwen/Qwen3-8B: `b968826d9c46dd6066d109eabc6255188de91218`.
- Contrastive-LM/CLM-v0.1-8B: `e939398d4556fcd9400c76fa8c5a513202f42b0a`.
- Reference code: `bb42c6c5bf914fd449bed2f6ca65be80602cb1f7`.
- Python 3.12.14; Torch 2.8.0, Transformers 4.57.6, NumPy 2.3.4 and Accelerate
  1.11.0, with exact transitive versions and distribution hashes in
  `packages/providers/python/requirements-macos.lock`.

The plan records all five encoder shards, exact tokenizer/config files, the
published head and both repositories' license/model-card files. Regular-file
hashes were derived from downloaded bytes and checked against the Git blob
identities returned for the pinned revision. Large-file hashes/sizes come from
the pinned Hugging Face LFS metadata and are verified after download. The total
declared download is 16,473,033,415 bytes. Keep at least 22 GB free for artifacts,
dependencies and temporary download/loading state. Downloads use HTTPS with
normal proxy/CA trust and reject size/hash disagreement. Failed transfers remove
only their temporary file; existing mismatched artifacts are preserved.

Both exact model repositories provide Apache-2.0 license text and declare
Apache-2.0 in their cards. This supports the owned experiment; distribution
notices, transitive wheel/native-library licenses, a distributable SBOM and
release-wide clearance remain pending. The derived head architecture retains
the reference license in `packages/providers/python/REFERENCE_LICENSE`.

The source revision in the pending plan is intentionally unresolved. Materialize
a local manifest from the exact clean commit being tested; never edit the
tracked pending file or insert an invented revision. Native manifest v2 binds
the macOS arm64 platform, Python version, requirements hash and server revision.
Container manifest v1 remains supported for later CUDA reference comparison.
Declarations and file preflight do not attest the executing runtime.

## Prepare on the laptop

These are prepared commands, **not a verified Mac run**. Use an existing checkout
of this source milestone and the pinned Node 26.5.0. Run in the repository root.
Use `uv` with normal TLS/checksum verification; do not replace an existing venv.

**Interpreter amendment, 2 October 2026 (owner Mac):** python-build-standalone
publishes no CPython 3.12.14 build for macOS aarch64, so `uv python install
3.12.14` fails with "No download found". Use uv's 3.12.13 instead (same minor
line). The hash-locked requirements carry no Python-version markers, so every
pin installs unchanged, and the manifest records the actual interpreter
version at startup. The prepared venv on the owner Mac used:

```sh
uv venv .build/clm-macos-venv --python 3.12.13
uv pip install --python .build/clm-macos-venv/bin/python \
  --require-hashes --only-binary=:all: \
  -r packages/providers/python/requirements-macos.lock
python3 packages/providers/python/fetch_artifacts.py .build/clm-artifacts
mkdir -p private-traces
python3 - <<'PY'
import json, pathlib, subprocess
if subprocess.check_output(['git', 'status', '--porcelain'], text=True).strip():
    raise SystemExit('Use a clean source commit for this experiment.')
p = pathlib.Path('packages/providers/fixtures/clm-artifact-manifest.macos.pending.json')
m = json.loads(p.read_text())
m['runtime']['serverRevision'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
path = pathlib.Path('.build/clm-macos-manifest.json')
with path.open('x') as f:
    json.dump(m, f, indent=2)
    f.write('\n')
PY
chmod -R a-w .build/clm-artifacts
node scripts/benchmark-clm-local.ts .build/clm-macos-manifest.json \
  .build/clm-artifacts "$PWD/.build/clm-macos-venv/bin/python" mps \
  private-traces/clm-macos-smoke.json
```

The command never controls an app. It loads only verified local safetensors and
the weights-only head, then runs the three committed synthetic semantic fixtures
twice. It creates a private report once, refuses overwrite, and closes its worker
on failure, deadline or Ctrl-C. No persistent text/vector cache is enabled.

Metal loading uses an explicit MPS device map to avoid two full encoder copies
in unified memory. The GPU allocator is capped at 70% of its recommended memory;
each text is encoded separately. BF16 or operation incompatibility and memory
exhaustion fail the experiment. CPU/disk offload, quantization, synthetic replies
and alternate encoders are not enabled. Startup is bounded to five minutes;
requests retain the serving contract's 30-second deadline. These limits are
candidate experiment settings, not measured hardware capability.

Inspect startup/request time, allocated and driver GPU memory, expected choices,
timeouts and OS memory pressure. MPS memory samples are **not peak measurements**.
Repeated cases measure a warm runtime without a persistent inference cache. A
successful six-request smoke run does not establish calibration or v1 readiness.
Next: full-encoder embedding/ranking parity against the pinned Linux/vLLM recipe,
at least 50 task-disjoint calibration cases, coexistence with speech, latency and
resource limits, Stop/cancellation, and actual native/browser acceptance gates.

## Optional local serving

After the experiment, `scripts/serve-clm-reference.ts` can start the authenticated
loopback gateway with the same five configuration arguments, replacing the
report path with a port. Supply `CLM_SERVING_API_KEY` through a private binding;
never include it in a command, tracked file or report. Remote access still needs
an owned TLS proxy. This milestone does not deploy an endpoint.
