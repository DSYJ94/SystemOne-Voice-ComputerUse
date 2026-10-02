# Mac continuation handoff

Updated 2 October 2026. The owner will pull the GitHub branch into:

```text
/Users/daryl/Library/CloudStorage/OneDrive-Personal/Shared GitHub Repos/SystemOne-Voice-ComputerUse
```

V1 is **not ready**. The previous owner goal was dropped; do not resume or
reconstruct it. Keep the intended scope: macOS voice/text computer use, primary
CLM inference, native apps, managed Chromium and the owner's existing Chrome
profile. Cloud source checks are not live Mac qualification.

## Pull the correct development branch

Repository: `DSYJ94/SystemOne-Voice-ComputerUse`.
Latest branch: **`codex/native-field-replacement`**, draft
[PR #75](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/75).
The branch includes the stacked changes; pulling `main` alone will not obtain
this milestone. No draft PR was merged by this session.

Run the following in Terminal. The subshell stops on failure, rejects a dirty
checkout, creates a tracking branch only when absent and permits only a fast
forward. It never resets, cleans, stashes or overwrites local work.

```sh
(
  set -eu
  cd '/Users/daryl/Library/CloudStorage/OneDrive-Personal/Shared GitHub Repos/SystemOne-Voice-ComputerUse'
  checkout_root=$(git rev-parse --show-toplevel)
  if [ "$checkout_root" != "$(pwd -P)" ]; then
    echo 'This path is not the checkout root. Verify the repository location before syncing.'
    exit 1
  fi
  if [ -n "$(git status --porcelain)" ]; then
    echo 'Local changes exist. Preserve them before switching or syncing branches.'
    exit 1
  fi
  git fetch origin
  if git show-ref --verify --quiet refs/heads/codex/native-field-replacement; then
    git switch codex/native-field-replacement
  else
    git switch --track -c codex/native-field-replacement origin/codex/native-field-replacement
  fi
  git merge --ff-only origin/codex/native-field-replacement
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse origin/codex/native-field-replacement)" ]; then
    echo 'Local commits differ from the remote. Preserve and reconcile them intentionally.'
    exit 1
  fi
  git status --short
  git log -3 --oneline
  echo 'Checkout matches the fetched development branch.'
)
```

If local changes or divergent commits block these commands, preserve them and
inspect the branch history before continuing. Do not force the checkout to match
GitHub. This cloud session did not access or modify the Mac path; local sync is
verified only by the actual Terminal results. No SSH connection is needed for
the owner-run pull.

## Source checkpoints and draft stack

| PR | Branch | Milestone |
|---|---|---|
| [#71](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/71) | `codex/native-field-actor` | Persistent field execution, independent completion, retained recovery/Resume and Stop |
| [#72](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/72) | `codex/clm-serving-boundary` | Authenticated bounded owned ingress and artifact startup preflight |
| [#73](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/73) | `codex/clm-reference-backend` | Offline exact tokenizer/Qwen3/head adapter and pinned laptop GPU experiment |
| [#74](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/74) | `codex/host-lifecycle-interruption` | Host snapshots, Stop on session interruption, grant revocation and no automatic wake execution |
| [#75](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/75) | `codex/native-field-replacement` | Explicit paused field correction, original target binding, fresh child admission and durable lineage |

Latest execution source commit:
`9d4fe3df026a860b7803c7fdc993e2aaf3a62285`.
The prior published handoff checkpoint was
`4ae1cc14ce37cd34ba86c1e71e56d9940f579c4a`; this document is a later documentation
commit on the same branch. Use the actual clean pulled HEAD for experiment
provenance, rather than hard-coding either older SHA.

Read [BUILD_HANDOFF.md](BUILD_HANDOFF.md) first, then repository agent instructions
if present, [V1_READINESS.md](V1_READINESS.md) and
[CLM_DEPLOYMENT_PLAN.md](CLM_DEPLOYMENT_PLAN.md). The current repository language
instructions are in [CONTEXT.md](../CONTEXT.md).

## Validated evidence and its limits

The pinned Linux environment passed typecheck and **466 tests**, with **zero
failures and two Mac-only skips (468 total)**; Python oracle **115/115**; focused
field authority/controller **32/32**; release inventory consistency and **7/7**
checks. `git diff --check` passed. Source milestones did not change the pinned
npm/test dependency declarations or generated release inventory.

Synthetic regressions cover native execution, correction/recovery identity,
Stop settlement and late effect history. Real headless Chromium exercises the
isolated browser path. They do not qualify physical Accessibility, microphone,
Mac focus/Spaces, lock behavior or the owner's Chrome profile. Swift/AppKit and
the extended Foundation intake checks remain uncompiled in this cloud session.

The owned CLM adapter is implemented, but no full encoder/GPU inference or
endpoint deployment occurred. Production never substitutes synthetic inference.
Token overflow is rejected before ranking. Published tokenizer and projection
head CPU component checks passed against the pinned reference; full encoder
parity, calibration and supported primary-CLM controller integration remain open.

## First laptop work: GPU experiment, then Mac compilation

The selected target is the owner's reported M5 MacBook Pro with 32 GB unified
memory. Follow [CLM_LOCAL_GPU_EXPERIMENT.md](CLM_LOCAL_GPU_EXPERIMENT.md) for the
complete owner-run commands, limits and report interpretation. It runs six
requests over committed synthetic semantic fixtures through the actual local
GPU backend and never controls an app. It is an experiment, not acceptance.

The runtime is pinned to Python **3.12.14**, Torch **2.8.0**, Transformers
**4.57.6**, NumPy **2.3.4** and Accelerate **1.11.0**, with hashed transitive
requirements. Model/tokenizer/head revisions and exact artifact hashes are in
`packages/providers/fixtures/clm-artifact-manifest.macos.pending.json`.
The tracked pending manifest deliberately has no server revision; materialize
an ignored local manifest from the clean pulled HEAD as instructed.

All 17 model files (16,473,033,415 bytes) and 27 hash-locked macOS runtime wheels
were verified in cloud caches. **Git pull does not transfer those caches.**
Prepare/download the artifacts and runtime on the Mac using the pinned plan;
allow at least 22 GB free as described in the experiment. Do not replace an
existing venv or a mismatched artifact silently. The model repositories provide
Apache-2.0 license texts; release-wide SBOM/notices and clearance remain open.

Keep the private GPU report in `private-traces/clm-macos-smoke.json`. Record the
actual source SHA, device, startup/request latency, choices, memory and any
errors. Do not commit private traces or credentials. A successful smoke report
does not prove full-reference parity, acceptable peak memory or v1 readiness.

For compilation and source checks, follow the [README setup](../README.md#development-checks)
and [development signing](DEVELOPMENT_SIGNING.md). Repository test pins are Node
**26.5.0**, Python **3.14.6**, Playwright **1.63.0** and Swift **6.4** on Mac;
the Python test runtime is separate from the CLM runtime. Preserve existing
checkout changes, venvs, signing configuration and private journals. Relevant
commands after prerequisites are restored:

```sh
make test
npm run test:dev-task-intake
npm run build:native-dev
npm run test:release-inventory
```

These are prepared Mac steps, not verified executions. Check field replacement
sheet selection, retained target identity, explicit Resume at the child revision,
Stop during preparation/setter, failed fences and session interruption. Workspace
notifications alone do not establish physical screen-lock coverage. Native Stop
permanently cancels task IDs; wake must never reconstruct a stopped task or reuse
an old Resume prompt. Recovery across interrupted sessions needs separately
authorized new worker leases and remains unimplemented.

## Continue v1 without reviving the dropped goal

After the laptop evidence, complete full encoder/reference parity, at least 50
task-disjoint calibration cases and supported primary-CLM execution. Continue
general/active correction, general semantic execution and restart recovery.
Then qualify voice, actual native apps, managed browser and the existing Chrome
profile, followed by packaging and the fixed acceptance corpus.

The saved cloud environment draft retains the Package managers preset plus
`api.github.com`, `cdn.playwright.dev`,
`playwright.download.prss.microsoft.com`, `storage.googleapis.com`,
`huggingface.co`, `registry-1.docker.io`, `auth.docker.io` and the artifact redirect
`us.aws.cdn.hf.co`. Actual GitHub/Hugging Face and registry/auth connectivity was
rechecked successfully; saving a draft does not prove published configuration
or fresh-task restoration.

No Mac/GPU connection or cloud account/region/credentials are bound to the cloud
session. No billable infrastructure was provisioned. Any future paid launch
requires a concrete pinned, cost-capped plan and approval. Do not change owner
TCC/Keychain or run owner-app actions without applicable authorization. Keep
source evidence separate from live qualification, keep the handoff updated and
publish validated source milestones as stacked draft PRs.
