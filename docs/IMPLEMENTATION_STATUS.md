# Implementation status

## Native field replacement admission, 2 October 2026

`codex/native-field-replacement`, stacked on host interruption #74 at
`b215bf7e5cd330e8bf2f14342536ec751c043b71`.
[Field correction](NATIVE_FIELD_REPLACEMENT.md) accepts an explicit changed field
or value only for the retained settled paused actor and its original target
binding. The old worker Stop must settle before fresh child observation/admission.
Unknown edits block correction, accepted parameters are frozen before awaiting
Stop, and the child retains durable provenance with fresh scope, limits, permits
and independent completion. Source/child Stop ownership survives transition;
only the immediate parent can alias its retained child. The developer panel
preserves the original target and offers an explicit replacement sheet.

Typecheck, **466 passed, zero failed, two Mac-only skips (468 total)**, Python
oracle **115/115**, inventory consistency and **7/7** checks pass. Fourteen added
Linux regressions cover changed and invalid goals, target/process binding,
lineage/revisions, Stop and late effects, unknown edits, interruption, voice
metadata/empty values, restart refusal, child Resume and accepted-request mutation.
Extended Foundation intake checks and Swift/AppKit remain uncompiled here. Actual Mac
execution, general/active correction, recovery across sessions, primary CLM
integration and release gates remain open. V1 is not ready; the old goal stays dropped.

## Host lifecycle interruption, 2 October 2026

`codex/host-lifecycle-interruption`, stacked on reference adapter #73.
[Host snapshots](HOST_LIFECYCLE_INTERRUPTION.md) synchronously hold admission,
cancel active or retained paused actors through existing Stop barriers, preserve
checkpoint/effect history and revoke Chrome host grants. Delayed worker replies
retain ownership; wake never reconstructs a task or Resume authority. Shutdown
settles pending lifecycle cleanup before closing durable stores. AppKit now
publishes documented workspace notifications and waits for their acknowledgment.

Typecheck; **452 passed, zero failed, two Mac-only skips (454 total)**; Python
oracle 115/115; inventory consistency and seven checks. Ten added regressions
cover host snapshots, native cancellation/recovery, cleanup and Chrome grants;
the existing real Chromium pipe test also exercises interruption and fresh intake.
Swift/AppKit remains uncompiled. Actual sleep/lock and session behavior, same-task
recovery across sessions, general execution/correction and release gates stay open.

## Offline reference adapter and laptop experiment, 2 October 2026

