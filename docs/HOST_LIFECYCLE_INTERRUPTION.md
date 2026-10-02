# Host session interruption

The AppKit development host sends complete sleeping/session-active snapshots on
its owned controller pipe. Each snapshot has a strictly increasing sequence;
old or replayed wake messages cannot release a newer suspension. AppKit-launched
controllers require an initial snapshot before admitting execution. The trusted
snapshot supplies availability only, never a task, Resume intent or authority.

Sleep and session loss immediately block new tasks, replacement admission and
recovery presentation/Resume. The controller cancels its active task through
existing bounded Stop barriers, including the retained paused native actor.
Worker replies and Chrome Stop/result frames remain receivable so effects can
settle in their original journal. A failed fence or unresolved effect continues
to block intake after wake; a late reply cannot imply terminal success or permit
a retry. Completed native tasks and their checkpoints are preserved.

After Stop, the controller revokes retained Chrome sessions, grants and reads by
closing host connections. It never closes owner tabs. The extension must grant a
new connection before future Chrome execution. No grant is reconstructed from a
snapshot. AppKit clears its displayed grant and captured target, cancels voice
capture and inspection, and dismisses recovery presentation on interruption.
Ordinary application deactivation remains distinct from session loss: switching
to the target app must not cancel computer use.

Wake supplies a new availability snapshot. It never resumes or starts execution.
The UI waits for the matching snapshot acknowledgment and completion of the Stop
operation, and the controller still applies active-task and unresolved-effect
checks. The next task requires explicit fresh submission. The current native
worker permanently cancels stopped task IDs; same-task Resume across these
interruptions is not implemented. Existing explicit Resume is for retained
paused actors within an uninterrupted host session.

Linux evidence covers monotonic snapshots, initial admission denial, pending and
failed Stop barriers, cancellation before admission, retained checkpoints,
late dispatched effects, real managed Chromium cleanup and private-pipe Chrome
grant revocation using synthetic extension frames. Swift/AppKit source is
uncompiled here. `NSWorkspace` sleep/wake and session notifications, plus the
initial `CGSessionCopyCurrentDictionary` console/login check, do not establish
physical screen-lock detection or a Stop deadline before hardware sleeps.

B17 remains open. On Mac, compile the app, verify initial session state, sleep
and wake while observing and while an effect is in flight, fast user switching,
actual lock/unlock coverage, stale prompts/voice callbacks, Chrome reconnection,
and unknown outcomes. Add separately authorized fresh worker leases before
claiming same-task recovery across sessions. No TCC/Keychain changes or owner-app
actions were performed by this source milestone.
