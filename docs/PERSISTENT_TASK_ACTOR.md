# Persistent scripted task actor

`PersistentTaskActor` now owns a progress-tracked admitted task across repeated
observe/decide/dispatch/verify steps, interruptions, explicit recovery, correction
and Stop. Its status comes from `AttemptJournal`, rather than an adapter's returned
success string. The development controller uses it for the fixed portal workflow.
`NativeFixtureTask` supplies the same actor contract for synthetic native
NAVIGATE/LOCATE/OPEN through the existing signed press-worker interface.

The actor permits one pending operation and one owner per journal object. A
workflow must spend observations and decisions each active advance; returning
without a bounded decision pauses. The journal still enforces its original
deadline, preparation/read/decision quotas and equivalent-state limits. The host
must obtain exclusive journal/process ownership; an in-process owner map does
not authenticate OS peers or replace the controller's cross-surface task slot.

An operation has a configurable 1 ms–60 second host timeout (15 seconds by
default). Timeout pauses and invalidates the workflow, but retains the pending
operation until it actually settles. Another run, recovery read or owner cannot
start during that interval. Stop cancels durable execution before waiting for
the adapter. Its report separates journal fencing, worker fencing, operation
settlement and unresolved execution IDs. A fence failure blocks another actor.
No timeout/fence claims undo or turns an uncertain effect into safe retry.

Pause closes the prompt and revokes pending workflow authority. Recovery must
independently recheck the historical checkpoint and current scope. The actor
binds a registered native-UI prompt, consumes its exact Resume intent and then
requires fresh actionable observations for subsequent execution. Stop or
correction closes pending prompts and fences late observations/receipts.
Correction reaches the actual workflow Stop barrier after cancelling the old
revision. [Fixture replacement admission](NATIVE_TASK_REPLACEMENT.md) now
transfers a changed paused goal into a fresh child after that settled fence.
General and active-operation replacement remain open.

## Scripted browser continuation

The portal resumes only at settled `located` or `opened` checkpoints. Its recovery
read checks original query, invoice ID, title/account, origin, current document
revision, independent predicate and an unchanged subsequent observation. Its
historical projection must first agree with journal checkpoints and effects.

Journal Resume commits before projection activation; projection failure pauses
the journal again and expires recovery facts. Only successful activation issues
a new exact one-use store record for task attachment. A copied persisted
admission/record cannot attach a new executor. Stage and quotas stay intact; the
resumed task performs only the remaining steps. Temporary download/session
receipts are not reconstructed, so `downloaded_temporary` stays blocked after
evidence loss. No pre-Resume navigation restores an old page automatically.

A real headless test pauses after OPEN and resumes DOWNLOAD, recording exactly
one search, one open, one download and one scoped save. This uses an isolated
synthetic profile and retained live page, not the owner's Chrome profile or a
browser restart with reconstructed state.

## Scripted native continuation

`NativeFixtureTask` validates fixed fixture policy, parameters, approved effects,
scope and outcome verifier. Each advance uses a complete fresh semantic
observation, the shared candidate builder and the existing worker preparation,
signed-permit/dispatch and independent title-verification boundary. NAVIGATE,
LOCATE and OPEN terminate at distinct states.

Recovery reads the full current fixture observation, rechecks its historical
title predicate and compares another semantic read, ignoring ephemeral handles.
Resumed execution uses new observation/preparation/permit IDs, preserves history
and never repeats a verified Documents press. Stop after dispatch leaves unknown
effect history; changed scopes, duplicate controls and unmatched predicates pause.
These actor checks use a synthetic worker. The development controller now routes
its fixture NAVIGATE/LOCATE/OPEN requests through this actor, retains pause/Stop
ownership and blocks new intake for unfinished durable tasks after restart.
See [native controller integration](NATIVE_CONTROLLER_ACTOR.md). The
[Resume path](NATIVE_CONTROLLER_RECOVERY.md) and bounded fixture replacement are
wired in source; physical AX/permission qualification and worker lifecycle
recovery remain open.

## Remaining v1 work

[Native field fills](NATIVE_FIELD_ACTOR.md) now run under the actor with retained
recovery. Extend correction beyond retained paused fixture actors, extend legal
semantic actions, and qualify
sleep/lock, persistent browser sessions and unknown-effect reconciliation.
Prove existing-profile Chrome continuity and authenticated release workers.
CLM decisions require their own artifact/calibration and closed-loop evidence.
See [v1 readiness](V1_READINESS.md), [recovery contract](TASK_RECOVERY.md) and
[validation](VALIDATION.md). The previous owner goal remains dropped.
