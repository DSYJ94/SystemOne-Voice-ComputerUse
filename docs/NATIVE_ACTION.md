# Native value-action source status

`NativeAX/ValueAction.swift` is an unexposed B11 driver for one semantic
Accessibility `AXValue` replacement. It is compiled into the development app
but has no UI command or controller route. No native app action is available
through SystemOne Dev yet.

Preparation requires one retained observation-scoped node ID, exact target
PID/bundle/path/launch identity, an enabled nonsecure text field with a
`setValue` capability, an expected label and a bounded supplied value. The
worker reads the prior field value only to compare before writing; it never
returns or logs that value. A changed node, target or prior value prevents the
setter. Duplicate labels remain distinct node IDs. The host must choose and
authorize one candidate; a label alone is insufficient.

`PreparedNativeValue.send` has a one-use Stop fence and calls a host-supplied
durable dispatch-boundary callback before `AXUIElementSetAttributeValue`. If
the callback fails, it sends no setter. A setter error, timeout or failed
re-observation is **unknown**, because the field might already have changed.
Stop registered during preflight prevents a setter; Stop acknowledgement
waits for any setter already entered to return. An AX call that ignores its
messaging timeout can therefore delay acknowledgement. Stop never undoes a
value already set. A late result after Stop must not complete the task.

The current tests use a synthetic backend, including interference, replay,
Stop before and during setter, and error after effect. They prove this source
API's behavior only. Before exposing an action in the app, connect the single
host task admission, candidate digest, one-use permit, journal transaction,
worker identity, UI Stop barrier, independent re-observation and recovery.
Do not infer permission from a model proposal or from a successful read-only
inspection. App-specific semantics, secure controls, focus changes and other
native operations remain separate qualification work.

`packages/runtime/src/native-fill-authority.ts` now owns a synthetic host-side
task path for this operation. It accepts only a bound final text command,
selects one exact candidate from a complete observation, records the admitted
source-value digest, prepares one journal attempt, writes the dispatch marker
before worker commit, and verifies a no-effect existing match separately.
Stop aborts preflight and waits up to three seconds for the worker fence;
boundary-crossed tasks remain blocked for recovery even if a late verified
receipt settles their history. An unconfirmed fence or unknown effect blocks
new native starts. Seven synthetic worker tests exercise those transitions.

This host class is **not yet connected** to the AppKit process or real AX
driver. Its `NativeFieldWorker` interface is an in-process test contract, not
proof of a signed worker, authenticated peer, durable worker-side permit or
cross-surface one-writer authority. No recovery-clearance API exists yet, so a
stopped boundary-crossed task intentionally stays blocked. The next integration
must supply those boundaries before native actions are enabled in the UI.