[Draft #73](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/73) implements
the offline tokenizer/Qwen3/head backend and bounded worker behind #72's serving
boundary. Immutable model revisions, all 17 files (16,473,033,415 bytes), license
texts and 27 hash-locked macOS runtime wheels are verified. Actual tokenizer and
head CPU component parity passed. The owner selected the laptop GPU first; the
[Metal experiment](CLM_LOCAL_GPU_EXPERIMENT.md) is prepared. No full encoder/GPU
run, Mac connection, deployed endpoint or live qualification exists here.

At #73: typecheck, 442 passed/two Mac-only skips, Python oracle 115/115, ten CPU
adapter checks and seven inventory checks. Network additions were saved in the
new environment preserving Package managers; actual GitHub, Playwright, Hugging
Face/artifact CDN and Docker auth/registry requests succeeded. Earlier blocked
access/configuration records below are historical. The previous goal stays dropped.

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
[Replacement admission](NATIVE_TASK_REPLACEMENT.md) now transfers one exact final
correction from a retained paused fixture actor into a fresh child task only
after cancellation and a settled successful worker fence. Source correction
message/digest/next revision and unique durable parent/child lineage are checked
inside the child admission transaction. Old history stays intact; new goals get
fresh scope/limits/evidence. Unchanged goals, foreign/stale commands, failed
fences, unknown effects and other unfinished tasks cannot admit replacements.
The controller keeps exclusive ownership and Stop targeting through the
transition; developer-panel intake adopts only its exact linked child/revision.

Linux typecheck and **407 passed, zero failed, two Mac-only skips (409 total)**;
19 added regressions and six release inventory checks pass. The extended Swift
intake checks and AppKit choice sheet are uncompiled in Linux. General/active
correction, native field-fill/browser actor integration, restart reconstruction
and all model/Mac/Chrome/release qualification remain open. Next: persistent
native field-fill actor and semantic completion contracts. The previous owner
goal remains dropped from the work plan.


## Native fixture recovery controller and panel, 1 October 2026

`codex/native-controller-recovery`, based on #68 at `d0482bc`.
Implementation `582b959`, [draft PR #69](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/69),
targeting `codex/native-controller-actor` (#68).
The [recovery integration](NATIVE_CONTROLLER_RECOVERY.md) adds explicit
Check recovery / Resume for the retained same-process fixture actor. The host
rechecks scoped checkpoint state, and accepts a session/presentation/checkpoint/
revision-bound one-use reply only after the parent confirms its sheet is visible.
Dismissal, superseding reads and Stop revoke old prompts. Resume keeps original
admission, deadlines, quotas and checkpoint history; no completed step is replayed.
Fixture worker scope now stays bound to the exact app PID, bundle URL and launch
identity across fresh observations; a replacement process fails closed.

Linux typecheck and **388 passed, zero failed, two Mac-only skips (390 total)**;
11 added authority/controller recovery tests. Source inventory consistency and
six release checks pass. Swift/AppKit compilation, actual sheet behavior and live
AX process-scope checks remain unrun. Restart recovery, replacement admission,
general execution and model/Mac/Chrome/release qualification remain open.
The owner dropped the previous goal; it is removed from the working plan.


## Native fixture controller actor, 1 October 2026

`codex/native-controller-actor`, based on #67 at `076c241`.
Implementation `54c3f0d`, [draft PR #68](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/68),
targeting `codex/release-dependency-inventory` (#67).
The [native controller integration](NATIVE_CONTROLLER_ACTOR.md) replaces the
controller's fixed fixture NAVIGATE/LOCATE/OPEN execution loop with its persistent
actor. Exact final-command admission, distinct title predicates, separately
signed worker dispatch and durable effect/checkpoint history remain enforced.
Pauses retain the native actor; exact Stop reaches it after its run settles.
Unfinished durable tasks block all controller intake after restart, even without
unknown effects. Native transport settlement precedes journal shutdown.

Linux typecheck and **377 passed, zero failed, two Mac-only skips (379 total)**;
14 added tests. The release inventory and its six checks still pass. The AppKit
status text changed but no Mac build or physical action was possible in Linux.
Controller/UI Resume, replacement admission, general actions and all real model,
Mac/current-profile/release gates remain open. The owner goal remains stopped.

## Pending release dependency inventory, 1 October 2026

`codex/release-dependency-inventory`, stacked on #66 at `3b6c6a8`.
Implementation `1673db7` is pushed; [draft PR #67](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/67)
targets `codex/clm-artifact-preflight` (#66). Applied network settings resolved
the initial GitHub API/download 403. The full suite now passes 363 tests with
zero failures and two Mac-only skips; six inventory checks also pass.
The [source inventory](RELEASE_DEPENDENCY_INVENTORY.md) reconstructs the pending
release record with 32 npm packages (nine runtime), 19 Python test pins and
non-npm Node/browser/platform/Chrome/model declarations. Repeatable generation
records source hashes; consistency checks reject stale output, missing npm
integrity/licenses and manifest, Node or browser metadata drift. Six focused
checks pass. Full-text notices, actual release artifact SBOM and qualification
remain open; B01/B27 and G1–G6 are not complete. See current validation evidence
for the resolved environment failures and actual publication evidence.
The owner goal remains stopped.

## Offline CLM artifact and serving preflight, 1 October 2026

`codex/clm-artifact-preflight`, based on #65 at `3da29cb`, implementation
`c984914`, [draft #66](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/66). The
[preflight](CLM_ARTIFACT_PREFLIGHT.md) validates immutable declarations and safe
baseline serving settings, then streams exact local SHA-256/byte checks without
checkpoint deserialization or network access. Missing/changed files, traversal,
symlinks, moving revisions, silent truncation and unsafe loading declarations fail.

The committed manifest is deliberately incomplete. No model pins were invented,
weights downloaded, inference qualified or paid deployment authorized. Container/
server declarations and an HTTP header do not establish running artifact identity.
Actual encoder/tokenizer/artifact access, server implementation, startup checks,
costed provider plan and live evaluation remain open before B02/B14 can pass.
Linux typecheck and **363 passed, zero failed, two Mac-only skips (365 total)**;
eight added tests. No owner goal or Mac checkout changed.

## CLM proposals and bounded owned transport, 1 October 2026

`codex/clm-decision-boundary`, based on #64 at `e64f59b`, implementation
`40eb6cb`, [draft #65](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/65).
The client validates
approved semantic choices before I/O and returns observation/digest/provider/
calibration-bound proposals. Host thresholds, ties, malformed output, cancellation
and transport errors prevent effect selection. Owned transport requires remote
HTTPS/authentication, rejects redirects and bounds/strictly parses replies.
The probe shares its wire codec and transport. See [boundary](CLM_DECISION_BOUNDARY.md).

An opt-in native fixture selector exercises synthetic proposals through existing
admission, worker preparation, journal dispatch and independent verification.
No live CLM or owner-app model configuration exists. Linux typecheck and
**355 passed, zero failed, two Mac-only skips (357 total)**, including 14 new
tests. B02/B14 remain open. Hugging Face metadata access returned 403; immutable
encoder/tokenizer pins and verified weights remain pending. No paid resource,
owner-goal resume or Mac checkout change occurred.

## Persistent scripted actors and continuation, 1 October 2026

`codex/persistent-scripted-actor`, based on #63 at `d18e6b3`, implementation
`cdc641c`, [draft #64](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/64)
stacked on `codex/explicit-task-recovery`. The actor derives status from durable
history, bounds operations and decisions, preserves pending ownership after
timeout and coordinates pause/recovery, correction and Stop. Unconfirmed idle
fences block recovery. The controller's fixed portal workflow now uses the actor.

The synthetic native workflow rechecks scope/title/control state and resumes
LOCATE/OPEN from Documents without repeating navigation. A real headless portal
DOWNLOAD resumes from verified detail and records exactly search/open/download/save.
Portal activation issues one-use attachment authority only after journal Resume
and projection activation; a projection failure pauses again. Temporary receipts
remain session-owned. These are scripted fixtures, not general computer use.

Linux typecheck and **341 passed, zero failed, two Mac-only skips (343 total)**;
16 added tests cover continuation, replay/fencing, changed state, timeouts,
projection failure and correction. No owner goal resumed, model/GPU ran or Mac
checkout changed. [Actor scope](PERSISTENT_TASK_ACTOR.md) and [v1 readiness](V1_READINESS.md)
track controller/UI recovery, replacement admission, general actions, live CLM,
Mac/existing-profile Chrome qualification and packaging. B15–B17 remain open.

## Explicit host recovery and correction fences, 1 October 2026

Cloud continuation: `codex/explicit-task-recovery`, based on #62 at `76e28dc`,
implementation `08abcaa`, [draft #63](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/63)
stacked on `codex/portal-checkpoint-reconciliation`. The journal now reserves
bounded paused-state reads, binds fresh checkpoint predicate evidence to an
exact one-use native-UI Resume intent and reactivates without resetting budgets
or restoring action facts. Restart fences already-paused reads too. Unknown
effects, uncheckpointed applied receipts and other active execution block recovery.

Committed next-revision corrections cancel the old task atomically, expire
pending facts and retain immutable admission, correction provenance and uncertain
effects. They do not install a replacement goal or imply compensation. See
[recovery contract](TASK_RECOVERY.md). Native/browser actors, controller/panel
intent routing, workflow predicates, adapter barriers and replacement admission
remain the next source slice. B15–B17 and live qualification remain incomplete;
CLM is not connected to execution.

Linux `npm run check`: **325 passed, zero failed, two Mac-only skips (327 total)**.
All **46 focused recovery/prompt/progress checks** passed after the final digest
normalization. Twenty-six added tests cover recovery, replay, expiry, bindings,
budgets, Stop/restart, uncertain effects, correction and rollback. The owner goal
remains stopped; no Mac UI, owner Chrome profile, live model or paid deployment ran.

## Portal checkpoints and conservative reconciliation, 30 September 2026

Cloud continuation: `codex/portal-checkpoint-reconciliation`, based on #61 at
`93259b7`, implementation `7381f03`,
[draft #62](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/62) stacked
on `codex/task-checkpoint-recovery`. The fixed portal now stores the exact admission in `AttemptJournal`,
uses shared observation/decision/equivalent-state limits and records independently
verified stages. Interference expires journal facts; Stop also cancels paused
tasks. Restart validates contract bindings and checkpoint/effect linkage, catches
up lagging historical progress and preserves unknown effects without replay.
Only already-committed terminal evidence plus completion can restore completed
history. Legacy/unbound or contradictory records remain blocked for review.
See [portal recovery](PORTAL_RECOVERY.md) and [progress](TASK_PROGRESS.md).

Linux typecheck and **299 passed, zero failed, two Mac-only skips (301 total)**
passed. Eighteen added tests cover crash windows, quotas, fresh references,
changed bindings, legacy/orphan records and late Stop replies. The user goal
remains stopped; no Mac UI, owner Chrome profile or inference deployment ran.
Explicit recovery/correction, the general actor and live qualification remain
open before CLM drives task decisions.

## Durable native checkpoints and bounded observations, 30 September 2026

Cloud continuation: `codex/task-checkpoint-recovery`, based on #60 at `387b61c`.
Implementation `653c022`, [draft #61](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/61)
stacked on `codex/durable-task-contracts`.
The journal now stores observation reservations, current fact references and
verified checkpoint history in its lifecycle transactions. Synthetic native
NAVIGATE/LOCATE/OPEN spend read/decision quotas, detect equivalent-state visits,
expire facts on dispatch/Stop/restart and require a current terminal predicate
for completion. Unknown effects remain unresolved; restart never resumes.
See [progress](TASK_PROGRESS.md) for scope and engineering defaults.

Portal progress/journal reconciliation and browser progress integration are
next, followed by explicit recovery/correction and CLM decisions. The general
actor and B15–B17 release gates remain incomplete. The owner has an M5/32 GB
Mac and cloud-provider access; [CLM preparation](CLM_DEPLOYMENT_PLAN.md) proposes
a private GPU reference API before local feasibility. No paid deployment or
live inference occurred. Linux typecheck and **281 passed, zero failed, two
Mac-only skips (283 total)** are recorded in [validation](VALIDATION.md).
The user goal remains stopped; the Mac checkout/app has not changed.

## Durable admitted task records, 30 September 2026

Cloud source continuation is on `codex/durable-task-contracts`, based on
`codex/panel-permission-recovery` at `f70f6e5`, implementation `4dea594`,
[draft #60](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/60).
The shared journal now persists
the exact admitted goal, command binding, parameters, effects, policy and
completion verifier atomically with task admission and budget. Native field,
synthetic native navigation/LOCATE/OPEN, managed field/link and existing-Chrome
fixture fill use this path. Scope/policy changes are refused before preparation
or dispatch, and terminal evidence commits with completed state.

[Task records](DURABLE_TASK_RECORD.md) provide a frozen diagnostic snapshot;
restart still pauses tasks and unknown effects block another admission. This
is a B15 foundation, not a general actor or resume procedure. Portal progress
reconciliation, current-fact expiry, decision/no-progress budgets and correction
remain open. Linux validation uses the pinned Playwright browsers; Mac native
build/live permission tests remain unrun in this continuation. See
[validation](VALIDATION.md) for exact counts and remaining gates. No user goal
was created or resumed and no normal AppKit UI or owner browser was launched.

Context refresh checkpoint, 30 September 2026: the canonical
[new-chat handoff](BUILD_HANDOFF.md#new-chat-resume-checkpoint--1-october-2026)
identifies the current #59 checkout, pending owner signing setup, protected
checkout state and next B15–B17 work. This documentation update adds no new
implementation or live-test evidence.

## Panel visibility and development identity, 30 September 2026

Owner feedback confirms Kimi was captured, but the running app still reports
Accessibility denied with an enabled Settings entry. The inspected build is
ad-hoc/hash-identified; no valid signing certificate is installed. The new
build supplies exact-path recovery, explicit request/recheck controls and
local certificate pinning. The owner has a regular Apple ID and must create
the Xcode Personal Team certificate before repeatable signing can be verified.
See [setup](DEVELOPMENT_SIGNING.md). This is not a verified permission fix yet.

The panel's hide-on-deactivation default was reproduced and corrected; the
floating panel now stays configured above ordinary windows across app switches
and joins Spaces. Audio cancellation remains unchanged. Native build and
synthetic panel/recovery diagnostics passed; physical multi-monitor behavior
remains open. Full Node suite: 255/255; signing unit tests: 4/4. A synthetic
same-identifier/different-build check rejects the previous ad-hoc requirement.

## Latest slice: persistent limits and progress guards, 29 September 2026

Manual Mac tests were parked on 29 September; the owner requested instructions
again on 30 September. New results are pending; implementation continues.
B15/B17 now have shared durable preparation budgets and deadlines, enforced by
the existing journal across native, managed Chromium and Chrome drivers. Budget
refusal pauses rather than completes, preserves already-dispatched uncertainty
and reaches the native status UI. Portal progress cannot skip/repeat stages or
complete at the wrong outcome, and advancement is single-flight.
[Details and limits](TASK_EXECUTION_LIMITS.md). Automated suite: 255/255 and
native development build passed. These tickets remain in progress: a general
actor, decision/no-progress budgets, reconciled checkpoints, explicit safe
resume and live compatibility are still required.

Updated 29 September 2026. The owner authorized beginning implementation and setting
up a repository after the independent GO WITH FIXES review. The original attached
baseline remains in the ignored local review directory. The proposed corrections
are adopted as the starting working specification; no gate is certified by this.

## Beta scope decision

The owner confirmed on 26 September 2026 that beta requires all three surfaces:
native macOS apps, managed Chromium, and existing Chrome using the user's current
profile, data and tabs. A fresh managed profile or a copied/migrated profile does
not satisfy existing-Chrome support. B19 and G4 remain beta release gates, and B20
retains its dependency on B19. The planned extension/native-messaging bridge must
qualify scoped user grants, exact browser/profile/tab/frame/document identity,
navigation invalidation, reconnection and revocation against existing-profile
fixtures. Supported operations and limitations must be stated explicitly.

The architecture follow-up gives the development controller one exclusive
active-task slot across native, managed Chromium and existing Chrome. A late
completion can only release its own slot. Adapter-specific Stop fences and
recovery decisions remain separate. A native build gate verifies nonempty
microphone and Speech purpose strings in the signed app bundle. These changes
passed 243 TypeScript/Node tests and a local ad-hoc native build; by themselves
they do not qualify physical voice permission, real computer use or a
distributable app.

On 29 September the owner reported one successful physical Enable Voice and
held-Talk run with a final editable transcript and no crash. This is a useful
voice-input smoke, but the screenshot showed no target app captured and no
action was run. A separate preflight fix now checks for a captured, current
target before checking or prompting for Accessibility in **Show fields**.
The built-app diagnostic failed before the reorder and passed after it;
the owner's target-captured Accessibility result remains open.

The compact command window now explicitly opts into Mission Control's managed
window behavior while retaining its floating appearance. A diagnostic mode
checks the actual built `NSPanel` property and passed after failing on the
prior build. The owner's trackpad overview and live voice paths still need
physical verification; see the [test guide](VOICE_COMPUTER_USE_TEST.md).

## First implementation slice

| Backlog | State | Evidence and remaining work |
|---|---|---|
| B01 source/dependency pins | In progress | Node/test dependency locks and CLM source metadata recorded. Actual model bytes, encoder/tokenizer revisions and release license clearance remain unverified. |
| B02 CLM reference probe | Fixture-only foundation | The pinned `/v1/systemone` choice shape is encoded from full semantic candidate descriptions; a probe captures raw replies, latency and token counts, and rejects malformed distributions/unknown IDs. Three synthetic fixtures and unavailable-service behavior are checked. No CLM service or weights have run; the 50-case benchmark, model artifact attestation, truncation and calibration remain. See [probe](CLM_REFERENCE_PROBE.md). |
| B03 protocol | In progress | TypeScript schema/parser/framing, Swift digest parity, endpoint allowlists, bounded reply correlation/deadlines, final-input routing, host-private task admission, one-use approvals, clarification/resume intent records and a Swift audit-token/code-signing peer verifier. Production supervisor integration, release-identity qualification, typed Swift messages and production permit/dispatch authority remain. |
| B05 fixtures | In progress | Fifteen schema messages, shared digest/Unicode fixtures, one resettable synthetic native text field, a compiled Documents/Downloads file navigator with select/open states and duplicate file names across folders, and a loopback-only invoice portal with duplicate titles, exact detail routes and fixed downloads. The new native navigator has not been manually exercised; broader adversarial fixtures remain. |
| B26 conformance | In progress | Python oracle and TypeScript tests pass; standalone Swift digest check passes. XCTest cannot run with the installed SDK. Full cross-language negative fixtures, property/fuzz/race tests and CI remain. |
| B05/B07 native fixture slice | Local test build | A synthetic AppKit fixture exposes one editable field. On this local Mac, the mock changed `Fixture Name` through Accessibility and the value was independently re-observed. This is one fixture action, not general native support. The separate development panel now compiles with shortcuts and focus display, but neither was manually exercised; voice, TCC attribution and production signing remain. |
| B09 host dispatch gate foundation | In progress | A fixture-scoped TypeScript gate binds a selected candidate to the admitted task, exact observation, policy, target, argument provenance and one-use in-process permit. Synthetic drivers prove Stop before send, unresolved send after Stop, expiry and stale-target refusal. The scripted portal task now requires one-use in-process admission and per-action permits, with a fresh observation before its journal boundary. These do not authenticate an OS worker or prove Playwright's actual input dispatch point. |
| B10 native observation foundation | In progress | A Swift package provides a bounded Accessibility tree walker with observation-scoped handles, target PID/bundle/path/launch identity and stale-node checks. Synthetic registry checks pass. The development panel now offers read-only, numbered subtree drill-down and explicit coverage gaps; secure labels/descendants are omitted and subtree completeness cannot be mistaken for whole-app coverage. The native field worker uses its own observation under a host task. Live inspector coverage, Stop responsiveness during a blocked AX call and broader real-app compatibility remain unverified. |
| B11 native value-action source | Development bridge | A restricted Swift `AXValue` driver prepares one exact nonsecure field, privately compares its prior value and re-observes after a one-use fenced setter. The TypeScript host class binds a final command, complete candidate set, value digest and journaled dispatch. A private pipe connects the persistent controller to the AppKit AX worker; synthetic process and Stop tests pass. The worker recomputes candidate/action digests and checks the native policy revision; TypeScript/Swift synthetic vectors agree and altered inputs fail. It durably consumes execution IDs and permit references in a worker-owned SQLite ledger before the setter; process-restart replay and unsafe-path checks pass. A per-process Ed25519 commit claim now binds the journaled permit to the retained worker observation; cross-language and bundled child-key handoff checks pass. A live action through this path, Developer ID host/worker identity and recovery remain unverified. See [native action](NATIVE_ACTION.md). |
| B11 native semantic press source | Development bridge | A separate Swift `AXPress` source for observed buttons/menu items uses the shared one-use Stop fence and rechecks the node after the durable boundary. Fixed synthetic Documents/Budget.xlsx LOCATE and OPEN tasks retain one admission across fresh observations and separately signed presses. LOCATE verifies selected-but-closed; OPEN alone invokes the separate Open control and verifies the opened title. Controller child and synthetic worker tests cover duplicate controls, interference, unknown effects and Stop between steps. The AppKit bundle compiles; no live press, general file workflow or release-qualified identity is established. See [native action](NATIVE_ACTION.md) and [manual check](NATIVE_NAVIGATION_TEST.md). |
| B12 managed Chromium worker | In progress | Playwright 1.63.0 launches a fresh temporary Chromium profile and a narrow scripted portal driver. Headless tests search, open an exact duplicate and download a fixed document. Stop closes this isolated context; a delayed-control test sees no download request after cancellation. The scripted task separately reports when a local save remains pending after browser closure. A separate general observer accepts exact approved origins, blocks out-of-scope requests, POSTs and WebSockets, and returns bounded main-document controls with coverage gaps. An admitted FILL task revalidates a private DOM handle, uses a one-use in-process permit and durable boundary, and verifies the exact field value. A separate `NAVIGATE` task now revalidates one plain same-origin link and explicit expected URL, journals dispatch, and re-observes exact arrival; Stop and unknown outcomes remain fenced. The development AppKit panel sends either action through a persistent controller and retains the browser for inspection. General multi-hop action dispatch, tabs/frames, uploads, release UX, authenticated browser-worker isolation and packaging remain. |
| B15 attempt journal foundation | In progress | SQLite records prepared attempts, the dispatch boundary, outcomes, cancellation, restart pause and host-verified task completion. The fixture portal task now writes all four scripted action attempts and Stop fences both the journal and task record; a simulated restart leaves an in-flight browser boundary paused and blocks replay. The two tables share a database but not one transaction. The native development path journals fixed field, Documents navigation, file selection and Open actions under each task and blocks further tasks after an uncertain effect; it still lacks a release-authenticated supervisor and an owner-qualified recovery procedure. |
| B16 portal outcome predicates | In progress | The managed portal re-observes exact invoice ID/title/account for LOCATE and OPEN, and requires a session-owned download receipt plus unchanged file bytes for DOWNLOAD. A scripted task uses those predicates across search/open/download/save; its output is private fixture data. No general outcome engine or authenticated task actor is connected. |
| B19 existing-Chrome bridge | Development guarded action source | A Manifest V3 extension requires a toolbar click and temporary `activeTab` grant for one normal HTTP(S) tab. It binds a semantic snapshot to extension/profile-session/tab/frame/document/exact URL and revokes on navigation or disconnect. The host admits and journals one `Find invoice` fill on a loopback page with the synthetic portal's shape, and the extension revalidates the retained field and value. Synthetic Stop/replay/ambiguity tests pass. An opt-in registration helper validates a signed host and exact origin; isolated install/verify/remove checks pass. A temporary Playwright Chromium copy of the production extension exchanges a semantic observation and journaled fixture field fill through a signed Swift host and signed test executable built from the production listener source, then revokes on reload. Duplicate fields reject before dispatch, replay rejects, and the fixture form is not submitted. Both code identities are checked and changed hashes disconnect. Test-handler invocation without a grant yields no observation; Chromium's test-only action trigger grants `activeTab` without a persistent host grant. A physical toolbar click, complete AppKit app and owner's Chrome profile have not been exercised together. See [existing Chrome](EXISTING_CHROME.md). |
| B04/B07 development bridge | In progress | A compact translucent voice/text panel now captures one previously focused app's process identity, offers read-only field-label preview and submits one reviewed `Fill` command to the existing native or managed-Chromium authority. It retains the developer tools separately. Control–Option–Space opens the compact panel and Control–Option–Escape requests Stop. The ad-hoc development build compiles, but shortcut/focus and real-app action behavior still need manual checks; release signing and general task UX remain open. See [voice test](VOICE_COMPUTER_USE_TEST.md). |
| B08 voice input | One owner-run voice smoke passed | Opt-in local Speech-framework recognition checks on-device support, requires on-device processing, records only while Hold Talk is pressed, and places a final editable transcript in the same task field as typed input. Partial results cannot run and Stop/close/deactivation cancel capture. The owner reported one held-Talk utterance and final editable transcript without a crash on 29 September. Repeated permission flows, recording cancellation, microphone shutdown, recognition quality and representative evaluation remain. This built-in transcriber is a fast development path; pinned WhisperKit assets remain open. |
| B27 packaging foundation | Development bundle | A movable ad-hoc app includes a checksum-verified official Node 26.5.0 executable, locked production npm packages and version-matched Playwright Chromium. It pins the signed Node code hash and checks the launched child from AppKit before accepting controller output; headless positive and changed-hash rejection checks passed. The bundled controller and browser worker pass a loopback fixture smoke after relocation. The current ad-hoc app/Chrome-host reciprocal CDHash pins create a sealing cycle if copied into one bundle; release needs a non-circular authenticated peer policy. It is not Developer ID signed/notarized and has no authenticated release supervisor, bundled Chrome host, model assets, update system or clean-Mac qualification. See [bundled runtime](BUNDLED_DEV_RUNTIME.md). |
| All other tickets | Not started or incomplete | No qualified signed UX, general native action adapter, model service or release artifact. |

The latest B19 isolated check now uses the production controller **child** and
its private pipe, in addition to the signed host/listener source and extension
copy. It reopens the child's journal to confirm one completed DOM fill and one
cancelled, unresolved edit after Stop and a delayed receipt. The full AppKit
bundle, physical toolbar click and installed Google Chrome remain unverified.

B13 now has a bounded [shared candidate foundation](ACTION_CANDIDATES.md) used
by the supported native field, managed field/link and Chrome field paths. It
does not yet cover all requested operations or prove candidate recall. Managed
field fill now classifies page-script network writes as a possible effect.
The panel's structured fill and navigation commands also bind their exact
user-entered values to UTF-8 byte spans in the committed private command.
Admission checks the span and digest before dispatch. This does not yet parse
arbitrary utterances or qualify approved selections, so B13 remains open.

The fixed `INV-105` scripted portal task is now reachable through the same
persistent controller and a development-panel button. An isolated child-process
test verifies search, exact open, download and private save, plus a Stop after
the durable download boundary that cannot become completion. A restarted child
reports the persisted recovery block. Fixture metadata is marked as fixture
configuration, while the loopback origin is bound to the panel command. The
AppKit bundle compiles; the button has not been manually exercised. This is
still a fixed synthetic workflow, not general browser navigation or model
control.

These slices are staged across draft PRs; they do not mark the entire contracts-and-fixtures stage
or any of B01/B03/B05/B26 complete. The private GitHub remote is configured.

## Input and reply foundation

`CommittedInputSession` validates final command records against a host-bound input
endpoint and task revision, rejects repeated message/utterance IDs, and routes
dictation as literal text. Partial previews remain native UI events; they cannot
enter this protocol path. This resolves the two reviews' differing advice on
`isFinal` by preserving the working specification's final-only command contract.
It does not perform task admission or validate a dictation destination.

`ReplyLedger` binds each pending request to the exact endpoint object, expected
reply type, task revision and caller-supplied observation/projection digests. It
checks an injected monotonic deadline before and after validation, accepts at most
one reply per request, caps memory use and rejects all replies after closure.
Use a new ledger and fresh request IDs after correction, cancellation or reconnect.
Closing a ledger is a local input barrier, not evidence of the real OS/browser
Stop barrier. Supervisor peer authentication and connection teardown remain.

The second-review Approval patch remains an assessment artifact and was not applied
wholesale. The working contract now independently adds an `Approval` record and
requires `policyRevision` on permits and execution requests. `ApprovalLedger`
accepts a reply only from the exact bound UI endpoint object and binds actor/UI
session, task revision, prompt, presentation, scope, observation, candidate set,
action, policy and elevated effects. It checks injected monotonic and wall clocks,
then permits one consumption. This is in-memory contract authority only: endpoint
objects do not authenticate an OS process, and consumption is not yet durable.

`TaskAdmissionRegistry` converts only the exact final command object issued by its
bound input session into a host-private task contract. A command object and task
admission each transfer once by in-process object identity; matching JSON or a
foreign session cannot mint task authority. It binds outcome kind, stated parameter provenance digests,
scope, completion verifier, policy revision and approved effects. Dictation cannot
admit a task and `UNKNOWN` effects fail closed. A future workflow-specific admission
UI still needs to select these fields; no natural-language interpreter or proof of
correct parameter extraction is implied. The fixture portal checks those admitted
values, effects and policy against its start contract. It does not issue execution
permits for each Playwright action. A separate fixture-specific authority now
issues short-lived one-use permits for search, open, download and save; it checks
admitted effect, stage, target URL and observation digest. The task re-observes
before using one and pauses on change. This moves action selection through a
host-private policy boundary, but the Playwright calls still run in-process and
have no signed peer or worker-side permit verifier.

The Swift peer-identity primitive now reads `LOCAL_PEERTOKEN` from an active local
socket, cross-checks effective UID/GID, validates the running code through
Security.framework, and enforces an Apple-anchored Team ID requirement or pinned-
CDHash trust anchor in addition to the signing identifier. A bounded local check
accepts the same ad-hoc-signed binary and rejects both a different identifier and a
same-identifier/different-hash binary. This host has no valid development or
distribution identity, so the actual
app/helper Team ID, installed path, update behavior and TCC attribution are untested.

`UserPromptLedger` accepts clarification only for an option registered in the exact
displayed prompt and current observation. Resume is a one-use intent bound to a
host-registered paused checkpoint and recovery observation. Changed revisions,
observations, actor/session, prompt presentation, checkpoint and expired responses
fail closed. Free-text corrections use a new committed `Command` and goal revision.
The ledger does not change task state, replay an attempt or issue a permit; B15/B17
must connect it to durable recovery and revalidation.

The local UI mock provides a runnable menu-bar panel for human feedback while B04
signing and permission attribution remain open. Its Preview button only updates
status text; the fixture-only action below is a separate explicit path and is not
evidence for general native-app or browser support.

The fixture build adds one deliberately separate effect path. It finds exactly one
running `com.aurium.systemone.fixture` bundle at the build path, checks a single
window and labelled AX text field, sets its value off the UI thread, and re-reads
the field before reporting success. This is a scripted local test, not natural-
language navigation. Stop invalidates the local attempt epoch and keeps the UI
responsive; it does not claim to undo or fence an already-started AX setter.
Native integration of the attempt journal, permit/approval dispatch, supervisor identity integration,
fast independent Stop barriers, and non-fixture scopes are still pending.

The separate TypeScript `AttemptJournal` now persists opaque task/permit/action
identifiers, candidate/observation/policy bindings and status dimensions in SQLite with a full-sync transaction before
the adapter boundary. A crash before that marker is recorded as not dispatched;
after it, delivery stays unresolved until evidence arrives. Stop prevents later
journal dispatch but does not fence an adapter queue. One unsettled attempt can
occupy the writer slot, and late receipts update that attempt without resuming a
cancelled task. This is a foundation only: the native fixture does not call it,
no host-issued permit is validated here, and restart ownership/worker termination
still need integration before non-fixture effects.

`HostDispatchGate` connects that journal to a copied, fixture-scoped candidate
set and an in-process one-use permit. A selected candidate ID alone cannot execute.
An effect-free driver preparation step rechecks the exact target, surface,
fingerprint and prior-value digest. The gate writes the dispatch-boundary marker
before calling the driver's synchronous send entrypoint. Stop aborts preparation,
fences journal dispatch and lists boundary-crossed calls as unresolved. Synthetic
tests prove these properties, including late results after Stop. A real native or
Playwright adapter must still prove that its preparation cannot cause an effect
and that its send entrypoint cannot wait and dispatch after Stop. The gate is
hard-limited to the synthetic fixture and does not authenticate a helper process.
It also does not validate a model proposal's producer or establish a recovery
policy for an unknown settled effect across a new task. The host must connect the
existing reply boundary and require fresh observation before allowing a related
action after an uncertain result.

The owner confirmed Fill after renewing the current Mock's grant. The revised
Reset feedback is still awaiting observation. The exact steps are in
`docs/FIXTURE_COMPUTER_USE_TEST.md`.

The 27 September reopen crash was in SystemOne Fixture, not the Mock. Two
diagnostic reports show the same reopen-handler crash after an older Fixture
process survived a bundle rebuild. The launcher now stops only exact-path
synthetic processes before rebuilding/reopening, and a direct build refuses to
overwrite a running test bundle. Generated app-bundle extended attributes from
the OneDrive checkout are cleared before ad-hoc signing. A fresh fixture opened
and reopened without a new crash; the owner's in-Mock click remains to be checked.

Later that day, the current Mock reported `AXIsProcessTrustedWithOptions == false`
while System Settings showed its Accessibility toggle on. The installed bundle
has an ad-hoc designated requirement bound to CDHash, and it was rebuilt after
the earlier grant. This Mac has zero valid code-signing identities. The narrow
`tccutil reset Accessibility com.aurium.systemone.native-mock` succeeded and the
Mock relaunched; the subsequent user grant and Fill result are recorded below. The build
script now accepts an optional `SYSTEMONE_CODESIGN_IDENTITY` for a valid local
development certificate and warns when using ad-hoc signing. No production TCC
update or clean-install behavior has been qualified.

The owner then granted the current Mock and showed both its Verified status and
`fixture-123` in the separate Fixture. The current fixture-only AX action is
verified again. Reset feedback and broader native control were not shown.

The local invoice portal now supplies deterministic search results, duplicate
titles under distinct IDs/accounts, exact detail pages and a download link that
appears after a short client-side delay. It binds only an ephemeral 127.0.0.1
port, rejects a foreign Host header and write methods, escapes search text and
serves fixed synthetic documents. HTTP tests distinguish finding a result from
opening its detail and downloading its exact file. Browser rendering, actionability
and download handling are now covered for this portal by B12's first managed Chromium tests.

`ManagedPortalSession` launches Playwright's version-matched Chromium with an empty
temporary profile, blocks service workers, routes page requests only to the exact
loopback portal origin, and never attaches to the user's Chrome profile. The
driver exposes only fixed search, exact-ID open and exact-ID download operations.
It observes DOM page identity and result rows, rejects stale result revisions,
waits for the delayed download link, validates the final URL, filename and exact
synthetic document contents, saves
inside its private temporary directory and removes that directory on close.
Headless tests pass. The fixture Stop path now records cancellation before
closing the context, and a delayed-control test confirms no download request
after its close. This is not a general browser executor, an offline-network
qualification, an OS-level network sandbox, or a Stop barrier integrated with
the host permit gate. The production headed build, installer and existing-
Chrome extension are still separate work.

## Next sequence

The 28 September Enable Voice crash has a callback-isolation fix. On
29 September the owner confirmed one physical held-Talk transcript without a
crash. Repeated permission/microphone flows remain unverified, and the owner has
now parked manual testing. See
[voice crash handoff](VOICE_CRASH_HANDOFF.md).

On 29 September, the chosen intake deepening moved command envelope creation,
typed start-request construction, send-once behavior and the active writer
record into `DevTaskIntake`; all UI entry points now use it. Native build and
synthetic one-writer/provenance checks pass. Controller admission, permits and
Stop semantics were not broadened. One physical voice-input smoke passed;
broader live panel actions remain open.
See [task intake](TASK_INTAKE.md).

1. Move the now-journaled fixture portal task behind one authenticated host
   authority and one-use permits. Prove the browser close fence at that dispatch
   boundary and preserve already-dispatched uncertainty. Add
   B10/B11 semantic native observations/actions with explicit scope; move beyond
   single-field fixtures without treating unverified effects as safe.
2. Finish B03 durable authority and supervisor peer-identity integration. Connect
   B09/B15 to native and managed-browser workers only after proving actual Stop
   barriers and unknown-outcome handling. Expand B05 interference fixtures and CI.
3. B04/B07/B08 plus B10–B13 and B15–B17: signed native panel/PTT/dictation,
   general semantic adapters, headed managed browser, multi-hop scripted tasks,
   exact completion and crash/interference tests. Prove TCC attribution and clean
   installation on an authorized test Mac.
4. B14 inserts qualified CLM after drivers and dispatch gates pass. B18/B19 must
   qualify transitions and the existing-Chrome profile before beta.

G1–G6 remain unverified. Local CLM, Laya, Jev and vision do not become enabled by
creating this repository. Server-first versus offline-first release and insertion
into a cloud-synced note remain owner decisions before those modes ship.

## Important implementation boundaries

- `requestDecision` accepts only a projection already reviewed by the trusted host;
  it checks enabled provider/location/revision and integrity before invoking its
  transport. It does not identify secrets or issue disclosure approval.
- The Swift package provides digest and peer-identity primitives, not a full JSON ingress validator. Do not
  decode untrusted IPC using Foundation alone and call it protocol conformance.
- Framing is for private inherited app/sidecar pipes: 4-byte big-endian length,
  followed by UTF-8 JSON, capped at 1 MiB. The caller must bound read chunks; malformed
  or truncated sessions fail closed. Chrome native messaging needs its own framing.
- Only the explicit synthetic fixture field can be changed by the local test build.
  General native/browser dispatch, durable one-use permits, host actor authentication,
  target freshness across navigation and production one-writer ownership remain open.
