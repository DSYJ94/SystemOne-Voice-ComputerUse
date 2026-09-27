# Development native-to-managed-browser test

This is an opt-in local test on macOS. It exercises a real AppKit menu-bar
process, a persistent Node controller over inherited private pipes, and one
isolated managed Chromium field edit. It does not control existing Chrome or
native apps, use CLM or voice, submit a form, or qualify a release build.

Use a terminal in the repository with the pinned Node and Playwright Chromium
installed. In terminal 1, run:

```sh
npm run run:portal-fixture
```

Copy the printed `http://127.0.0.1:<port>/` URL and leave that terminal open.
In terminal 2, run:

```sh
npm run run:native-dev
```

The **SystemOne Dev** panel should open. If it is hidden, choose **S1 Dev →
Open Command Panel** in the menu bar or click its Dock icon. Enter the exact
fixture URL, **Find invoice** as the field label, and `fixture-123` as the
value. Press **Fill field**. A fresh Chromium window should open with the
synthetic portal. The panel should say **Verified** only after the controller
has re-read the field's DOM value. The browser stays open for inspection. Press
**Stop** to close it; the panel should say **Stopped**. Repeat with a second
synthetic value if desired. To end the fixture server, press Ctrl-C in terminal
1. Quit the development app using its menu item or Dock menu.

The app requires no Accessibility grant for this browser test. It launches a
fresh temporary Chromium profile and never attaches to an existing Chrome
profile. Do not enter passwords, personal data or a real account into this
development UI. The app accepts HTTPS pages but arbitrary-site privacy,
compatibility and worker isolation are not yet qualified; use the synthetic
fixture for this manual test. A field edit is a local DOM state, not a submit
or a persisted website change. Stop cannot undo an edit already dispatched.

The build is ad-hoc signed and refers to this checkout's Node executable and
TypeScript source by absolute paths. Move/rebuild the checkout or change Node
and the app must be rebuilt. It is not a distributable signed/notarized app.
If the panel reports **Earlier effect unresolved**, do not retry blindly;
retain `~/Library/Application Support/SystemOne-Dev/attempts.sqlite` for
inspection. A controller exit or uncertain browser fence likewise needs
re-observation before any retry.
