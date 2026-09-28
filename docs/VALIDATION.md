# Initial foundation validation

26 September 2026; macOS 26.6.2 arm64, Node 26.5.0, npm 11.17.0,
Python 3.14.6, Swift 6.4 (swiftlang-6.4.0.34.1), command-line-tools SDK MacOSX27.0.
These are development checks, not production qualification.

| Command | Actual result |
|---|---|
| `npm install --ignore-scripts --no-fund --cache /private/tmp/systemone-npm-cache` | Installed locked packages; installation audit reported zero vulnerabilities. |
| `npm run check` | TypeScript typecheck passes; 45 tests pass, zero fail/skip. Repeated after framing closure correction. |
| `review-work/.venv/bin/python packages/protocol/validate_contract.py` | 104/104 checks pass with jsonschema 4.26.0 and format extras. The existing isolated review environment supplied the dependencies pinned in requirements-test.txt. |
| `npm run fixtures` | Generated four shared digest fixtures. Three protocol golden hashes also match the Python oracle. |
| `swift test --package-path packages/protocol/swift --cache-path /private/tmp/systemone-swift-cache` | Initial sandbox attempt failed writing compiler cache. With temporary cache environment variables, nested compiler sandbox was denied. Authorized execution then reached compilation but failed because XCTest is unavailable in this SDK. XCTest tests remain unverified. |
| Standalone Swift command below | Compiled successfully; all four shared canonical/digest vectors and three invalid-value checks pass. Linker emitted warnings about absent command-line-tools Developer framework/library search paths. |

Exact successful Swift command (run with execution permission for the compiler sandbox):

```sh
CLANG_MODULE_CACHE_PATH=/private/tmp/systemone-clang-cache SWIFTPM_MODULECACHE_OVERRIDE=/private/tmp/systemone-clang-cache swift run --package-path packages/protocol/swift --cache-path /private/tmp/systemone-swift-cache DigestCheck tests/fixtures/digests.json
```

The initial Node test run exposed library object-prototype and module-interop
differences. The implementation was corrected and the original assertions retained.
No tests were disabled to get the reported pass.

Dependencies: ajv 8.20.0, ajv-formats 3.0.1, jsonc-parser 3.3.1,
TypeScript 7.0.2, @types/node 26.6.3. Exact transitive pins are in package-lock.json;
the independent Python environment is pinned in requirements-test.txt.

Not tested: full Swift protocol decoding, authenticated IPC, concurrent dispatch,
durable permits/journaling, Stop, crash recovery, any Accessibility/DOM workflow,
TCC attribution, signing/notarization, microphone/ASR, models, remote inference,
clean-Mac installation or release reproducibility. No live apps or accounts were
operated and no model weights or OS permission grants were requested.

The local Git repository is initialized on main. The owner subsequently selected
Daryl <darylseow@hotmail.com> as commit author, a private GitHub repository, and MIT
licensing. These repository administration changes do not alter the test results.

## Input/reply foundation, 26 September 2026

`npm run check`: TypeScript typecheck and **67/67 tests passed**, zero skipped.
This adds 22 tests for input routing and producer/correlation/deadline boundaries.
Cases include partial input, literal dictation, Unicode preservation, duplicate
utterance/message IDs, endpoint impersonation by a different object, wrong task
revisions, changed observation/projection digests, expired/replayed replies,
session closure, clock faults, memory budgets and validation crossing a deadline.

All producers and clocks in these tests are injected local fixtures. No process
authentication, real pipe lifecycle, durable execution ledger, dispatch or Stop
latency is qualified by these results. Existing Python/Swift files and schema were
unchanged in this slice; the earlier Python/Swift results above are prior evidence,
not newly executed platform tests.

## Task admission and approval authority, 27 September 2026

`npm run check`: TypeScript typecheck and **95/95 tests passed**, zero skipped.
The new cases cover final-command-only task admission, outcome and parameter-source
binding, exact endpoint identity, task/goal revision, actor and UI session, prompt
and presentation, scope, observation, candidate set, action, policy revision,
effect equality, one-use consumption, monotonic deadlines, wall-clock expiry,
mutable caller inputs, replay and closure.

`review-work/.venv/bin/python packages/protocol/validate_contract.py`:
**110/110 synthetic contract checks passed** with jsonschema 4.26.0 and format
extras. The added independent structural cases reject multi-use approvals, missing
prompt identity, non-elevated approval effects, and execution/permit records without
policy revisions.

