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
  [#20 managed-browser observation](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/20).
  These are stacked drafts; evaluate or merge in dependency order.
- The current implementation branch is `codex/managed-browser-observation`,
  stacked on `codex/chrome-native-host-bridge`.
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
Separately, a general read-only managed-Chromium observer now opens an exact
approved origin in an isolated profile and returns bounded main-document
controls with explicit frame/shadow/truncation gaps. It issues no action permit
and is not connected to the app or durable task controller.
It fences both stores on Stop. Stop distinguishes browser context closure from
an independent local save still pending and reports an incomplete worker fence
for the latter. Context closure does not prove an already-dispatched action had
no effect; the two stores lack one atomic transaction and
the path has no OS-authenticated host/worker boundary. An existing-Chrome
extension source now has explicit one-tab read-only grants. A Swift
native-messaging host passes a signed synthetic framing/peer check and
exact-origin manifest staging, but no host is installed, no controller listener
exists and no real Chrome action works.
Host/helper release identity, TCC attribution after installation and
update, voice, CLM inference, privacy review, crash recovery across real workers,
packaging/notarization and clean-Mac installation are unverified. Treat effects
that may have crossed a worker boundary as unknown until re-observed; Stop cannot
undo an already-dispatched effect.

## Next implementation order

1. Move the in-process portal permit issuer behind authenticated B03/B09/B15
   host/worker IPC. The scripted task still calls Playwright directly from
   trusted code in the same process; its durable candidate/argument digests and
   one-use permits do not authenticate an OS peer. Preserve the
   already-dispatched uncertainty and make Stop's worker fence measurable.
   Extend the B10 read-only native observer to an approved live fixture under
   the authenticated host; build B11 actions only after authority/Stop tests.
2. Integrate B03/B09/B15 host authority, authenticated worker identity, durable
   permit consumption and a real native/managed-browser Stop barrier. Qualify
   dispatch timing and unknown outcomes before broadening native or browser
   actions. Extend B05 fixtures for interference and recovery cases.
3. Build B04/B07/B08 signed native UX and B10/B11 general native observations/
   actions; add B12 headed managed workflows with explicit limits. Prove clean
   installation and TCC attribution on an authorized Mac.
4. Complete B13 candidate projection, scripted B15-B17 multi-hop/recovery and
   B18 transitions; then qualify CLM under B14. For B19, connect the signed
   host source to an authenticated controller protocol, package/register the
   exact-origin manifest and test on a separate profile, then qualify the
   owner's current-profile and reconnect/revocation cases. Do not substitute
   managed Chromium for B19.

Release gates G1-G6 remain unverified; consult the review handoff and status
before changing scope. Optional model/training/vision research must not block a
configuration that does not ship it.
