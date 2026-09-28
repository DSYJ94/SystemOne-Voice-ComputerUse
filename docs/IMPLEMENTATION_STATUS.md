# Implementation status

Updated 28 September 2026. The owner authorized beginning implementation and setting
up a repository after the independent GO WITH FIXES review. The original attached
baseline remains in the ignored local review directory. The proposed corrections
are adopted as the starting working specification; no gate is certified by this.

## Beta scope decision

The owner confirmed on 26 September 2026 that beta requires all three surfaces:
native macOS apps, managed Chromium, and existing Chrome using the user's current
profile, data and tabs. A fresh managed profile or a copied/migrated profile does
not satisfy existing-Chrome support. B19 and G4 remain beta release gates, and B20
retains its dependency on B19. The planned extension/native-messaging bridge must
qualify scoped user grants, exact browser/profile/tab/frame/document identity,
navigation invalidation, reconnection and revocation against existing-profile
fixtures. Supported operations and limitations must be stated explicitly.

## First implementation slice

| Backlog | State | Evidence and remaining work |
|---|---|---|
| B01 source/dependency pins | In progress | Node/test dependency locks and CLM source metadata recorded. Actual model bytes, encoder/tokenizer revisions and release license clearance remain unverified. |
| B02 CLM reference probe | Fixture-only foundation | The pinned `/v1/systemone` choice shape is encoded from full semantic candidate descriptions; a probe captures raw replies, latency and token counts, and rejects malformed distributions/unknown IDs. Three synthetic fixtures and unavailable-service behavior are checked. No CLM service or weights have run; the 50-case benchmark, model artifact attestation, truncation and calibration remain. See [probe](CLM_REFERENCE_PROBE.md). |
| B03 protocol | In progress | TypeScript schema/parser/framing, Swift digest parity, endpoint allowlists, bounded reply correlation/deadlines, final-input routing, host-private task admission, one-use approvals, clarification/resume intent records and a Swift audit-token/code-signing peer verifier. Production supervisor integration, release-identity qualification, typed Swift messages and production permit/dispatch authority remain. |
| B05 fixtures | In progress | Fifteen schema messages, shared digest/Unicode fixtures, one resettable synthetic native text field, and a loopback-only invoice portal with duplicate titles, exact detail routes and fixed downloads. A narrow managed-browser driver uses the portal; broader native and adversarial fixtures remain. |
| B26 conformance | In progress | Python oracle and TypeScript tests pass; standalone Swift digest check passes. XCTest cannot run with the installed SDK. Full cross-language negative fixtures, property/fuzz/race tests and CI remain. |
| B05/B07 native fixture slice | Local test build | A synthetic AppKit fixture exposes one editable field. On this local Mac, the mock changed `Fixture Name` through Accessibility and the value was independently re-observed. This is one fixture action, not general native support. No shortcut, focus capture, voice, TCC attribution or production signing. |
| B09 host dispatch gate foundation | In progress | A fixture-scoped TypeScript gate binds a selected candidate to the admitted task, exact observation, policy, target, argument provenance and one-use in-process permit. Synthetic drivers prove Stop before send, unresolved send after Stop, expiry and stale-target refusal. The scripted portal task now requires one-use in-process admission and per-action permits, with a fresh observation before its journal boundary. These do not authenticate an OS worker or prove Playwright's actual input dispatch point. |
| B10 native observation foundation | In progress | A Swift package provides a bounded Accessibility tree walker with observation-scoped handles, target PID/bundle/path/launch identity and stale-node checks. Synthetic registry checks pass. The development panel inspects one named running app off the UI thread; the native field worker now uses this observation under a host task. A live observation through the new controller remains unverified. |
| B11 native value-action source | Development bridge | A restricted Swift `AXValue` driver prepares one exact nonsecure field, privately compares its prior value and re-observes after a one-use fenced setter. The TypeScript host class binds a final command, complete candidate set, value digest and journaled dispatch. A private pipe now connects the persistent controller to the AppKit AX worker; synthetic process and Stop tests pass. A live action through this path, OS peer authentication and worker-side digest/permit validation remain unverified. See [native action](NATIVE_ACTION.md). |
| B12 managed Chromium worker | In progress | Playwright 1.63.0 launches a fresh temporary Chromium profile and a narrow scripted portal driver. Headless tests search, open an exact duplicate and download a fixed document. Stop closes this isolated context; a delayed-control test sees no download request after cancellation. The scripted task separately reports when a local save remains pending after browser closure. A separate general observer accepts exact approved origins, blocks out-of-scope requests, POSTs and WebSockets, and returns bounded main-document controls with coverage gaps. One admitted FILL task revalidates a private DOM handle, uses a one-use in-process permit and durable boundary, verifies the exact field value, and keeps unknown outcomes blocked. A development AppKit panel now sends that one action through a persistent Node controller over inherited private pipes, retains the browser for inspection and offers Stop. The sidecar uses source paths and is not OS-authenticated. General action dispatch, tabs/frames, uploads, release UX, authenticated host integration and packaging remain. |
| B15 attempt journal foundation | In progress | SQLite records prepared attempts, the dispatch boundary, outcomes, cancellation, restart pause and host-verified task completion. The fixture portal task now writes all four scripted action attempts and Stop fences both the journal and task record; a simulated restart leaves an in-flight browser boundary paused and blocks replay. The two tables share a database but not one transaction. No authenticated host permit, signed supervisor or explicit unknown-effect recovery is connected. |
| B16 portal outcome predicates | In progress | The managed portal re-observes exact invoice ID/title/account for LOCATE and OPEN, and requires a session-owned download receipt plus unchanged file bytes for DOWNLOAD. A scripted task uses those predicates across search/open/download/save; its output is private fixture data. No general outcome engine or authenticated task actor is connected. |
| B19 existing-Chrome bridge | Development guarded action source | A Manifest V3 extension requires a toolbar click and temporary `activeTab` grant for one normal HTTP(S) tab. It binds a semantic snapshot to extension/profile-session/tab/frame/document/exact URL and revokes on navigation or disconnect. The host now admits and journals one `Find invoice` fill on a loopback page with the synthetic portal's shape, and the extension revalidates the retained field and current value. Synthetic Stop/replay/ambiguity tests pass; no real Chrome extension action or profile has been exercised. The signed synthetic host/listener check remains, but no host or manifest is installed in Chrome. See [existing Chrome](EXISTING_CHROME.md). |
| B04/B07 development bridge | In progress | An ad-hoc-signed AppKit menu-bar/Dock panel accepts explicit managed-browser and native-field fills through one persistent local controller. The ordinary development build still points to an external Node path; the separate bundled development spike includes that runtime. The panel remains a test shell without a global shortcut, dictation or release signing. See [managed test](NATIVE_MANAGED_TEST.md) and [native test](NATIVE_COMPUTER_USE_TEST.md). |
| B27 packaging foundation | Development bundle | A movable ad-hoc app now includes a checksum-verified official Node 26.5.0 executable, locked production npm packages and version-matched Playwright Chromium. The bundled controller and browser worker pass a loopback fixture smoke check after relocation. It is not Developer ID signed/notarized and has no bundled Chrome host, model assets, update system or clean-Mac qualification. See [bundled runtime](BUNDLED_DEV_RUNTIME.md). |
| All other tickets | Not started | No qualified signed UX, general native action adapter, ASR, model service or release artifact. |

