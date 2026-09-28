# Native field computer-use development test

This is an opt-in human test for the current development branch. It sends one
explicit native field-fill request from the AppKit panel to the persistent
controller, which admits the task and journals the boundary before the AppKit
Accessibility worker changes the field. It is not a general native-app agent,
CLM workflow, or release build. The automated tests use a synthetic worker;
the real AppKit-to-AX path still needs this human observation.

First finish and quit any earlier **SystemOne Dev** app. The launcher refuses
to open a second build while another checkout's Dev app is running. Open just
one **SystemOne Fixture** window from the existing local synthetic fixture
build. Then, from the checkout containing this change, run:

```sh
npm run run:native-dev
```

In the new SystemOne Dev panel, enter `com.aurium.systemone.fixture` under
**Native app**, `Fixture Name` as the exact field label, and a synthetic value
such as `fixture-456`. Choose **Request Accessibility** and grant **SystemOne
Dev** in macOS settings if prompted. A grant to **SystemOne Mock** does not
grant this app. Return to the panel and choose **Fill native field** once.
The separate Fixture window should show the value, and the panel should say
**Verified** only after the AX worker re-reads that field. The result means the
current field matches; it does not mean a document was saved.

If the panel says **unsupported**, check that exactly one Fixture process is
running and that the field is visible. Incomplete Accessibility coverage also
prevents this action. If it says **uncertain** or **Earlier effect unresolved**,
inspect the Fixture field and do not repeat the click; retain the local
`~/Library/Application Support/SystemOne-Dev/attempts.sqlite` journal for
recovery. **Stop** fences queued work and waits for a setter already entered,
but it cannot undo a value already set. The automated Stop races remain
synthetic until a live test is deliberately performed.

Only use the synthetic Fixture here. This ad-hoc-signed development app points
to the local Node executable and source files by absolute path, and rebuilding
it may require a fresh Accessibility grant. Its worker pipe and permit check
are not release-authenticated. Existing Chrome and other native apps have not
been qualified by this test.
