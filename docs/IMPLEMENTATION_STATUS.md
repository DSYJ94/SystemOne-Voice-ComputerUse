# Implementation status

Updated 27 September 2026. The owner authorized beginning implementation and setting
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
| B03 protocol | In progress | TypeScript schema/parser/framing, Swift digest parity, endpoint allowlists, bounded reply correlation/deadlines, final-input routing, host-private task admission, one-use approvals, clarification/resume intent records and a Swift audit-token/code-signing peer verifier. Production supervisor integration, release-identity qualification, typed Swift messages and production permit/dispatch authority remain. |
| B05 fixtures | In progress | Fifteen schema messages, shared digest/Unicode fixtures, one resettable synthetic native text field, and a loopback-only invoice portal with duplicate titles, exact detail routes and fixed downloads. A narrow managed-browser driver uses the portal; broader native and adversarial fixtures remain. |
| B26 conformance | In progress | Python oracle and TypeScript tests pass; standalone Swift digest check passes. XCTest cannot run with the installed SDK. Full cross-language negative fixtures, property/fuzz/race tests and CI remain. |
| B05/B07 native fixture slice | Local test build | A synthetic AppKit fixture exposes one editable field. On this local Mac, the mock changed `Fixture Name` through Accessibility and the value was independently re-observed. This is one fixture action, not general native support. No shortcut, focus capture, voice, TCC attribution or production signing. |
| B09 host dispatch gate foundation | In progress | A fixture-scoped TypeScript gate binds a selected candidate to the admitted task, exact observation, policy, target, argument provenance and one-use in-process permit. Synthetic drivers prove Stop before send, unresolved send after Stop, expiry and stale-target refusal. No OS/browser worker barrier has been qualified. |
| B12 managed Chromium worker | In progress | Playwright 1.63.0 launches a fresh temporary Chromium profile and a narrow scripted portal driver. Headless tests search, open an exact duplicate and download a fixed document. General DOM snapshots, tabs/frames, uploads, headed UX, Stop barrier and packaging remain. |
| B15 attempt journal foundation | In progress | SQLite records prepared attempts, the dispatch boundary, outcomes, cancellation and restart pause. Crash, late-receipt and replay scenarios pass synthetic tests. It is not connected to the native mock or a signed supervisor yet. |
| B16 portal outcome predicates | In progress | The managed portal re-observes exact invoice ID/title/account for LOCATE and OPEN, and requires a session-owned download receipt plus unchanged file bytes for DOWNLOAD. Stale revision, missing receipt and tampering tests pass. No general task actor or other outcome kinds are connected. |
| All other tickets | Not started | No qualified signed UX, general native adapter, ASR, existing-Chrome bridge, model service or release artifact. |

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

`TaskAdmissionRegistry` converts only an already validated final command into a
host-private task contract. It binds outcome kind, parameter provenance digests,
scope, completion verifier, policy revision and approved effects. Dictation cannot
admit a task and `UNKNOWN` effects fail closed. A future workflow-specific admission
UI still needs to select these fields; no natural-language interpreter is implied.

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

The owner is revisiting the interactive fixture test. The revised Reset feedback
is still awaiting their observation; continue independent implementation and
synthetic checks while that result is pending. The exact steps are in
`docs/FIXTURE_COMPUTER_USE_TEST.md`.

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
Headless tests pass. This is not a general browser executor, an offline-network
qualification, an OS-level network sandbox, or a proven Stop barrier during
Playwright actionability waits. The production headed build, installer and
existing-Chrome extension are still separate work.

## Next sequence

1. Extend the B16 fixture outcome checks into an admitted, persistent scripted
   task: preserve explicit ID/title/account parameters and verified progress
   across search, open and download. Keep the task model-free.
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