These slices are staged across draft PRs; they do not mark the entire contracts-and-fixtures stage
or any of B01/B03/B05/B26 complete. The private GitHub remote is configured.

## Input and reply foundation

`CommittedInputSession` validates final command records against a host-bound input
endpoint and task revision, rejects repeated message/utterance IDs, and routes
dictation as literal text. Partial previews remain native UI events; they cannot
enter this protocol path. This resolves the two reviews' differing advice on
`isFinal` by preserving the working specification's final-only command contract.
It does not perform task admission or validate a dictation destination.

`ReplyLedger` binds each pending request to the exact endpoint object, expected
reply type, task revision and caller-supplied observation/projection digests. It
checks an injected monotonic deadline before and after validation, accepts at most
one reply per request, caps memory use and rejects all replies after closure.
Use a new ledger and fresh request IDs after correction, cancellation or reconnect.
Closing a ledger is a local input barrier, not evidence of the real OS/browser
Stop barrier. Supervisor peer authentication and connection teardown remain.

The second-review Approval patch remains an assessment artifact and was not applied
wholesale. The working contract now independently adds an `Approval` record and
requires `policyRevision` on permits and execution requests. `ApprovalLedger`
accepts a reply only from the exact bound UI endpoint object and binds actor/UI
session, task revision, prompt, presentation, scope, observation, candidate set,
action, policy and elevated effects. It checks injected monotonic and wall clocks,
then permits one consumption. This is in-memory contract authority only: endpoint
objects do not authenticate an OS process, and consumption is not yet durable.