These are in-process and schema fixtures. They do not prove OS peer credentials,
durable approval consumption, signed native UI provenance, permit minting, dispatch,
Stop barriers or recovery after a crash. No application, browser, account, audio,
model endpoint or macOS permission was exercised.

## macOS peer identity probe, 27 September 2026

Host: macOS 26.6.2 build 25G83 on arm64; Swift 6.4 with the command-line-tools
MacOSX27.0 SDK. `security find-identity -v -p codesigning` reported **0 valid
identities**, so Developer ID/Apple Development and Team ID qualification could not
run.

`scripts/check-peer-identity.sh` completed with exit status 0. It built the Swift
peer verifier, ad-hoc signed temporary copies, and exercised live Unix-domain
connections. The exact same signed binary was accepted. A differently identified
binary was rejected for signing-identifier mismatch. A modified binary signed with
the same identifier was rejected for CDHash mismatch.

The kernel audit token reported the actual spawned client PID and a nonzero PID
version. Security.framework resolved the signing identifier and validated the
dynamic code before returning its CDHash. The first sandboxed socket attempt was
denied by the execution sandbox; the documented check then ran with permission.

This proves the primitive on this host only. Production still requires the signed
app/helper topology, a configured Team ID or release requirement, supervisor
integration, installed/update/revocation tests and TCC attribution. No TCC prompt,
Accessibility API, browser automation, microphone, model or user account was used.

## Clarification, resume and local tester, 27 September 2026

`npm run check`: TypeScript typecheck and **108/108 tests passed**. New tests cover
host-registered clarification options, changed observations, checkpoint identity,
paused-state registration, actor/session and revision mismatch, expiry, closure and
replay. `review-work/.venv/bin/python packages/protocol/validate_contract.py`:
**115/115 checks passed**, including the two new positive examples and three new
negative structure checks.

`npm run test:mac-peer`: the local Apple Silicon test completed with exit status 0;
the expected peer was accepted and impostors failed for the exact intended reasons.
The command and expected output are in `docs/LOCAL_MAC_TEST.md`. This is a local
code-signing/socket test; it does not start a menu-bar app or request TCC grants.

## Native UI mock, 27 September 2026

`scripts/build-native-mock.sh` compiled an AppKit menu-bar bundle and ad-hoc signed
it on macOS 26.6.2 arm64. `codesign --verify --deep --strict` and `plutil -lint`
passed. `scripts/run-native-mock.sh` returned successfully after invoking `open`.
The first UI inspection attempt timed out; a later read-only check showed that
the initial background-only build was absent from the app inventory while its
process was alive. The revised regular-app build appeared as running and exposed
its command panel, text field, Preview, Stop and Hide controls through macOS
Accessibility. Button behaviour still needs a human check. This mock requests no
TCC permissions and cannot execute actions. It does not satisfy B04/B07 release
acceptance.

The tester command was rerun against the live corrected build; it reopened the
existing bundle without recompiling or modifying its running executable.

## Fixture-only native action build, 27 September 2026

Swift 6 compilation passed for the synthetic fixture and the bounded
Accessibility host. The resulting ad-hoc-signed bundles launched locally. A
read-only macOS Accessibility inspection showed the fixture window, labelled
`fixture.name` text field, and Reset button; it also showed Open Fixture,
Request Accessibility, Fill Fixture Name and Stop in the host panel. No TCC
permission was granted, no AX setter was invoked by the product, and the
effectful path remains **unverified** until the owner performs the opt-in test.
See `docs/FIXTURE_COMPUTER_USE_TEST.md`.

## Fixture action and attempt journal, 27 September 2026

On the local macOS 26.6.2 arm64 host, the user-granted Accessibility path was
exercised with a synthetic value. A direct fixture entry of `fixture-123` was
cleared by Reset. The separate SystemOne Mock then reported "Verified" after
Fill Fixture Name, and an independent Accessibility read of SystemOne Fixture
showed `fixture-123`. This verifies one local fixture-only action, not a general
native adapter, TCC update behavior, or production signing. The rebuilt fixture
now gives explicit Reset feedback; that new UI text has compiled but has not yet
been interactively retested in a restarted app.

