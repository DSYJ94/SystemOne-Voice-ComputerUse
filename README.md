# SystemOne Voice Computer Use

A native macOS voice/text computer-use product in early development. The intended
app is a background/menu-bar agent with a transient command panel, one persistent
task controller, semantic Accessibility/DOM adapters, and CLM as its primary
decision model. Two local development bundles exercise one synthetic
Accessibility field; a separate development panel drives one managed-browser
field fill. There is no general-purpose executor or release binary yet.

## Current implementation

- Protocol 2.0 schema and the corrected independent Python conformance oracle.
- TypeScript strict JSON ingress, schema validation, bounded private-RPC framing,
  and the restricted canonical digest format.
- A pre-I/O provider policy boundary with spy-transport tests. A separate
  [fixture-only CLM probe](docs/CLM_REFERENCE_PROBE.md) can explicitly call an
  owned reference service; no model transport is connected to task execution.
  Host disclosure review is still required before approving real task input.
- A Swift digest library checked against the same Unicode and integrity fixtures.
- Final-input routing with literal dictation separation, trusted-endpoint allowlists,
  and bounded request/reply correlation with monotonic deadlines and replay rejection.
- Host-private task admission from an exact command issued by the bound final-input
  session, plus revision-, prompt-, actor-, presentation-, action- and policy-bound
  approvals that are accepted and consumed once in mock tests.
- A SQLite attempt-journal foundation that preserves uncertain dispatch across
  restart, fences journal dispatch after cancellation, and records verified
  terminal task completion. Unknown settled effects still block a new task;
  adapter and permit integration remain open.
- A fixture-scoped host dispatch gate that binds a copied candidate, target and
  argument to a one-use in-process permit and the journal. Synthetic Stop and
  stale-target tests pass; no native/browser adapter uses this gate yet.
- A loopback-only synthetic invoice portal with duplicate titles, exact detail
  identities, a delayed download control and fixed downloads. Its HTTP tests pass;
  a narrow Playwright worker now exercises search, open and download in an
  isolated temporary Chromium profile. A separate general managed-Chromium
  observer can open an explicitly scoped URL in a fresh isolated profile and
  return bounded main-document semantic controls. One admitted `FILL` task can
  now replace and verify a supported text field through an in-process permit
  and durable attempt journal. A development AppKit panel can now send one
  explicitly entered field-fill request over private pipes to a persistent
  controller, show verification, and Stop the isolated browser. This is not a
  general browser executor or an authenticated release worker.
- The existing-Chrome Manifest V3 extension source requires a toolbar click
  and exact tab/document grant. Its development path now supports one
  journaled fill of the synthetic loopback portal's `Find invoice` field,
  with a fresh semantic observation and current DOM-value check. The Swift
  native-messaging host and opt-in AppKit listener pass signed synthetic
  socket/framing checks. No host is installed in Chrome, no real profile has
  been exercised, and the action remains unqualified in a real extension.
- An ignored, movable development app bundles a checksum-verified official
  Apple Silicon Node runtime, locked production packages and Playwright
  Chromium. The AppKit parent checks the launched signed Node child's pinned
  code hash before accepting controller output; headless positive and mismatch
  checks pass. Its controller and managed-browser worker pass a synthetic portal
  smoke check after relocation. It remains ad-hoc signed and lacks the Chrome
  host, models, notarization and clean-Mac qualification; see
  [bundled runtime](docs/BUNDLED_DEV_RUNTIME.md).
- Fixture-scoped outcome checks re-observe the portal and distinguish an exact
  search result, an opened detail and a saved document. These are not wired to
  the general host controller or a production completion engine.
- A fixture-scoped durable task accepts a one-use admitted contract and runs
  portal search/open/download/save one action at a time, keeping verified progress
  and pausing after unknown in-flight outcomes. Each action requires a short-lived
  in-process permit bound to a fresh portal observation and admitted effect, then
  writes an attempt and dispatch boundary before its browser call. Stop fences both records.
  Output is confined to a private fixture directory. This is still in-process
  fixture authority, not authenticated production dispatch.
- A read-only native Accessibility observation package with bounded traversal,
  private observation-scoped handles and synthetic stale-target checks. The
  development AppKit panel can now inspect one explicitly named running app
  off its UI thread and show local labels/capabilities without field values.
  It is not yet connected to task admission, action dispatch or the controller.
- A restricted native `AXValue` driver now prepares one observed nonsecure text
  field, compares its prior value privately, and uses a one-use Stop fence and
  durable-boundary callback before setting it. Synthetic interference and Stop
  checks pass. The development panel now routes one explicit field fill through
  the persistent controller, journal and private AppKit worker pipe. This path
  recomputes candidate/action digests in the AppKit worker and has passed
  synthetic process and cross-language vector tests. A live AX run and release peer/permit
  authentication remain unverified. See [native action status](docs/NATIVE_ACTION.md).