`TaskAdmissionRegistry` converts only the exact final command object issued by its
bound input session into a host-private task contract. A command object and task
admission each transfer once by in-process object identity; matching JSON or a
foreign session cannot mint task authority. It binds outcome kind, stated parameter provenance digests,
scope, completion verifier, policy revision and approved effects. Dictation cannot
admit a task and `UNKNOWN` effects fail closed. A future workflow-specific admission
UI still needs to select these fields; no natural-language interpreter or proof of
correct parameter extraction is implied. The fixture portal checks those admitted
values, effects and policy against its start contract. It does not issue execution
permits for each Playwright action. A separate fixture-specific authority now
issues short-lived one-use permits for search, open, download and save; it checks
admitted effect, stage, target URL and observation digest. The task re-observes
before using one and pauses on change. This moves action selection through a
host-private policy boundary, but the Playwright calls still run in-process and
have no signed peer or worker-side permit verifier.

The Swift peer-identity primitive now reads `LOCAL_PEERTOKEN` from an active local
socket, cross-checks effective UID/GID, validates the running code through
Security.framework, and enforces an Apple-anchored Team ID requirement or pinned-
CDHash trust anchor in addition to the signing identifier. A bounded local check
accepts the same ad-hoc-signed binary and rejects both a different identifier and a
same-identifier/different-hash binary. This host has no valid development or
distribution identity, so the actual
app/helper Team ID, installed path, update behavior and TCC attribution are untested.

`UserPromptLedger` accepts clarification only for an option registered in the exact
displayed prompt and current observation. Resume is a one-use intent bound to a
host-registered paused checkpoint and recovery observation. Changed revisions,
observations, actor/session, prompt presentation, checkpoint and expired responses
fail closed. Free-text corrections use a new committed `Command` and goal revision.
The ledger does not change task state, replay an attempt or issue a permit; B15/B17
must connect it to durable recovery and revalidation.

The local UI mock provides a runnable menu-bar panel for human feedback while B04
signing and permission attribution remain open. Its Preview button only updates
status text; the fixture-only action below is a separate explicit path and is not
evidence for general native-app or browser support.

The fixture build adds one deliberately separate effect path. It finds exactly one
running `com.aurium.systemone.fixture` bundle at the build path, checks a single
window and labelled AX text field, sets its value off the UI thread, and re-reads
the field before reporting success. This is a scripted local test, not natural-
language navigation. Stop invalidates the local attempt epoch and keeps the UI
responsive; it does not claim to undo or fence an already-started AX setter.
Native integration of the attempt journal, permit/approval dispatch, supervisor identity integration,
fast independent Stop barriers, and non-fixture scopes are still pending.

The separate TypeScript `AttemptJournal` now persists opaque task/permit/action
identifiers, candidate/observation/policy bindings and status dimensions in SQLite with a full-sync transaction before
the adapter boundary. A crash before that marker is recorded as not dispatched;
after it, delivery stays unresolved until evidence arrives. Stop prevents later
journal dispatch but does not fence an adapter queue. One unsettled attempt can
occupy the writer slot, and late receipts update that attempt without resuming a
cancelled task. This is a foundation only: the native fixture does not call it,
no host-issued permit is validated here, and restart ownership/worker termination
still need integration before non-fixture effects.

`HostDispatchGate` connects that journal to a copied, fixture-scoped candidate
set and an in-process one-use permit. A selected candidate ID alone cannot execute.
An effect-free driver preparation step rechecks the exact target, surface,
fingerprint and prior-value digest. The gate writes the dispatch-boundary marker
before calling the driver's synchronous send entrypoint. Stop aborts preparation,
fences journal dispatch and lists boundary-crossed calls as unresolved. Synthetic
tests prove these properties, including late results after Stop. A real native or
Playwright adapter must still prove that its preparation cannot cause an effect
and that its send entrypoint cannot wait and dispatch after Stop. The gate is
hard-limited to the synthetic fixture and does not authenticate a helper process.
It also does not validate a model proposal's producer or establish a recovery
policy for an unknown settled effect across a new task. The host must connect the
existing reply boundary and require fresh observation before allowing a related
action after an uncertain result.

The owner confirmed Fill after renewing the current Mock's grant. The revised
Reset feedback is still awaiting observation. The exact steps are in
`docs/FIXTURE_COMPUTER_USE_TEST.md`.

