# Build handoff

Updated 28 September 2026. This is the current implementation handoff, not a
release claim. Read this with [implementation status](IMPLEMENTATION_STATUS.md),
the [fixture test](FIXTURE_COMPUTER_USE_TEST.md),
[managed-browser status](MANAGED_BROWSER.md), and the reviewed
[backlog](specification/BACKLOG.md). Keep this file and the README aligned as
each implementation slice lands.

## Product boundary

The authorized beta scope is native macOS apps, an isolated managed Chromium
profile, and **existing Chrome with the user's current profile, data and tabs**.
CLM remains the primary decision model. Laya is a separately qualified option;
Jev is an explicitly enabled external fallback. The eventual app is a signed
menu-bar/background app with a transient typed/dictation interface, push-to-talk,
one persistent task controller, semantic observations/actions, bounded Stop,
durable recovery and truthful completion. None of those broader capabilities is
established by the current fixture-only native or browser tests.

## Current checkout and work

- Private remote: `DSYJ94/SystemOne-Voice-ComputerUse`; MIT source license.
- The reviewed specification is versioned in `docs/specification/`.
- Draft PR stack: [#3 native fixture](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/3),
  [#4 attempt journal](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/4),
  [#5 dispatch gate](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/5),
  [#6 portal fixture](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/6),
  [#7 managed browser](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/7),
  [#8 handoff and outcome checks](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/8),
  [#9 native fixture launch recovery](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/9),
  [#10 scripted task and TCC development fix](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/10),
  [#11 read-only native observation foundation](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/11),
  [#12 managed-browser Stop fence](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/12),
  [#13 journal completion and unknown effects](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/13),
  [#14 scripted portal journal integration](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/14),
  [#15 command-bound portal admission](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/15),
  [#16 local-save Stop fence accounting](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/16),
  [#17 portal action permits](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/17),
  [#18 existing-Chrome attachment](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/18),
  [#19 Chrome native-host transport](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/19),
  [#20 managed-browser observation](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/20),
  [#21 admitted managed-browser fill](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/21),
  [#22 native-to-managed development bridge](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/22),
  [#23 native read-only inspection](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/23),
  [#24 guarded native value driver](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/24),
  [#25 journaled native task authority](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/25),
  [#26 development native controller bridge](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/26),
  [#27 existing-Chrome controller read path](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/27),
  [#28 guarded existing-Chrome loopback fill](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/28),
  [#29 movable bundled development runtime](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/29),
  [#30 fixture-only CLM reference probe](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/30),
  [#31 bounded development Stop acknowledgement](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/31),
  [#32 bundled controller running-code identity](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/32),
  [#33 native worker digest binding](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/33),
  [#34 native worker replay ledger](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/34),
  [#35 controller-signed native permit](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/35),
  [#36 managed semantic navigation](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/36),
  [#37 guarded Chrome host registration](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/37),
  [#38 isolated Chrome native transport](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/38),
  [#39 Chrome host/listener integration](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/39),
  [#40 Chrome action-scoped grant](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/40),
  [#41 isolated Chrome journaled fill](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/41).
  These are stacked drafts; evaluate or merge in dependency order.
- The current implementation branch is `codex/chrome-stop-transport`,
  stacked on `codex/chrome-journaled-fill`.
  Preserve the existing untracked local review files `EXECUTION_ASSESSMENT.md`
  and `approval-record.patch`; they are not implementation inputs.

## Evidence and open gates

The synthetic protocol, journal, dispatch-gate, loopback portal and managed
Chromium tests pass. On this Mac, an earlier user-authorized mock changed one
synthetic fixture field through Accessibility and independently re-observed it.
The current owner-authorized Mock again changed one synthetic Fixture field
through Accessibility after its grant was renewed. Revised Reset feedback is
compiled but still awaits observation. The [exact test steps](FIXTURE_COMPUTER_USE_TEST.md)
and result remain separate from automated evidence.
The local launcher now restarts the two exact-path synthetic processes before a
rebuild and refuses direct in-place builds while they run. A fresh Fixture
reopened without a crash after the 27 September incident. The owner's in-Mock
Fill succeeded; Reset feedback is still pending.
An enabled Accessibility toggle did not grant the rebuilt ad-hoc Mock. Its
current-binary grant was reset for this app only, and a fresh user grant is
now confirmed by the owner: the Mock reported Verified and the Fixture showed
`fixture-123`. Reset feedback was not shown. No valid development signing
identity is installed on this Mac; the
build accepts `SYSTEMONE_CODESIGN_IDENTITY` when one becomes available.

`npm run check` is the TypeScript/Node suite; `npm run build:native-mock`
compiles the two ad-hoc-signed local bundles. `npm run test:mac-peer` checks a
temporary signing/audit-token identity fixture. Full commands, actual results
and limitations are in [validation](VALIDATION.md). The Swift XCTest suite needs
an SDK with XCTest; the installed command-line-tools SDK cannot run it.
`npm run test:native-ax` compiles a separate B10 read-only Accessibility
observation package and runs synthetic registry checks. It does not attach to
the Mock or observe any live app. It was built without changing the currently
granted Mock binary.

The native mock does not use the TypeScript journal/dispatch gate. The scripted
managed-browser task now accepts only a one-use admission from the bound final
input session and checks its exact fixture contract. Each scripted action requires
a short-lived in-process permit bound to task revision, stage, effect and a fresh
portal observation before its journal dispatch boundary.
Separately, a general managed-Chromium observer now opens an exact
approved origin in an isolated profile and returns bounded main-document
controls with explicit frame/shadow/truncation gaps. One admitted `FILL` task
now uses a one-use in-process permit, private DOM handle revalidation, a
durable dispatch boundary and current field-value verification. A development
AppKit panel sends that one action to a persistent Node controller over
inherited private pipes. A successful fill leaves Chromium open for inspection;
Stop fences the journal and closes the isolated context, while any dispatched
uncertainty remains unresolved. The development bundle points to external
source and Node paths; its child is not authenticated as a release worker.
See [native managed test](NATIVE_MANAGED_TEST.md).
The panel now also accepts one explicit managed `NAVIGATE` task: it matches an
observed plain link to a user-supplied exact same-origin destination, journals
one permit, and re-observes arrival before reporting it. It does not treat
arrival as proof that a named item was opened. Stop and uncertainty use the
same browser fence. See [managed navigation test](MANAGED_NAVIGATION_TEST.md).
The development AppKit build now also compiles the B10 read-only
Accessibility observer and can inspect one exact running bundle by explicit
user input. Labels and capabilities remain local; field values are not read.
Compilation and synthetic registry checks pass; live observation remains
unverified while the earlier manual browser test stays available. See
[native inspection test](NATIVE_INSPECTION_TEST.md).
The B11 source includes a guarded native `AXValue` driver and synthetic
Stop/interference checks. The development panel can now submit one exact
native field edit through the same persistent controller used for managed
Chromium. A private pipe connects the journaled host task class to the AppKit
AX worker. The process-level test uses a synthetic worker; a live action through
the new bridge is pending. The external-source controller is unauthenticated;
the bundled child now has a code-hash check and a worker-verified per-process
permit, but no release identity is qualified. See [native action status](NATIVE_ACTION.md) and the
[optional native test](NATIVE_COMPUTER_USE_TEST.md).
It fences both stores on Stop. Stop distinguishes browser context closure from
an independent local save still pending and reports an incomplete worker fence
for the latter. Context closure does not prove an already-dispatched action had
no effect; the two stores lack one atomic transaction and
the path has no OS-authenticated host/worker boundary. An existing-Chrome
extension source now has explicit one-tab read-only grants. A Swift
native-messaging host, opt-in AppKit listener and Node controller read session
pass signed synthetic framing and strict binding tests. Exact-origin development
artifacts can be staged without installation. No host is installed in Chrome,
no real profile has been observed. A narrow journaled Chrome field-fill source
exists for the loopback portal fixture. An isolated Chromium run now verifies
its DOM edit and durable receipt through signed host/listener peers.
An opt-in Chrome per-user manifest installer now checks the staged signed host,
exact origin and configuration. Its install/verify/remove checks use only a
temporary synthetic directory. Release bundling and a separate-account
extension-to-host qualification still precede any owner-profile test.
A temporary Playwright Chromium profile now connects a test-modified copy of
the production extension to the signed Swift host and a signed test executable
built from the production `DevChromeListener` source. Both peer identities are
checked, with changed hashes rejected. The production service-worker source
observes and fills a semantic fixture field after Chromium's test-only extension
action trigger grants `activeTab`, then revokes the grant on reload. A second
edit followed by Stop and a delayed matched receipt remains unresolved after
the grant is revoked. A physical toolbar click, complete AppKit integration and
installed Google Chrome remain open.
The isolated handler also fails to observe a tab without a browser host grant;
the successful read needs the action-triggered `activeTab` grant.
Host/helper release identity, TCC attribution after installation and
update, voice, CLM inference, privacy review, crash recovery across real workers,
packaging/notarization and clean-Mac installation are unverified. Treat effects
that may have crossed a worker boundary as unknown until re-observed; Stop cannot
undo an already-dispatched effect.
An ad-hoc bundled development app now starts its controller and managed
Chromium worker from internal Node, npm and browser assets after relocation.
This is a B27 packaging foundation; it is not Developer ID signed, notarized,
or a clean-Mac test, and the Chrome native host is still external. See
[bundled runtime](BUNDLED_DEV_RUNTIME.md).
A fixture-only [CLM reference probe](CLM_REFERENCE_PROBE.md) now serializes
full candidate descriptions to the pinned CLM choice API and validates its
response shape. It has not contacted a model service or qualified any weights;
B02 and G1 remain open.
The development controller now acknowledges native and existing-Chrome Stop
from their worker fences without awaiting delayed action receipts. Managed
Chromium Stop closes an available context with a bounded wait; an in-flight
launch reports uncertainty and remains blocked. These are source and synthetic
process checks, not release-authenticated Stop evidence.
The bundled development AppKit parent now checks its launched Node child's
running code identity against a signed-bundle CDHash pin before processing
controller output or issuing commands. A changed-hash app copy was rejected.
External-source development mode is still unauthenticated, and release peer
identity remains open.
The native AppKit worker now recomputes candidate/action digests from its
retained observation and supplied value before preparing the AX setter. A
Swift/TypeScript vector check passes; no live AX action was re-run for this
change. It also writes execution and permit identifiers to a full-sync,
worker-owned SQLite ledger before the AX setter; restart replay is denied in
isolated process checks. Neither digest agreement nor identifier consumption
authenticates the development host or constitutes a release permit.
The controller now issues a short-lived Ed25519 commit claim. The worker checks
its signature and exact retained task/observation/candidate bindings before
durable consumption. A cross-language negative suite and bundled AppKit
identity/key-handoff smoke pass. The ad-hoc bundle is not a Developer ID release,
and external-source mode still lacks code authentication.

## Next implementation order

1. Qualify the new native panel-to-controller-to-AX path on the synthetic
   Fixture with an explicit user test. Capture the verified result and Stop
   behavior without claiming general native control. Authenticate the release
   host/worker boundary under Developer ID signing and qualify the signed
   permit across installation, update and crash recovery.
2. Integrate B03/B09/B15 host authority, release worker identity, signed
   permit validation and a real native/managed-browser Stop barrier. Qualify
   dispatch timing and unknown outcomes before broadening native or browser
   actions. Extend B05 fixtures for interference and recovery cases.
3. Build B04/B07/B08 signed native UX and B10/B11 general native observations/
   actions; add B12 headed managed workflows with explicit limits. Prove clean
   installation and TCC attribution on an authorized Mac.
4. Complete B13 candidate projection, scripted B15-B17 multi-hop/recovery and
   B18 transitions; then qualify CLM under B14. For B19, qualify the staged
   host/listener/extension path and fixed loopback fill in a separate macOS
   test account; then extend the effect policy, Stop/reconnect and
   current-profile tests.
   Do not substitute managed Chromium for B19.

Release gates G1-G6 remain unverified; consult the review handoff and status
before changing scope. Optional model/training/vision research must not block a
configuration that does not ship it.
