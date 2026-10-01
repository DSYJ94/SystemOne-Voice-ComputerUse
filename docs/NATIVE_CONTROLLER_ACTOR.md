# Native fixture controller actor

The development controller now routes its existing synthetic Documents,
LOCATE and OPEN requests through `NativeFixtureAuthority`, `NativeFixtureTask`
and `PersistentTaskActor`. The earlier fixed `NativePressAuthority` remains a
legacy isolated test implementation; the development controller no longer
executes through it. Native field fills now use their own [persistent workflow](NATIVE_FIELD_ACTOR.md)
through the shared actor and controller.

The intake wrapper accepts the same exact developer-panel commands, Fixture
bundle, folder/file parameters, terminal title and final text provenance as
before. A new task still receives a one-use `CommittedInputSession` command
and `TaskAdmissionRegistry` admission. Nothing reconstructs admission from
stored JSON, enables model decisions or admits arbitrary apps/files.

The scope-discovery observation is copied into immutable actor-local state and
used once for its first budgeted step. Pause/Stop discard it. Later steps use
new observations and worker preparations. Independent title predicates still
distinguish Documents navigation, selected-but-closed LOCATE and synthetic OPEN.
The signed worker permit, durable dispatch boundary and effect/checkpoint
records are unchanged. A receipt alone never completes the task.

The native controller actor uses a **three-second per-operation engineering
timeout**, not a measured release latency promise. Timeout revokes workflow
authority and pauses durable history; an operation that ignores cancellation
retains ownership until it settles. Stop independently cancels the journal and
requests the worker fence. A late result cannot reactivate or complete it.
Unknown effects and failed worker fences continue blocking new work.

## Pause, restart and shutdown

The controller now checks unfinished durable task IDs before admitting a new
request on any surface, including after restart when no effect is unknown.
A paused native actor remains retained after its run releases the dispatch
slot. `native_paused` and the existing `paused_budget` status describe that
pause, followed by `blocked_recovery`. The panel preserves its intake slot.
Explicit Stop targeting that retained native fixture task reaches the actor and
worker fence. A matched, settled fence with no uncertain effect can report ready;
it cancels the old task, rather than resetting its budget or resuming it.

On shutdown, the controller closes the native transport and awaits the actor's
actual pending operation before closing the journal. This prevents late
preparation/history callbacks from accessing a closed database. A paused task
remains paused across that shutdown; startup does not replay it.

Fourteen added authority/controller tests exercise all three outcomes,
already-satisfied state, rejected commands, checkpoints/quotas, Stop before
admission and during preparation/dispatch, failed fences, timeout ownership,
cross-surface intake blocking, restart and shutdown. Existing child-process
tests still verify separately signed native presses and delayed Stop receipts.
All use synthetic native workers. Linux cannot build or qualify the AppKit
panel, live Accessibility, voice or owner-profile Chrome.

## Remaining work

The [controller/panel recovery path](NATIVE_CONTROLLER_RECOVERY.md) now exposes
fresh scoped recovery reads and exact user Resume for a retained fixture actor.
The [bounded replacement path](NATIVE_TASK_REPLACEMENT.md) now connects explicit
changed fixture goals to fresh child admission after cancellation and fencing.
General
native/browser actions, browser reconstruction,
unknown-effect reconciliation, sleep/lock, qualified primary CLM and authenticated
release workers remain open. Older paused non-fixture records also block new
controller intake; no generic UI recovery or automatic cancellation is invented
for them. See [v1 readiness](V1_READINESS.md) and [validation](VALIDATION.md).
The owner dropped the previous goal from the working plan.
