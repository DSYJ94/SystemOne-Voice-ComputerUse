# Native fixture controller recovery

The development panel has an explicit **Check recovery** button for its existing
synthetic Documents, LOCATE and OPEN task. It asks the controller to independently
recheck the paused actor's last checkpoint in its admitted scope. A successful
read opens a sheet showing the original goal, checkpoint and revision, with
**Resume** and **Keep Paused** buttons. It never automatically resumes a task.

The private inherited parent pipe accepts four strict request shapes:
`prepare_native_recovery`, `native_recovery_presented`, `resume_native_task` and
`cancel_native_recovery`. Reads and resumed execution occupy the controller's
exclusive native task slot. The original task ID remains the Stop target.
Recovery only uses the retained in-process actor/admission; serialized messages
or journal history cannot reconstruct that authority after restart.

The host produces an immutable presentation projection and canonical digest.
The parent validates its task/session/revision bindings and recomputes the digest
before constructing an AppKit sheet. A queued acknowledgment checks that the
exact sheet is visible. Only then does the host register a 20-second prompt
ledger bound to the parent UI session. The explicit first-button response carries
an exact protocol Resume request; acceptance produces the one-use in-process
intent consumed by the actor and journal. No UI message becomes a worker permit.
The independent recovery-read TTL remains 30 seconds from before the read,
so presentation acknowledgment cannot extend checkpoint freshness.

Keep Paused, superseding reads and Stop invalidate old prompt authority. The
sheet expires after 20 seconds. Failed, altered, missing, stale or replayed
intent cannot resume execution. The journal keeps original admission, deadlines,
quotas and effect/checkpoint history. Exhausted budgets, unknown effects,
uncheckpointed applied effects and changed scope/predicates remain blockers.
Continuation dispatches only the remaining steps from a verified checkpoint.

Native fixture observation scope now retains the same opaque ID only for the
same task and exact app PID, bundle ID, bundle URL and launch date. AX handles and
fences are still refreshed on each observation. A restarted/replaced app cannot
inherit the original scope; at most 1,000 task scope bindings are retained per
worker, and host identity invalidation clears them. Field-fill scope behavior
is unchanged. This fixes fresh fixture reads rejecting their own admission.

Eleven new synthetic authority/controller tests cover recovery and refusal paths;
the full Linux suite passes 388 tests with two Mac-only skips. Linux cannot
compile AppKit. Actual sheet visibility/acknowledgment, focus, expiry/Stop races,
process-scope binding and live AX actions still require a Mac build and manual
qualification. The inherited development pipe is not authenticated release IPC.
The [replacement path](NATIVE_TASK_REPLACEMENT.md) now supports changed paused
fixture goals. Restart reconstruction, general/active correction, arbitrary native or
browser recovery and release/model qualification remain open.

The previous owner goal was dropped from the work plan. No owner-app execution
or owner journal mutation occurred in this cloud continuation.
