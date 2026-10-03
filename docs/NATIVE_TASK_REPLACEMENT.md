# Native fixture replacement admission

The developer panel's **Replace fixture goal…** action offers the other two
synthetic fixture outcomes and **Keep Paused**. It operates only on a retained,
settled, paused Documents/NAVIGATE, LOCATE or OPEN actor. Selecting an outcome
submits a final typed correction at the next goal revision. The host rejects
unchanged goals, voice/dictation, arbitrary apps/files, skipped revisions,
foreign task IDs and reused replacement IDs before cancelling anything.

The private inherited pipe request is `replace_native_fixture`, carrying the
source task ID, a fresh replacement request/task ID, exact fixture mode and
command/parameters. The controller owns one exclusive slot throughout correction,
worker fencing, fresh observation, new admission and execution. Active tasks,
other surfaces and restarted actors cannot use this path.

## Correction and provenance

`cancelTaskForCorrection` atomically cancels the old revision, expires its facts
and pending reads, settles only unsent preparations and records the exact
command digest. It uses the input session's distinct `claimForCorrection`;
an ordinary admission claim cannot become correction transfer authority.
`PersistentTaskActor.correct` closes prompts and revokes workflow generation
before independently stopping the actual worker. The fixture authority requires
a successful worker fence, settled operations, no unresolved effects and no
other unfinished task before any replacement observation.

Only then does `transferClaimedCorrection` transfer that exact accepted command
once into a derived input session. It changes task ID and epoch to the fresh
child identity, keeping goal revision, message ID, text, utterance, timestamp and
origin provenance. It does not reaccept command JSON. Copied, foreign, unclaimed,
ordinarily admitted or previously transferred command objects cannot transfer.
The original command digest and source revision remain available as immutable
host diagnostics in that session, never as serialized authority.

Fresh scope discovery and `TaskAdmissionRegistry` create a new one-use admission.
The journal verifies source cancellation, source epoch/next revision and exact
correction message/digest, and writes the admission plus unique parent/child
link in the same transaction. A forged admission, inconsistent correction,
second child or unrelated paused task rolls back the child and link.
`getTaskRecord().replacement` and `.replaces` expose both sides for diagnostics.
Opening an older journal adds the lineage table without rewriting old history.

The old admission, revision, budgets, attempts and checkpoints remain immutable
history. The explicitly changed goal gets fresh host limits, scope, facts and
checkpoints. It cannot inherit evidence from its parent or silently reset the
same goal's limits. Current state may already satisfy the new outcome, but only
fresh independent predicate evidence can complete that task. No old effect is
undone, replayed or declared safe by a correction or worker acknowledgment.

## Stop and panel ownership

Until the run settles the panel keeps the old task as its active Stop target.
The controller accepts that source ID and the exact current child ID for this
run and fences the authority's actual pending worker task. Stop during the old
fence prevents child reads; Stop during child scope discovery prevents admission.
Other controller intake stays busy throughout.

After an admitted child settles, `native_replacement_task` transfers panel
ownership before child status is emitted. Intake validates the exact pending
IDs, next revision and chosen outcome; stale handoffs and source-ready statuses
cannot release the child. A pending old UI Stop targeting the immediate source
also reaches its exact retained paused child through the durable link. This
alias does not target unrelated tasks or later descendants. Recovery sheets
now bind to the intake's current goal revision rather than hard-coding revision 1.

Rejected requests clear only pending replacement intake. If a valid correction
has cancelled the source but no child was admitted, a settled fence with no
uncertainty can release intake. Failed fences or unknown effects remain blocked.
Once a replacement has paused, further correction requires another explicit
changed command; restart does not recreate transfer or actor authority.

## Evidence and remaining work

Nineteen added Linux regressions cover command ownership, lineage/rollback and
restart history, valid changed outcomes and revisions, unchanged/invalid input,
failed fences, unknown effects, absent inherited checkpoints, exclusive intake
and Stop during fencing/observation and after ownership transfer. The full suite
passes 407 tests with two Mac-only skips; source inventory and six checks pass.
The extended Foundation intake check and AppKit sheet are source changes only:
Linux has no Swift/AppKit toolchain. Mac compilation, sheet selection/Stop/focus
races and live AX execution remain required.

This is bounded fixture correction, not general replacement across all surfaces.
Active-operation correction, field-fill/browser actor integration, restart
reconstruction, unknown-effect reconciliation, sleep/lock and qualified primary
CLM, owner-profile Chrome and release workers remain open. Next source milestone:
move native field fills under the persistent actor and establish their semantic
observation/completion contract. The previous owner goal remains dropped from
the work plan; no owner-app execution or owner journal change occurred here.
