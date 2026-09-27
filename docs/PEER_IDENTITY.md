# macOS local peer identity boundary

Status: implemented and locally probed as a B03 transport primitive. It is not yet
wired to a production supervisor or certified signing chain.

`PeerIdentity.inspectConnectedUnixPeer` obtains `LOCAL_PEERTOKEN` from a connected
Unix-domain socket, extracts PID, PID version, effective UID/GID from the kernel
audit token, and cross-checks UID/GID with `getpeereid`. It resolves the running
peer through `SecCodeCopyGuestWithAttributes`, calls `SecCodeCheckValidity`, and
records its signing identifier, Team ID when present, and CDHash.

`PeerRequirement` refuses identifier-only trust. A valid requirement must bind:

- the expected effective user and signing identifier; and
- an Apple-anchored Team ID requirement, one or more release-pinned CDHashes, or
  both.

Production callers use `authenticateConnectedUnixPeer`; inspecting identity fields
alone is diagnostic and does not authorize a peer. The authenticated connection
must be converted into an in-process endpoint
capability before message decoding. JSON `issuer` or `producer` fields remain
descriptive metadata. A PID alone is insufficient because it can be reused; the
audit token's PID version is retained with the identity.

For a shipped app, prefer a signed inherited socket or a socket inside a protected
application-group location. Keep the connection open while authenticating it. Load
the expected Team ID/designated release identity from signed host configuration;
do not learn trust from the connecting peer. Release validation must repeat this
with the actual app/helper signature after install and update.

## Bounded local check

Run on macOS:

```sh
scripts/check-peer-identity.sh
```

The script builds the Swift target, copies it only into a private temporary
directory, and applies ad-hoc signatures. It verifies:

1. the exact same signed binary is accepted;
2. a binary with a different signing identifier is rejected; and
3. a changed binary with the same identifier but a different CDHash is rejected.

Ad-hoc signing does not establish a Team ID, Developer ID trust, notarization or
TCC responsibility. The check requests no Accessibility, microphone or screen
capture permission and performs no application or browser action.
