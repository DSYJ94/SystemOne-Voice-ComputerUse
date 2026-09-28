# Native value-action source status

`NativeAX/ValueAction.swift` is a restricted B11 driver for one semantic
Accessibility `AXValue` replacement. It is compiled into the development app
and is now routed from one explicit development-panel command through the
persistent controller and a private AppKit worker pipe. This is one explicit
field edit, not general native app control.

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

The driver tests use a synthetic backend, including interference, replay,
Stop before and during setter, and error after effect. A separate process test
exercises the controller and private pipe with a synthetic AppKit worker. These
checks prove source behavior, not a live AX effect or release security.
Before release, qualify Developer ID identity and the signed permit across
installation and update, then prove recovery and independent re-observation on
real apps. The current ledger and permit checks are development evidence.
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
The development controller now reports the Stop fence without waiting for a
pending commit receipt. It keeps that task slot occupied until the late reply
settles, and a boundary-crossed task reports uncertainty rather than success.

The development controller connects this host class to the AppKit AX worker
through inherited private pipes. One controller owns both native and managed
task slots and blocks either surface after native recovery becomes necessary.
This pipe is not an authenticated release boundary. The AppKit worker checks
one-use preparation, task, execution and permit references. It now recomputes
the protocol-2 candidate-set and action digests from its retained observation,
presented label, supplied value and fixed native policy revision before
preparing a setter. A digest consistency check is not a host signature or a
durable worker-side execution permit. The worker now also inserts the execution
ID and permit reference into its own full-sync SQLite ledger before invoking
the AX setter. A restarted worker rejects either replayed identifier, and a
storage failure returns an unknown outcome without calling the setter. This
persists replay consumption. The controller now signs a ten-second Ed25519
commit claim over the journaled permit and preparation reference. The AppKit
parent accepts its public key only from the launched controller pipe after the
bundled child passes running-code identity checks; the worker verifies the
signature, exact task/observation/candidate/digest bindings and expiry before
ledger consumption. In the external-source development build, the child code
is not authenticated, so this signature is not a release authority boundary.
The bundled build is ad-hoc signed and has no Developer ID/update/TCC
qualification. Deleting the local ledger is not an approved recovery mechanism.
No recovery-clearance API exists yet, so a stopped boundary-crossed
task intentionally stays blocked. Follow the [development test](NATIVE_COMPUTER_USE_TEST.md)
for the optional live synthetic fixture check.