`npm run build:native-mock` succeeded after the guide change. `npm run check`
passed TypeScript typechecking and **113/113** Node tests, zero skipped. The five
new file-backed SQLite tests cover crash before/after the dispatch boundary,
conservative unresolved recovery, Stop fencing at the journal, late receipt,
one writer slot, permit-reference replay and impossible outcome dimensions.
No browser, model, microphone, account or non-fixture app was controlled.
The journal is not yet connected to the native app or an authenticated host;
therefore its tests do not qualify a real Stop barrier, exactly-once delivery or
safe resume.

## Read-only native observation foundation, 27 September 2026

`npm run test:native-ax` passed on this arm64 Mac with Apple Swift 6.4 and the
installed macOS SDK. The script compiles the new Swift package sources directly
and runs synthetic registry checks for bounded coverage, duplicate labels,
secure-control metadata, stale observations, changed targets and foreign nodes.
`swift run --package-path packages/native-ax NativeAXCheck` was attempted but
failed in this sandbox because SwiftPM's nested sandbox could not apply. The
direct compile passed using a temporary build directory. No Accessibility
permission was requested and no live app was inspected by this check. Real AX
coverage, thread responsiveness, privacy filtering and target interference
remain untested.

`npm run check` typechecked and passed **136/136** Node tests on a rerun with
loopback fixture access. The first sandboxed attempt failed 13 portal/browser
tests at `listen EPERM 127.0.0.1`; those tests did not reach their assertions.
The permitted rerun had zero failures. No application source changed between
these runs.

## Fixture-scoped host dispatch gate, 27 September 2026

`npm run check` typechecked the project and passed **123/123** Node tests after
adding ten synthetic dispatch-gate cases. The cases cover legal one-use dispatch,
forged/cloned permits, invented or stale candidate selections, Stop during
effect-free preparation, in-flight Stop and late result, changed target state,
send failure, expiry before and during preparation, invalid success evidence and
forbidden effect admission.
The journal now stores candidate, observation, policy and lease bindings. No new
dependencies were installed. This was a synthetic test run only; the owner has
parked further interactive fixture testing. No native or browser UI was operated
for this slice, and no OS worker cancellation barrier is claimed.

## Loopback invoice portal fixture, 27 September 2026

The first sandboxed `npm run check` passed typechecking and 123 existing tests
but four new portal tests failed because the sandbox denied `listen` on
127.0.0.1 with `EPERM`. The same command, rerun with local loopback permission,
passed **127/127** Node tests. The portal tests cover separate search/detail
states, duplicate titles, exact synthetic downloads, a delayed-link script,
foreign Host rejection, write-method rejection, query escaping and HEAD behavior.
No browser was launched and no user account, external site or profile was touched.
The delayed control's actual browser behavior remains unverified.

## First managed Chromium workflow, 27 September 2026

Playwright **1.63.0** was installed from the local npm cache with
`npm install --save-exact playwright@1.63.0 --ignore-scripts --offline --no-fund`.
`npx playwright install --list` showed a pre-existing matching Chromium 1243 and
headless-shell 1243; no browser binary was downloaded. The first isolated browser
test exposed a mismatch between the portal's `data-page` values and the driver's
state names. The mapping was corrected without weakening tests. The focused
`node --test packages/browser/test/managed-portal.test.ts` run then passed 3/3
with local execution permission: exact search/open/download, stale/unknown IDs,
and rejection of non-fixture origins. The browser used an empty temporary profile
and the synthetic loopback portal; it never accessed existing Chrome, accounts
or external websites. The final full `npm run check` passed TypeScript typechecking
and **130/130** Node tests with local loopback/browser execution permission.

## Fixture portal outcome predicates, 27 September 2026

`npm run check` first typechecked successfully but reported 124/131 passing
because the sandbox denied all seven loopback fixture tests with `listen EPERM`
on 127.0.0.1. The same command, rerun with local loopback/browser permission,
passed TypeScript typechecking and **131/131** Node tests. The new browser test
checks exact duplicate identity, LOCATE versus OPEN versus DOWNLOAD, stale
navigation evidence, missing or fabricated session receipts, and file tampering.
The driver re-observes the current portal and re-reads saved bytes before
reporting a fixture goal matched. This does not prove a general task actor,
non-fixture browser control, Stop, or production completion.

## Native fixture reopen failure and launch guard, 27 September 2026

