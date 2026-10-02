# Native field replacement admission

A settled retained paused field task can now accept an explicit changed field or
literal value for its original target. The AppKit developer panel provides
**Replace field goal…** with **Keep Paused** and **Replace Goal**. Replacement
never captures a new foreground app. A captured bundle/PID/launch binding must
remain identical; an explicit bundle target cannot silently become a captured
process or another app. Active-operation correction and cross-surface changes
remain open.

## Command and execution ownership

`replace_native_field` is an exact private-pipe request containing a new request
ID, the source task ID and replacement parameters. Its final text or voice
command identifies the source task, epoch 1 and exactly the next goal revision.
Unchanged field/value, malformed parameters, altered targets, stale revisions,
non-final input and unrecognized sources are rejected before cancelling the old
task or asking its worker to Stop. Unknown earlier effects require reconciliation
first; correction cannot use a new goal to bypass them.

The retained actor durably records correction cancellation and Stops its old
worker task. No replacement read occurs until the fence succeeds and the actual
old operation has settled. A failed fence blocks intake; no child is admitted.
After a successful fence, the already claimed correction transfers exactly once
into a new task ID. The host freezes the accepted request before awaiting Stop,
so caller mutation cannot alter its ID, target, field or value.

The child obtains a fresh scoped observation, final-command parameter bindings,
admission, progress limits and one-use permits. It inherits no handles,
checkpoints, completion evidence or Resume authority. The journal retains the
cancelled source, correction provenance and parent/child lineage. Setter receipts
still require an independent current-value observation for terminal completion.
The panel sends canonical literal suffix text, preserving empty values and
leading/trailing whitespace without inventing a value or reparsing old input.

## Stop, recovery and host interruption

The old source remains the panel's Stop target while correction owns the global
controller slot. Stop during fencing prevents child observation; Stop during the
new observation fences the actual derived worker task and prevents admission.
After child admission and run settlement, a validated `native_replacement_task`
with mode `fill` transfers panel ownership before child status is delivered.
Only the immediate durable parent is a permitted pending-Stop alias; unrelated
or older ancestor IDs cannot cancel a descendant.

The child can itself pause, recover with a freshly presented exact Resume, or
receive another explicit changed goal at the next revision. A late setter reply
can settle only that child's history. Stop retains the slot until actual
operation settlement, and unresolved effects or required reconciliation keep
new intake blocked. Session loss uses the same Stop path, invalidates the
transition and never resumes it after wake. Restart preserves history but does
not recreate the correction transfer, input capability or live actor.

## Evidence and remaining gates

Linux synthetic regressions cover changed field/value, provenance and completion,
invalid/unchanged input, process binding, repeated correction, exclusive intake,
Stop during fencing/observation/setter, failed fences, unknown edits, interruption,
final voice metadata, empty literals, restart refusal and caller mutation while
Stop is pending. Foundation intake checks cover retained target/goal tracking,
handoff identity/revision, failed delivery, concurrent replacement and empty
literal submission. Swift/AppKit and those Foundation checks are source only
in this Linux environment.

Mac compilation, sheet selection/Stop/session/focus races, physical AX effects,
live voice and supported app qualification remain required. This extends field
correction within the current bounded adapter; general active correction,
restart reconstruction, recovery across sessions, primary CLM integration,
existing-profile Chrome and release gates remain open. No owner app, TCC or
Keychain action was performed. V1 is not ready; the prior owner goal stays dropped.
