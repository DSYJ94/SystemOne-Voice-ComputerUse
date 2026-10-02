# Initial foundation validation

## First CLM local GPU smoke on the owner M5, 2 October 2026

`codex/mac-first-validation` at `6a14dd8`, owner's OneDrive checkout, macOS
26.6 arm64, Apple M5 / 32 GB unified memory, MPS, Torch 2.8.0 +
Transformers 4.57.6 per `requirements-macos.lock` (hash-verified), pinned
Qwen3-8B revision and CLM head, 15 GB artifacts re-hashed by both Node
preflight and the worker. First real CLM inference on any host.

The run surfaced two macOS-specific defects, both fixed on this branch:

1. `reference_backend.py` compared whole `stat_result` objects, whose
   equality includes `st_atime`; the worker's own reads (inventory hashing,
   model load) updated access time on APFS and tripped "artifact changed;
   restart refused" after every successful load. Linux CI never saw this
   because relatime/noatime hides it. Now compares size, mode, inode, device,
   mtime and ctime, mirroring the Node preflight precedent (0af36e4).
2. The native manifest validator hardcoded `pythonVersion '3.12.14'`, which
   python-build-standalone does not ship for macOS aarch64; every
   `createVerifiedCLMReferenceBackend` call was refused before spawn. It now
   validates the 3.12 patch line and passes the declared value through; the
   worker still binds the exact running interpreter (f17a91f).

Result at manifest digest `6c95793e…` (private report
`private-traces/clm-macos-smoke.json`, mode 0600): startup **39.2 s**;
per-request latency cold 4.08 s then **767 ms / 992 ms / 868 ms** warm
(95–122 input tokens, three fixtures, two repetitions); GPU **15.21 GB
allocated, ~16.25 GB driver** against the 70% allocator cap (~22.4 GB),
leaving ~6 GB unified-memory headroom. Repeated fixtures reproduced
byte-identical probability distributions. Expected choices matched on
`browser-open-exact-invoice` (exact, p 0.924) and `missing-target-abstention`
(help, p 0.99998); `native-locate-documents` chose help (0.517) over the
expected documents (0.099), deterministically.

This is a six-request synthetic smoke on real Metal hardware. It does not
establish full-encoder parity with the pinned Linux/vLLM recipe, calibration
(the document miss is unexamined), warm p95 at target, coexistence with
speech, or any v1 or beta gate.

## First Mac host validation, 2 October 2026

`codex/native-field-replacement` at
`7cfe7a6b20961908ee86ba8b2e729e200f53e09c`, the owner's OneDrive checkout,
macOS arm64. First execution of the repository test suite on a Mac.

Prerequisites verified at the exact pins: Node v26.5.0, npm 11.17.0, Python
3.14.6 (system default), Apple Swift 6.4 (swift-driver 1.168.6,
arm64-apple-macosx26.0). A fresh `.venv` was created from
`requirements-test.txt`; `npm ci` added 13 packages to the existing tree;
Playwright Chromium revisions 1228/1243 were already cached locally.

`make test`: typecheck clean; **468 passed, zero failed, zero skipped, zero
cancelled** — the two tests Linux records as Mac-only skips ran and passed on
macOS for the first time. Python oracle **115/115**. Release inventory
consistency and **7/7** checks pass. The focused intake check passes
("task intake keeps one writer and binds committed command bytes").

`npm run build:native-dev` compiled and ad-hoc signed the development app on a
Mac for the first time: `.build/native-dev/SystemOne Dev.app` (ad-hoc identity,
external Node path; not distributable, and the live TCC permission flow is
still unverified). The Swift protocol package's standalone check executables
build under Command Line Tools. `npm run test:swift` still cannot run: the
Command Line Tools SDK does not ship XCTest
(`unable to resolve module dependency: 'XCTest'`), matching the documented
limitation; the XCTest suite needs full Xcode.

This is source and compilation evidence on the target platform. It does not
qualify Accessibility, microphone, voice, focus/Spaces, lock behavior, the
owner's Chrome profile, CLM inference or any release gate. The GPU experiment,
signing certificate and live qualification items in [V1_PLAN.md](V1_PLAN.md)
remain open.

## Native field replacement admission, 2 October 2026

`codex/native-field-replacement`, based on host interruption #74 at
`b215bf7e5cd330e8bf2f14342536ec751c043b71`.
`make test`: typecheck, **466 passed, zero failed, two Mac-only skips (468 total)**
and Python oracle **115/115**. Release inventory consistency and **7/7** checks
pass; `git diff --check` passes. Dependency declarations, locks and inventory
remain unchanged. The focused authority/controller suite passes **32/32**.

Fourteen added synthetic regressions cover changed field/value with fresh
completion and durable lineage, unchanged/invalid/non-final commands, captured
process binding, exclusive pending fences, Stop during child observation and
setter, repeated correction/parent aliases, failed fences, unknown edits,
session interruption, final voice metadata/empty literals, restart refusal,
child Resume and caller mutation while awaiting Stop. No physical Mac or voice
execution occurred.

Validation caught an overly broad recovery guard rejecting ordinary safe paused
actors; corrected to reject unresolved effects while retaining paused-actor
ownership checks. It also exposed the scoped text parser's empty-value refusal;
replacement submission now uses canonical literal suffix text. Initial test
fixtures needed a foreign UUID and permission for the constructor's public-key
frame. All resulting typecheck and full suite failures are resolved.

The Foundation intake check now covers exact original process retention, invalid
and failed delivery, concurrent correction, handoff/revision validation, changed
child goals and empty literals. Linux has no Swift compiler/AppKit, so these
checks and the new sheet remain uncompiled source. Live Mac/GPU, general/active
correction, restart reconstruction, primary CLM and release gates remain open.

## Host lifecycle interruption, 2 October 2026

`codex/host-lifecycle-interruption`, based on reference adapter #73 at
`ec2735bca614c40c575114f2b0ef914c32e7e16e`.
`make test`: typecheck, **452 passed, zero failed, two Mac-only skips (454 total)**
and Python oracle **115/115**. Release inventory consistency and **7/7** checks
pass; `git diff --check` passes. Dependencies and frozen inventory are unchanged.

Ten added regressions cover strict full snapshots, stale wake rejection,
initial snapshot admission, delayed/failed native Stop, retained checkpoint and
recovery cancellation, completed history, late dispatched effects, pending
shutdown cleanup and private-pipe Chrome grant revocation. The existing real
headless Chromium pipe test now also proves interruption cleanup, completed
history preservation and fresh explicit task intake after wake.

The first focused run incorrectly expected a durable cancelled record before the
initial observation admitted a task; corrected to assert no record or effect.
The late-effect test initially checked recovery while the old run still owned
its slot; it now waits for actual run settlement. Final full suite passes.
Swift/AppKit changes remain uncompiled; notifications, actual sleep/lock, voice,
owner apps and existing-profile Chrome require Mac qualification. Same-task
recovery across host sessions is not implemented. B17 and v1 gates remain open.

Separately, all 27 macOS runtime wheels for #73 were downloaded with
`--require-hashes --only-binary=:all:` and their license metadata/files inspected
without executing Mac binaries. This verifies experiment distributions, not
runtime compatibility, a release SBOM or release-wide license clearance.

## Owned CLM serving boundary, 1 October 2026

`codex/clm-serving-boundary`, based on native field actor #71 at `7727da0`.
[Owned serving ingress](CLM_SERVING_BOUNDARY.md) requires constant-time bearer
checks, exact SystemOne request shape, bounded body/deadline/concurrency,
pre-ranking exact-tokenizer counts and overflow rejection, validated redacted
replies, and actual backend settlement before capacity release. Production
startup verifies local artifact bytes before opening a loopback-only listener.
It performs no model download, tensor loading, cloud deployment or inference.
The manifest header identifies declarations, not loaded GPU attestation.

`npm run check`: typecheck and **432 passed, zero failed, two Mac-only skips
(434 total)**. Fifteen new ingress/transport regressions cover identity/auth,
startup refusal, exact reference text formatting, schema/body/token bounds,
redaction, timeout/disconnect and stalled/chunked bodies. Release inventory
consistency and six checks pass; no dependency declarations changed.
`git diff --check` passes. The first test run caught unsupported Node strip-only
parameter-property syntax; corrected. A raw duplicate-header test needed Host;
the chunked-body regression exposed early iterator destruction, corrected with
`destroyOnReturn: false` before the passing full run.

A concrete pinned tokenizer/ranking adapter, verified artifacts/runtime/licenses,
owned GPU and live reference/calibration evidence remain open. No Mac runner or
provider credential binding is available; Hugging Face metadata is blocked.
Saving added network hosts failed with a conflict; reread confirmed the draft
unchanged. General/lifecycle, Mac/Chrome/voice and release gates stay open.
V1 remains not ready; the previous owner goal remains dropped.

## Native field persistent actor, 1 October 2026

