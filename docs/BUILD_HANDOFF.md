# Build handoff

Updated 27 September 2026. This is the current implementation handoff, not a
release claim. Read this with [implementation status](IMPLEMENTATION_STATUS.md),
the [fixture test](FIXTURE_COMPUTER_USE_TEST.md), and the reviewed
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
  [#7 managed browser](https://github.com/DSYJ94/SystemOne-Voice-ComputerUse/pull/7).
  These are stacked drafts; evaluate or merge in dependency order.
- The working branch for the next slice starts at `codex/managed-browser-driver`.
  Preserve the existing untracked local review files `EXECUTION_ASSESSMENT.md`
  and `approval-record.patch`; they are not implementation inputs.

## Evidence and open gates

The synthetic protocol, journal, dispatch-gate, loopback portal and managed
Chromium tests pass. On this Mac, an earlier user-authorized mock changed one
synthetic fixture field through Accessibility and independently re-observed it.
The revised Reset feedback is compiled but awaits the owner's renewed manual
test. The owner has the [exact test steps](FIXTURE_COMPUTER_USE_TEST.md); record
their result separately from automated evidence.

`npm run check` is the TypeScript/Node suite; `npm run build:native-mock`
compiles the two ad-hoc-signed local bundles. `npm run test:mac-peer` checks a
temporary signing/audit-token identity fixture. Full commands, actual results
and limitations are in [validation](VALIDATION.md). The Swift XCTest suite needs
an SDK with XCTest; the installed command-line-tools SDK cannot run it.

The native mock does not use the TypeScript journal/dispatch gate. Managed
Playwright operations have no qualified Stop boundary. Existing Chrome is not
connected. Host/helper release identity, TCC attribution after installation and
update, voice, CLM inference, privacy review, crash recovery across real workers,
packaging/notarization and clean-Mac installation are unverified. Treat effects
that may have crossed a worker boundary as unknown until re-observed; Stop cannot
undo an already-dispatched effect.

## Next implementation order

1. Extend the initial B16 portal outcome predicates into an admitted, persistent
   scripted task. The current predicate distinguishes found, opened and saved
   exact-invoice states; the next step must preserve explicit parameters and
   verified progress across actions without calling progress success. Keep this
   model-free.
2. Integrate B03/B09/B15 host authority, authenticated worker identity, durable
   permit consumption and a real native/managed-browser Stop barrier. Qualify
   dispatch timing and unknown outcomes before broadening native or browser
   actions. Extend B05 fixtures for interference and recovery cases.
3. Build B04/B07/B08 signed native UX and B10/B11 general native observations/
   actions; add B12 headed managed workflows with explicit limits. Prove clean
   installation and TCC attribution on an authorized Mac.
4. Complete B13 candidate projection, scripted B15-B17 multi-hop/recovery and
   B18 transitions; then qualify CLM under B14. B19 existing-Chrome extension
   and native-messaging bridge is a beta gate, with current-profile and
   reconnect/revocation tests. Do not substitute managed Chromium for B19.

Release gates G1-G6 remain unverified; consult the review handoff and status
before changing scope. Optional model/training/vision research must not block a
configuration that does not ship it.
