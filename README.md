# SystemOne Voice Computer Use

A native macOS voice/text computer-use product in early development. The intended
app is a background/menu-bar agent with a transient command panel, one persistent
task controller, semantic Accessibility/DOM adapters, and CLM as its primary
decision model. There is no application binary or live executor yet.

## Current implementation

- Protocol 2.0 schema and the corrected independent Python conformance oracle.
- TypeScript strict JSON ingress, schema validation, bounded private-RPC framing,
  and the restricted canonical digest format.
- A pre-I/O provider policy boundary with spy-transport tests. No network transport
  is implemented; host disclosure review is still required before approving input.
- A Swift digest library checked against the same Unicode and integrity fixtures.
- Final-input routing with literal dictation separation, trusted-endpoint allowlists,
  and bounded request/reply correlation with monotonic deadlines and replay rejection.
- Host-private task admission plus revision-, prompt-, actor-, presentation-, action-
  and policy-bound approvals that are accepted and consumed once in mock tests.
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
tested here. No test below requests OS permissions or controls another app.

```sh
npm ci --ignore-scripts
npm run check
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-test.txt
.venv/bin/python packages/protocol/validate_contract.py
npm run test:swift
npm run test:mac-peer
```

To try the available macOS host test yourself, run `npm run test:mac-peer` from
this repository. The expected result lines are shown in
`docs/LOCAL_MAC_TEST.md`.

For a visual, no-effects menu-bar mock, run `npm run run:native-mock`, then choose
**Open Command Panel** under **S1 Mock**. It accepts text and demonstrates Stop,
but it does not control apps or browsers. The current command-line self-check and
this UI mock exercise different pieces of the intended product.

The XCTest suite requires an SDK providing XCTest; it could not run with this
machine's command-line-tools installation. The standalone parity check did pass:
`swift run --package-path packages/protocol/swift DigestCheck tests/fixtures/digests.json`.
The peer-identity check is macOS-only and uses temporary ad-hoc-signed binaries;
it does not require or qualify a release signing identity.
See `docs/VALIDATION.md` for the actual commands and environment limitations.

`npm run fixtures` regenerates shared digest vectors. Fixture changes must preserve
the schema's existing golden digests unless the contract is intentionally revised.
Python and Swift remain independent checks of the TypeScript fixture output.

CLM/ASR model downloads, signing, microphone capture, native control, browser
automation and remote inference are not part of these commands. Do not add models
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
