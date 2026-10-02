# Voice computer-use v1 readiness

The owner requested continuous progress toward v1 on 1 October 2026. The release
scope remains macOS voice/text computer use, CLM as the primary decision model,
and native apps plus managed Chromium and the owner's existing Chrome profile.
The owner dropped the previous goal; v1 source development continues. No proposed scope reduction is treated as approved.

V1 is **not ready**. Source tests and draft PRs are development evidence. The
[reviewed build plan](specification/BUILD_PLAN.md#12-build-milestones-and-exit-gates)
requires M6 and qualification of every enabled optional mode. Tickets stay open
until their actual acceptance evidence exists.

| Requirement | Current evidence | Remaining gate |
|---|---|---|
| Persistent execution and Stop | Durable admission/effect/checkpoint journals; bounded actor; native fixture and field controllers, independent field completion, explicit Resume and bounded fixture/field replacement admission; host snapshot interruption with Stop and no automatic wake execution; synthetic native and real headless portal continuation | General semantic actions, general/active replacement admission, restart/general controller recovery, physical sleep/lock qualification and recovery across sessions |
| Primary CLM | Bounded owned serving ingress; offline tensor adapter; verified Qwen/tokenizer/head bytes and hash-locked Metal runtime; published tokenizer/head component checks | Full encoder/runtime execution, actual laptop GPU experiment and full-reference parity, calibration, at least 50 task-disjoint cases and supported controller integration |
| Voice and input | One owner-reported editable held-Talk transcript; typed/final-input source guards | Representative speech corpus, on-device/offline assets, repeated capture/permission lifecycle, voice through the qualified task actor |
| Native Mac execution | Previous fixture action and build evidence | Stable signing/TCC attribution, physical AX actions, permission revocation/rebuild, focus/Spaces/multi-monitor, actual supported applications |
| Existing Chrome | Isolated extension/native-host fixture checks | Owner-profile tabs/data continuity, authentication/grants, Stop, routing and live qualification |
| Privacy and authority | Strict protocol/digests, default-denied effects, pre-I/O provider checks | Release peer identities, enabled-mode disclosure/egress evidence, transfers, retention and logging review |
| Release packaging | Development build scripts, bundled runtime experiments and a validated pending source dependency inventory | Developer ID/notarization, artifact SBOM/license notices, clean-Mac install without Node/Python/Xcode, update/rollback and compatibility matrix |
| Acceptance corpus | Focused synthetic/headless regressions | Fixed 300-run native/browser/hybrid corpus plus 100 failure scenarios; published latency, success, Stop and resource metrics |

Source work can proceed in Linux, but Linux cannot qualify macOS Accessibility,
microphone, signing, focus or physical window behavior. The owner signing and
Accessibility status requested on 1 October is unconfirmed. Follow
[development signing](DEVELOPMENT_SIGNING.md) and preserve the owner checkout;
do not reset TCC, alter Keychain or replace a running app automatically.

No owned CLM endpoint/API key or AWS/GCP/Modal/Runpod credential binding was
present under the relevant variable names in this cloud task on 1 October.
Provider account access reported by the owner is not an authenticated deployment
session. Prepare and review a pinned, cost-capped experiment before billable
provisioning. Credentials belong in a secret manager, never chat or git.

Local CLM feasibility, alternative providers and OCR/VLM remain separate tracks;
they are not a prerequisite if not shipped. No substitute for primary CLM or the
mandatory existing-profile Chrome scope is silently enabled.

On 2 October the owner selected the laptop GPU first, superseding the previous
Linux/NVIDIA-first experiment order. The [Metal experiment](CLM_LOCAL_GPU_EXPERIMENT.md)
is prepared for the reported M5/32 GB Mac; no connection or actual run exists in
this Linux session. Source and component parity evidence does not qualify MPS,
full encoder inference, Mac actions or release gates. Cloud provisioning stays deferred.

The next source milestones and exact evidence live in [handoff](BUILD_HANDOFF.md),
[implementation status](IMPLEMENTATION_STATUS.md) and [validation](VALIDATION.md).
