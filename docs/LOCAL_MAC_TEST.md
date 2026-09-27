# Try the local macOS builds

## Peer identity self-check

This test checks whether a local helper can prove its identity to the host over
a Unix socket. It exercises one security boundary. The menu-bar mock below is a
separate build; there is no computer-controlling product app yet.

Open Terminal and run:

```sh
cd '/Users/daryl/Library/CloudStorage/OneDrive-Personal/Shared GitHub Repos/SystemOne-Voice-ComputerUse'
npm run test:mac-peer
```

The first run may spend a few seconds compiling Swift. A successful run exits with
code 0 and prints these results (the PID and hash change each run):

```text
accepted pid=... identifier=com.aurium.systemone.peercheck cdhash=...
rejected: peer requirement mismatch: signing identifier
rejected: peer requirement mismatch: CDHash
PASS: local peer identity checks completed; no app or browser was controlled.
```

The two `rejected` lines are deliberate successful checks. Linker warnings about
missing Command Line Tools search paths can appear before `Build complete`; they
are non-fatal when the `PASS` line appears and Terminal returns to its prompt.

The script makes temporary ad-hoc-signed test binaries under `/private/tmp`, opens
only a temporary local socket, and removes its temporary directory on exit. It
does not ask for macOS Accessibility, microphone or screen capture access.

If the command fails, send the full Terminal output and exit code. A `bind failed:
Operation not permitted` error means the runner was sandboxed; use Terminal itself
for this check. An XCTest error is separate from this test and reflects the current
Command Line Tools installation, which lacks XCTest.

## Native menu-bar UI mock

To try the current visual shell, run:

```sh
cd '/Users/daryl/Library/CloudStorage/OneDrive-Personal/Shared GitHub Repos/SystemOne-Voice-ComputerUse'
scripts/run-native-mock.sh
```

The command panel now opens on launch, and the mock also appears in the Dock.
If your menu-bar manager shows **S1 Mock**, its menu also has **Open Command Panel**.
Type any request and select **Preview only**. The panel should say it received a preview
and sent no action. **Stop** clears the text; **Hide** closes the panel without
quitting; **Quit Mock** is in the menu-bar menu, or you can quit from the Dock.
This build has no shortcut,
microphone, model, Accessibility adapter or browser connection. It will not act
on the typed request. The mock is ad-hoc signed locally and asks for no TCC grants.

The app lives under `.build/native-mock/` and is rebuilt when the command runs.
If the menu-bar item is hidden, click the **SystemOne Mock** Dock icon to reopen
the panel. Quit the running mock before rebuilding after source changes.