The user's 21:20 report matches `SystemOneFixture-2026-09-27-212008.ips`:
`EXC_BAD_ACCESS` in `FixtureApp.applicationShouldHandleReopen`, with the process
launched at 17:31 before the 17:36 bundle rebuild. A 17:31 report has the same
reopen stack. `ps` also showed a Mock process launched before that rebuild.
The previous `run:native-mock` used `open`, which reused the old process; it did
not guarantee a fresh binary. The exact-path process test passed, and a direct
`npm run build:native-mock` correctly refused to overwrite the two running
synthetic bundles. The first corrected `npm run run:native-mock` stopped both
processes but failed during signing because OneDrive had attached Finder/file-
provider extended attributes to the generated Mock bundle. After clearing only
the generated bundles' attributes before signing, the same command built and
opened the Mock successfully. Two `open` calls against the fresh Fixture left
one live Fixture process and no new crash report. This confirms the launch/
reopen path, not the owner's full manual Fill/Reset test or a release update path.
`npm run test:mac-launch` passed the exact-path stop and unrelated-process
preservation test. `zsh -n` passed for all changed scripts, `npm run check`
passed TypeScript typechecking and **131/131** Node tests, and a second
`npm run run:native-mock` stopped both fresh synthetic processes and left only
a newly launched Mock running. The owner has not yet repeated the in-Mock
Open Fixture/Fill/Reset sequence against this build.

## Accessibility identity and scripted portal task, 27 September 2026

The owner showed an enabled Accessibility toggle while the current Mock returned
false from `AXIsProcessTrustedWithOptions`. `codesign -dr -` showed the Mock's
ad-hoc designated requirement is a CDHash; the bundle had been rebuilt after
the earlier successful grant. `security find-identity -v -p codesigning`
reported **0 valid identities**. The targeted command `tccutil reset
Accessibility com.aurium.systemone.native-mock` succeeded, and
`npm run run:native-mock` relaunched the Mock. A new user grant and live fixture
Fill/Reset result are still unverified. The optional development signing
identity and clearer status text have not been qualified with a certificate.

`npm run check` passed typechecking and **136/136** Node tests. Five new tests
cover the fixture-only task's exact duplicate-invoice search/open/download/save
sequence in isolated Chromium, private output scope, restart with an in-flight
unknown action, manual navigation interference, and late success after Stop.
This is a model-free scripted
workflow. It does not prove a host permit, browser worker cancellation barrier,
native app automation, existing Chrome, or production completion.

`zsh -n` passed for the build/run scripts. After the final Mock status-text
rebuild, `npm run run:native-mock` built and ad-hoc signed both synthetic apps;
the targeted TCC reset succeeded again, and a second `npm run run:native-mock`
relaunched that same binary without rebuilding. A human still has to grant that
binary in macOS and test Fill/Reset. The new `SYSTEMONE_CODESIGN_IDENTITY` option
was not tested because the Mac has no valid code-signing identity.

## Owner-confirmed native fixture action, 27 September 2026

After the targeted TCC reset and fresh macOS grant, the owner showed the
current SystemOne Mock reporting "Verified: the synthetic Fixture Name field
was changed" and the separate SystemOne Fixture displaying `fixture-123`.
This verifies the current ad-hoc build's one supported AX setter after the
permission repair. The screenshot does not show Reset feedback, a non-fixture
app, crash recovery, or production signing; those remain unverified.

## Fixture managed-browser Stop fence, 27 September 2026

`node --test packages/browser/test/scripted-portal-task.test.ts` passed 6/6
tests, including a delayed download control: Stop persisted cancellation,
closed the isolated Chromium context, and the local portal received no download
request. The pending task did not become completed. `npm run check` passed
typechecking and **137/137** Node tests with local loopback access. This proves
that one fixture scenario was fenced; a click or download already dispatched
before Stop may still have had an effect and remains unresolved. The path is
not connected to the host permit/journal, native app, or existing Chrome.
An additional store test then confirmed that a cancelled task with an unresolved
in-flight action blocks admission of a second task, while cancellation before
any action permits a new task. The final `npm run check` passed typechecking
and **138/138** Node tests. Explicit recovery of a truly unknown effect is still
not implemented.

## Journal task completion and unknown-effect persistence, 27 September 2026

The focused Node journal and dispatch-gate tests cover host-verified multi-step
completion, a read-only LOCATE completion with no effect attempt, rejection of
unsettled or unknown attempts, a new task after
completion, unknown-effect exclusion after reopening SQLite, and migration of
the prior task-state schema while preserving a child event foreign key.
`completeTask` records a host assertion backed by an opaque evidence reference;
the journal cannot itself verify the real-world task predicate. The scripted
portal task, native mock and authenticated host are not connected to this
terminal state yet.
`npm run check` passed TypeScript typechecking and **142/142** Node tests with
local loopback fixture access. The native AX check was not rerun in this slice;
its source was unchanged.

