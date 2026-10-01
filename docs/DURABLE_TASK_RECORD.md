# Durable admitted task records

This B15 foundation retains the goal that an existing action path admitted,
along with the task's lifecycle, budgets and effect history. It prepares the
shared journal for a general task actor; it does not implement that actor or
enable CLM, broader actions or goal resume.

`AttemptJournal.startAdmittedTask` transfers the exact one-use admission from
its issuing `TaskAdmissionRegistry`. One SQLite transaction stores the task,
deadline/preparation budget, goal, command message ID, outcome kind, scope,
parameter provenance, approved effects, policy and completion-verifier reference.
A copied, foreign, closed or consumed admission cannot start a task. A failed
contract write rolls back the entire start. The registry transfer occurs last;
a failed commit after transfer may consume the admission conservatively, but
cannot leave an active task without its stored contract.

The native field and synthetic native NAVIGATE/LOCATE/OPEN paths, managed
Chromium field/link tasks, the fixed portal and existing-Chrome fixture fill use this API.
Preparation and the dispatch boundary recheck the persisted scope and policy.
A digest retained on the task row detects accidental contract changes or
deletion instead of downgrading to the older revision-only path. These are
private journal consistency checks; hashes do not authenticate a worker or
authorize an effect. Existing action-specific validation and permits remain
necessary.

Terminal completion now stores structured evidence and the admitted verifier
reference in the same transaction as the completed state and task event. An
evidence-write failure cannot leave a completed task. Settled effect receipts
remain separate history: a late verified effect after Stop, expiry or restart
cannot reactivate or complete the task. A read-only already-matched task can
still complete through the host's fresh verifier without dispatching an action.

`getTaskRecord` returns one frozen, transactionally consistent diagnostic
snapshot containing the admission, state, budget, attempts, opt-in progress,
correction provenance and terminal evidence. [Progress tracking](TASK_PROGRESS.md) now persists verified
native/portal checkpoints and expires current references separately from their history.
This contains private goal text and must not enter provider projections or
general logs. A deserialized contract has no registry object-identity authority.
It is historical evidence, not a current UI fact, a permit or a safe-resume
decision. Restart still pauses active tasks and preserves unresolved effects.

Legacy task rows remain explicitly unbound (`admission: null`). Existing
completed rows without structured evidence also remain explicit rather than
inventing a verifier or reconstructing authority from event text. The fixed
portal now transfers its admission into the journal and persists its fixture
contract in `ScriptedPortalStore`. Its separate commits are conservatively
[reconciled at restart](PORTAL_RECOVERY.md); legacy unbound records require
review. The older synthetic `HostDispatchGate` retains the revision-only API.

The journal now has [checkpoint-bound recovery intent and correction fences](TASK_RECOVERY.md).
The [fixture replacement path](NATIVE_TASK_REPLACEMENT.md) now records unique
parent/child lineage atomically with child admission after a settled worker fence.
`replacement` and `replaces` are diagnostic links; restart cannot reconstruct
command transfer or actor authority. General/browser replacement and active
correction remain open. Stored history alone never authorizes retry or resume. See
[validation](VALIDATION.md) and the [build handoff](BUILD_HANDOFF.md).
