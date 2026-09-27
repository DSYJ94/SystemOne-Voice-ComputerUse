# Native Accessibility inspection development test

This opt-in macOS check reads one running app's bounded Accessibility tree.
It does not change an app, read field values, or qualify native computer-use
actions. The worktree build is separate from the currently running managed-
browser test; do not launch two SystemOne Dev builds at once.

After closing the earlier SystemOne Dev app, run `npm run run:native-dev` from
the updated checkout. In the panel's **Native app — read-only inspection**
section, enter the exact bundle ID of a running app. For the synthetic fixture,
start `npm run run:native-mock`, choose **Open Fixture** in SystemOne Mock, and
use `com.aurium.systemone.fixture` as the bundle ID. Click **Request
Accessibility** only if you want macOS to grant this new SystemOne Dev build
access; the grant for SystemOne Mock does not apply to it. Then click **Inspect
app**. The panel should list labelled controls and mark coverage complete or
incomplete. **Stop** discards a pending read-only inspection result.

The observer binds the target process ID, bundle ID, executable bundle path and
launch time, limits traversal to 80 nodes and depth 5, and marks any truncation
or failure as incomplete coverage. It omits secure-field labels and never reads
`AXValue`. A missing control in incomplete coverage is not evidence that the
control does not exist. The observation runs off the UI thread, but an
Accessibility API call may still time out; this is not yet a supervised worker
with a proven deadline. Do not use this build to inspect a sensitive app unless
you are comfortable with its labels appearing locally in the panel.

This app is ad-hoc signed and launches external Node/source paths; it is not a
release artifact. Rebuilding an ad-hoc bundle can require a fresh macOS
Accessibility grant. Record whether the fixture field appears, whether
coverage is incomplete, and any permission or timeout message. Do not infer
native action support from a successful read-only inspection.