## Scripted portal attempt-journal integration, 27 September 2026

The portal task now records one prepared attempt and dispatch-boundary event
before each scripted search, open, download and save operation. A completed
four-step fixture task has four matched journal outcomes and a completed journal
task state. A delayed browser Stop leaves both records cancelled and the action
unresolved; Stop during save verification prevents a subsequent file write. A
simulated host restart after a browser boundary pauses both records and blocks
new task admission. The focused browser suite passed 9/9 tests. These are
fixture-only in-process checks, not authenticated host permits or atomic
cross-table commits. `npm run check` passed typechecking and **144/144** Node
tests with local loopback access. The native AX check was not rerun; its source
was unchanged.

## Bound command to scripted portal admission, 27 September 2026

`npm run check` passed TypeScript typechecking and **147/147** Node tests with
local loopback fixture access. New tests reject cloned/foreign command objects,
cloned or replayed admissions, mismatched task/outcome/parameter contracts and
cloned scripted-start records. The portal fixture still uses in-process authority;
the tests do not establish authenticated OS peer identity, per-action host permits,
general browser control, existing Chrome or release readiness. The native AX and
Swift checks were not rerun because their sources were unchanged.

## Local-save Stop fence accounting, 27 September 2026

The focused scripted portal suite passed **10/10** tests and `npm run check`
passed typechecking and **147/147** Node tests with local loopback access.
In the held save-verification case, the synthetic browser reports a
successful close while the local save remains pending. Stop now reports
`browserFenced=true`, `localSaveFenced=false` and `workerFenced=false`; the
late continuation cannot report task completion or write the output file.
This accounts for the independent file path but does not prove a true OS worker
barrier or undo any already-dispatched file effect.

## Fixture portal action permits, 27 September 2026

`npm run check` passed TypeScript typechecking and **152/152** Node tests with
local loopback access. The new authority tests reject cloned, replayed, expired,
revoked, wrong-stage, wrong-effect and wrong-origin permits. A task test changes
the observation between planning and preflight; the task pauses without a
browser dispatch or journal attempt. Stop during a held preflight also prevents
a late browser action. The full four-action fixture workflow
still completes with matching journal outcomes. These are in-process guarantees;
they do not prove OS peer authentication, true Playwright dispatch timing,
existing-Chrome behavior or production Stop latency. Native/Swift checks were
not rerun because their sources were unchanged.

## Existing-Chrome extension attachment source, 27 September 2026

`node --check extensions/chrome/service-worker.mjs` passed syntax validation.
`npm run check` passed TypeScript typechecking and **157/157** Node tests, including
five new extension tests. Mocked Chrome events cover a toolbar-initiated grant,
native-port challenge acknowledgement, exact main-document read, unsupported
actions and navigation revocation. The manifest test confirms no broad host,
content-script, externally callable or debugger grant. No extension was loaded
into Chrome, native-messaging host was installed, existing profile was read or
real browser action was executed. Chrome API/runtime, enterprise policy and
incognito behavior still require browser-level qualification.

## Existing-Chrome native-host transport source, 27 September 2026

`npm run check` passed TypeScript typechecking and **160/160** Node tests,
including three native-host manifest-staging tests. The staging tests pin one
extension ID and controller identity, reject a wildcard or unanchored trust
input, refuse a symlinked executable and avoid leaving a new config behind when
the manifest path already exists. `zsh -n scripts/check-chrome-native-host.sh`
passed. `zsh scripts/check-chrome-native-host.sh` compiled the Swift host and
synthetic controller, ad-hoc signed temporary copies, and reported `PASS: Chrome
framing and controller peer checks; no browser was opened`. Its synthetic
cases exchanged a framed message and rejected a wrong extension origin, an
oversized Chrome frame and a wrong controller CDHash. The Swift production
configuration compiled with `swift build -c release --package-path
packages/chrome-native-host --cache-path /private/tmp/systemone-swift-cache
--product SystemOneChromeNativeHost` (with module caches under `/private/tmp`).
The installed command-line-tools SDK emitted missing framework/library search
path warnings but all builds completed.

