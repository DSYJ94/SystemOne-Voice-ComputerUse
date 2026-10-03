# Native field persistent execution

Native field fills now use `NativeFieldTask` and `PersistentTaskActor` through
`NativeFillAuthority`. Exact final input binds both the field label and value
spans. Existing signed worker permits, native scope and durable dispatch remain
the effect boundary; model output cannot authorize a setter.

The first budgeted read creates a nonterminal `field_ready` checkpoint for one
eligible enabled, nonsecure, settable field. A verified worker receipt then
requires a separate fresh value verification before `field_filled` evidence and
terminal completion commit. An already-matched field also needs that independent
read. Observation, decision and effect budgets remain durable across pause.
Field values stay inside the worker; semantic predicates retain parameter hashes.

A settled paused actor can offer Check recovery and explicit Resume through the
same private controller/presentation ledger used by fixture recovery. Two fresh
reads must reproduce eligibility and the original process scope. Exact visible
one-use Resume intent preserves the original deadline, quotas and history.
Changed label, secure state or process identity rejects recovery. Recovery cannot
skip an applied effect lacking terminal evidence or resolve an unknown effect.

Stop fences both active and retained paused field actors. A pending operation
that ignores cancellation retains ownership until actual settlement. Shutdown
waits for that operation before journal close. Late results cannot complete a
stopped task; uncertain effects and failed fences continue blocking intake.

The Swift worker now retains process identity for field and fixture reads and
rechecks eligibility during independent value verification. These source changes
are uncompiled in Linux. Ten added synthetic authority/controller regressions
and the signed child-pipe path pass; no live Mac, voice or owner-app test ran.

Field replacement, restart reconstruction of private bindings, general semantic
actions, sleep/lock recovery, CLM integration and release qualification remain
open. The previous owner goal remains dropped. See [v1 readiness](V1_READINESS.md).
