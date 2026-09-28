# Native Accessibility inspection development test

This opt-in macOS check reads one running app's bounded Accessibility tree.
The **Inspect app** button does not change an app or read field values. The
separate [native field test](NATIVE_COMPUTER_USE_TEST.md) uses an explicit
action and has additional limits. Do not launch two SystemOne Dev builds at once.

After closing the earlier SystemOne Dev app, run `npm run run:native-dev` from
the updated checkout. In the panel's **Native app — read-only inspection**
section, enter the exact bundle ID of a running app. For the synthetic fixture,
start `npm run run:native-mock`, choose **Open Fixture** in SystemOne Mock, and
use `com.aurium.systemone.fixture` as the bundle ID. Click **Request
Accessibility** only if you want macOS to grant this new SystemOne Dev build
access; the grant for SystemOne Mock does not apply to it. Then click **Inspect
app**. The panel should list labelled controls and mark coverage complete or
incomplete, with numbered nodes and coverage-gap reasons. To narrow an
incomplete observation, enter a displayed node number (0–23) in **Region #**
and click **Inspect region**. The next result applies only to that subtree and
invalidates the earlier node numbers. Use **Inspect app** to restart at the
application root. **Stop** discards a pending read-only inspection result.

The observer binds the target process ID, bundle ID, executable bundle path and
launch time, limits each traversal to 80 nodes and depth 5, and records bounded
reasons for incomplete coverage (including limits, inaccessible/foreign nodes,
and secure content). It omits secure-field labels and descendants and never reads
`AXValue`. A complete subtree does not establish whole-app coverage; a missing
control in incomplete coverage is not evidence that the control does not exist.
The observation runs off the UI thread, but an
Accessibility API call may still time out; this is not yet a supervised worker
with a proven deadline. Do not use this build to inspect a sensitive app unless
you are comfortable with its labels appearing locally in the panel.

This app is ad-hoc signed and launches external Node/source paths; it is not a
release artifact. Rebuilding an ad-hoc bundle can require a fresh macOS
Accessibility grant. Record whether the fixture field appears, any gap reasons,
whether region drill-down works, and any permission or timeout message. Do not infer
native action support from a successful read-only inspection.