This is local transport evidence only. No Chrome extension or native-host
manifest was installed; no real Chrome profile or account was accessed. The
SystemOne controller socket does not exist yet, and no Chrome-to-controller
task action, Stop barrier, release signing, notarization or clean-Mac install
was tested.

## General managed-Chromium observation source, 28 September 2026

`npm run check` passed TypeScript typechecking and **163/163** Node tests;
`node --test packages/browser/test/managed-observation.test.ts` also passed
in isolation. Three new synthetic
tests use only loopback pages and an isolated headless Chromium profile. They
verify semantic labels and observation-scoped IDs, duplicate-control context,
omission of input/password values, explicit unobserved frame/shadow coverage,
denial of a cross-origin request and a page-initiated POST, and rejection of
unapproved start URLs. The production default is headed, but headed operation
was not exercised. No external site, real account, existing Chrome profile or
computer-use action was controlled. This observer has no host action authority,
durable journal or completion verifier; page load itself may have site-defined
effects even though SystemOne sends no action.

## Managed-browser admitted FILL source, 28 September 2026

`npm run check` passed TypeScript typechecking and **168/168** Node tests.
Five new local-loopback tests exercise a real isolated Chromium field fill with
an admitted final command, exact source-byte digest, one-use permit, private
observation-scoped DOM handle and durable journal boundary. They reject a
cloned permit and stale observation, prove Stop before dispatch prevents the
send, preserve a late receipt only as history after Stop, and leave uncertain
post-boundary outcomes blocking new tasks. The successful check verifies the
current synthetic DOM field value; it does not prove a server save. Stop races
after dispatch used an injected driver, not a live browser race. No app UI,
external site, existing Chrome profile, OS-authenticated worker, headed
workflow, CLM or signed distribution was tested.

## Native panel to managed-browser development bridge, 28 September 2026

`npm run typecheck` passed. The first unprivileged run of
`node --test packages/runtime/test/native-managed-controller.test.ts` could not
bind the isolated fixture to `127.0.0.1` (`listen EPERM` in the sandbox); it
was rerun with local-loopback permission and passed. After final edits,
`npm run check` passed TypeScript checking and **169/169** Node tests, including
the process-level private-pipe test. That test rejects a mismatched final
command before any fixture GET, fills a field through a spawned controller and
headless isolated Chromium, keeps the verified page alive until Stop, then
repeats in the same controller process. `npm run build:native-dev` compiled
the AppKit panel, ad-hoc signed it and passed strict codesign verification on
this Mac. The first build run emitted a sandbox `ps` denial while checking for
a running app; the build script now fails closed if process inspection fails,
and the escalated rerun completed without that warning.
`npm run run:portal-fixture` started a synthetic loopback server, and
`npm run run:native-dev` opened the app. A process check found the AppKit app,
its Node controller child and the fixture server running. A human-visible
field fill has not yet been reported by the owner.

The manual headed panel/Chromium test in [native managed test](NATIVE_MANAGED_TEST.md)
still needs owner observation. The app uses absolute external Node/source paths;
the child is not OS-authenticated or packaged for distribution. No native-app
workflow, existing Chrome action, voice, CLM, arbitrary-site compatibility,
clean install or release signature is validated by these checks.

## Development native Accessibility inspection, 28 September 2026

In the isolated `codex/native-ax-worker` worktree,
`npm run test:native-ax` compiled the Swift package and passed its synthetic
registry checks. `npm run build:native-dev` compiled the AppKit panel with the
read-only observer and passed strict codesign verification using an ad-hoc
signature. `npm run check` passed TypeScript checking and **169/169** Node tests.
The first `npm ci --offline` attempt could not find `undici-types` in the local
cache; the pinned ordinary `npm ci --ignore-scripts` then installed 13 packages
and reported zero audit vulnerabilities.

The updated app was not launched because an earlier SystemOne Dev build and
synthetic portal were left running for the owner's managed-browser test. No
Accessibility permission was requested, no live native app was inspected, and
no native action was dispatched. The synthetic test checks registry identity,
truncation and stale-handle behavior, not TCC attribution, live AX timing,
real application compatibility or a worker Stop barrier.

## Restricted native field action source, 28 September 2026

