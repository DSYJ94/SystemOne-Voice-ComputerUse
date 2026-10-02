# V1 plan

Updated 2 October 2026. This is the single consolidated plan: what version 1 is,
which scope decisions are fixed, where the project actually stands, the ordered
remaining path, and which document owns which detail. It consolidates and points
to; it does not replace the reviewed [build plan](specification/BUILD_PLAN.md),
the [backlog](specification/BACKLOG.md), [readiness](V1_READINESS.md),
[status](IMPLEMENTATION_STATUS.md), [handoff](BUILD_HANDOFF.md) or
[validation](VALIDATION.md). When this document and a newer dated checkpoint in
those files disagree, the dated checkpoint wins.

**V1 is not ready.** No draft PR in the stack is merged. Source evidence,
however green, is not Mac, live, or release qualification.

## 1. What version 1 is

From the reviewed build plan §1. An installed app runs in the user's logged-in
macOS session. A shortcut opens a compact command field or starts push-to-talk;
the user speaks, edits the transcript, or types. One persistent controller
performs supported tasks through native applications and browser pages without
losing the goal at the boundary, with CLM as the primary decision model.

Representative release workflows: locate-not-open a Documents file in Finder;
open a named Slack channel canvas (dedicated test workspace, named build);
search and download an invoice from the test portal; carry a selected reference
number through search and clipboard return with provenance; upload one approved
file to the approved destination. Initial action coverage: launch/activate
approved apps, focus windows, invoke controls, select rows/options, fill fields,
scroll, a small approved key-chord registry, open/switch/close tabs, navigate to
approved URLs, downloads/uploads, copy a selected value, and explicit read-only
inspection. Drag-and-drop is out of protocol 2.0.

V1 must not promise universal task solving. Excluded: autonomous purchases,
irreversible deletion, sending messages, entering credentials, installation,
shell execution, OS security changes, bypassing permission prompts, CAPTCHAs.
The release support matrix — not marketing — states exactly which apps, action
families, OS builds and browser modes passed.

Version 1 requires M6 plus qualification of every enabled M5 mode. It does not
require fine-tuning, a VLM, SemIf, or an offline CLM port if those are
explicitly not shipped.

## 2. Fixed scope decisions

These are founder decisions and are not reopened by proposals or agents:

1. **Three beta surfaces, all required** (26 September 2026): native macOS
   apps, managed Chromium in an isolated profile, and **existing Chrome with
   the user's current profile, data and tabs**. A fresh or copied profile does
   not satisfy the third. B19 and G4 remain beta gates; B20 keeps its B19
   dependency.
2. **CLM is the primary decision model.** Jev — TypeSafe's System One model,
   consumed over its hosted API — is the designated external fallback (owner
   decision, 2 October 2026): enabled only explicitly, with disclosed data
   transfer and a hard spending limit, never active in offline/privacy mode
   (build plan §9). Laya remains a separately qualified open-weight
   alternative. No substitute is silently enabled, and a fallback provider is
   never a substitute for the primary model passing its own gates.
3. **The previous owner goal stays dropped.** Do not resume or reconstruct it.
4. **No billable infrastructure without a pinned, cost-capped, approved plan.**
   The owner selected laptop-GPU-first CLM qualification (2 October 2026),
   superseding Linux/NVIDIA-first ordering.
5. No TCC/Keychain changes, no owner-app actions, no running-app replacement
   without applicable authorization.

## 3. Architecture invariants the plan must not trade away

- The host owns admission, policy, permits, epochs, the journal and Stop;
  workers prepare and dispatch only against short-lived one-use permits.
- Effects are default-denied; every dispatch passes a durable boundary before
  the adapter acts; already-dispatched effects are tracked, never claimed
  cancelled; unknown outcomes block related execution until re-observed.
- Completion requires independent fresh verification, not a dispatch receipt.
- Wake from sleep/session interruption never resumes a task; native Stop
  permanently cancels task IDs; recovery needs fresh, separately authorized
  leases and explicit one-use Resume at the current revision.
- CLM proposals are validated against admitted candidates before any I/O;
  production never substitutes synthetic inference.
- Correction cancels the old revision, never implies undo, and admits a fresh
  child with durable lineage, fresh scope, limits and verification.

## 4. Milestone ladder and current position (2 October 2026)

