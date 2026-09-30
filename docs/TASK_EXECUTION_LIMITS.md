# Durable task limits

This B15/B17 slice puts a shared host policy in `AttemptJournal`, which is
already used by native Accessibility, managed Chromium and existing Chrome
actions. It does not add a model, planner or action permission.

At journal admission the host stores an immutable deadline and maximum number
of prepared attempts. The development default is **30 preparations and five
minutes**. Thirty follows the plan's proposed action ceiling; counting failed
preflights too is a conservative retry limit. Five minutes is an engineering
default for the current short workflows, not a measured product threshold.
Host code may choose a smaller or larger workflow limit within validated bounds
(1–1000 preparations, 1 ms–1 hour). Model messages cannot change it.

The journal checks limits transactionally before preparation, dispatch and
terminal completion. Each successfully persisted preparation spends one step,
including one later classified not dispatched. Reopening the database or
minting another execution ID cannot reset the count or deadline. Read-only
completion spends no step; the last permitted action can still complete.

Exhaustion commits a paused task and opaque reason before returning an error.
Unsent preparations become definitely not dispatched. Dispatched or unknown
effects stay untouched, and unknown effects prevent a new preparation even
when budget remains. Late receipts may document an applied effect, but cannot
complete a task after its deadline. The controller reports `paused_budget`
instead of a caught adapter error or apparent success; the panel asks the owner
to inspect the result before starting again.

The persisted wall-clock deadline is checked against a saved high-water time.
A backwards or invalid clock causes a conservative pause; a forward clock
adjustment may expire a task early. The production host must still address
sleep/lock notifications and workflow-specific time policy. Old task rows
without a budget fail closed; restart recovery still pauses old active tasks,
and this slice does not introduce a resume path.

These checks run at journal transitions. They do **not** interrupt a hung
observation, stop an already dispatched effect at the exact deadline, or undo
an edit. Adapter timeouts and Stop barriers remain necessary. Preparation
counts also do not bound pure observation/model/wait loops: the general actor
still needs total decision/observation budgets and equivalent-state detection.

The scripted portal now admits only its legal stage transitions:
`admitted -> located -> opened -> downloaded_temporary -> saved`.
LOCATE terminates at located, OPEN at opened and DOWNLOAD at saved. Skipped or
repeated steps, premature completion and opening under LOCATE are refused.
Only one `advance()` runs at once, and rejected progress checkpoints cannot
silently continue the loop. Fresh observations, admission and per-action
permits remain with the existing restricted adapter.

The portal progress and attempt journal still use separate transactions.
Crash reconciliation, goal correction, current-fact expiration, safe explicit
resume, general native/browser navigation and CLM decisions remain unfinished.
See [build handoff](BUILD_HANDOFF.md) for the next implementation slice and
[validation](VALIDATION.md) for source evidence versus manual evidence.