`npm run test:native-ax` passed both the pre-existing synthetic observation
check and the new `NativeAXValueCheck`. The new check covers exact selected
duplicate node, one-use send, Stop before send, Stop during blocked preflight,
Stop acknowledgement during a blocked setter, stale descriptor, changed prior
value, failed journal-boundary callback, secure-field rejection and a setter
that changes the field before returning an error. The first Swift build found a
missing `try` on a throwing value read; it was corrected before the passing
check. These are synthetic backend behaviors, not live Accessibility action
evidence. The native driver is linked into the development app but has no
controller or UI action route. Journal integration, authenticated permits,
live AX timing and real-app verification remain untested.
After the final fence changes, `npm run check` passed **169/169** Node tests and
`npm run build:native-dev` again passed AppKit compilation and strict ad-hoc
codesign verification. The native action remains unexposed.
`swift build --package-path packages/native-ax --cache-path
/private/tmp/systemone-swift-cache` built the library and both check targets.
The command-line-tools linker emitted warnings about missing framework/library
search paths, but exited successfully. A matching value at preflight remains a
read-only match, not evidence of a dispatched action or durable completion.

## Journaled native host task contract, 28 September 2026

`node --test packages/runtime/test/native-fill-authority.test.ts` passed
**7/7** synthetic worker tests. They cover an exact admitted candidate and
one durable boundary, malformed command before observation, duplicate and
incomplete observations, independently verified existing value, Stop during
preflight, Stop after a boundary with a late verified receipt, lost setter
reply and unconfirmed worker fence. The first full `npm run check` found one
strict TypeScript optional-property test declaration error; it was fixed.
The final `npm run check` passed TypeScript checking and **176/176** tests.

No real AX worker was connected, no native effect was dispatched, and no
AppKit task route or OS peer authentication was exercised. A successful
synthetic worker receipt is not evidence of a real app change. Recovery after
a stopped boundary-crossed task remains blocked pending explicit fresh
observation and user intent.

## Development native controller bridge, 28 September 2026

`node --test packages/runtime/test/native-pipe-bridge.test.ts` passed its
process-level synthetic native task and late-Stop case. `npm run check` passed
TypeScript checking and **177/177** tests when run with local loopback access.
The first restricted run had **156 passes and 21 failures**, all because the
sandbox denied the synthetic portal's `127.0.0.1` listen socket (`EPERM`);
the exact suite then passed with that local access. `npm run build:native-dev`
compiled and ad-hoc signed the AppKit bundle after the build guard received
permission to inspect running processes. `zsh -n scripts/build-native-dev.sh
scripts/run-native-dev.sh` and `git diff --check` passed.

The new source route is panel -> one persistent Node controller -> journaled
native host task -> private AppKit AX worker -> field re-read. The process test
simulates the AppKit worker; no live Accessibility action was run through this
route. No release-signed helper, OS-authenticated peer, durable worker-side
permit, clean install, or update/TCC continuity was tested. See the
[optional live synthetic test](NATIVE_COMPUTER_USE_TEST.md).

## Existing-Chrome development read transport, 28 September 2026

`npm run check` passed TypeScript checking and **182/182** Node tests with
loopback fixture access. New tests cover exact Chrome hello/read binding,
changed profile/document, malformed snapshots, revocation, replay, timeout and
a spawned Node controller pipe. An extension/controller synthetic contract test
also exchanges one exact tab snapshot and revokes on navigation. `zsh -n` passed for the new staging/check
scripts and `git diff --check` passed. `npm run build:native-dev` compiled and
ad-hoc signed the AppKit listener with Security/bsm linkage.

`zsh scripts/build-chrome-dev-bridge.sh aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`
compiled and ad-hoc signed a development host and app, and staged an exact-
origin manifest using a **synthetic extension ID**. It did not install that
manifest, launch Chrome or alter a profile. `zsh scripts/check-chrome-dev-listener.sh`
passed a signed temporary host/listener framed exchange and rejected a wrong
pinned host CDHash. The current host
configuration is development-only and external to a signed release bundle.

No browser-to-host-to-controller run, Chrome action, trusted-input behavior,
file transfer, current-profile compatibility, signed release identity or
clean-Mac installation was tested. A signed host process can be invoked outside
Chrome, so this transport check alone is not proof of user-granted authority.

## Existing-Chrome guarded loopback fill source, 28 September 2026

`npm run check` passed TypeScript checking and **191/191** Node tests with local
loopback access. The new host tests cover a fresh complete field observation,
journal marker before action, one-use permit, ambiguous/incomplete rejection,
Stop during observation, and Stop after dispatch with a late receipt that
cannot complete the task. Lost replies remain unresolved in the journal.
An extension mock checks one action and replay rejection. A separate
`node --test extensions/chrome/test/semantic-controls.test.mjs` passed **1/1**
in headless Playwright Chromium, checking current field value and stale or
duplicate field refusal. `npm run build:native-dev` compiled and ad-hoc signed
the development panel with its Chrome field controls. `git diff --check` passed.

