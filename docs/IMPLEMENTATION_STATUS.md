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
| B03 protocol | In progress | TypeScript schema/parser/framing, Swift digest parity, endpoint allowlists, bounded reply correlation/deadlines, final-input routing, host-private task admission, one-use approvals, clarification/resume intent records and a Swift audit-token/code-signing peer verifier. Production supervisor integration, release-identity qualification, typed Swift messages and permit/dispatch authority remain. |
| B05 fixtures | In progress | Fifteen schema messages and shared digest/Unicode fixtures. Resettable native fixture app and browser portal have not been built. |
| B26 conformance | In progress | Python oracle and TypeScript tests pass; standalone Swift digest check passes. XCTest cannot run with the installed SDK. Full cross-language negative fixtures, property/fuzz/race tests and CI remain. |
| B07 UX shell | Mock only | A local ad-hoc-signed AppKit menu-bar shell can display a translucent command panel and Stop without dispatch. It lacks shortcut, focus capture, voice, TCC qualification and production signing. |
| All other tickets | Not started | No qualified signed UX, ASR, adapter, browser worker, model service, durable journal or release artifact. |

These slices advance PR1; they do not mark the entire contracts-and-fixtures stage
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
status text; Stop clears the mock input. It has no task controller or execution
path and is not evidence for native-app or browser support.

## Next sequence

1. Finish B03 durable authority, supervisor peer-identity integration and Swift
   typed message bindings. Add B05
   resettable portal/native fixtures and mock-only CI. Do not port the Python guard
   wholesale as host authorization code.
2. B04/B07/B08/B09: signed native panel/PTT/dictation and independent Stop with mock
   effects. Prove TCC attribution and clean installation on an authorized test Mac.
3. B10–B13 plus B15–B17 foundations: scripted native and managed-browser workflows,
   durable attempts, exact completion predicates and Stop/crash/interference tests.
4. B14 inserts qualified CLM only after those drivers and dispatch gates pass.

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
- No code in this slice can dispatch OS/browser actions. Actor authentication,
  one-use permits, target freshness and one-writer ownership are still future work.
