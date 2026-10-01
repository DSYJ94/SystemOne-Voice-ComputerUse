# Explicit host recovery and correction fences

The shared journal now has a bounded recovery API for admitted, progress-tracked
tasks. A trusted host must independently recheck the latest historical checkpoint
in its original scope, present that exact recovery state, and consume the user's
explicit Resume reply. A [persistent scripted actor](PERSISTENT_TASK_ACTOR.md)
now uses this path for native fixtures and the fixed portal. Controller/panel
recovery intent and general actor/action integration remain incomplete.

The source tests use synthetic tasks only. The owner's stopped goal is unchanged.
No automatic retry, effect compensation, model call or deployment is introduced.

## Recovery sequence

1. Fence the previous adapter/worker and obtain exclusive journal ownership.
   On restart, call `recoverAfterRestart()`. It pauses active tasks and expires
   facts and pending recovery reads for **already-paused tasks too**. It preserves
   historical checkpoints, counts, deadlines and uncertain outcomes.
2. Call `reserveTaskRecoveryObservation(taskId)` before awaiting an independent
   read. The task must be paused, have an intact admission and a verified
   checkpoint. The reservation spends its existing observation quota and expires
   older facts. Its validity ends after **30 seconds**, starting before the read,
   or at the task deadline, whichever comes first. This is an engineering bound.
3. Recheck the latest checkpoint's predicate in the admitted scope. Pass the
   fresh semantic observation and predicate/evidence references to
   `recordTaskRecoveryObservation`. The host owns predicate correctness; journal
   hashes and a user reply cannot establish it. Changed scope, checkpoint,
   lifecycle/effect history, stale reservation or expiry is refused.
4. Present the returned `TaskRecoveryBinding` through `UserPromptLedger`, with
   the actual UI presentation digest and prompt ID. The authenticated endpoint,
   actor, UI session and task revision must match. `acceptResume` returns an exact
   in-process intent; plain, copied, persisted or foreign-ledger messages cannot
   stand in for it. New presentations, invalidation, closure and expiry revoke
   accepted but unused intent. OS peer authentication remains the caller's job.
5. Call `resumeTask(ledger, intent)`. One transaction checks the fresh recovery
   state again, records durable message/ticket replay guards, consumes the exact
   intent and reactivates the task. Ordinary SQL failure rolls back state/events
   without consuming intent. A commit failure after capability consumption can
   conservatively consume it without activating the task.
6. Obtain a **new actionable observation** and decision before preparing an
   action. Reactivation expires the recovery observation and does not mint a
   permit, restore an old checkpoint as current, dispatch anything or declare
   completion. Completion still needs a fresh terminal predicate.

The original deadline and every quota remain in force. Exhausted preparations,
observations, decisions or equivalent-state visits cannot be reset by Resume.
Clock pauses are sticky. A task with no remaining read/decision capacity is
conservatively refused, even if an old terminal checkpoint exists.

An active task, unsent preparation or unresolved/unknown effect anywhere in the
journal blocks recovery. An applied receipt without its matched, independently
verified checkpoint also blocks recovery. The new API does not resolve unknown
effects or classify an uncheckpointed mutation as safe to retry. Legacy tasks,
missing checkpoints and completed/cancelled tasks are ineligible.

## Correction sequence

`cancelTaskForCorrection(taskId, inputSession, command)` accepts only the exact
final Command object issued by that bound input session, at the next goal
revision with the same task/epoch. Dictation, copied/foreign/claimed commands,
skipped revisions and terminal tasks are refused.

The transaction cancels the old revision, expires its pending reads and facts,
settles only unsent preparations and records the correction message ID, proposed
revision and command digest. `getTaskRecord().correction` exposes that private
diagnostic record. The original admission and goal revision remain immutable;
late outcomes update old execution history without reactivation. Unknown effects
still block replacement execution. There is no implied undo.

The actor now coordinates cancellation with its workflow Stop barrier. This API
consumes the command for the cancellation fence. It does **not** install
or admit the replacement goal. A future actor must implement replacement
admission/provenance and coordinate its adapter Stop barrier, pending proposal
and permit revocation, prompt closure, task slot and browser projection. A journal
fence alone cannot recall an operation already handed to an adapter.

## Remaining integration

Extend the scripted actor with controller/UI intent and replacement admission.
The portal now rechecks results/detail predicates, reconciles history and issues
an exact activation record after journal Resume. DOWNLOAD can continue from
verified detail; a temporary receipt cannot be restored into a new browser
session. Never reconstruct a `TaskAdmissionRegistry` capability from JSON.
Failure classification, unknown-effect reconciliation, sleep/lock handling,
voice/UI recovery and real Mac/existing-profile Chrome qualification remain open.
Prove this scripted integration before CLM makes execution decisions.

See [progress](TASK_PROGRESS.md), [portal history](PORTAL_RECOVERY.md),
[validation](VALIDATION.md) and the [handoff](BUILD_HANDOFF.md).
