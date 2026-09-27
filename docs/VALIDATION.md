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
