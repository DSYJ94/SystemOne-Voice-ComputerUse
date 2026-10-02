# Mac GPU smoke continuation handoff

Updated 2 October 2026, immediately after the first real CLM inference on the
owner M5. This supersedes [MAC_CONTINUATION_HANDOFF.md](MAC_CONTINUATION_HANDOFF.md)
as the current entry point; read [V1_PLAN.md](V1_PLAN.md) for the consolidated
plan and [VALIDATION.md](VALIDATION.md) for evidence so far.

V1 is **not ready**. This was a six-request synthetic smoke; the report itself
records `inferenceQualified: false`, `fullReferenceParityQualified: false`,
`acceptanceCorpusCompleted: false`. The previous owner goal stays dropped; do
not resume or reconstruct it. Cloud/Linux results are source evidence only and
never Mac qualification.

## Repository state

Latest branch: **`codex/mac-first-validation`** at `6a14dd8`, pushed to
`DSYJ94/SystemOne-Voice-ComputerUse`. Nothing through `6a14dd8` is merged to
`main` (the ~150-commit stacked history is still draft PRs; `main` is far
behind — never pull `main` alone).

The seven commits on this branch beyond `7cfe7a6`
(`codex/native-field-replacement`):

- `e694674` — first Mac host validation record (468/468, oracle 115/115,
  first native build) and consolidated `V1_PLAN.md`, including the Jev
  decision.
- `24b0fdd` — TypeSafe Jev over its API designated the external fallback
  (never in offline/privacy mode; disclosed transfer; owner cost cap).
- `23466a4` — dated amendment: python-build-standalone ships no CPython
  3.12.14 for macOS aarch64; use 3.12.13.
- `55b94ca` — manifest materialization binds the interpreter that actually
  runs (`platform.python_version()`), not the pending declaration.
- `0af36e4` — worker fix: artifact tamper comparison is now atime-insensitive
  (size/mode/inode/device/mtime/ctime). The old whole-`stat_result` equality
  false-tripped on macOS because the worker's own reads update `st_atime`;
  Linux CI passed only due to relatime/noatime.
- `f17a91f` — validator fix: native manifest accepts the declared 3.12 patch
  instead of hardcoding `3.12.14` (which no macOS aarch64 build ever shipped);
  the worker still binds the exact running interpreter.
- `6a14dd8` — first CLM local GPU smoke record.

## What ran on the M5 (evidence, not qualification)

Private report `private-traces/clm-macos-smoke.json` (mode 0600, refuses
overwrite), manifest digest `6c95793e…`: startup **39.2 s**; cold decision
4.08 s; warm **767 / 992 / 868 ms**; GPU **15.21 GB allocated / ~16.25 GB
driver** against the 70% cap; byte-identical distributions on repetition;
expected choices matched 2/3 (`browser-open-exact-invoice` → exact,
`missing-target-abstention` → help); `native-locate-documents` chose help
(0.517) over expected documents (0.099), deterministically — unexamined,
expected to be a parity/calibration finding.

## Environment on the owner Mac (already prepared)

- Node v26.5.0; repo test suite green at this branch: typecheck clean,
  **468 passed / 0 skipped**, Python oracle 115/115.
- CPython **3.12.13** venv at `.build/clm-macos-venv` (uv; 27 hash-locked
  pins from `packages/providers/python/requirements-macos.lock`).
- Artifacts at `.build/clm-artifacts` (17 files, ~15 GB, `chmod -R a-w`,
  re-hashed on every startup by Node preflight and the worker).
- Local manifest `.build/clm-macos-manifest.json` is untracked and binds
  `serverRevision` to the commit it was materialized at — **re-materialize at
  the current clean HEAD before any run**:

```sh
.build/clm-macos-venv/bin/python - <<'PY'
import json, pathlib, platform, subprocess
if subprocess.check_output(['git', 'status', '--porcelain'], text=True).strip():
    raise SystemExit('Use a clean source commit for this experiment.')
p = pathlib.Path('packages/providers/fixtures/clm-artifact-manifest.macos.pending.json')
m = json.loads(p.read_text())
m['runtime']['serverRevision'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
# Bind the interpreter that will actually run the experiment.
m['runtime']['pythonVersion'] = platform.python_version()
path = pathlib.Path('.build/clm-macos-manifest.json')
with path.open('x') as f:
    json.dump(m, f, indent=2)
    f.write('\n')
PY
```

The report path is created `wx`/0600 and refuses overwrite; delete a stale
`private-traces/clm-macos-smoke.json` deliberately if it exists.

## Pull the branch (safe sync)

```sh
(
  set -eu
  cd '/Users/daryl/Library/CloudStorage/OneDrive-Personal/Shared GitHub Repos/SystemOne-Voice-ComputerUse'
  [ "$(git rev-parse --show-toplevel)" = "$(pwd -P)" ] || { echo 'Not the checkout root.'; exit 1; }
  [ -z "$(git status --porcelain)" ] || { echo 'Dirty checkout; preserve local work first.'; exit 1; }
  git fetch origin
  git rev-parse --verify --quiet refs/heads/codex/mac-first-validation >/dev/null \
    || git branch --track codex/mac-first-validation origin/codex/mac-first-validation
  merge_base=$(git merge-base HEAD codex/mac-first-validation)
  [ "$merge_base" = "$(git rev-parse codex/mac-first-validation)" ] || { echo 'Not a fast forward; stop.'; exit 1; }
  git merge --ff-only codex/mac-first-validation
)
```

Fast forward only. Never reset, clean or stash on this OneDrive checkout.
Preserve the untracked review artifacts `EXECUTION_ASSESSMENT.md` and
`approval-record.patch`.

## Next steps, in order

1. **Full-encoder parity** against the pinned Linux/vLLM recipe
   (`referenceRevision` `bb42c6c5…`): run the reference recipe on a Linux
   host/CI to produce embedding/ranking references, then compare the MPS
   worker's embeddings and probability distributions within the plan's
   tolerances. The parity harness itself is authored on the Mac; the Linux
   side is source evidence only.
2. **Calibration corpus**: ≥50 task-disjoint cases per
   `docs/CLM_DECISION_BOUNDARY.md`; use them to explain the
   `native-locate-documents` miss rather than tuning to it. Tune thresholds
   only on this corpus, never on the three smoke fixtures.
3. **Primary-CLM controller integration** (V1_PLAN Phase 3): replace the
   synthetic decision source with the verified worker behind the existing
   serving/decision boundary, with the 30 s deadline and wake-never-resumes
   semantics unchanged.
4. **Parallel track — Jev fallback adapter (B22)**: implement the provider
   interface against the `/v1/systemone` contract in `V1_PLAN.md` §4/Phase 4,
   feature-flagged off, never active in offline mode. No API key enters chat,
   git or a tracked file; the owner supplies credentials from a secret
   manager.
5. **Owner-blocked items** (not agent-actionable): distribution signing
   certificate, live TCC permission flows, full Xcode for the XCTest suite,
   and any billable cloud infrastructure (needs a pinned, cost-capped,
   owner-approved plan first).

Constraints that bind every step: default-denied effects, one-use permits,
independent verification; no TCC/Keychain changes or owner-app actions
without applicable authorization; credentials only in a secret manager;
synthetic results are never live evidence; a passing Linux run is never Mac
qualification.