| Milestone | Exit gate | Position | Missing for the gate |
|---|---|---|---|
| M0 reference and contracts | Known fixture ranks correctly; hardware/config recorded; no unevidenced CLM claim | **Nearly closed in source.** Protocol 2.0, fixtures, Python oracle, dependency inventory, CLM serving boundary/adapter/artifact preflight all implemented and tested (468/468 Node + 115/115 oracle, now on Mac too) | Model bytes verified only in cloud caches; nothing CLM has run on hardware. B04 signing attribution unqualified: this Mac has zero valid signing identities |
| M1 native shell | Cold install opens panel and produces one committed command; no focus theft | **Partial.** Development panel with push-to-talk/text/target capture exists; one owner-run held-Talk transcript passed (29 Sept) | No signing certificate, no repeatable TCC grant across rebuilds, no cold-install path, physical panel behavior unverified |
| M2 deterministic adapters | Adapter tests pass with NO model; stale targets rejected | **Source-complete for fixture workflows; first Mac compile/tests 2 Oct.** No-model tests green everywhere | Physical AX/managed-browser qualification, real-app observation coverage, headed browser, live Stop barriers |
| M3 CLM multi-hop | Closed-loop Finder and portal tasks pass with CLM; no repeated side effects on timeout/restart | **Deepest built area, none of it live.** Persistent actor, durable journals, checkpoints, recovery/Resume, correction/replacement lineage, CLM decision boundary + offline adapter + serving boundary | Zero CLM inference ever run; no full encoder/GPU parity; no calibration (≥50 task-disjoint cases); recovery across sessions unimplemented |
| M4 seamless hybrid | Cross-surface tasks retain session and target; regular Chrome needs no insecure debug setup | **Extension/native-host fixtures only**; owner-profile continuity untouched | B19 qualification on the owner's actual profile: grants, tab/document identity, navigation invalidation, reconnect/revocation; B18 transitions |
| M5 optional qualification | Only enabled modes pass their own gates | **Jev via the TypeSafe API designated as the external fallback** (2 Oct 2026); adapter and qualification not started | B22: Jev provider adapter, egress disclosure, spending cap, latency and policy gates; Laya and other M5 tracks stay optional |
| M6 production release | Fresh-Mac install without developer tools; notarization and rollback pass | **Bundled-runtime foundation only** (ad-hoc signed, sealing cycle known) | Developer ID + notarization, SBOM/licenses, update/rollback, clean-Mac matrix, B26 adversarial CI, acceptance corpus |

Public beta may begin after M4 and its security/packaging gates. M2 must
precede model-driven clicking; M3 must precede speech optimization work.

## 5. The ordered path to v1

Sequenced by evidence, not calendar. Each phase's gate is evidence, and
phases 1–2 are on the critical path of everything after them.

### Phase 1 — make this Mac a real development host (current)

Done 2 October 2026 (owner-run, recorded in
[validation](VALIDATION.md)): prerequisites verified at exact pins (Node 26.5.0,
Python 3.14.6, Swift 6.4 arm64); first-ever Mac run of `make test` —
**468/468 passed, zero failed, zero skipped** (the two Mac-only Linux skips ran
and passed here), Python oracle **115/115**, typecheck clean; release inventory
**7/7**; focused intake check passed; **first Swift/AppKit compilation** built
`.build/native-dev/SystemOne Dev.app` (ad-hoc signed). `test:swift` remains
blocked only by the documented CLT/XCTest SDK gap (full Xcode needed).

Remaining in this phase:

1. Owner runs the pinned [laptop GPU experiment](CLM_LOCAL_GPU_EXPERIMENT.md):
   M5/32 GB Metal, ≥22 GB free, pinned Python 3.12.14/Torch 2.8.0 runtime,
   report to `private-traces/clm-macos-smoke.json`. Git pull does not transfer
   the 16.5 GB artifact cache; download per the pinned plan.
2. Owner creates an Apple Development certificate via Xcode Personal Team
   ([signing](DEVELOPMENT_SIGNING.md)); then qualify the Accessibility grant
   across rebuild/relaunch — the stale ad-hoc-grant failure mode.
3. Manual Mac qualification of the current source: field replacement sheet,
   retained target identity, explicit Resume at the child revision, Stop
   during preparation/setter, failed fences, session interruption.

### Phase 2 — finish CLM as the primary model

Full encoder/reference parity on the qualified GPU, at least 50 task-disjoint
calibration cases, then supported primary-CLM execution inside the controller
(B14). Token overflow stays rejected before ranking; calibration decides
abstention and clarification thresholds.

### Phase 3 — generalize execution

General semantic actions beyond fixed commands; general/active correction;
restart/controller recovery across sessions with separately authorized worker
leases; qualified physical lock/sleep coverage (B15–B17 closure).

### Phase 4 — live qualification of all three surfaces