The 27 September reopen crash was in SystemOne Fixture, not the Mock. Two
diagnostic reports show the same reopen-handler crash after an older Fixture
process survived a bundle rebuild. The launcher now stops only exact-path
synthetic processes before rebuilding/reopening, and a direct build refuses to
overwrite a running test bundle. Generated app-bundle extended attributes from
the OneDrive checkout are cleared before ad-hoc signing. A fresh fixture opened
and reopened without a new crash; the owner's in-Mock click remains to be checked.

Later that day, the current Mock reported `AXIsProcessTrustedWithOptions == false`
while System Settings showed its Accessibility toggle on. The installed bundle
has an ad-hoc designated requirement bound to CDHash, and it was rebuilt after
the earlier grant. This Mac has zero valid code-signing identities. The narrow
`tccutil reset Accessibility com.aurium.systemone.native-mock` succeeded and the
Mock relaunched; the subsequent user grant and Fill result are recorded below. The build
script now accepts an optional `SYSTEMONE_CODESIGN_IDENTITY` for a valid local
development certificate and warns when using ad-hoc signing. No production TCC
update or clean-install behavior has been qualified.

The owner then granted the current Mock and showed both its Verified status and
`fixture-123` in the separate Fixture. The current fixture-only AX action is
verified again. Reset feedback and broader native control were not shown.

The local invoice portal now supplies deterministic search results, duplicate
titles under distinct IDs/accounts, exact detail pages and a download link that
appears after a short client-side delay. It binds only an ephemeral 127.0.0.1
port, rejects a foreign Host header and write methods, escapes search text and
serves fixed synthetic documents. HTTP tests distinguish finding a result from
opening its detail and downloading its exact file. Browser rendering, actionability
and download handling are now covered for this portal by B12's first managed Chromium tests.

`ManagedPortalSession` launches Playwright's version-matched Chromium with an empty
temporary profile, blocks service workers, routes page requests only to the exact
loopback portal origin, and never attaches to the user's Chrome profile. The
driver exposes only fixed search, exact-ID open and exact-ID download operations.
It observes DOM page identity and result rows, rejects stale result revisions,
waits for the delayed download link, validates the final URL, filename and exact
synthetic document contents, saves
inside its private temporary directory and removes that directory on close.
Headless tests pass. The fixture Stop path now records cancellation before
closing the context, and a delayed-control test confirms no download request
after its close. This is not a general browser executor, an offline-network
qualification, an OS-level network sandbox, or a Stop barrier integrated with
the host permit gate. The production headed build, installer and existing-
Chrome extension are still separate work.

## Next sequence

1. Move the now-journaled fixture portal task behind one authenticated host
   authority and one-use permits. Prove the browser close fence at that dispatch
   boundary and preserve already-dispatched uncertainty. Add
   B10/B11 semantic native observations/actions with explicit scope; move beyond
   single-field fixtures without treating unverified effects as safe.
2. Finish B03 durable authority and supervisor peer-identity integration. Connect
   B09/B15 to native and managed-browser workers only after proving actual Stop
   barriers and unknown-outcome handling. Expand B05 interference fixtures and CI.
3. B04/B07/B08 plus B10–B13 and B15–B17: signed native panel/PTT/dictation,
   general semantic adapters, headed managed browser, multi-hop scripted tasks,
   exact completion and crash/interference tests. Prove TCC attribution and clean
   installation on an authorized test Mac.
4. B14 inserts qualified CLM after drivers and dispatch gates pass. B18/B19 must
   qualify transitions and the existing-Chrome profile before beta.

G1–G6 remain unverified. Local CLM, Laya, Jev and vision do not become enabled by
creating this repository. Server-first versus offline-first release and insertion
into a cloud-synced note remain owner decisions before those modes ship.

## Important implementation boundaries

- `requestDecision` accepts only a projection already reviewed by the trusted host;
  it checks enabled provider/location/revision and integrity before invoking its
  transport. It does not identify secrets or issue disclosure approval.
- The Swift package provides digest and peer-identity primitives, not a full JSON ingress validator. Do not
  decode untrusted IPC using Foundation alone and call it protocol conformance.
- Framing is for private inherited app/sidecar pipes: 4-byte big-endian length,
  followed by UTF-8 JSON, capped at 1 MiB. The caller must bound read chunks; malformed
  or truncated sessions fail closed. Chrome native messaging needs its own framing.
- Only the explicit synthetic fixture field can be changed by the local test build.
  General native/browser dispatch, durable one-use permits, host actor authentication,
  target freshness across navigation and production one-writer ownership remain open.
