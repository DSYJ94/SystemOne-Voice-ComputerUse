# Test one native computer-use action

This is a fixture-only macOS test. SystemOne Mock may change **only** the
**Fixture Name** field in **SystemOne Fixture** through macOS Accessibility.
There is no model, voice input, browser connection, clipboard use, personal-app
control or remote service in this path. Use synthetic text.
`npm run test:mac-peer` is a separate Terminal-only signing check and will not
open either test app.

1. The run command below stops only earlier SystemOne Mock and SystemOne Fixture
   test processes from this build path, then opens a fresh Mock. Any synthetic
   value left in the Fixture will be lost. This avoids reopening an older process
   after its bundle has been rebuilt.
2. In Terminal, run:

   ```sh
   cd '/Users/daryl/Library/CloudStorage/OneDrive-Personal/Shared GitHub Repos/SystemOne-Voice-ComputerUse'
   npm run run:native-mock
   ```

3. In SystemOne Mock, choose **Open Fixture**. Confirm a separate **SystemOne
   Fixture** window has an empty **Fixture Name** field. If **S1 Mock** is hidden
   by a menu-bar manager, use Command-Tab to select **SystemOne Mock** or use
   its Dock icon to reopen the panel.
4. Return to **SystemOne Mock**. Enter `fixture-123` in **its** value field;
   typing directly in the fixture does not exercise computer use. If the mock
   says Accessibility is unavailable, choose **Request Accessibility**. If macOS
   asks, grant Accessibility to **SystemOne Mock** in System Settings. The prompt
   is controlled by macOS; granting it is your choice. The first check may still
   say access is unavailable because Apple's prompt is asynchronous. Return to
   the mock after granting access.
5. Choose **Fill Fixture Name**. A successful run changes the fixture field to
   `fixture-123` and reports that the value was re-observed. If it was already
   that value, the mock reports that no edit was sent. You can clear the field
   with **Reset** in the fixture and try another synthetic value. Reset should
   display "Reset completed" and leave Fixture Name empty.

**Stop** remains responsive while the Accessibility worker runs. If an edit was
already dispatched, Stop cannot undo it. The status will say whether the value
was verified or whether the outcome is uncertain. Do not repeat an uncertain
attempt until you inspect the fixture field. This is a development test of one
operation; durable dispatch, fast Stop barriers, crash recovery and signed TCC
attribution remain open before controlling non-fixture apps.

If Fill does not work, record the exact status text. A missing fixture process,
denied Accessibility permission, changed target identity or missing control
will stop before the setter is called. Permission may need to be granted again
after rebuilding an ad-hoc-signed development app. Do not grant access to a
different app merely because its name looks similar.

If the macOS toggle is **on** but the Mock reports "Accessibility is not
granted," the current ad-hoc build may no longer match the earlier approval.
The narrow development reset is `tccutil reset Accessibility
com.aurium.systemone.native-mock`; then relaunch with `npm run run:native-mock`,
choose **Request Accessibility**, and grant the current Mock when macOS asks.
The reset removes only this test app's Accessibility decision; it does not grant
access. A valid development signing identity can be supplied with
`SYSTEMONE_CODESIGN_IDENTITY` to test stable identity across builds. Production
signing and update attribution remain separate release work.
Apple documents the [per-app reset command](https://developer.apple.com/documentation/xcode/resetting-access-to-protected-resources-in-macos)
and notes that [Accessibility prompting is asynchronous](https://developer.apple.com/documentation/applicationservices/1459186-axisprocesstrustedwithoptions).

If either test app exits unexpectedly, stop the test and report which app
disappeared. `npm run run:native-mock` is the clean restart path; direct
`npm run build:native-mock` now refuses to overwrite a running test bundle.