At this stage, no installed extension, native-host registration, real Chrome
profile or end-to-end isolated-world `executeScript` sequence was exercised. The DOM
test runs the functions in a synthetic page, not Chrome's extension isolated
world. Current-profile compatibility, trusted-input behavior, Stop during a
real injection, release signing and clean installation remain unverified.

## Temporary MV3 isolated-world check, 28 September 2026

`node --test extensions/chrome/test/isolated-world.test.mjs` passed **1/1**.
It launched Playwright's bundled Chromium with a disposable persistent profile
and a temporary MV3 extension importing the production semantic functions.
Against the loopback portal, separate document-targeted `chrome.scripting`
calls retained a field handle, filled and verified its DOM value, rejected a
new duplicate field, and rejected the old handle after reload. The temporary
profile and extension directory were removed after the test. The final
`npm run check` passed TypeScript checking and **192/192** tests.
The extension Stop mock also rejects a mismatched action target and reports
an in-flight post-Stop result as unknown.

This is stronger than page-world `evaluate`, but still omits the production
extension's native-messaging transport and any installed Chrome profile.
It does not establish trusted-input behavior, server persistence, Stop during
a real native-host action, or distributable signing.

## Bundled development runtime, 28 September 2026

`zsh scripts/build-bundled-dev.sh .build/release-deps/node-v26.5.0-darwin-arm64.tar.xz
/Users/daryl/Library/Caches/ms-playwright` built a roughly 715 MB ad-hoc app.
The official Node archive's SHA-256 matched the pinned `48231d6204eca6be13e6c5184dfdffa1d64ad88880364cc2cfb198f872cb2b13`
entry from Node's HTTPS `SHASUMS256.txt`. The extracted binary reported
`v26.5.0 arm64 darwin`; `otool -L` showed only system libraries. The current
Homebrew Node binary showed multiple `/opt/homebrew` library dependencies and
was therefore not copied into the bundle.

The first build with `npm ci --offline` failed because `jsonc-parser` was not
cached. The build script now uses lockfile integrity with scripts disabled and
allows npm to fetch missing production archives; that retry built successfully.
`node scripts/check-bundled-dev.mjs ABSOLUTE_APP_PATH` passed: the bundled
controller started and stopped, and bundled headless Chromium observed the
loopback invoice portal using the app's own Node, npm packages and browser
assets with a restricted `PATH`. The same check passed after moving the app to
another directory in the worktree, then it was returned to the documented
build path. The app's nested and outer ad-hoc signatures verified strictly.

No AppKit GUI launch from this bundle, clean-Mac install, Chrome native-host
registration, Developer ID signing, notarization, model assets, updates or
rollback was tested. The release gates remain open.

## Fixture-only CLM reference probe, 28 September 2026

The probe's request/answer shape was checked against CLM source commit
`bb42c6c5bf914fd449bed2f6ca65be80602cb1f7`: `src/clm/server.py`,
`src/clm/schema.py` and `src/clm/engine.py`. This was source inspection, not
model inference. `npm run typecheck && node --test packages/providers/test/*.test.ts`
passed 6/6 focused tests, including a loopback fake-service CLI run. That
test produced three structurally valid responses but only two expected choices;
the missing-target case chose an unrelated candidate and was correctly counted
as wrong. The initial full `npm run check` passed 197/197 tests before the CLI
integration test was added. The final full-suite result is recorded below.

`node scripts/probe-clm.ts --allow-owned-service --endpoint
http://127.0.0.1:1/v1/systemone --fixtures
packages/providers/fixtures/clm-probe-synthetic.json --output
/private/tmp/systemone-clm-unavailable-probe.json` exited 1 as expected. Its
owner-only report recorded 0/3 valid and three `unavailable` outcomes, with
model artifact identity and tokenizer truncation unverified. Port 1 had no
service; this proves failure reporting, not CLM behavior. No model weights were
downloaded and no inference endpoint was contacted successfully. B02/G1 remain
unverified pending an attested private deployment and representative benchmark.
Final `npm run check`: TypeScript passed and **198/198 tests passed**, zero
skipped or failed.
