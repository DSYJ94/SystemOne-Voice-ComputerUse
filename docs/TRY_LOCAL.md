# Try the current local computer-use build

From this checkout on an Apple Silicon Mac, with the locked npm dependencies and
Playwright Chromium installed, run:

```sh
npm run try:local
```

This command rebuilds a stale synthetic Fixture, opens it and SystemOne Dev,
then runs the loopback invoice portal in the same terminal. It does not request
Accessibility access, capture audio, install a Chrome extension, or connect to
an account. Leave the terminal open and copy the printed portal URL. If older
SystemOne Dev or SystemOne Fixture builds are running from another checkout,
quit them first; the launcher refuses to open an ambiguous target. A rebuild
of the ad-hoc-signed Dev app can require a new macOS
Accessibility grant.

In the **Native app** section, enter bundle ID
`com.aurium.systemone.fixture`, label `Fixture Name`, and a disposable value such
as `fixture-456`. Choose **Request Accessibility** only if you want to grant this
Dev build access. Click **Fill native field** once. The separate Fixture field
should change, and the panel should report **Verified** after a fresh read.
You can also use **Inspect app**, then enter a displayed number and choose
**Inspect region**; inspection is read-only. This is an actual AX action against
a separate app, but the target is synthetic and general-app compatibility is
not established.

In **Managed browser**, enter the printed portal URL, label `Find invoice`, and
another disposable value. Click **Fill field**. A fresh Chromium profile should
open; **Verified** means only that its DOM field has the expected value. Click
**Stop** to close that context. The **Download fixture INV-105** button runs a
separate fixed search/open/download/save task using the same URL. Its verified
file goes under `~/Library/Application Support/SystemOne-Dev/fixture-output/`.
An existing file is never overwritten.

The existing-Chrome bridge has an isolated automated test:
`npm run test:chrome-browser-transport`. It uses disposable Playwright Chromium
and never touches your Chrome profile. The full installed bridge still needs a
separate-account, signed-host qualification before a current-profile test.
This command therefore does **not** test existing Chrome, voice, CLM, or a
distributable v1. Those remain required for v1.

If a task reports **uncertain**, **Earlier effect unresolved**, or a failed Stop
fence, inspect the visible result and do not immediately repeat the action.
Keep `~/Library/Application Support/SystemOne-Dev/attempts.sqlite` for recovery
analysis. Press Ctrl-C in the terminal to stop the portal; quit SystemOne Dev
and the Fixture normally. Neither Stop nor closing the portal undoes a field
already changed.
