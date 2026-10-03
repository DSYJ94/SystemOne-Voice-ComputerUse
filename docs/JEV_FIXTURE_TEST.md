# Jev-chosen fixture steps (owner test)

Added 3 October 2026. With `npm start` (or the Developer Tools checkbox), Jev
(`jev-1.13.0`, TypeSafe) chooses each step of the synthetic fixture workflow.
Without the checkbox, the fixed script chooses. Only the bundled
SystemOne Fixture app is involved. No real app, file or browser profile is
touched.

## What changes when the box is ticked

- Jev is offered **every** pressable fixture button, plus wait and ask for
  help. It is not limited to the one scripted button.
- Each request sends the fixture window title, its button labels, the fixed
  command text and the candidate descriptions to
  `https://api.typesafe.ai/v1/systemone`. Control handles, permits and the
  journal never leave the Mac.
- The key comes from the login Keychain item `systemone-jev` when the task
  starts. If the key is missing or unreadable, the task is refused; it never
  falls back to the script.
- A choice is acted on only when its probability is ≥ 0.5 and leads the
  runner-up by ≥ 0.1. These are uncalibrated development thresholds.
  Otherwise nothing is pressed and the task pauses.
- After every press, the existing independent title check must match the
  admitted stage. A wrong choice is pressed once, fails that check and never
  completes.
- The status line and the native output pane show each choice, for example
  `Jev chose “Budget.xlsx” (97%)`.

## Steps

1. `npm start`. It checks Node 26, confirms the Keychain key against
   TypeSafe without printing it, builds what is stale, opens a fresh
   SystemOne Fixture window, and restarts SystemOne Dev with Jev enabled for
   this session (`SYSTEMONE_DECISION_PROVIDER=jev`, shown as a **Jev** chip).
2. Press Control-Option-Space. The glass command bar appears in the centre.
3. Type `open Budget.xlsx`, `locate Budget.xlsx` or `go to Documents`, then
   press Return. Each step shows `Jev chose “…” (97%)` under the bar, then the
   verified result. Control-Option-Escape or the stop button stops the task.
4. If the bar reports that this build is not authorized (an ad-hoc rebuild
   drops the grant), use **⋯ → Accessibility…** and grant it to
   `.build/native-dev/SystemOne Dev.app`.

To run the workflow again, use the Fixture window's **Reset**. Fixture tasks
accept typed requests only for now; a spoken transcript is refused with a
message. The Developer Tools window (**⋯ → Developer Tools**) keeps the
older buttons and the per-task Jev checkbox.

Limits: this is a synthetic fixture with development thresholds. It does not
qualify B22, calibration, privacy review or any v1 gate. Real apps still use
the scripted or exact-label paths.
