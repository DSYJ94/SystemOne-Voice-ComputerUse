# Try the local macOS peer test

The current runnable test checks whether a local helper can prove its identity
to the host over a Unix socket. It is a command-line test of one product boundary;
there is no menu-bar app binary to launch yet.

Open Terminal and run:

```sh
cd '/Users/daryl/Library/CloudStorage/OneDrive-Personal/Shared GitHub Repos/SystemOne-Voice-ComputerUse'
npm run test:mac-peer
```

The first run may spend a few seconds compiling Swift. A successful run exits with
code 0 and prints these three results (the PID and hash change each run):

```text
accepted pid=... identifier=com.aurium.systemone.peercheck cdhash=...
rejected: peer requirement mismatch: signing identifier
rejected: peer requirement mismatch: CDHash
```

The script makes temporary ad-hoc-signed test binaries under `/private/tmp`, opens
only a temporary local socket, and removes its temporary directory on exit. It
does not ask for macOS Accessibility, microphone or screen capture access.

If the command fails, send the full Terminal output and exit code. A `bind failed:
Operation not permitted` error means the runner was sandboxed; use Terminal itself
for this check. An XCTest error is separate from this test and reflects the current
Command Line Tools installation, which lacks XCTest.
