# Try the voice/text computer-use command panel

Manual testing is parked at the owner's request on 29 September 2026. Keep
these steps for when the owner asks to revisit testing; current source work and
open evidence are tracked in [build handoff](BUILD_HANDOFF.md).

This development build can act on one labeled, editable field in a real native
app or on an approved HTTPS page in a fresh managed Chromium profile. It is a
bounded first agent workflow, not general computer control or v1 certification.
The final spoken transcript and typed text use the same task command field and
the same controller, journal, action permit, Stop and verification path.
This development build uses Apple's on-device Speech recognizer to make the
flow testable without a model download. The planned pinned WhisperKit path and
representative speech evaluation remain open; this does not change CLM as the
primary decision model.

For the current Accessibility-preflight build, first quit any earlier **SystemOne Dev**
with **Command–Q**. Closing the window can leave the app running. In Terminal:

```sh
cd '/Users/daryl/.codex/worktrees/ax-preflight/SystemOne-Voice-ComputerUse'
npm run run:native-dev
```

The compact translucent **SystemOne** window opens on launch; Control–Option–Space
reopens it. The menu-bar or Dock item also opens it. Control–Option–Escape is
Stop. A rebuild is ad-hoc signed and may need a fresh Accessibility grant for
native actions. If the launcher reports another exact SystemOne Dev path, quit
that app with Command–Q and run the command again; do not use a force-quit script.

First check the reported window problem: with **SystemOne** visible, use your
trackpad's Mission Control gesture (normally swipe up with three or four fingers)
and, if applicable, App Exposé (normally swipe down). The SystemOne window should
remain in the window overview and be selectable. Command–Tab alone is not the
acceptance check. If it still disappears, report which gesture you used and
whether Stage Manager or multiple Spaces are enabled. The built-window
`npm run test:window-visibility` check verifies the explicit AppKit `.managed`
setting, but only the physical gesture verifies the actual desktop behavior.

"No target app captured" on initial launch is expected: SystemOne itself can be
frontmost then. Focus the app you want to test, then press Control–Option–Space;
the panel should name that app. Do not run a native request while no target is
captured. **Show fields** now asks for a target first; it does not check or
prompt for Accessibility while the target is absent.

For a real native app, open a disposable document or field in an app you choose
and bring that app to the front. Press Control–Option–Space. Confirm the panel's
**Target** names that app. Choose **Show fields** to see up to five observed,
nonsecure editable labels. If macOS asks for Accessibility access, grant it to
this exact development build and choose **Show fields** again. If the switch
already appears on but this running app still reports denied, quit SystemOne
Dev with Command–Q and reopen it once. If it remains denied, remove the stale
**SystemOne Dev** entry from System Settings → Privacy & Security → Accessibility,
then add the exact app at
`/Users/daryl/.codex/worktrees/ax-preflight/SystemOne-Voice-ComputerUse/.build/native-dev/SystemOne Dev.app`
and turn it on. In the file picker, Command–Shift–G accepts that full path.
Reopen the app and choose
**Show fields** again. An ad-hoc rebuild can invalidate the previous grant;
the visible switch alone does not prove trust for the running executable.
If coverage is
incomplete or no label appears, do not guess. Enter
`Fill <exact displayed label> with <disposable value>`. Choose
**Run request** once. **Verified** means a fresh read found that exact value in
the chosen field. It does not mean the document was saved or submitted.

Before running any action, test voice alone. Choose **Enable Voice** once and
grant microphone and speech recognition access to this build. Hold **Talk**
while speaking the same command,
then release. Recording stops on release. Wait for **Final transcript ready**,
read and edit the command text if needed. Only then choose **Run request** if
you intend to test the selected disposable field. Partial transcripts never
run. Recognition requires an available on-device recognizer
for the current Mac language; it never falls back to network speech. Raw audio
is not saved. If the recognizer is unavailable, type the command instead.

**Crash regression gate (28 September):** the owner previously saw SystemOne Dev
quit after Enable Voice. On 29 September, the owner reported that Enable Voice
and held Talk produced a final editable transcript without a crash in one run.
Repeat this after switching builds, but do not confuse a final transcript with
a verified computer-use action. If the app closes, stop there and record the
new crash-report incident; do not proceed to Run request.
See [voice crash handoff](VOICE_CRASH_HANDOFF.md).

For a browser page, enter or speak `Fill <exact field label> on <HTTPS URL> with
<disposable value>`. Review the URL carefully before **Run request**. This opens
an isolated Chromium profile, observes that page and fills one matching field.
The page's scripts may transmit text over the network, so use only disposable
values. **Verified** means the current DOM field holds the value; it does not
prove a server save. **Stop** closes the managed browser. HTTP is accepted only
for `127.0.0.1` local testing.

If the target field is missing, duplicated, secure, outside observed coverage,
or changed before dispatch, the action is refused. If an effect becomes
uncertain, inspect the visible result before retrying; Stop cannot undo an
already-dispatched edit. The compact panel does not yet route commands into
the existing Chrome profile, perform multi-hop open/download tasks from an
arbitrary utterance, or call CLM. Those remain v1 work.