- A separate native host task class binds a final text command, complete
  candidate set, supplied-value digest and one journaled attempt before calling
  an abstract AX worker. Synthetic Stop, late-result and unknown-effect tests
  pass. The development controller now owns both native and managed task slots;
  it blocks either surface after an unresolved native effect.
- A fixture-only managed-browser Stop path cancels the task record and closes
  the isolated Chromium context. A delayed-control test confirms no download
  request after Stop. Stop reports an incomplete worker fence when a local save
  remains pending even if Chromium has closed; already-dispatched effects remain uncertain and block a
  new scripted task until an explicit recovery path is built.
- Clarification and resume intent records bound to displayed prompts, task revisions,
  current observations and recovered checkpoints.
- A macOS Unix-socket peer verifier that binds kernel audit-token identity to
  dynamically validated signing identity and an Apple-anchored Team ID requirement
  or pinned CDHash.

Schema validity and hashes do not confer execution authority. The Python guard is
an illustrative oracle, not our production security implementation. The next work
is tracked in `docs/IMPLEMENTATION_STATUS.md`; the reviewed product specification
is under `docs/specification/`.

## Development checks

Use Node **26.5.0**, Python **3.14.6**, and Swift **6.4** on macOS for the environment
tested here. Browser tests launch a fresh headless Chromium profile against the
local synthetic portal; they do not touch existing Chrome or real accounts.

```sh
npm ci --ignore-scripts
npx playwright install --only-shell chromium
npm run check
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-test.txt
.venv/bin/python packages/protocol/validate_contract.py
npm run test:swift
npm run test:mac-peer
npm run test:chrome-host
npm run test:native-ax
```

`npm run test:mac-peer` checks a signing/peer-identity fixture in Terminal;
it does **not** launch the SystemOne Mock window. Its expected result lines
are shown in `docs/LOCAL_MAC_TEST.md`.

For the local native test build, run `npm run run:native-mock`. It stops earlier
synthetic Mock/Fixture processes from this build path before opening a fresh
Mock, so any synthetic Fixture value is reset. Its panel opens on launch; the
Dock icon can reopen it if a menu-bar manager hides **S1 Mock**.
Preview only has no effect. The build also offers one **fixture-only** action: set and verify
the `Fixture Name` field of a synthetic app through macOS Accessibility. It has no
general computer-control capability. See `docs/FIXTURE_COMPUTER_USE_TEST.md` for
the opt-in local steps and exact limits.
On 27 September, the owner confirmed the current Mock set `fixture-123` through
Accessibility and the separate Fixture showed that value. Reset feedback has
not yet been observed. The guided steps distinguish the mock's input from the
target field.
On 27 September, the current ad-hoc-signed Mock reported untrusted despite an
enabled macOS toggle after a rebuild. Its grant was reset for this bundle ID
only; the owner then granted the current build and confirmed Fill. This Mac has
no valid development signing identity, so rebuilds may require renewed approval until
stable development signing is configured.

The XCTest suite requires an SDK providing XCTest; it could not run with this
machine's command-line-tools installation. The standalone parity check did pass:
`swift run --package-path packages/protocol/swift DigestCheck tests/fixtures/digests.json`.
The peer-identity check is macOS-only and uses temporary ad-hoc-signed binaries;
it does not require or qualify a release signing identity.
See `docs/VALIDATION.md` for the actual commands and environment limitations.
See `docs/EXISTING_CHROME.md` for the extension's grant model and remaining
native-host work.
For the current native-to-managed-browser development test, follow
`docs/NATIVE_MANAGED_TEST.md`. It uses only the synthetic portal and needs no
Accessibility permission.
The separate [native inspection test](docs/NATIVE_INSPECTION_TEST.md) exercises
read-only Accessibility observations and requires a grant to the current Dev build.
For the current PR stack, open gates and next implementation order, see
`docs/BUILD_HANDOFF.md`.

`npm run fixtures` regenerates shared digest vectors. Fixture changes must preserve
the schema's existing golden digests unless the contract is intentionally revised.
Python and Swift remain independent checks of the TypeScript fixture output.

CLM/ASR model downloads, release signing, microphone capture, live native fixture
editing, live existing-Chrome automation and remote inference are not part of the automated
check commands above. The automated browser check covers only the synthetic
portal in an isolated profile. The opt-in native fixture test is separate. Do not add models
to the effect path until scripted drivers and durable dispatch/Stop tests pass.

## Repository and publication

The source is licensed under MIT; see `LICENSE`. The GitHub repository is private
under `DSYJ94/SystemOne-Voice-ComputerUse`. `private: true` continues to prevent
accidental npm publication. Release signing identity and third-party model/runtime
redistribution clearance remain separate release requirements.

Dependency versions are locked in `package-lock.json` and `requirements-test.txt`.
See `docs/DEPENDENCIES.md` for purposes, license observations, update boundaries and
replacement paths. Never commit credentials, user traces, model weights or browser
profiles. Existing local review artifacts and their virtual environment are
excluded from Git; the approved specification and a portable implementation record
are versioned.