Voice lifecycle against a representative corpus (B08); real native apps with
stable signing and TCC attribution, focus/Spaces/multi-monitor (B04/B10/B11);
headed managed browser workflows (B12/B13 candidate recall); existing Chrome on
the owner's current profile — grants, identity, Stop, reconnect, revocation
(B19/G4). Physical toolbar click, full AppKit integration and installed Google
Chrome together remain untested.

Parallel provider-fallback track (B22; must never block the baseline):
implement the Jev provider adapter against TypeSafe's System One HTTP API —
`POST /v1/systemone` with bearer auth, one `choice` question over the minimized
provider view, the full probability distribution (not just the top answer)
consumed by the existing host decision boundary with its threshold, tie and
malformed-output fences. Explicit user enablement per session, disclosed
egress, a hard spending cap, exponential backoff on 429/529, and automatic
deactivation in offline/privacy mode. Pin the exact API contract and model
revision at implementation time — `jev-latest` is a moving pin — and clear
TypeSafe's data-handling terms in the privacy review before any real
observation leaves the machine.

### Phase 5 — release

B26 adversarial CI and the fixed acceptance corpus (300 runs + 100 failure
scenarios, thresholds in build plan §13); B27 packaging — Developer ID,
notarization, clean-Mac install without Node/Python/Xcode, updates/rollback,
SBOM and license notices; B28 supported-app publication.

## 6. Blockers that only the owner can clear

1. **Signing identity** — this Mac has zero valid code-signing identities;
   create the Xcode Personal Team certificate. Until then every rebuild
   invalidates the previous Accessibility grant.
2. **GPU experiment run** — needs owner execution or an authorized Mac
   connection; artifacts are not in git.
3. **Physical/manual test sessions** — panel, voice, real apps, Spaces,
   existing-profile Chrome.
4. Any paid cloud work requires a pinned, cost-capped plan and explicit
   approval first.

## 7. Evidence rules

- Linux/cloud test passes are source evidence only. They never qualify macOS
  Accessibility, microphone, signing, focus or physical window behavior.
- Synthetic and fixture evidence never substitutes live CLM, live browser
  profiles or owner-app actions.
- Draft PR and test counts are not a measure of release readiness.
- Keep [validation](VALIDATION.md) updated with each slice's actual results and
  limits; keep source milestones as stacked draft PRs merged in dependency
  order.

## 8. Document map (what to read for what)

| Need | Document |
|---|---|
| Authoritative product/architecture contract | [specification/BUILD_PLAN.md](specification/BUILD_PLAN.md) |
| Ticket list and done-criteria | [specification/BACKLOG.md](specification/BACKLOG.md) |
| This consolidated position | [V1_PLAN.md](V1_PLAN.md) (this file) |
| Gate-by-gate readiness table | [V1_READINESS.md](V1_READINESS.md) |
| Latest session checkpoint / resume here | [BUILD_HANDOFF.md](BUILD_HANDOFF.md) |
| Owner-run Mac pull instructions | [MAC_CONTINUATION_HANDOFF.md](MAC_CONTINUATION_HANDOFF.md) |
| Per-slice implementation log | [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) |
| Recorded test evidence and limits | [VALIDATION.md](VALIDATION.md) |
| Native app, panel, permissions | DEVELOPMENT_SIGNING, VOICE_COMPUTER_USE_TEST, VOICE_CRASH_HANDOFF, TASK_INTAKE, NATIVE_ACTION, NATIVE_INSPECTION_TEST, NATIVE_SHORTCUT_TEST |
| Task lifecycle | DURABLE_TASK_RECORD, TASK_PROGRESS, TASK_RECOVERY, TASK_EXECUTION_LIMITS, PERSISTENT_TASK_ACTOR, NATIVE_CONTROLLER_ACTOR, NATIVE_CONTROLLER_RECOVERY, NATIVE_TASK_REPLACEMENT, NATIVE_FIELD_ACTOR, NATIVE_FIELD_REPLACEMENT, HOST_LIFECYCLE_INTERRUPTION |
| Browser | MANAGED_BROWSER, MANAGED_NAVIGATION_TEST, NATIVE_MANAGED_TEST, TRY_LOCAL |
| Existing Chrome | EXISTING_CHROME |
| CLM | CLM_DEPLOYMENT_PLAN, CLM_LOCAL_GPU_EXPERIMENT, CLM_SERVING_BOUNDARY, CLM_REFERENCE_ADAPTER, CLM_ARTIFACT_PREFLIGHT, CLM_DECISION_BOUNDARY, CLM_REFERENCE_PROBE |
| Release | RELEASE_DEPENDENCY_INVENTORY, BUNDLED_DEV_RUNTIME, DEPENDENCIES |
