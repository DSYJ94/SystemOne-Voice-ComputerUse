# Implementation status

Updated 26 September 2026. The owner authorized beginning implementation and setting
up a repository after the independent GO WITH FIXES review. The original attached
baseline remains in the ignored local review directory. The proposed corrections
are adopted as the starting working specification; no gate is certified by this.

## First implementation slice

| Backlog | State | Evidence and remaining work |
|---|---|---|
| B01 source/dependency pins | In progress | Node/test dependency locks and CLM source metadata recorded. Actual model bytes, encoder/tokenizer revisions and release license clearance remain unverified. |
| B03 protocol | In progress | TypeScript schema/parser/framing and Swift digest parity. Full typed Swift messages, authenticated endpoint roles, correlation/deadline handling, host-private task admission/replies and cross-message authority validation remain. |
| B05 fixtures | In progress | Twelve schema messages and shared digest/Unicode fixtures. Resettable native fixture app and browser portal have not been built. |
| B26 conformance | In progress | Python oracle and TypeScript tests pass; standalone Swift digest check passes. XCTest cannot run with the installed SDK. Full cross-language negative fixtures, property/fuzz/race tests and CI remain. |
| All other tickets | Not started | No signed UX, ASR, adapter, browser worker, model service, durable journal or release artifact. |

This slice starts PR1; it does not mark the entire contracts-and-fixtures PR or any
of B01/B03/B05/B26 complete. No pull request exists until a remote is selected.

## Next sequence

1. Finish B03 typed command/task-admission/reply contracts, correlation and deadlines,
   authenticated producer mapping and cross-language semantic fixtures. Add B05
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
- The Swift package is a digest library, not a full JSON ingress validator. Do not
  decode untrusted IPC using Foundation alone and call it protocol conformance.
- Framing is for private inherited app/sidecar pipes: 4-byte big-endian length,
  followed by UTF-8 JSON, capped at 1 MiB. The caller must bound read chunks; malformed
  or truncated sessions fail closed. Chrome native messaging needs its own framing.
- No code in this slice can dispatch OS/browser actions. Actor authentication,
  one-use permits, target freshness and one-writer ownership are still future work.
