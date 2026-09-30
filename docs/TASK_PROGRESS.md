# Observations, checkpoints and bounded progress

This B15–B17 slice adds opt-in progress tracking to `AttemptJournal` and uses
it in synthetic native NAVIGATE/LOCATE/OPEN and the fixed portal workflow.
It preserves verified history
while expiring the facts that could authorize an action. It does not implement
a general task actor, correction or resume.

The host enables tracking before any attempt, binding the scope and completion
verifier to the stored admission. Development defaults are **90 observations,
30 decisions and three visits to an equivalent state** since the last newly
verified stage. These are engineering limits, not measured release thresholds.
Only host code can select limits; validated values are 1–1000 for each quota.
The existing preparation limit and five-minute deadline still apply.

An observation reservation commits before the host awaits a read. It spends
one observation, expires current facts/checkpoints and fences older pending
reads. Failed reads still cost a reservation. Only the latest reservation can
install a scope-matched observation. The native admission needs one initial
bounded read to identify its scope; that read is retained and counted once
after admission. Subsequent full reads and independent title-verification reads
are reserved before I/O. Predicate-only reads cannot authorize dispatch.

The native host hashes semantic titles and control properties, excluding
ephemeral handles, observation IDs and control ordering. A new identifier
therefore cannot disguise the same state; A–B–A cycles also count. Only the
first verified occurrence of a stage resets equivalent-state counting.
Refreshing a stage or alternating previously verified stages does not reset it.
Decision cost is spent before each admitted step selects a control, including
the already-matched terminal path.

Preparation and dispatch require the current actionable observation in the
tracked scope. Crossing the dispatch boundary expires that observation. The
worker's independently read title predicate becomes a separate non-actionable
observation; a returned press alone supplies no checkpoint. A linked checkpoint
requires a settled matched attempt with exactly the same evidence reference.
Unsettled or unknown effects block checkpoints. Terminal checkpoints must use
the admitted completion verifier, and completion requires their current
observation and matching evidence. Already-matched tasks use a fresh independent
predicate and can complete without an attempt.

Progress-budget exhaustion atomically pauses the task, expires facts, records
`paused_budget:observations`, `:decisions` or `:no_progress`, and settles unsent
preparations. Unknown/dispatched effects remain history and block replay. Stop,
restart, deadline exhaustion and completion also expire current references.
Restart retains counters, limits and checkpoints but leaves tasks paused;
history never becomes a permit or resume intent. Late replies cannot install
facts or terminal checkpoints after cancellation or restart.

`getTaskRecord().progress` includes limits, counts, current observation and
checkpoint history. Completed/cancelled/paused checkpoints are historical
(`current: false`). These records are private diagnostics and are not provider
input. Checkpoint fields and semantic digests are host-owned; they do not prove
predicate correctness or authenticate workers by themselves.

The fixed portal now uses these guards and [reconciles its progress projection](PORTAL_RECOVERY.md)
against journal checkpoints before worker startup. It retains historical
completion only when terminal evidence and completion already committed.
Single-action native field, managed field/link, existing-Chrome fill and older
host-gate fixtures retain their existing preparation/deadline guards. The next
slice must prove explicit recovery decisions with fresh native/browser
observations and invalidate pending steps on correction.
No automatic resume or paid inference deployment is introduced here. Hung
reads still need adapter timeouts and Stop barriers; quotas bound starts of
reads rather than interrupting an outstanding OS call.

See [task records](DURABLE_TASK_RECORD.md), [limits](TASK_EXECUTION_LIMITS.md),
[validation](VALIDATION.md) and the [handoff](BUILD_HANDOFF.md).