`codex/native-field-actor`, based on `codex/native-task-replacement` (#70)
at `e6ba315`. [Native field execution](NATIVE_FIELD_ACTOR.md) now uses the
persistent actor, budgeted eligibility checkpoints and a separate fresh value
read before terminal completion. Controller Check recovery / explicit Resume
supports retained paused field actors without resetting admission or limits.
Stop and shutdown retain ownership until actual worker settlement. Swift
process-scope and independent eligibility checks are source changes only.

`npm run check`: typecheck and **417 passed, zero failed, two Mac-only skips
(419 total)**. Ten added synthetic regressions cover checkpoints, fresh terminal
verification, recovery identity/visibility, exhausted budgets, timeout ownership,
Stop and controller shutdown. Signed child-pipe execution now asserts the
independent verify operation. Release inventory consistency and six checks pass;
`git diff --check` passes. No Swift/AppKit compilation or live qualification ran.
General/active correction, restart reconstruction, sleep/lock, primary CLM,
existing-profile Chrome and release gates remain open. The previous owner goal
remains dropped.

## Native fixture replacement admission, 1 October 2026

`codex/native-task-replacement`, based on #69 at `4bcab66`.
Implementation `244441d`, [draft PR #70](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/70),
targeting `codex/native-controller-recovery` (#69).
Pinned Linux Node 26.5.0 and official Playwright 1.63.0 revision 1243.

- `npm run check`: typecheck passed; **407 passed, zero failed, two Mac-only
  skips (409 total)**, including headless browser and signed worker regressions.
- **19 added regressions** cover exact one-use correction transfer, ordinary
  admission refusal, copied/unclaimed/replayed input, immutable source history,
  next revisions, fresh limits/checkpoints, invalid/unchanged goals, failed fences,
  unknown effects, transaction rollback, durable links across restart, forged
  provenance/second children, unrelated paused history, cross-surface intake and
  Stop during old fencing, child observation and after panel handoff.
  Focused committed-input/lineage/authority/controller suites pass **49/49**.
- `npm run test:release-inventory`: consistency and **6/6** checks pass;
  dependency declarations and generated inventory are unchanged.
- `git diff --check`: passed. An initial test incorrectly assumed a fresh child
  inherited a recoverable checkpoint; corrected to assert empty history and
  require a separately explicit changed revision. Full typecheck then caught
  UUID-template inference in a helper; fixed before the passing full run.

The Foundation intake check was extended for failed delivery, exact handoffs,
revision progression, concurrent submissions, stale rejection and stale Ready,
but was **not run**: no Swift/AppKit toolchain exists here. Sheet/focus/Stop timing
and real AX worker behavior need a Mac build and live qualification. Native
workers in these tests are synthetic. No owner app, microphone, TCC/Keychain,
owner Chrome profile, model/GPU, paid service or owner journal mutation ran.
The previous owner goal remains dropped. See [replacement limits](NATIVE_TASK_REPLACEMENT.md).


## Native fixture recovery controller and panel, 1 October 2026

`codex/native-controller-recovery`, based on #68 at `d0482bc`.
Implementation `582b959`, [draft PR #69](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/69),
targeting `codex/native-controller-actor` (#68).
Pinned Linux Node 26.5.0 and official Playwright 1.63.0 revision 1243.

- `npm run check`: typecheck passed; **388 passed, zero failed, two Mac-only
  skips (390 total)**, including actual headless managed-browser regressions.
- **11 added tests** exercise continuation without repeated Documents dispatch,
  admission/deadline/quota preservation, missing presentation, altered UI session,
  checkpoint, observation, revision and digest, dismissal, superseding reads,
  mismatched scope/title, concurrent recovery, Stop during reads and after
  presentation, exhausted budgets, strict pipe controls and restart refusal.
  Focused authority/controller suites pass **18/18** and **7/7** respectively.
- `npm run test:release-inventory`: consistency and **6/6** focused checks pass.
- `git diff --check`: passed. No dependencies or inventory entries changed.

Native workers are synthetic. No Swift/AppKit compiler exists here: sheet
visibility/acknowledgment timing, timeout/dismissal behavior and retained native
process-scope binding require Mac build and live validation. The source changes
are not Mac qualification. No owner app, microphone, TCC/Keychain, owner Chrome,
model/GPU or paid provisioning ran. The previous owner goal was dropped from the
working plan; no owner journal was modified. See [recovery](NATIVE_CONTROLLER_RECOVERY.md).


## Native fixture controller actor, 1 October 2026

`codex/native-controller-actor`, based on #67 at `076c241`.
Implementation `54c3f0d`, [draft PR #68](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/68),
targeting `codex/release-dependency-inventory` (#67).
Pinned Linux Node 26.5.0 and official Playwright 1.63.0 Chromium/headless-shell
revision 1243, using ignored `.build/playwright` as `PLAYWRIGHT_BROWSERS_PATH`.

- `npm run check`: typecheck passed; **377 passed, zero failed, two Mac-only
  skips (379 total)**. Existing browser, Chrome, journal and signed native
  child-process regressions ran successfully.
- **14 added authority/controller tests** cover exact final commands and
  outcome parameters, NAVIGATE/LOCATE/OPEN and already-matched evidence,
  retained quota/checkpoint pauses, pre-admission Stop after an earlier task,
  late preparations/dispatch receipts, failed fences, timeout ownership,
  cross-surface intake blocking, paused startup with no unknown effect and
  shutdown settlement before closing journal history.
- Earlier focused signed native pipe, budget and actor checks passed **16/16**.
  `npm run test:release-inventory` passed consistency and **6/6** focused tests;
  dependency pins, inventory and lockfiles remain unchanged.
- `git diff --check`: passed. Initial test development caught a missing journal
  revision argument and a deferred test-helper initialization error; both were
  fixed before the final passing full suite. An old focused run awaiting the
  previous ready status was stopped; the budget test now expects the truthful
  blocked-recovery state for a paused record.

All native action workers in these tests are synthetic. AppKit status strings
were updated for native pause/unfinished-task states, but no Swift/AppKit build
toolchain exists here; native build/live UI qualification remains unrun. No Mac
app, Accessibility/TCC/Keychain, microphone, model/GPU, paid service, owner Chrome
profile or owner-goal resume ran. See [integration limits](NATIVE_CONTROLLER_ACTOR.md).

## Pending release dependency inventory, 1 October 2026

`codex/release-dependency-inventory`, based on #66 at `3b6c6a8`.
Implementation `1673db7` is pushed and its remote hash verified.
[Draft PR #67](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/67) targets #66.
The initial draft attempt returned GitHub API 403; publication succeeded after
the owner applied the saved network settings.
Reconstructed from committed manifests, lockfiles and bundle declarations;
no pending worktree/stash/unreachable implementation or remote branch was found.

- Official Linux Node 26.5.0 was downloaded and checked against its official
  SHA-256 list. Frozen `npm ci --ignore-scripts --cache
  /tmp/systemone-npm-cache --no-audit --no-fund` installed 13 packages without
  changing dependency pins or the lockfile. The initial installation failed
  because the default cache path was unavailable; using `/tmp` fixed it with
  integrity and TLS verification preserved.
- `npm run inventory:write` and `npm run test:release-inventory`: inventory
  consistency passed; **6/6 focused tests passed**. Repeat generation is byte
  stable. Changed output, manifest/lock disagreement, missing integrity/license,
  unpinned Python, changed Node checksum and changed browser revision fail.
- `npm run typecheck` and `git diff --check`: passed.
- Initial broader `npm run check`: typecheck passed; **338 passed, 25 failed, two
  Mac-only skips (365 total)**. Browser cases lacked pinned Chromium/headless
  executables; dependent controller cases then timed out waiting for browser
  status. That failed attempt is retained as historical environment evidence.
- Initially, installing official Playwright revision 1243 was blocked by HTTP 403
  `Domain forbidden` at `cdn.playwright.dev`. GitHub API reads also returned 403,
  blocking draft PR creation. A saved environment network draft adds
  `api.github.com`, `cdn.playwright.dev`, `storage.googleapis.com` and
  `playwright.download.prss.microsoft.com`, preserving the package-manager
  preset. The owner applied these settings; the restarted environment reports
  them and actual GitHub API reads and official browser downloads succeed.
- With official Chromium/headless-shell revision 1243 (153.0.8010.12) installed
  under ignored `.build/playwright`, `npm run check` passed: typecheck and
  **363 passed, zero failed, two Mac-only skips (365 total)**. Run with pinned
  Node 26.5.0 and `PLAYWRIGHT_BROWSERS_PATH` pointing to that cache. Playwright
  also downloaded its ffmpeg helper; this is test setup, not a change to what
  the Mac bundle script copies. TLS verification stayed enabled.
- `npm run test:release-inventory` again passed inventory consistency and all
  **six focused tests** after the environment restart. No dependency pins,
  source inventory or lockfiles changed.

The [source inventory](RELEASE_DEPENDENCY_INVENTORY.md) is pending release review,
not a distributable SBOM or new artifact/license clearance. No Mac app, model,
GPU, microphone, TCC/Keychain, owner Chrome profile or owner-goal resume ran.
The publication body and exact draft command are retained in
[draft PR material](release/DRAFT_PR.md); publication is complete as a stacked
draft, with release review and Mac qualification still pending.

## Offline CLM artifact preflight, 1 October 2026

`codex/clm-artifact-preflight`, based on #65 at `3da29cb`, implementation
`c984914`, [draft #66](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/66).
Same Linux/pinned Node/Playwright toolchain as preceding records.

- `npm run check`: typecheck passed; **363 passed, zero failed, two Mac-only
  skips, 365 total**. Eight focused new artifact checks passed **8/8**.
- Tests use metadata declarations and small synthetic bytes; none loads tensors
  or downloads a model. They cover unresolved/moving pins, reference identities,
  loader/authentication/recipe declarations, missing roles, duplicate/escaping
  paths, checksum/size mismatch, symlinks/nonregular files and cancellation.
- The pending-manifest CLI exits unsuccessfully without writing a report;
  absent model files cannot produce a successful full preflight. Successful
  standalone fixture-file hashing proves those fixture bytes only.
- Initial typecheck caught array guard narrowing to `any[]`; an explicit typed
  snapshot fixed it. Final checks and `git diff --check` passed.

The recipe/settings are declarations, not verified server behavior. No genuine
artifact preflight report, inference, container, GPU or paid service exists.
Mac/voice/owner-profile/release qualification remains open. No owner goal resumed.
See [preflight limits](CLM_ARTIFACT_PREFLIGHT.md) and [v1 gates](V1_READINESS.md).

## CLM proposal boundary and owned transport, 1 October 2026

`codex/clm-decision-boundary`, based on #64 at `e64f59b`, implementation
`40eb6cb`, [draft #65](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/65).
Same Linux/pinned Node/Playwright toolchain as preceding records.

- `npm run check`: typecheck passed; **355 passed, zero failed, two Mac-only
  skips, 357 total**. Focused provider/native checks passed **29/29**.
- Fourteen added tests cover pre-I/O egress/revision/disclosure/digest rejection,
  exact semantic wire choices, confidence/ties, non-effect choices, malformed
  replies, unavailable transport, mutation and cancellation. Loopback HTTP tests
  check exact POST/authentication, no startup/health requests, manifest-header
  consistency, redirects, strict JSON, both size bounds and timeout/cancellation.
- Synthetic native proposals complete three independently verified steps;
  abstention, invented IDs, wait/help and Stop during model selection prepare no
  effect. Thresholds/replies are fixtures, not measured model calibration.
- The initial typecheck caught an overloaded HTTP listener type in the test
  helper; corrected to `RequestListener`. Final checks passed.

No live endpoint, weights, inference or paid GPU ran. Hugging Face metadata was
blocked with HTTP 403 by the cloud network policy. No Mac build/audio/TCC/Keychain,
owner-profile browser action or owner-goal resume occurred. Existing native
Python suites were not rerun for this TypeScript slice. See
[CLM boundary](CLM_DECISION_BOUNDARY.md) and [v1 gates](V1_READINESS.md).

## Persistent actors and scripted continuation, 1 October 2026

`codex/persistent-scripted-actor`, based on #63 at `d18e6b3`, implementation
`cdc641c`, [draft #64](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/64).
Same Linux/pinned Node/Playwright toolchain as preceding cloud records.

- `npm run check`: typecheck passed; **341 passed, zero failed, two Mac-only
  skips, 343 total**. Existing headless/controller-child and Chrome regressions ran.
- **16 new tests** cover native NAVIGATE/LOCATE/OPEN and checkpoint continuation,
  changed scopes/account/predicates, duplicate controls, Stop before/after dispatch,
  correction, exact portal attachment, projection activation failure, timed-out
  read ownership, no-decision progress and an unconfirmed idle fence.
- A real isolated headless browser pauses after OPEN, rechecks detail and resumes
  DOWNLOAD, preserving exactly four attempts and verified scoped output bytes.
  It retains the live page/session; it does not reconstruct a browser after restart.
- Focused native/portal/controller checks passed **50/50** before the final idle
  fence test, which passes in the final full suite. `git diff --check` passed.
- Initial typechecks caught tuple narrowing and a wrong fixture URL property.
  A changed-account negative test exposed that a permissive verifier stub could
  bypass host semantic contract checks; recovery now checks query/invoice/account
  and unchanged observations itself. Final checks passed after correction.

New native actor tests use a synthetic worker; physical AX and its controller/UI
integration remain unqualified. No normal AppKit launch, TCC/Keychain change,
audio, owner-profile action, live model, paid resource or owner-goal resume ran.
Python/native suites were not rerun for this TypeScript/documentation slice.
See [actor scope](PERSISTENT_TASK_ACTOR.md) and [v1 gates](V1_READINESS.md).

## Explicit recovery intent and correction fences, 1 October 2026

Branch `codex/explicit-task-recovery`, based on #62 at `76e28dc`, implementation
`08abcaa`, [draft #63](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/63).
Same Linux/Node 26.5.0 and official Playwright 1.63.0 assets as prior cloud
records; manifests, locks, fixtures and saved environment settings are unchanged.

- `npm run check`: typecheck passed; **325 passed, zero failed, two skipped,
  327 total**. Only the existing macOS Chrome-host registration tests skipped.
- **26 added tests** cover exact one-use intent, fresh reactivation/terminal
  evidence, already-paused restart, out-of-order reads, scope/predicate/revision
  bindings, read/prompt expiry, copied/foreign/closed/invalidated intent, durable
  replay, Stop, global active/unknown blockers, applied receipts without checkpoints,
  immutable quotas/clock pauses, changed history, transactional SQL failure and
  correction provenance/cancellation without undo. Recovery tests use synthetic
  host state and journal attempts, not live AX or portal resumed execution.
- All **46 focused recovery/prompt/progress tests** and typecheck passed after
  final normalization of digest inputs to their contracted fields. The existing
  headless portal, controller-child, synthetic-native and Chrome-extension
  regressions passed in the full suite.
- `git diff --check`: passed. Initial typechecks caught a SQLite result cast and
  one misplaced test assertion; both were corrected before passing runs.

The new host APIs do not wire Resume into the fixed native/browser actors or
panel, resolve unknown effects, admit replacement goals or replace adapter Stop
barriers. No native Mac build/live permission check, normal AppKit launch,
TCC/Keychain change, audio capture, owner-profile browser use, model call, paid
resource or user-goal resume occurred. Python/native suites were not rerun for
this TypeScript/documentation slice. See [recovery scope](TASK_RECOVERY.md).

## Portal reconciliation and shared progress guards, 30 September 2026

Branch `codex/portal-checkpoint-reconciliation`, based on #61 at `93259b7`.
Implementation `7381f03`, [draft #62](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/62).
Same Linux, Node 26.5.0 and official Playwright 1.63.0 browser assets as the
prior cloud records. Dependency locks, fixture data and environment settings
remain unchanged.

- `npm run check`: typecheck passed; **299 passed, zero failed, two skipped,
  301 total**. Only the existing macOS Chrome-host registration tests skipped.
- Eighteen new tests cover intermediate/terminal projection-write failures,
  receipt without checkpoint, checkpoint without completion, unknown effects
  after verified progress, read-only completion, changed bindings, staged orphan
  and legacy/unbound rows, admission-write rollback/retry, browser read/decision
  limits, equivalent states despite changed revisions, Stop during predicates,
  projection ahead of journal history, persisted Stop reconciliation and fresh
  permit observation references and multiple legacy records pausing together.
- The existing real headless four-step portal and controller-child workflows
  assert the durable admission, scoped output binding, checkpoint stages,
  decision count and expired facts. Existing delayed download/local-save Stop,
  restart, manual interference, native, managed and extension regressions pass.
- The focused portal/permit/journal/controller checks passed **50/50** before
  the final five tests were added. The final full suite includes those tests.
- `git diff --check`: passed. No test failure was encountered in this slice.

Reconciliation repairs a historical projection; it never resumes execution or
reuses an old browser/download receipt. Portal/journal writes remain separate
commits, with crash windows tested conservatively. This does not qualify a
general actor, user-facing recovery, release-authenticated workers, real Mac
permission/voice use or the owner's existing Chrome profile. No normal AppKit
launch, TCC/Keychain change, audio capture, live model call, paid resource or
user-goal resume occurred. Python/native checks were not rerun for this
TypeScript/documentation slice. See [recovery scope](PORTAL_RECOVERY.md).

## Native progress and checkpoint guards in the cloud, 30 September 2026

Branch `codex/task-checkpoint-recovery`, based on #60 at `387b61c`, implementation
`653c022`, [draft #61](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/61). Same Linux,
Node 26.5.0 and official Playwright 1.63.0 browser assets as the prior cloud
record. Manifests, lockfiles, fixtures and environment settings remain unchanged.

- `npm run check`: typecheck passed; **281 passed, zero failed, two skipped,
  283 total**. The skips remain the two macOS Chrome-host registration tests.
- Fifteen added tests cover observation fencing/cost, decision exhaustion,
  equivalent-state cycles, stage-refresh budget bypass, dispatch fact expiry,
  predicate-only reads, terminal verifier/evidence/current-fact binding, Stop,
  restart, unknown effects, transactional checkpoint failure, deadline expiry,
  admission-bound progress policy and native read/decision quota integration.
- Existing native LOCATE assertions now check checkpoint stages, spent reads
  and decisions, completion and expired facts. Stop between steps retains only
  historical progress. All included managed-browser, portal, extension and
  controller-child regressions executed with disposable loopback fixtures.
- `git diff --check`: passed. The first full run had one misplaced assertion
  expecting a verified folder checkpoint after Stop during its unverified first
  dispatch. Corrected it to expect no checkpoint and asserted historical folder
  progress in the Stop-between-verified-steps case. The final full run passed.

This is native fixture/controller source evidence. The portal's separate store
does not yet enable the new progress tracking or reconcile its transactions
with journal checkpoints. No native Mac build/live permission test, normal
AppKit launch, TCC/Keychain change, audio capture, owner-profile browser action,
model call, paid GPU or user-goal resume occurred. CLM hosting is documented
as a [preparation plan](CLM_DEPLOYMENT_PLAN.md), not a qualified deployment.
Earlier Python/signing counts below are prior evidence and were not rerun for
this TypeScript/documentation slice. See [progress scope](TASK_PROGRESS.md).

## Durable admitted task records in the cloud, 30 September 2026

Branch `codex/durable-task-contracts`, based on #59 at `f70f6e5`. Runtime:
Linux x86_64, Node 26.5.0, Python 3.14.6, Playwright 1.63.0 and its official
Chrome for Testing/Headless Shell 153.0.8010.12 (revision 1243). Locked
dependencies and fixtures were preserved.

- `npm run check`: typecheck passed; **266 passed, zero failed, two skipped,
  268 total**. The two existing Chrome-host registration tests require macOS
  signing and skip on Linux. All other included browser, controller, native
  synthetic-worker, journal and extension tests executed.
- The full suite includes 13 new journal checks covering restart persistence,
  copied/foreign/consumed admissions, transactional start failures, stored
  scope/policy, atomic completion evidence, cancelled late receipts, unknown
  effects, changed/missing contracts and legacy rows. Existing native field,
  multi-step LOCATE, managed field and Chrome fill tests also assert their
  persisted contracts and verifier-bound terminal evidence.
- `.venv/bin/python packages/protocol/validate_contract.py`: **115/115**.
- `.venv/bin/python -m unittest discover -s scripts -p
  'test_development_signing.py'`: **4/4**, synthetic certificate selection only.
- `git diff --check`: passed. The reusable install script was rerun successfully
  with frozen npm installation, pinned Python requirements and retained browser
  assets; installation changed no manifests, lockfiles or fixtures.

The cloud instance initially failed to start, then recovered. Its main-branch
snapshot lacked this newer branch and Playwright browsers. Native Git fetched
the #59 source without requesting a token. The first suite reached 255 tests
but browser cases failed because the executables were absent. Official browser
downloads initially received a proxy `Domain forbidden` response; adding
`cdn.playwright.dev`, `storage.googleapis.com` and
`playwright.download.prss.microsoft.com` to the saved network draft restored
the download. TLS verification stayed enabled. `api.github.com` was also added
for draft-PR access; existing injected GitHub authentication was reused.

Before the policy propagated, a temporary Playwright `executablePath` override
checked the image's Debian Chromium 151.0.7922.173: 252 passed, one extension
service-worker timeout, two Mac-only skips. This compatibility run was not
used as final validation. The override was removed and the final run used the
official pinned browser artifacts without it. The earliest new record tests
failed before the journal APIs were implemented; an intermediate typecheck
also caught an optional task-row access, which was corrected.

Saved cloud configuration now includes browser installation and activation in
`install_script`/`start_skill`, plus the required network destinations. A saved
draft is separate from environment publication. No new snapshot/publication or
future-task restore has been tested here.

No native AppKit build, Swift/macOS test, certificate creation, Keychain/TCC
change, microphone capture, model call, owner-profile browser action or user
goal resume occurred. Disposable headless/loopback fixtures remain synthetic
evidence. Live permission, multi-monitor, voice reliability and v1 release
gates remain open. See [task records](DURABLE_TASK_RECORD.md).

## Captured-target denial and panel deactivation, 30 September 2026

Owner screenshots show Target: Kimi (`com.moonshot.kimichat`), actual runtime
Accessibility denial, and an enabled SystemOne Dev Settings entry. This advances
the earlier no-target case: correct capture is now observed, but no field read
or edit was verified. The owner also reports the panel disappears when clicking
another app on another monitor. The owner has a regular Apple ID.

Read-only `pgrep -fl SystemOneDev` identified the running `ax-preflight` app;
`codesign -d -r- '.build/native-dev/SystemOne Dev.app'` showed a hash-based
designated requirement, and `security find-identity -v -p codesigning` returned
zero valid identities. A stale ad-hoc grant is a supported hypothesis, not a
verified reading of TCC state. Neither TCC data nor machine settings changed.

In the idle `task-lifecycle` worktree, branch `codex/panel-permission-recovery`:

- Expanded the built-window diagnostic to assert no hide on deactivation and
  level above ordinary windows. `npm run test:window-visibility` first failed:
  `hides=true, level=3, managed=true`. After `hidesOnDeactivate=false` and an
  explicit floating level it passed. The final built app's direct
  `--check-command-window-visibility` diagnostic also passed.
- `npm run test:accessibility-recovery` compiled the app and passed a synthetic
  denied→granted transition, exact bundle-path message and no-prompt check.
  It did not request real OS permissions, inspect Kimi or operate a live field.
- `npm run test:dev-signing`: 4/4 Python selection/pin tests passed. A missing
  configured certificate refuses signing rather than falling back.
- `npm run configure:dev-signing` failed as expected with no certificate and
  printed Xcode setup steps; it wrote no pin and changed no Keychain state.
- `npm run test:adhoc-identity` passed: two tiny temporary C binaries with the
  same signing identifier have different hash-based requirements. The second
  fails validation against the first's requirement. This is code-identity
  evidence, not a live TCC grant test. The initial invocation omitted codesign's
  inline-requirement `=` prefix and failed syntax validation; correcting the
  invocation did not alter the identity expectation.
- `npm run check`: TypeScript and 255/255 Node tests passed with isolated
  loopback/headless fixtures. The native build also passed. Initial Security
  compilation used an unavailable C constant; the SDK's Swift
  `SecCodeSignatureFlags.adhoc` spelling fixed it.

Node 26.5.0 and locked npm dependencies unchanged. The signing selector also
uses system Python 3.9.6; Python unit tests passed on both 3.14.6 and 3.9.6. The movable bundle's
final signing path was updated to honor the pin but was not rebuilt here.
No normal UI launch, certificate creation, audio recording, TCC request/reset,
or live computer-control action occurred. The owner's running build remains
untouched. Certificate signing, grant persistence across a rebuild and physical
multi-monitor/full-screen behavior await owner setup/testing.

Primary references: [AppKit panel deactivation](https://developer.apple.com/documentation/appkit/nswindow/hidesondeactivate),
[Apple signing requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements),
[Personal Team development](https://developer.apple.com/support/compare-memberships/),
[certificate setup](https://help.apple.com/xcode/mac/current/en.lproj/dev154b28f09.html).

## Durable task budgets and workflow progress, 29 September 2026

Branch `codex/durable-task-budgets`, based on draft #57. Five new journal
counterexamples failed before implementation: reopening/resetting an action
budget, expiry before dispatch, late verified completion, exhaustion with an
unknown earlier effect, and invalid limits/backwards clock. They passed after
the persistent guard was added. An initial implementation used a TypeScript
parameter property unsupported by Node's strip-only execution; it was replaced
with an ordinary declared field. No test expectation was weakened.

Commands run from the idle `ax-preflight` managed worktree:

- `node --test packages/runtime/test/attempt-journal.test.ts`: first run
  9 passed/5 failed as expected, then 14/14 passed. Final added cases cover
  remaining budget after an unknown effect and completion at the last step.
- `node --test --test-name-pattern='progress cannot|LOCATE contract|concurrent advancement' packages/browser/test/scripted-portal-task.test.ts`:
  3/3 synthetic progress/concurrency checks passed, no browser launched.
- `node --test --test-timeout=5000 packages/runtime/test/controller-task-budget.test.ts`:
  2/2 passed. Synthetic worker replies through the real controller/pipe adapter
  prove no commit before expired preparation and no completion after a late
  verified effect. The first run failed in test cleanup because controller
  closure already owns journal closure; the redundant test close was removed.
- `npm run check`: typecheck and full automated suite passed, 255/255.
  The authorized unsandboxed run used disposable loopback/headless fixtures;
  it did not launch the normal AppKit UI or operate user applications/accounts.
- `npm run build:native-dev`: passed; signed bundle metadata check passed.
  The new bundle was compiled in the idle worktree and not launched.

Runtime: Node 26.5.0; dependencies remain lockfile-pinned (Playwright 1.63.0,
TypeScript 7.0.2, Ajv 8.20.0, ajv-formats 3.0.1, jsonc-parser 3.3.1,
@types/node 26.6.3). No model weights, provider call, audio recording or TCC
request was used for this slice. A sandboxed process-list read failed because
sysmond was unavailable; the authorized read confirmed that the owner's
running app was the separate `task-lifecycle` build, which was left untouched.

Manual tests are parked. Existing live Accessibility, window-gesture and real
computer-use gates remain unverified. Deadline enforcement is at journal
transitions; a hung adapter is not asynchronously interrupted by this guard.
General no-progress detection, goal corrections, atomic checkpoint recovery,
explicit resume and CLM-driven navigation remain unfinished.

## Owner voice smoke and target-first Accessibility preflight, 29 September 2026

The owner reported that **Enable Voice** and held **Talk** stayed open and
produced the final editable transcript “Hello system one.” The supplied panel
screenshot shows **Final transcript ready** and **No target app captured**.
This is one physical voice-input success, not a field observation or action;
the permission-prompt sequence, repeated audio lifecycle, trackpad window
overview and live computer-use paths remain unverified.

The owner also showed an enabled **SystemOne Dev** Accessibility switch, but
the panel's Show fields action prompted for access. Inspection found that Show
fields checked TCC before checking for a captured target. In isolated
`codex/ax-preflight`, a built-app diagnostic substituted spy trust/prompt
callbacks with no target. It returned **FAIL** (exit 1) before the reorder and
**PASS** (exit 0) after; the passing check made neither trust query nor prompt.
`npm run test:field-preflight` passed, as did `npm run build:native-dev`,
`npm run check` (243/243) and the inherited window-behavior diagnostic.
No actual TCC prompt or native field read was initiated by these checks.
Whether the exact running build is trusted after a valid target capture awaits
the owner's next test; the Settings switch alone cannot settle that question.

## Command-window Mission Control behavior, 29 September 2026

The owner reported that the compact SystemOne window was reachable by
Command–Tab but disappeared from the trackpad window overview. On isolated
`codex/window-visibility`, `npm run build:native-dev` passed before and after
the change. The diagnostic-only built-app command
`'.build/native-dev/SystemOne Dev.app/Contents/MacOS/SystemOneDev' --check-command-window-visibility`
returned **FAIL** (exit 1) before the window declared `.managed` and **PASS**
(exit 0) after. It creates the actual command `NSPanel` without running the
controller, requesting TCC permissions or capturing audio. This checks the
AppKit property implicated by [Apple's Mission Control window-behavior
documentation](https://developer.apple.com/documentation/appkit/nswindow/collectionbehavior-swift.struct); it does
not simulate the owner's gesture. Physical Mission Control/App Exposé behavior,
including Spaces and Stage Manager, remains owner-unverified.
The repeatable `npm run test:window-visibility` wrapper passed after its build
invocation was corrected. `npm run check` passed 243/243; the synthetic
`npm run test:voice-permission-callback` and `npm run test:dev-task-intake`
passed. None of these records a live voice permission, transcript, or user
gesture result.

## Architecture follow-up, 29 September 2026

In isolated `codex/task-lifecycle`, `npm run typecheck` passed and the authorized
loopback-capable `npm run check` passed **243/243** tests. An initial sandboxed
run failed on `listen EPERM` at `127.0.0.1`; it was not a code failure. The new
cross-surface slot tests reject simultaneous admission, stale release, and
releasing a settled task before its Stop barrier returns.
`npm run build:native-dev` compiled, ad-hoc signed and verified the bundle;
the voice metadata gate passed. A temporary bundle with an empty Speech purpose
string was rejected by the same gate. No app was launched, no permissions were
requested, no audio was captured, and no live computer action was run here.
The owner-run Enable Voice/Talk check on the preceding branch remains open.

26 September 2026; macOS 26.6.2 arm64, Node 26.5.0, npm 11.17.0,
Python 3.14.6, Swift 6.4 (swiftlang-6.4.0.34.1), command-line-tools SDK MacOSX27.0.
These are development checks, not production qualification.

| Command | Actual result |
|---|---|
| `npm install --ignore-scripts --no-fund --cache /private/tmp/systemone-npm-cache` | Installed locked packages; installation audit reported zero vulnerabilities. |
| `npm run check` | TypeScript typecheck passes; 45 tests pass, zero fail/skip. Repeated after framing closure correction. |
| `review-work/.venv/bin/python packages/protocol/validate_contract.py` | 104/104 checks pass with jsonschema 4.26.0 and format extras. The existing isolated review environment supplied the dependencies pinned in requirements-test.txt. |
| `npm run fixtures` | Generated four shared digest fixtures. Three protocol golden hashes also match the Python oracle. |
| `swift test --package-path packages/protocol/swift --cache-path /private/tmp/systemone-swift-cache` | Initial sandbox attempt failed writing compiler cache. With temporary cache environment variables, nested compiler sandbox was denied. Authorized execution then reached compilation but failed because XCTest is unavailable in this SDK. XCTest tests remain unverified. |
| Standalone Swift command below | Compiled successfully; all four shared canonical/digest vectors and three invalid-value checks pass. Linker emitted warnings about absent command-line-tools Developer framework/library search paths. |

Exact successful Swift command (run with execution permission for the compiler sandbox):

```sh
CLANG_MODULE_CACHE_PATH=/private/tmp/systemone-clang-cache SWIFTPM_MODULECACHE_OVERRIDE=/private/tmp/systemone-clang-cache swift run --package-path packages/protocol/swift --cache-path /private/tmp/systemone-swift-cache DigestCheck tests/fixtures/digests.json
```

The initial Node test run exposed library object-prototype and module-interop
differences. The implementation was corrected and the original assertions retained.
No tests were disabled to get the reported pass.

Dependencies: ajv 8.20.0, ajv-formats 3.0.1, jsonc-parser 3.3.1,
TypeScript 7.0.2, @types/node 26.6.3. Exact transitive pins are in package-lock.json;
the independent Python environment is pinned in requirements-test.txt.

Not tested: full Swift protocol decoding, authenticated IPC, concurrent dispatch,
durable permits/journaling, Stop, crash recovery, any Accessibility/DOM workflow,
TCC attribution, signing/notarization, microphone/ASR, models, remote inference,
clean-Mac installation or release reproducibility. No live apps or accounts were
operated and no model weights or OS permission grants were requested.

The local Git repository is initialized on main. The owner subsequently selected
Daryl <darylseow@hotmail.com> as commit author, a private GitHub repository, and MIT
licensing. These repository administration changes do not alter the test results.

## Input/reply foundation, 26 September 2026

`npm run check`: TypeScript typecheck and **67/67 tests passed**, zero skipped.
This adds 22 tests for input routing and producer/correlation/deadline boundaries.
Cases include partial input, literal dictation, Unicode preservation, duplicate
utterance/message IDs, endpoint impersonation by a different object, wrong task
revisions, changed observation/projection digests, expired/replayed replies,
session closure, clock faults, memory budgets and validation crossing a deadline.

All producers and clocks in these tests are injected local fixtures. No process
authentication, real pipe lifecycle, durable execution ledger, dispatch or Stop
latency is qualified by these results. Existing Python/Swift files and schema were
unchanged in this slice; the earlier Python/Swift results above are prior evidence,
not newly executed platform tests.

## Task admission and approval authority, 27 September 2026

`npm run check`: TypeScript typecheck and **95/95 tests passed**, zero skipped.
The new cases cover final-command-only task admission, outcome and parameter-source
binding, exact endpoint identity, task/goal revision, actor and UI session, prompt
and presentation, scope, observation, candidate set, action, policy revision,
effect equality, one-use consumption, monotonic deadlines, wall-clock expiry,
mutable caller inputs, replay and closure.

`review-work/.venv/bin/python packages/protocol/validate_contract.py`:
**110/110 synthetic contract checks passed** with jsonschema 4.26.0 and format
extras. The added independent structural cases reject multi-use approvals, missing
prompt identity, non-elevated approval effects, and execution/permit records without
policy revisions.

These are in-process and schema fixtures. They do not prove OS peer credentials,
durable approval consumption, signed native UI provenance, permit minting, dispatch,
Stop barriers or recovery after a crash. No application, browser, account, audio,
model endpoint or macOS permission was exercised.

## macOS peer identity probe, 27 September 2026

Host: macOS 26.6.2 build 25G83 on arm64; Swift 6.4 with the command-line-tools
MacOSX27.0 SDK. `security find-identity -v -p codesigning` reported **0 valid
identities**, so Developer ID/Apple Development and Team ID qualification could not
run.

`scripts/check-peer-identity.sh` completed with exit status 0. It built the Swift
peer verifier, ad-hoc signed temporary copies, and exercised live Unix-domain
connections. The exact same signed binary was accepted. A differently identified
binary was rejected for signing-identifier mismatch. A modified binary signed with
the same identifier was rejected for CDHash mismatch.

The kernel audit token reported the actual spawned client PID and a nonzero PID
version. Security.framework resolved the signing identifier and validated the
dynamic code before returning its CDHash. The first sandboxed socket attempt was
denied by the execution sandbox; the documented check then ran with permission.

This proves the primitive on this host only. Production still requires the signed
app/helper topology, a configured Team ID or release requirement, supervisor
integration, installed/update/revocation tests and TCC attribution. No TCC prompt,
Accessibility API, browser automation, microphone, model or user account was used.

## Clarification, resume and local tester, 27 September 2026

`npm run check`: TypeScript typecheck and **108/108 tests passed**. New tests cover
host-registered clarification options, changed observations, checkpoint identity,
paused-state registration, actor/session and revision mismatch, expiry, closure and
replay. `review-work/.venv/bin/python packages/protocol/validate_contract.py`:
**115/115 checks passed**, including the two new positive examples and three new
negative structure checks.

`npm run test:mac-peer`: the local Apple Silicon test completed with exit status 0;
the expected peer was accepted and impostors failed for the exact intended reasons.
The command and expected output are in `docs/LOCAL_MAC_TEST.md`. This is a local
code-signing/socket test; it does not start a menu-bar app or request TCC grants.

## Native UI mock, 27 September 2026

`scripts/build-native-mock.sh` compiled an AppKit menu-bar bundle and ad-hoc signed
it on macOS 26.6.2 arm64. `codesign --verify --deep --strict` and `plutil -lint`
passed. `scripts/run-native-mock.sh` returned successfully after invoking `open`.
The first UI inspection attempt timed out; a later read-only check showed that
the initial background-only build was absent from the app inventory while its
process was alive. The revised regular-app build appeared as running and exposed
its command panel, text field, Preview, Stop and Hide controls through macOS
Accessibility. Button behaviour still needs a human check. This mock requests no
TCC permissions and cannot execute actions. It does not satisfy B04/B07 release
acceptance.

The tester command was rerun against the live corrected build; it reopened the
existing bundle without recompiling or modifying its running executable.

## Fixture-only native action build, 27 September 2026

Swift 6 compilation passed for the synthetic fixture and the bounded
Accessibility host. The resulting ad-hoc-signed bundles launched locally. A
read-only macOS Accessibility inspection showed the fixture window, labelled
`fixture.name` text field, and Reset button; it also showed Open Fixture,
Request Accessibility, Fill Fixture Name and Stop in the host panel. No TCC
permission was granted, no AX setter was invoked by the product, and the
effectful path remains **unverified** until the owner performs the opt-in test.
See `docs/FIXTURE_COMPUTER_USE_TEST.md`.

## Fixture action and attempt journal, 27 September 2026

On the local macOS 26.6.2 arm64 host, the user-granted Accessibility path was
exercised with a synthetic value. A direct fixture entry of `fixture-123` was
cleared by Reset. The separate SystemOne Mock then reported "Verified" after
Fill Fixture Name, and an independent Accessibility read of SystemOne Fixture
showed `fixture-123`. This verifies one local fixture-only action, not a general
native adapter, TCC update behavior, or production signing. The rebuilt fixture
now gives explicit Reset feedback; that new UI text has compiled but has not yet
been interactively retested in a restarted app.

`npm run build:native-mock` succeeded after the guide change. `npm run check`
passed TypeScript typechecking and **113/113** Node tests, zero skipped. The five
new file-backed SQLite tests cover crash before/after the dispatch boundary,
conservative unresolved recovery, Stop fencing at the journal, late receipt,
one writer slot, permit-reference replay and impossible outcome dimensions.
No browser, model, microphone, account or non-fixture app was controlled.
The journal is not yet connected to the native app or an authenticated host;
therefore its tests do not qualify a real Stop barrier, exactly-once delivery or
safe resume.

## Read-only native observation foundation, 27 September 2026

`npm run test:native-ax` passed on this arm64 Mac with Apple Swift 6.4 and the
installed macOS SDK. The script compiles the new Swift package sources directly
and runs synthetic registry checks for bounded coverage, duplicate labels,
secure-control metadata, stale observations, changed targets and foreign nodes.
`swift run --package-path packages/native-ax NativeAXCheck` was attempted but
failed in this sandbox because SwiftPM's nested sandbox could not apply. The
direct compile passed using a temporary build directory. No Accessibility
permission was requested and no live app was inspected by this check. Real AX
coverage, thread responsiveness, privacy filtering and target interference
remain untested.

`npm run check` typechecked and passed **136/136** Node tests on a rerun with
loopback fixture access. The first sandboxed attempt failed 13 portal/browser
tests at `listen EPERM 127.0.0.1`; those tests did not reach their assertions.
The permitted rerun had zero failures. No application source changed between
these runs.

## Fixture-scoped host dispatch gate, 27 September 2026

`npm run check` typechecked the project and passed **123/123** Node tests after
adding ten synthetic dispatch-gate cases. The cases cover legal one-use dispatch,
forged/cloned permits, invented or stale candidate selections, Stop during
effect-free preparation, in-flight Stop and late result, changed target state,
send failure, expiry before and during preparation, invalid success evidence and
forbidden effect admission.
The journal now stores candidate, observation, policy and lease bindings. No new
dependencies were installed. This was a synthetic test run only; the owner has
parked further interactive fixture testing. No native or browser UI was operated
for this slice, and no OS worker cancellation barrier is claimed.

## Loopback invoice portal fixture, 27 September 2026

The first sandboxed `npm run check` passed typechecking and 123 existing tests
but four new portal tests failed because the sandbox denied `listen` on
127.0.0.1 with `EPERM`. The same command, rerun with local loopback permission,
passed **127/127** Node tests. The portal tests cover separate search/detail
states, duplicate titles, exact synthetic downloads, a delayed-link script,
foreign Host rejection, write-method rejection, query escaping and HEAD behavior.
No browser was launched and no user account, external site or profile was touched.
The delayed control's actual browser behavior remains unverified.

## First managed Chromium workflow, 27 September 2026

Playwright **1.63.0** was installed from the local npm cache with
`npm install --save-exact playwright@1.63.0 --ignore-scripts --offline --no-fund`.
`npx playwright install --list` showed a pre-existing matching Chromium 1243 and
headless-shell 1243; no browser binary was downloaded. The first isolated browser
test exposed a mismatch between the portal's `data-page` values and the driver's
state names. The mapping was corrected without weakening tests. The focused
`node --test packages/browser/test/managed-portal.test.ts` run then passed 3/3
with local execution permission: exact search/open/download, stale/unknown IDs,
and rejection of non-fixture origins. The browser used an empty temporary profile
and the synthetic loopback portal; it never accessed existing Chrome, accounts
or external websites. The final full `npm run check` passed TypeScript typechecking
and **130/130** Node tests with local loopback/browser execution permission.

## Fixture portal outcome predicates, 27 September 2026

`npm run check` first typechecked successfully but reported 124/131 passing
because the sandbox denied all seven loopback fixture tests with `listen EPERM`
on 127.0.0.1. The same command, rerun with local loopback/browser permission,
passed TypeScript typechecking and **131/131** Node tests. The new browser test
checks exact duplicate identity, LOCATE versus OPEN versus DOWNLOAD, stale
navigation evidence, missing or fabricated session receipts, and file tampering.
The driver re-observes the current portal and re-reads saved bytes before
reporting a fixture goal matched. This does not prove a general task actor,
non-fixture browser control, Stop, or production completion.

## Native fixture reopen failure and launch guard, 27 September 2026

The user's 21:20 report matches `SystemOneFixture-2026-09-27-212008.ips`:
`EXC_BAD_ACCESS` in `FixtureApp.applicationShouldHandleReopen`, with the process
launched at 17:31 before the 17:36 bundle rebuild. A 17:31 report has the same
reopen stack. `ps` also showed a Mock process launched before that rebuild.
The previous `run:native-mock` used `open`, which reused the old process; it did
not guarantee a fresh binary. The exact-path process test passed, and a direct
`npm run build:native-mock` correctly refused to overwrite the two running
synthetic bundles. The first corrected `npm run run:native-mock` stopped both
processes but failed during signing because OneDrive had attached Finder/file-
provider extended attributes to the generated Mock bundle. After clearing only
the generated bundles' attributes before signing, the same command built and
opened the Mock successfully. Two `open` calls against the fresh Fixture left
one live Fixture process and no new crash report. This confirms the launch/
reopen path, not the owner's full manual Fill/Reset test or a release update path.
`npm run test:mac-launch` passed the exact-path stop and unrelated-process
preservation test. `zsh -n` passed for all changed scripts, `npm run check`
passed TypeScript typechecking and **131/131** Node tests, and a second
`npm run run:native-mock` stopped both fresh synthetic processes and left only
a newly launched Mock running. The owner has not yet repeated the in-Mock
Open Fixture/Fill/Reset sequence against this build.

## Accessibility identity and scripted portal task, 27 September 2026

The owner showed an enabled Accessibility toggle while the current Mock returned
false from `AXIsProcessTrustedWithOptions`. `codesign -dr -` showed the Mock's
ad-hoc designated requirement is a CDHash; the bundle had been rebuilt after
the earlier successful grant. `security find-identity -v -p codesigning`
reported **0 valid identities**. The targeted command `tccutil reset
Accessibility com.aurium.systemone.native-mock` succeeded, and
`npm run run:native-mock` relaunched the Mock. A new user grant and live fixture
Fill/Reset result are still unverified. The optional development signing
identity and clearer status text have not been qualified with a certificate.

`npm run check` passed typechecking and **136/136** Node tests. Five new tests
cover the fixture-only task's exact duplicate-invoice search/open/download/save
sequence in isolated Chromium, private output scope, restart with an in-flight
unknown action, manual navigation interference, and late success after Stop.
This is a model-free scripted
workflow. It does not prove a host permit, browser worker cancellation barrier,
native app automation, existing Chrome, or production completion.

`zsh -n` passed for the build/run scripts. After the final Mock status-text
rebuild, `npm run run:native-mock` built and ad-hoc signed both synthetic apps;
the targeted TCC reset succeeded again, and a second `npm run run:native-mock`
relaunched that same binary without rebuilding. A human still has to grant that
binary in macOS and test Fill/Reset. The new `SYSTEMONE_CODESIGN_IDENTITY` option
was not tested because the Mac has no valid code-signing identity.

## Owner-confirmed native fixture action, 27 September 2026

After the targeted TCC reset and fresh macOS grant, the owner showed the
current SystemOne Mock reporting "Verified: the synthetic Fixture Name field
was changed" and the separate SystemOne Fixture displaying `fixture-123`.
This verifies the current ad-hoc build's one supported AX setter after the
permission repair. The screenshot does not show Reset feedback, a non-fixture
app, crash recovery, or production signing; those remain unverified.

## Fixture managed-browser Stop fence, 27 September 2026

`node --test packages/browser/test/scripted-portal-task.test.ts` passed 6/6
tests, including a delayed download control: Stop persisted cancellation,
closed the isolated Chromium context, and the local portal received no download
request. The pending task did not become completed. `npm run check` passed
typechecking and **137/137** Node tests with local loopback access. This proves
that one fixture scenario was fenced; a click or download already dispatched
before Stop may still have had an effect and remains unresolved. The path is
not connected to the host permit/journal, native app, or existing Chrome.
An additional store test then confirmed that a cancelled task with an unresolved
in-flight action blocks admission of a second task, while cancellation before
any action permits a new task. The final `npm run check` passed typechecking
and **138/138** Node tests. Explicit recovery of a truly unknown effect is still
not implemented.

## Journal task completion and unknown-effect persistence, 27 September 2026

The focused Node journal and dispatch-gate tests cover host-verified multi-step
completion, a read-only LOCATE completion with no effect attempt, rejection of
unsettled or unknown attempts, a new task after
completion, unknown-effect exclusion after reopening SQLite, and migration of
the prior task-state schema while preserving a child event foreign key.
`completeTask` records a host assertion backed by an opaque evidence reference;
the journal cannot itself verify the real-world task predicate. The scripted
portal task, native mock and authenticated host are not connected to this
terminal state yet.
`npm run check` passed TypeScript typechecking and **142/142** Node tests with
local loopback fixture access. The native AX check was not rerun in this slice;
its source was unchanged.

## Scripted portal attempt-journal integration, 27 September 2026

The portal task now records one prepared attempt and dispatch-boundary event
before each scripted search, open, download and save operation. A completed
four-step fixture task has four matched journal outcomes and a completed journal
task state. A delayed browser Stop leaves both records cancelled and the action
unresolved; Stop during save verification prevents a subsequent file write. A
simulated host restart after a browser boundary pauses both records and blocks
new task admission. The focused browser suite passed 9/9 tests. These are
fixture-only in-process checks, not authenticated host permits or atomic
cross-table commits. `npm run check` passed typechecking and **144/144** Node
tests with local loopback access. The native AX check was not rerun; its source
was unchanged.

## Bound command to scripted portal admission, 27 September 2026

`npm run check` passed TypeScript typechecking and **147/147** Node tests with
local loopback fixture access. New tests reject cloned/foreign command objects,
cloned or replayed admissions, mismatched task/outcome/parameter contracts and
cloned scripted-start records. The portal fixture still uses in-process authority;
the tests do not establish authenticated OS peer identity, per-action host permits,
general browser control, existing Chrome or release readiness. The native AX and
Swift checks were not rerun because their sources were unchanged.

## Local-save Stop fence accounting, 27 September 2026

The focused scripted portal suite passed **10/10** tests and `npm run check`
passed typechecking and **147/147** Node tests with local loopback access.
In the held save-verification case, the synthetic browser reports a
successful close while the local save remains pending. Stop now reports
`browserFenced=true`, `localSaveFenced=false` and `workerFenced=false`; the
late continuation cannot report task completion or write the output file.
This accounts for the independent file path but does not prove a true OS worker
barrier or undo any already-dispatched file effect.

## Fixture portal action permits, 27 September 2026

`npm run check` passed TypeScript typechecking and **152/152** Node tests with
local loopback access. The new authority tests reject cloned, replayed, expired,
revoked, wrong-stage, wrong-effect and wrong-origin permits. A task test changes
the observation between planning and preflight; the task pauses without a
browser dispatch or journal attempt. Stop during a held preflight also prevents
a late browser action. The full four-action fixture workflow
still completes with matching journal outcomes. These are in-process guarantees;
they do not prove OS peer authentication, true Playwright dispatch timing,
existing-Chrome behavior or production Stop latency. Native/Swift checks were
not rerun because their sources were unchanged.

## Existing-Chrome extension attachment source, 27 September 2026

`node --check extensions/chrome/service-worker.mjs` passed syntax validation.
`npm run check` passed TypeScript typechecking and **157/157** Node tests, including
five new extension tests. Mocked Chrome events cover a toolbar-initiated grant,
native-port challenge acknowledgement, exact main-document read, unsupported
actions and navigation revocation. The manifest test confirms no broad host,
content-script, externally callable or debugger grant. No extension was loaded
into Chrome, native-messaging host was installed, existing profile was read or
real browser action was executed. Chrome API/runtime, enterprise policy and
incognito behavior still require browser-level qualification.

## Existing-Chrome native-host transport source, 27 September 2026

`npm run check` passed TypeScript typechecking and **160/160** Node tests,
including three native-host manifest-staging tests. The staging tests pin one
extension ID and controller identity, reject a wildcard or unanchored trust
input, refuse a symlinked executable and avoid leaving a new config behind when
the manifest path already exists. `zsh -n scripts/check-chrome-native-host.sh`
passed. `zsh scripts/check-chrome-native-host.sh` compiled the Swift host and
synthetic controller, ad-hoc signed temporary copies, and reported `PASS: Chrome
framing and controller peer checks; no browser was opened`. Its synthetic
cases exchanged a framed message and rejected a wrong extension origin, an
oversized Chrome frame and a wrong controller CDHash. The Swift production
configuration compiled with `swift build -c release --package-path
packages/chrome-native-host --cache-path /private/tmp/systemone-swift-cache
--product SystemOneChromeNativeHost` (with module caches under `/private/tmp`).
The installed command-line-tools SDK emitted missing framework/library search
path warnings but all builds completed.

This is local transport evidence only. No Chrome extension or native-host
manifest was installed; no real Chrome profile or account was accessed. The
SystemOne controller socket does not exist yet, and no Chrome-to-controller
task action, Stop barrier, release signing, notarization or clean-Mac install
was tested.

## General managed-Chromium observation source, 28 September 2026

`npm run check` passed TypeScript typechecking and **163/163** Node tests;
`node --test packages/browser/test/managed-observation.test.ts` also passed
in isolation. Three new synthetic
tests use only loopback pages and an isolated headless Chromium profile. They
verify semantic labels and observation-scoped IDs, duplicate-control context,
omission of input/password values, explicit unobserved frame/shadow coverage,
denial of a cross-origin request and a page-initiated POST, and rejection of
unapproved start URLs. The production default is headed, but headed operation
was not exercised. No external site, real account, existing Chrome profile or
computer-use action was controlled. This observer has no host action authority,
durable journal or completion verifier; page load itself may have site-defined
effects even though SystemOne sends no action.

## Managed-browser admitted FILL source, 28 September 2026

`npm run check` passed TypeScript typechecking and **168/168** Node tests.
Five new local-loopback tests exercise a real isolated Chromium field fill with
an admitted final command, exact source-byte digest, one-use permit, private
observation-scoped DOM handle and durable journal boundary. They reject a
cloned permit and stale observation, prove Stop before dispatch prevents the
send, preserve a late receipt only as history after Stop, and leave uncertain
post-boundary outcomes blocking new tasks. The successful check verifies the
current synthetic DOM field value; it does not prove a server save. Stop races
after dispatch used an injected driver, not a live browser race. No app UI,
external site, existing Chrome profile, OS-authenticated worker, headed
workflow, CLM or signed distribution was tested.

## Native panel to managed-browser development bridge, 28 September 2026

`npm run typecheck` passed. The first unprivileged run of
`node --test packages/runtime/test/native-managed-controller.test.ts` could not
bind the isolated fixture to `127.0.0.1` (`listen EPERM` in the sandbox); it
was rerun with local-loopback permission and passed. After final edits,
`npm run check` passed TypeScript checking and **169/169** Node tests, including
the process-level private-pipe test. That test rejects a mismatched final
command before any fixture GET, fills a field through a spawned controller and
headless isolated Chromium, keeps the verified page alive until Stop, then
repeats in the same controller process. `npm run build:native-dev` compiled
the AppKit panel, ad-hoc signed it and passed strict codesign verification on
this Mac. The first build run emitted a sandbox `ps` denial while checking for
a running app; the build script now fails closed if process inspection fails,
and the escalated rerun completed without that warning.
`npm run run:portal-fixture` started a synthetic loopback server, and
`npm run run:native-dev` opened the app. A process check found the AppKit app,
its Node controller child and the fixture server running. A human-visible
field fill has not yet been reported by the owner.

The manual headed panel/Chromium test in [native managed test](NATIVE_MANAGED_TEST.md)
still needs owner observation. The app uses absolute external Node/source paths;
the child is not OS-authenticated or packaged for distribution. No native-app
workflow, existing Chrome action, voice, CLM, arbitrary-site compatibility,
clean install or release signature is validated by these checks.

## Development native Accessibility inspection, 28 September 2026

In the isolated `codex/native-ax-worker` worktree,
`npm run test:native-ax` compiled the Swift package and passed its synthetic
registry checks. `npm run build:native-dev` compiled the AppKit panel with the
read-only observer and passed strict codesign verification using an ad-hoc
signature. `npm run check` passed TypeScript checking and **169/169** Node tests.
The first `npm ci --offline` attempt could not find `undici-types` in the local
cache; the pinned ordinary `npm ci --ignore-scripts` then installed 13 packages
and reported zero audit vulnerabilities.

The updated app was not launched because an earlier SystemOne Dev build and
synthetic portal were left running for the owner's managed-browser test. No
Accessibility permission was requested, no live native app was inspected, and
no native action was dispatched. The synthetic test checks registry identity,
truncation and stale-handle behavior, not TCC attribution, live AX timing,
real application compatibility or a worker Stop barrier.

## Restricted native field action source, 28 September 2026

`npm run test:native-ax` passed both the pre-existing synthetic observation
check and the new `NativeAXValueCheck`. The new check covers exact selected
duplicate node, one-use send, Stop before send, Stop during blocked preflight,
Stop acknowledgement during a blocked setter, stale descriptor, changed prior
value, failed journal-boundary callback, secure-field rejection and a setter
that changes the field before returning an error. The first Swift build found a
missing `try` on a throwing value read; it was corrected before the passing
check. These are synthetic backend behaviors, not live Accessibility action
evidence. The native driver is linked into the development app but has no
controller or UI action route. Journal integration, authenticated permits,
live AX timing and real-app verification remain untested.
After the final fence changes, `npm run check` passed **169/169** Node tests and
`npm run build:native-dev` again passed AppKit compilation and strict ad-hoc
codesign verification. The native action remains unexposed.
`swift build --package-path packages/native-ax --cache-path
/private/tmp/systemone-swift-cache` built the library and both check targets.
The command-line-tools linker emitted warnings about missing framework/library
search paths, but exited successfully. A matching value at preflight remains a
read-only match, not evidence of a dispatched action or durable completion.

## Journaled native host task contract, 28 September 2026

`node --test packages/runtime/test/native-fill-authority.test.ts` passed
**7/7** synthetic worker tests. They cover an exact admitted candidate and
one durable boundary, malformed command before observation, duplicate and
incomplete observations, independently verified existing value, Stop during
preflight, Stop after a boundary with a late verified receipt, lost setter
reply and unconfirmed worker fence. The first full `npm run check` found one
strict TypeScript optional-property test declaration error; it was fixed.
The final `npm run check` passed TypeScript checking and **176/176** tests.

No real AX worker was connected, no native effect was dispatched, and no
AppKit task route or OS peer authentication was exercised. A successful
synthetic worker receipt is not evidence of a real app change. Recovery after
a stopped boundary-crossed task remains blocked pending explicit fresh
observation and user intent.

## Development native controller bridge, 28 September 2026

`node --test packages/runtime/test/native-pipe-bridge.test.ts` passed its
process-level synthetic native task and late-Stop case. `npm run check` passed
TypeScript checking and **177/177** tests when run with local loopback access.
The first restricted run had **156 passes and 21 failures**, all because the
sandbox denied the synthetic portal's `127.0.0.1` listen socket (`EPERM`);
the exact suite then passed with that local access. `npm run build:native-dev`
compiled and ad-hoc signed the AppKit bundle after the build guard received
permission to inspect running processes. `zsh -n scripts/build-native-dev.sh
scripts/run-native-dev.sh` and `git diff --check` passed.

The new source route is panel -> one persistent Node controller -> journaled
native host task -> private AppKit AX worker -> field re-read. The process test
simulates the AppKit worker; no live Accessibility action was run through this
route. No release-signed helper, OS-authenticated peer, durable worker-side
permit, clean install, or update/TCC continuity was tested. See the
[optional live synthetic test](NATIVE_COMPUTER_USE_TEST.md).

## Existing-Chrome development read transport, 28 September 2026

`npm run check` passed TypeScript checking and **182/182** Node tests with
loopback fixture access. New tests cover exact Chrome hello/read binding,
changed profile/document, malformed snapshots, revocation, replay, timeout and
a spawned Node controller pipe. An extension/controller synthetic contract test
also exchanges one exact tab snapshot and revokes on navigation. `zsh -n` passed for the new staging/check
scripts and `git diff --check` passed. `npm run build:native-dev` compiled and
ad-hoc signed the AppKit listener with Security/bsm linkage.

`zsh scripts/build-chrome-dev-bridge.sh aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`
compiled and ad-hoc signed a development host and app, and staged an exact-
origin manifest using a **synthetic extension ID**. It did not install that
manifest, launch Chrome or alter a profile. `zsh scripts/check-chrome-dev-listener.sh`
passed a signed temporary host/listener framed exchange and rejected a wrong
pinned host CDHash. The current host
configuration is development-only and external to a signed release bundle.

No browser-to-host-to-controller run, Chrome action, trusted-input behavior,
file transfer, current-profile compatibility, signed release identity or
clean-Mac installation was tested. A signed host process can be invoked outside
Chrome, so this transport check alone is not proof of user-granted authority.

## Existing-Chrome guarded loopback fill source, 28 September 2026

`npm run check` passed TypeScript checking and **191/191** Node tests with local
loopback access. The new host tests cover a fresh complete field observation,
journal marker before action, one-use permit, ambiguous/incomplete rejection,
Stop during observation, and Stop after dispatch with a late receipt that
cannot complete the task. Lost replies remain unresolved in the journal.
An extension mock checks one action and replay rejection. A separate
`node --test extensions/chrome/test/semantic-controls.test.mjs` passed **1/1**
in headless Playwright Chromium, checking current field value and stale or
duplicate field refusal. `npm run build:native-dev` compiled and ad-hoc signed
the development panel with its Chrome field controls. `git diff --check` passed.

At this stage, no installed extension, native-host registration, real Chrome
profile or end-to-end isolated-world `executeScript` sequence was exercised. The DOM
test runs the functions in a synthetic page, not Chrome's extension isolated
world. Current-profile compatibility, trusted-input behavior, Stop during a
real injection, release signing and clean installation remain unverified.

## Temporary MV3 isolated-world check, 28 September 2026

`node --test extensions/chrome/test/isolated-world.test.mjs` passed **1/1**.
It launched Playwright's bundled Chromium with a disposable persistent profile
and a temporary MV3 extension importing the production semantic functions.
Against the loopback portal, separate document-targeted `chrome.scripting`
calls retained a field handle, filled and verified its DOM value, rejected a
new duplicate field, and rejected the old handle after reload. The temporary
profile and extension directory were removed after the test. The final
`npm run check` passed TypeScript checking and **192/192** tests.
The extension Stop mock also rejects a mismatched action target and reports
an in-flight post-Stop result as unknown.

This is stronger than page-world `evaluate`, but still omits the production
extension's native-messaging transport and any installed Chrome profile.
It does not establish trusted-input behavior, server persistence, Stop during
a real native-host action, or distributable signing.

## Bundled development runtime, 28 September 2026

`zsh scripts/build-bundled-dev.sh .build/release-deps/node-v26.5.0-darwin-arm64.tar.xz
/Users/daryl/Library/Caches/ms-playwright` built a roughly 715 MB ad-hoc app.
The official Node archive's SHA-256 matched the pinned `48231d6204eca6be13e6c5184dfdffa1d64ad88880364cc2cfb198f872cb2b13`
entry from Node's HTTPS `SHASUMS256.txt`. The extracted binary reported
`v26.5.0 arm64 darwin`; `otool -L` showed only system libraries. The current
Homebrew Node binary showed multiple `/opt/homebrew` library dependencies and
was therefore not copied into the bundle.

The first build with `npm ci --offline` failed because `jsonc-parser` was not
cached. The build script now uses lockfile integrity with scripts disabled and
allows npm to fetch missing production archives; that retry built successfully.
`node scripts/check-bundled-dev.mjs ABSOLUTE_APP_PATH` passed: the bundled
controller started and stopped, and bundled headless Chromium observed the
loopback invoice portal using the app's own Node, npm packages and browser
assets with a restricted `PATH`. The same check passed after moving the app to
another directory in the worktree, then it was returned to the documented
build path. The app's nested and outer ad-hoc signatures verified strictly.

No AppKit GUI launch from this bundle, clean-Mac install, Chrome native-host
registration, Developer ID signing, notarization, model assets, updates or
rollback was tested. The release gates remain open.

## Fixture-only CLM reference probe, 28 September 2026

The probe's request/answer shape was checked against CLM source commit
`bb42c6c5bf914fd449bed2f6ca65be80602cb1f7`: `src/clm/server.py`,
`src/clm/schema.py` and `src/clm/engine.py`. This was source inspection, not
model inference. `npm run typecheck && node --test packages/providers/test/*.test.ts`
passed 6/6 focused tests, including a loopback fake-service CLI run. That
test produced three structurally valid responses but only two expected choices;
the missing-target case chose an unrelated candidate and was correctly counted
as wrong. The initial full `npm run check` passed 197/197 tests before the CLI
integration test was added. The final full-suite result is recorded below.

`node scripts/probe-clm.ts --allow-owned-service --endpoint
http://127.0.0.1:1/v1/systemone --fixtures
packages/providers/fixtures/clm-probe-synthetic.json --output
/private/tmp/systemone-clm-unavailable-probe.json` exited 1 as expected. Its
owner-only report recorded 0/3 valid and three `unavailable` outcomes, with
model artifact identity and tokenizer truncation unverified. Port 1 had no
service; this proves failure reporting, not CLM behavior. No model weights were
downloaded and no inference endpoint was contacted successfully. B02/G1 remain
unverified pending an attested private deployment and representative benchmark.
Final `npm run check`: TypeScript passed and **198/198 tests passed**, zero
skipped or failed.

## Bounded development Stop acknowledgement, 28 September 2026

The controller now replies to native and existing-Chrome Stop after their
worker fences, before a held commit/action result arrives. Managed Chromium
Stop reports a closed-context fence within a three-second wait when a session
exists; a launch still in flight returns `uncertain` and latches recovery.
Synthetic process tests also assert that a new task is `busy` until a late
result or launch settles, then recovery remains blocked after a crossed
dispatch boundary. These checks do not authenticate worker identities or prove
Stop latency on production apps/extensions.

The first full `npm run check` after this change failed because the old native
pipe test submitted a third task immediately after early Stop acknowledgement
and expected recovery blocking. The active slot correctly returned `busy`.
The test now asserts `busy` before the late result and `blocked_recovery`
after it. The final `npm run check` passed **199/199 tests**, zero skipped or
failed. No real app, Chrome profile or account was operated in this run.

## Bundled controller running-code identity, 28 September 2026

`swift build --package-path packages/protocol/swift --target PeerIdentity`
compiled the new PID-based dynamic-code check. `swift run --package-path
packages/protocol/swift RunningProcessCheck
'.build/bundled-dev/SystemOne Dev.app/Contents/Frameworks/node'
com.aurium.systemone.bundlednode
46adcf0df2f075b27c228926b105cac6072fa3d6` passed: the launched signed
Node was accepted, while wrong signing identifier and CDHash requirements were
rejected. The current ad-hoc signature has no Team ID.

`zsh scripts/build-native-dev.sh` and `zsh scripts/build-bundled-dev.sh
.build/release-deps/node-v26.5.0-darwin-arm64.tar.xz
/Users/daryl/Library/Caches/ms-playwright` compiled and signed the development
app, pinned the nested Node CDHash in the outer signed metadata, and built the
movable bundle. The actual AppKit executable's
`--check-controller-identity` path passed without opening a panel. `node
scripts/check-bundled-dev.mjs ABSOLUTE_APP_PATH` passed the AppKit identity,
direct controller and isolated Chromium portal checks. An isolated copy with
the expected CDHash changed to all `f` values and re-signed ad hoc exited 1
with `Controller identity check failed to start.` The canonical bundle was
not modified by the negative test.

This authenticates a development child code identity only. It does not prove
the release host/worker channel, Team ID/Developer ID certificate chain,
durable permit consumption, TCC attribution after installation, real-app
effects, notarization or clean-Mac delivery.
Final `npm run check` passed **199/199 tests**. `npm run test:mac-peer`
accepted the expected signed peer and rejected wrong signing identifier and
CDHash; it controlled no app or browser. Swift linked with the same
command-line-tools missing search-path warnings as before.

## Native worker digest binding, 28 September 2026

The AppKit AX worker now retains the exact projected control list it sent to
the host and recomputes the candidate-set and action digests, including the
supplied value digest and `native-ax-policy-v1`, before preparation.
`npm run test:native-permit-digest` compiled the Swift worker-digest routine
and compared it with TypeScript protocol-2 digests. The authentic vector
matched; changed candidate-set digest, action digest, policy revision and
value were rejected. `zsh scripts/build-native-dev.sh` compiled the worker.
This was synthetic, with no Accessibility call or changed system permission.
Final `npm run check` passed **199/199 tests**, zero failed or skipped.
`zsh scripts/build-bundled-dev.sh` rebuilt the ad-hoc bundle and
`node scripts/check-bundled-dev.mjs ABSOLUTE_APP_PATH` passed its AppKit
controller-identity and isolated Chromium fixture checks. The smoke check
does not exercise a live AX setter or the new worker digest guard.

## Native worker replay ledger, 28 September 2026

`npm run test:native-worker-ledger` compiled a standalone Swift worker ledger
against macOS SQLite 3.51.0. Separate processes consumed an execution ID once,
then refused the same execution ID with either permit reference and a different
execution ID with the old permit reference. A new pair was accepted. Existing
world-readable, corrupt and symlink database paths failed closed. The created
support directory and database had modes 0700 and 0600 respectively. This
check did not call Accessibility; it does not simulate a power-loss durability
failure or authenticate a host permit. The worker verifies SQLite's DELETE
journal and FULL synchronous mode and requires successful statement finalization
before dispatch; the same isolated ledger check and app build passed after this
hardening.

`npm run build:native-dev` compiled and ad-hoc signed the AppKit worker with
SQLite linked. The sandboxed first attempt could not run its `/bin/ps` safety
check; an approved unsandboxed retry succeeded. The first `npm run check`
could not bind synthetic loopback ports in the sandbox. The approved retry
passed **199/199 tests**, zero skipped. No live native action was performed.

## Controller-signed native commit claim, 28 September 2026

`npm run test:native-host-permit` compiled the Swift Ed25519 verifier and
compared it against a Node-signed canonical protocol claim. The valid fixture
passed; a different public key/signature, changed preparation reference or
action digest, changed or independently signed wrong candidate, changed task
epoch, expired/future claim and extra permit field were
rejected. This test used fixed synthetic identities and made no AX call.

`npm run check` passed **199/199 tests** after the private-pipe process test was
updated to verify the key announcement and a signed commit. The first full run
had one failing process test because it treated the new key announcement as an
action request; no product action failed. `zsh scripts/build-bundled-dev.sh
.build/release-deps/node-v26.5.0-darwin-arm64.tar.xz
/Users/daryl/Library/Caches/ms-playwright` rebuilt the ad-hoc bundle and
`node scripts/check-bundled-dev.mjs ABSOLUTE_APP_PATH` passed its AppKit
running-code/key acceptance and isolated Chromium smoke. This is not a live
native setter, Developer ID/notarization, clean-Mac or existing-profile Chrome
test.

## Managed semantic navigation, 28 September 2026

`node --test packages/browser/test/managed-navigate-task.test.ts
packages/runtime/test/managed-navigate-controller.test.ts
packages/runtime/test/native-managed-controller.test.ts` passed **7/7** focused
tests. Against the loopback portal, one admitted observed link navigated to the
explicit expected URL and re-observed it. A wrong destination and stale
observation sent no navigation. Stop during preflight prevented send; Stop after
the journal boundary left a late result uncertain rather than completed. The
controller process test kept `NAVIGATE` distinct from opening an invoice detail.
An external link is visible for inspection but has no executable destination.

`npm run check` passed **204/204 tests**, zero skipped. `npm run build:native-dev`
compiled the revised panel. The ad-hoc bundled app rebuilt using the pinned
Node 26.5.0 and Chromium assets, and `node scripts/check-bundled-dev.mjs
ABSOLUTE_APP_PATH` passed its identity/key and isolated-browser smoke. The
bundled smoke starts the controller but does not run its new navigation action;
that action was tested through the source controller and managed Chromium.
No real site, account, existing Chrome profile, CLM model or live native AX
action was used.

## Existing-Chrome native-host registration, 28 September 2026

Chrome's [native messaging documentation](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
was checked for the absolute macOS host path, exact `allowed_origins` and
default per-user registration directory. The registration helper was exercised
only with a temporary synthetic Chrome directory. Two focused macOS tests passed:
an ad-hoc-signed disposable host installed, verified and removed exactly; a
different registration, changed origin, symlinked host and tampered signature
were rejected. No owner Chrome configuration or profile was changed.

`npm run check` passed **206/206 tests**, zero skipped, including those two
tests and the TypeScript typecheck. An installed extension-to-host exchange,
separate-profile qualification, current-profile qualification, Developer ID
signing, app-bundle placement, update/rollback and clean-Mac delivery remain
untested.

## Isolated Chromium native-messaging transport, 28 September 2026

`npm run test:chrome-browser-transport` passed on macOS 26.6.2 arm64 with
Playwright 1.63.0 Chromium. A temporary copy of the production MV3 extension
loaded in a temporary user-data directory and connected through native
messaging to the ad-hoc-signed Swift host. A signed test executable compiled
from the production `DevChromeListener` source authenticated the host; the host
authenticated the listener. It relayed a nonce frame and its reply from a
synthetic Node controller, then carried the production service worker's
`hello`/`observe` exchange and semantic `Find invoice` observation from the
loopback portal. A synthetic private field value was absent from the reported
snapshot. Reload revoked the document grant. Changed listener and host CDHashes each caused a
browser-visible disconnect without delivering another probe. The manifest was
registered only inside the temporary Chromium profile; the test removed that
directory and did not change the owner's Chrome setup.

This is real browser-to-host transport and production service-worker read-path
evidence. The copy has no persistent host permission. Its positive read now
uses Chromium's test-only action trigger to exercise temporary `activeTab`;
a physical toolbar click, fill workflow, complete AppKit app, Google Chrome and
current profile remain untested end to end.

## Existing-Chrome grant boundary, 28 September 2026

`npm run test:chrome-browser-transport` passed again with a new negative case.
Before invoking any browser action, the temporary copy of the production
extension invoked its handler on the synthetic portal tab. The
browser badge became `OFF`, no semantic observation reached the controller,
and the test observed no controller protocol error. The positive read instead
used Chromium's `Extensions.triggerAction` on the exact tab target, with no
persistent host grant. The production `onClicked` handler then completed the
semantic observation through the mutually authenticated Swift processes and
revoked it on reload. `npm run check` passed **206/206 tests**.

Chrome's [commands documentation](https://developer.chrome.com/docs/extensions/reference/api/commands)
supports `_execute_action` as an action invocation shortcut. A temporary
shortcut registered in the disposable Chromium profile, but Playwright
`Meta+Shift+Y` keys did not dispatch the action in headless or headed mode;
both bounded attempts timed out waiting for an observation. Those failed
automation attempts do not show whether a physical Chrome toolbar click or
keyboard shortcut works. The separate DevTools action-trigger check did pass
with `--enable-unsafe-extension-debugging` and Playwright's private debugging
pipe, both confined to disposable Chromium. This flag is test-only, not a
requirement for existing-profile support. Physical toolbar behavior and Google
Chrome's installed profile remain unverified.

## Isolated Chromium journaled field action, 28 September 2026

`npm run test:chrome-browser-transport` passed on macOS 26.6.2 arm64. The
production extension source, signed native host and signed listener source
exchanged a real action request through Chromium's native-messaging transport.
The host admitted a final synthetic text command, recorded a one-use permit
and durable dispatch boundary, then the extension filled the fixture's
`Find invoice` field. The controller recorded a matched receipt and completed
the task only after checking the current DOM value. A duplicate editable
label returned `unsupported` with no journal attempt or changed field; a replay
of the successful request returned `error`. No `/invoices` request occurred,
so the test establishes a field edit, not form submission or a completed search.

The test still uses the disposable Chromium profile, copied service worker with
test-only hooks, DevTools action trigger, ad-hoc signatures and loopback portal.
It does not qualify a physical toolbar click, full AppKit integration, Google
Chrome/current-profile installation, real-site trusted-input behavior or
release signing. `npm run check` passed **206/206 tests**, zero skipped, with
TypeScript typecheck; `git diff --check` passed.

## Isolated Chromium late receipt after Stop, 28 September 2026

`npm run test:chrome-browser-transport` passed on macOS 26.6.2 arm64 after
adding a second grant and a second actual fixture edit. The harness withheld
only the extension's matched receipt after the page field became `INV-105`.
Host Stop then returned a positive worker fence and revoked the grant. The
field remained edited; delivery of the held receipt returned `stopped`, left
the task cancelled with one unresolved journal attempt, and refused a new
request before dispatch. This distinguishes a future-action fence from undoing
an effect. The delay was injected in the synthetic Node controller's inbound
receipt path, so other crash and disconnection timings remain unverified.
`npm run check` passed **206/206 tests**, zero skipped, with TypeScript
typecheck; `git diff --check` passed.

## Production controller child over signed Chrome transport, 28 September 2026

`npm run test:chrome-browser-transport` passed on macOS 26.6.2 arm64 after
replacing the browser check's test-local `ChromeFillAuthority` with the real
`native-managed-controller.ts` child process. The signed Swift listener now
forwards connection, native-messaging frames and closure through the same
private line protocol used by the development AppKit panel. The child reports
its bounded semantic observation, rejects an ambiguous field and replay,
verifies a fixture DOM fill, acknowledges Stop after a second dispatched edit,
then blocks new work when a matched receipt arrives late. The journal is
reopened after child exit: the first task is completed with a matched outcome,
the second is cancelled with one unresolved attempt, and the rejected requests
have no attempts. Changed signed-peer hashes still disconnect.

The test uses a signed test executable compiled from the production listener
source, not the launched AppKit bundle. It also uses a disposable Chromium
profile and test-only action trigger. Physical toolbar use, installed Google
Chrome/current-profile behavior and release identity remain unverified.
`npm run check` passed **206/206 tests**, zero skipped, with TypeScript
typecheck; `git diff --check` passed.

## Shared candidate foundation, 28 September 2026

`npm run check` passed **210/210 tests**, zero skipped, including four new
candidate tests and TypeScript typecheck. The tests cover native secure,
disabled and unlabeled fields; exact same-origin managed links; ambiguous and
incomplete Chrome observations; candidate overflow; private target/parameter
refs excluded from provider views; disclosure review of candidate text; and
offline provider egress refusal. The current native, managed and Chrome action
paths use the builder as a legality check before existing admissions and
permits. `npm run test:chrome-browser-transport` passed again through the
production controller child and signed Swift peers in disposable Chromium.
`npm run build:native-dev` compiled and ad-hoc signed the development AppKit
bundle after its managed-fill disclosure text was updated; it was not launched.

The tests do not prove candidate recall for full multi-hop tasks, tokenizer
budget, model accuracy, live native action after this change, installed Google
Chrome or release policy. B13 and B14 remain open.

## Structured command value provenance, 28 September 2026

`npm run check` passed **212/212 tests**, zero skipped, including UTF-8
multibyte-span, changed-value and stale-revision admission checks. Structured
panel field fills (native, managed Chromium and existing-Chrome fixture) and
managed navigation now bind literal values to immutable final-command byte
ranges before driver dispatch. `npm run test:chrome-browser-transport` passed
through the production controller child, signed Swift listener/host and a
disposable Chromium profile. `npm run build:native-dev` compiled and ad-hoc
signed the changed AppKit command serialization but did not launch the app.
These checks do not prove general natural-language extraction, selected-value
provenance, a physical Chrome toolbar grant, current-profile compatibility or
Developer ID release identity. The value is now present in the private command
record; it must pass disclosure review before any provider egress.

## Portal workflow through the persistent controller, 28 September 2026

`npm run check` passed **215/215 tests**, zero skipped, with TypeScript
typecheck. A controller child launched disposable headless Chromium against
the loopback fixture, verified exact `INV-105` search/open/download, and saved
the expected bytes in its private fixture output directory. A malformed final
command made no fixture request. With the delayed download control, the test
waited for the journaled download dispatch boundary, sent Stop, observed no
saved file or completion, then restarted the child and saw
`blocked_recovery`. A symlinked or group/world-writable fixture output root is
rejected. `npm run build:native-dev` compiled and ad-hoc signed the
new panel button and restart status; the app was not launched for manual UI
verification. `npm run test:chrome-browser-transport` still passed through
the signed Swift host/listener and disposable Chromium after the controller
startup change. This is a fixed fixture workflow and does not establish CLM,
general sites, release authentication or notarized distribution.

During this slice, an initial full run failed because Node's TypeScript strip
mode rejected a parameter-property constructor; the constructor was rewritten.
A later run exposed a test timing error: the `portal_opened` status did not
prove the download dispatch boundary had been crossed. The test now waits for
that journal event before Stop. Both failures were corrected before the final
215/215 run; neither earlier run is counted as a pass.

## Development global shortcuts, 28 September 2026

`npm run build:native-dev` compiled and ad-hoc signed the AppKit panel with
exclusive Control–Option–Space (open) and Control–Option–Escape (Stop) Carbon
hotkeys, an explicit registration-failure message, and a previously focused app
display. `npm run check` passed **215/215 tests**, zero skipped, with TypeScript
typecheck. `git diff --check` passed. The app was not launched, so registration,
shortcut delivery, focus across spaces/displays and a live Stop request remain
**unverified**. The menu/Dock fallback is retained. The
[owner-run check](NATIVE_SHORTCUT_TEST.md) covers a synthetic focus target and
Stop entry point; it cannot alone qualify post-dispatch cancellation.

## Native semantic-press source and synthetic navigator, 28 September 2026

`npm run test:native-ax` compiled the registry, value-action and new press-action
sources and passed all three isolated Swift checks. The press check proves that
Stop before send, a failed durable-boundary callback, a changed node before or
during that callback, and replay send no `AXPress`. A synthetic press receipt
remains `returnedUnverified`; the test observes the resulting Documents-like
surface separately. A thrown reply after effect is unknown. `npm run
build:native-mock` compiled and ad-hoc signed the expanded Fixture and Mock;
`npm run build:native-dev` compiled and ad-hoc signed the panel with this press
source. `npm run check` passed **215/215** TypeScript/Node tests, zero skipped.

The updated Fixture and panel were **not launched**. No press operation is
connected to host admission, the signed worker permit, the task journal or the
controller yet. These checks do not establish a live Finder workflow, exact
LOCATE/OPEN verification, native Stop under a press hang, or release signing.
An initial Swift compile failed because this SDK does not expose `kAXLinkRole`;
the new driver was limited to buttons and menu items. A later test compile
failed because a synthetic test type was private at top level; its visibility
was corrected. Only the final passing runs count as validation.

## Fixture native press through the persistent controller, 28 September 2026

`npm run check` passed **222/222** TypeScript/Node tests, zero skipped, with
typecheck. Five focused native-press authority tests cover exact command and
candidate binding, duplicate/incomplete observations, no-effect verification,
failed post-press verification and late Stop after the journal boundary. A
controller **child-process** test used the production pipe handler and a fake
AppKit worker: it checked the signed commit claim, positive window-title
verification, journal completion, and a late press receipt after Stop that
could not complete the cancelled task. `npm run test:native-host-permit` passed
Swift/TypeScript positive and changed-policy checks, and `npm run
test:native-permit-digest` passed field and press digest parity with an altered
expected-title rejection. `npm run build:native-dev` and `npm run
build:native-mock` compiled and ad-hoc signed the changed app and Fixture.
`npm run test:native-ax` passed its synthetic registry, value-action and
semantic-press checks. `git diff --check` passed.

The apps were **not launched**; a real AXPress, current Accessibility grant,
window-title verification in AppKit, global shortcut behavior, and live Stop
remain unverified. The task only navigates to the synthetic Documents folder.
It does not locate/select/open Budget.xlsx, control Finder, or qualify a
Developer ID release. One attempted command used the nonexistent npm script
`test:native-worker-digest`; the documented script is
`test:native-permit-digest`, which was then run and passed. The mistaken command
is not counted as a test failure or pass.

## Fixed synthetic native LOCATE task, 28 September 2026

`npm run check` passed **230/230** TypeScript/Node tests, zero skipped, with
typecheck. Seven focused LOCATE tests cover one task with two verified presses,
skipping an already visible folder or selected file, a duplicate exact file
label, changed folder between steps, an already opened file, Stop during the
first dispatch, Stop between verified steps, and an unknown second effect.
The controller child-process test confirms two separately signed commits and
two journaled attempts under one task ID, with no Open control sent.
`npm run test:native-ax` and `npm run test:native-host-permit` passed.
`npm run test:native-permit-digest` passed TypeScript/Swift parity for the
field, folder and file actions and rejects a substituted Open control.
`npm run build:native-dev` compiled and ad-hoc signed the updated panel and
AppKit worker. `git diff --check` passed.

The first digest run in the restricted shell failed while Swift wrote to its
user module cache; it also printed an SDK/compiler mismatch during that
failure. A privileged rerun passed. The test script now uses an isolated
temporary module cache, and a fresh restricted-shell rerun passed. The apps
were **not launched**. Real Accessibility behavior, the title precondition
on an actual Fixture window, Stop during a live AX call and release signing
remain unverified. The Fixture title is a synthetic outcome oracle, not
evidence of a real file path or Finder compatibility.

## Distinct synthetic native OPEN outcome, 28 September 2026

`npm run check` passed **237/237** TypeScript/Node tests, zero skipped, with
typecheck. The OPEN tests cover a three-press task from Reset, a one-press
task from the selected state, no-effect verification when already opened,
the LOCATE command being unable to authorize Open, duplicate Open controls,
interference after selection, Stop between selection and Open, unknown Open
delivery and a late Open receipt after Stop. The controller child-process
test confirms separately signed Documents, selection and Open commits and
three journaled attempts under one OPEN task ID. `npm run test:native-ax`
and `npm run test:native-host-permit` passed. The expanded
`npm run test:native-permit-digest` passed TypeScript/Swift parity for all
three press outcomes and rejects swapping selected/opened title bindings.
`npm run build:native-dev` compiled and ad-hoc signed the panel and worker.
`git diff --check` passed.

One restricted-shell `npm run check` attempt failed because the sandbox
denied loopback listeners used by unrelated browser fixtures (`listen EPERM`
on `127.0.0.1`). The unchanged suite passed with the established test
permissions. No AppKit action was launched or OS permission requested. The
Fixture changes only its own title/status; it does not open a real document.
Actual Accessibility behavior, live Stop timing, Finder path identity,
Developer ID signing and notarization remain unverified. Static packaging
review found that the current ad-hoc app/Chrome-host CDHash pins cannot be
embedded together without a signing cycle; see
[bundled runtime](BUNDLED_DEV_RUNTIME.md).

## Scoped native AX coverage and development inspector, 28 September 2026

`npm run test:native-ax` passed the synthetic registry, value and press checks.
The registry checks cover explicit truncation/depth/foreign/secure gaps,
sanitized secure labels and capabilities, exact-node subtree drill-down,
stale prior handles and rejection of secure drill-down. A value-action fixture
now expects incomplete coverage when its secure field is intentionally omitted.
`npm run build:native-dev` compiled and ad-hoc signed the development app;
`npm run check` typechecked and passed **237/237** TypeScript/Node tests.

An initial Swift compile failed because a new public gap type lacked a public
initializer; that was fixed. A subsequent test compile failed because the
assertion helper takes a non-throwing closure; the throwing resolve was moved
outside it. The next run exposed the prior value fixture's now-invalid
whole-tree completeness expectation; it was changed to assert the precise
secure-content gap. Only the final passing runs count.

No app was launched, no Accessibility grant was requested and no real app was
observed or controlled in this slice. The inspector is development-only,
read-only and does not enter the controller's candidate/permit path. AX API
timeouts, real-app tree coverage, secure-control behavior across apps and
Stop responsiveness under a blocked call still require a manual Mac check.

## Local test-session launcher, 28 September 2026

`zsh -n` passed for the changed launch/build scripts.
`npm run build:native-dev` compiled and ad-hoc signed this worktree's app.
`npm run check` typechecked and passed **237/237** tests. The isolated
`npm run test:chrome-browser-transport` passed its signed-host/temporary
Chromium fixture, including the journaled fill and late-Stop accounting.
`git diff --check` passed.

`npm run try:local` was attempted three times. The first version opened a Fixture
path before discovering an older SystemOne Dev process from the OneDrive
checkout; it then refused a second Dev launch. The launcher was reordered and
now checks for a Fixture from another checkout before opening either app. Its
second and third runs correctly refused the older OneDrive Fixture. The portal did not
start and no native action was dispatched in either attempt. A successful
end-to-end UI run is still pending until those older apps are quit; existing
Chrome/current-profile behavior, microphone, CLM and release distribution
remain unverified.

The user's next `try:local` report showed the remaining OneDrive Fixture
process (PID 14189). An exact executable-path check confirmed that process
and a separate Fixture from this worktree. The old process was terminated by
the synthetic-app process helper, without signaling unrelated apps. The
launcher then opened Dev and started the loopback portal; a GET of
`http://127.0.0.1:65525/` returned the expected invoice page. LaunchServices
returned success for the Fixture but did not leave this worktree's process
running. Explicit `open -n` started it. Both current-worktree test apps were
then observed by exact executable path. The launcher now uses `open -n` when
its exact app process is absent and polls for that process after opening; it
fails instead of claiming readiness when no process appears. Shell syntax and
diff checks passed. Native field fill and managed-browser UI actions are still
awaiting the owner's manual check.

After the launcher change, `npm run try:local` completed startup without the
older-checkout error and printed `http://127.0.0.1:49266/`. Exact-path `ps`
checks found this worktree's Dev (PID 14168) and Fixture (PID 14455), and a
loopback GET returned the portal title and `Find invoice` control. The portal
session was left running for the owner's interactive test. These checks do not
establish that either UI action completed.

## Voice/text command panel and real-target routes, 28 September 2026

`npm run check` typechecked and passed **241/241** tests. This includes a
child-process run of the persistent controller with a voice-sourced managed
field command, plus native authority tests that verify a voice-sourced command
uses the existing journaled permit and rejects a changed field name. The
Swift-side `npm run test:task-command` passed its native/managed grammar and
unsafe-origin cases. `npm run build:native-dev` compiled and ad-hoc signed the
compact panel with the on-device Speech and microphone frameworks. `git diff
--check` passed. `npm run run:native-dev` reported launch, and an exact-path
process check found the current app running (PID 21189 before the final status
copy change). None of these commands requested microphone or Speech permission,
recorded audio, dispatched a real-app action, or attached to existing Chrome.

After the captured-process guard, `npm run check` still passed **241/241** and
`npm run build:native-dev` compiled. The final app ran at the exact current
worktree path (PID 23919). Read-only accessibility inspection bound by that
path found the compact **SystemOne** window with its task field, Enable Voice,
Hold Talk, Show fields, Run request and Stop. A prior name-based inspection had
opened a stale bundled-dev copy; that exact older test process was stopped.
The native request now carries captured PID and launch time through the
controller pipe, and a synthetic child-process test checked both fields. The
worker rejects a different running app instance before AX observation. This
does not prove the live microphone or a real-app edit works.

The manual gates are a final on-device transcript, held-button microphone
shutdown, captured-app and editable-label accuracy, one verified edit in a
real native app, one headed managed-browser edit on an approved public page,
and Stop during those paths. This development build does not qualify CLM,
multi-hop open/download commands, existing-profile Chrome, Developer ID
distribution or clean-Mac permissions.

After adding a Show-fields-triggered Accessibility prompt, the Swift app
recompiled, was ad-hoc signed and relaunched from the exact native-dev path
(PID 25001). No permission prompt was invoked during this build or launch.

## Enable Voice crash diagnosis and bounded regression, 28 September 2026

The owner reported a crash after clicking Enable Voice. Local incidents
`D473FC9D-FD30-46CF-92E5-56D002CDD37B` and
`B0D1F920-5C81-4681-88D7-C2357E3D8C18` both show `SIGTRAP` in
`_dispatch_assert_queue_fail` / `_swift_task_checkIsolatedSwift` at
`OnDeviceSpeech.requestPermissions()`'s Speech authorization reply on a
background queue. The built app contains the Speech usage-description key.

After marking external callbacks `@Sendable` and adding an injectable Speech
permission requester, `npm run test:voice-permission-callback` passed: a
synthetic denial delivered from a background queue reached the main-actor
status handler. `npm run build:native-dev` compiled and ad-hoc signed the new
app. `npm run check` passed 241/241 tests. The first sandboxed smoke build
failed writing the global Clang cache; the test script now uses a private
temporary cache. The first sandboxed full suite hit loopback `EPERM`; the
permitted local run passed. No OS permission request, audio capture, or live
Enable Voice click was run by the agent. The manual gate remains open; see
[handoff](VOICE_CRASH_HANDOFF.md).

## Task intake and adjacent voice callback, 29 September 2026

`npm run test:dev-task-intake` passed its synthetic one-writer, failed-send,
stale-status, voice/text provenance, captured PID/launch identity,
LOCATE-versus-OPEN and Chrome grant checks. `npm run
test:voice-permission-callback` passed with denied Speech plus denied and
authorized microphone results injected from background queues. Neither check
requested macOS permission or audio input. `npm run build:native-dev` compiled
and ad-hoc signed the refactored app, including a nonisolated audio-tap block.
The audio tap was not exercised. The first compile needed a Swift `return`
correction in the new request switch; the second build passed. `npm run check`
passed 241/241 TypeScript/Node tests. No live Enable Voice click, final
transcript, real-app edit, headed browser edit or existing-Chrome-profile
action was run in this session. No SystemOne Dev crash report newer than the
two 28 September permission incidents was present when checked. These results
do not certify the app against further live crashes.

After the final build, `npm run run:native-dev` launched the exact worktree
bundle and an exact executable-path process check found PID 47288 still running.
The two 28 September incidents remained the newest SystemOne Dev crash reports
at that check. This is a startup-only observation; Enable Voice, Talk and task
execution were not invoked.
# Reference tensor adapter and laptop experiment, 2 October 2026

Started from `codex/clm-serving-boundary` at
`4d9891156988dfe2f02c671eebb3bb8fd25f7d76`, in the existing isolated Linux
checkout. The previous owner goal remains dropped. The owner selected the
laptop GPU first; no Mac connection or GPU is available in this session.

- Node 26.5.0 and Python 3.14.6 retained; locked npm installation and official
  Playwright 1.63.0 Chromium/headless-shell revision 1243 restored. The complete
  reusable install script executed successfully without changing existing
  dependency declarations, lockfile, fixtures or test assertions.
- `make test`: typecheck passed; **442 passed, zero failed, two Mac-only skips
  (444 total)**; Python oracle **115/115** passed. The initial baseline before
  network/browser restoration had 25 browser-dependent failures; after actual
  pinned downloads and cache activation those failures are resolved.
- Ten CPU Python adapter tests passed, including a real tiny Qwen3 model,
  fast-tokenizer fixture, head architecture/finite-value checks, weights-only
  rejection, token overflow before encoder invocation and download integrity.
  Nine Node process/CLI tests and one native-runtime declaration regression
  are included in the full suite. No assertions or tests were disabled.
- Release inventory consistency and **seven** checks passed. The source
  inventory now includes the Metal runtime's exact pins/distribution hashes
  and detects declaration/lock drift. Wheel/native notices and release SBOM
  remain pending. `git diff --check` passed.
- GitHub API, actual Playwright downloads, Hugging Face metadata/artifacts and
  Docker registry/auth requests succeeded after additive settings changes.
  Package managers preset was preserved. Artifact redirects required the
  additional `us.aws.cdn.hf.co` host. Runtime policy observation remains unknown;
  these access claims are based on actual requests. No cloud identity is bound.
- Qwen3-8B/tokenizer revision resolved to
  `b968826d9c46dd6066d109eabc6255188de91218`. All **17 declared artifact files**,
  **16,473,033,415 bytes**, independently passed streaming size/SHA-256
  verification in `/workspace/.artifacts/clm`. The head matches published
  `b2b4a8c9c2d39263eff78a351eb909a342ce9b3bf21a3f07c1d1bf15f1c4eda5`.
  Both exact model repositories supply Apache-2.0 license text/card declarations;
  release-wide redistribution clearance is not established.
- `check_components.py`: thirteen exact downloaded-tokenizer fast/slow cases
  passed, including 2048/2049 token counts. The actual published head safely
  loaded and passed twelve CPU ranking comparisons to pinned upstream, maximum
  probability difference **2.22045e-16**. The first comparison diagnosed Torch
  versus NumPy normalization rounding; using the reference NumPy float32
  reduction fixed it without relaxing tolerance.

No full encoder inference, deployed endpoint, MPS/CUDA run, Swift/AppKit compile,
live voice/native/browser/owner-profile action, signing/TCC/Keychain change or
billable provisioning occurred. The laptop commands and 70% MPS memory allowance
are prepared settings, not measured hardware capability. Full encoder/vLLM parity,
calibration, live Mac and release/acceptance gates remain open. V1 is not ready.
