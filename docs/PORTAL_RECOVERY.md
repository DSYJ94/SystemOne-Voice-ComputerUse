# Portal checkpoints and restart reconciliation

The fixed synthetic portal now persists its exact task admission in
`AttemptJournal`, enables the shared [progress guards](TASK_PROGRESS.md), and
records verified stages beside effect history. `ScriptedPortalStore` remains a
separate progress projection. Its writes are separate commits, so startup
reconciles that projection against the journal before opening a browser worker.
This is a B15–B17 scripted foundation; it does not resume a task or enable CLM.

Start validates the fixture contract and output scope, stages the portal row,
then transfers the one-use admission into the journal. The row is not issued
to a task until journal admission succeeds. Ordinary admission failure removes
the unsent row. A crash between commits leaves an unbound row that blocks
startup recovery rather than authorizing execution. Stored contracts cannot
mint a new admission; copied/claimed admissions remain rejected.

Every advance spends a decision against a fresh actionable observation.
Preflight reserves another fresh read and binds its unique host reference to
the permit, while the permit still checks the full observation including the
document revision. Equivalent-state hashes exclude changing revisions and
read IDs; result rows are ordered by stable invoice identity. Predicate reads
and temporary/saved file verification reads spend non-actionable reservations.
These are host operation counts, not a count of every DOM RPC inside Playwright.
The shared 90-observation/30-decision/three-state-visit engineering defaults
apply; smaller host limits are checked in tests.

Dispatch expires current facts. A returned search/open/download alone supplies
no checkpoint: the independent predicate must match the exact revision and
task binding. Saved completion additionally reads the destination and compares
its hash with the verified session receipt. The final checkpoint is bound to
`portal-download-v1`; temporary download progress uses a different predicate.
Already-satisfied LOCATE/OPEN can use a fresh terminal predicate without an
action. The general managed field/link and existing-Chrome tasks retain their
earlier single-action guards and are not general portal workflows.

Host interference, verification failure or quota exhaustion pauses the journal
and projection, expires facts and settles only unsent preparations. Stop also
cancels a paused journal. Uncertain dispatched effects remain unresolved, and
a browser fence cannot undo a pending independent file save.

Recovery checks the admitted origin, invoice, title/account, query, output
binding, effects, policy and verifier. It then validates checkpoint stages,
predicates, action ordering and exact settled attempt/evidence linkage. It
never returns an active task, issues a permit, contacts a model/browser or opens
the saved/downloaded invoice file. Directory scope checks still apply.

| Durable evidence at restart | Reconciled result |
|---|---|
| Staged row with missing/unbound admission or changed bindings | Paused for review; no reconstructed authority. |
| Dispatch boundary or unknown effect | Last verified stage stays historical; uncertainty and in-flight action block replay. |
| Matched receipt without committed checkpoint | Progress is not promoted; the task remains paused for review. |
| Intermediate checkpoint committed but projection write failed | Historical stage catches up; its linked settled action can clear in-flight status, and the task remains paused. |
| Terminal checkpoint without committed completion | Historical terminal stage is retained, but the task stays paused. |
| Matching terminal checkpoint and journal completion, projection write failed | Restore already-committed completed history without executing anything. |
| Projection claims completion ahead of journal evidence | Pause and project only verified journal stages. |
| Persisted Stop before journal cancellation | Finish the cancellation fence; never reactivate the task. |

Counts, limits and checkpoint history survive recovery; current references stay
expired. Temporary download receipts are not restored into a new browser
session. Legacy portal records without a journal admission require review.
Multiple legacy records may pause together; a migrated index still restricts
active portal rows, and start refuses any paused or unresolved projection.
Reconciliation can be rerun after a projection-write interruption and remains
conservative. A storage/integrity failure may block startup rather than guess.

The journal now supplies [explicit recovery and correction APIs](TASK_RECOVERY.md),
but this projection and fixed task constructor do not yet use them. Remaining
work: actor integration with fresh portal predicates and adapter barriers,
replacement admission, safe classification of unknown effects, sleep/lock
handling and a general task actor. A release-authenticated browser
worker and real-app qualification also remain. No inference service, paid GPU,
owner browser profile, live Mac permission or user-goal resume was involved.
See [validation](VALIDATION.md) and the [handoff](BUILD_HANDOFF.md).
