# Enable Voice crash handoff — 28 September 2026

## Observed failure and diagnosis

The owner clicked **Enable Voice** in the ad-hoc `SystemOne Dev` app and macOS
reported that it quit unexpectedly. Two local DiagnosticReports incidents,
`D473FC9D-FD30-46CF-92E5-56D002CDD37B` (22:55) and
`B0D1F920-5C81-4681-88D7-C2357E3D8C18` (23:15), have the same relevant
stack: `EXC_BREAKPOINT` / `SIGTRAP` in `_dispatch_assert_queue_fail` →
`_swift_task_checkIsolatedSwift` → `closure #1 in
OnDeviceSpeech.requestPermissions()` → Speech authorization's TCC reply on
`com.apple.root.default-qos`. The main thread was in the normal AppKit event
loop. This is a Swift actor-isolation failure at the Speech permission reply,
not evidence that the app recorded audio or dispatched a computer-use action.
The reports are stored locally under `~/Library/Logs/DiagnosticReports/` and
are not committed because they contain device/process metadata.

`OnDeviceSpeech` is `@MainActor`. Its permission callback was formed in that
context, but Speech invoked it on a background queue. The explicit
`Task { @MainActor ... }` inside the callback ran too late: the runtime checked
the callback's inferred isolation before entering its body. The built app's
`Info.plist` contains `NSSpeechRecognitionUsageDescription`, so a missing
speech purpose string is not the supported explanation for these two crashes.

## Change in this branch

The Speech, microphone, and recognition-result callbacks are explicitly
`@Sendable`; all UI/state access remains inside `Task { @MainActor ... }`.
Speech authorization accepts an injectable requester so a test can deliver a
permission result from a background queue without requesting TCC access or
recording audio. The test checks the exact denied-permission status on the main
actor. It protects the callback isolation pattern but cannot prove the system
permission dialog, microphone lifecycle, or final transcription works.

## Validation and next agent

- `npm run test:voice-permission-callback`: passed on this Mac, synthetic
  background callback only.
- `npm run build:native-dev`: passed, ad-hoc development app rebuilt.
- `npm run check`: passed, 241/241 TypeScript/Node tests.
- A sandboxed first attempt to run the Swift smoke could not write the global
  Clang module cache; the script now uses a private temporary cache. A
  sandboxed `npm run check` also had loopback `EPERM`; the permitted local run
  passed. Those initial failures are environment restrictions, not product
  regressions.
- **Unverified:** clicking Enable Voice in the rebuilt app, both permission
  prompts, actual held speech, transcript completion, and no new crash report.

The next agent should first inspect `git status`, the latest commit/PR, and
this handoff. Do not infer live voice success from the smoke. When the owner is
ready for a manual check, run the exact checkout's `npm run run:native-dev`,
choose **Enable Voice** once, and record whether the app stays open and whether
macOS shows Speech and microphone prompts. Then hold Talk for a disposable
utterance, release it, and verify that only a final editable transcript appears.
Record the result and any new `.ips` incident ID here and in
`docs/VALIDATION.md`. Do not run an action in a real app merely to test speech.
If permission is denied, the app should stay open and report denial; do not
reset TCC or alter machine settings automatically.

The product remains a bounded development alpha. It does not yet use CLM in
the task loop, accept arbitrary multi-hop computer-use requests, qualify the
existing Chrome profile, or meet signed/notarized distribution gates.
