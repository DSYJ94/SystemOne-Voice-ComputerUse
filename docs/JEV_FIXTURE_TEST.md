# Jev-chosen fixture steps (owner test)

Added 3 October 2026. With a checkbox in the development app, Jev
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

1. Quit any running SystemOne Dev and Fixture apps (Cmd-Q).
2. `npm run run:native-mock`, then choose Reset in the Fixture window.
3. `npm run run:native-dev`. The command rebuilds the app when sources
   changed. An ad-hoc rebuild can invalidate the Accessibility grant; use the
   panel's Accessibility… button to re-grant it to
   `.build/native-dev/SystemOne Dev.app`.
4. In Developer Tools, tick **Let Jev choose each fixture step**, then click
   **Documents**, **Locate Budget.xlsx** or **Open Budget.xlsx**.
5. Expect one `Jev chose …` line per step, then the usual verified status.
   Stop (Control-Option-Escape) works as before.

Limits: this is a synthetic fixture with development thresholds. It does not
qualify B22, calibration, privacy review or any v1 gate. Real apps still use
the scripted or exact-label paths.
