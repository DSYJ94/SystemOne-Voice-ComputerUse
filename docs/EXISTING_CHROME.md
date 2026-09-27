# Existing Chrome bridge: source status

Updated 27 September 2026. This is B19 implementation work, not a usable
existing-profile computer-use release. No extension or native host has been
installed in the owner's Chrome profile by the automated checks.

`extensions/chrome/` contains a Manifest V3 extension with `activeTab`,
`scripting`, `nativeMessaging`, `storage` and `webNavigation`. It declares no
`<all_urls>` host grant, content script, externally callable message bridge or
`debugger` permission. The user must click its toolbar action for the current
normal HTTP(S) tab. Incognito, restricted pages and subframes are unsupported.
The badge shows `...` while a native-host handshake is pending, `ON` after an
exact acknowledgement, and `OFF` when the tab/document grant is revoked.

The ephemeral grant binds extension ID, a random per-profile installation tag,
service-worker session, native-port session, tab, window, main frame, document,
exact URL and origin. A navigation, history/fragment change, tab move/close,
native-port disconnect or service-worker restart discards the grant. The tag is
not independent proof of the Chrome profile or OS browser process. Each read
checks the current tab and main-frame document before and after a bounded
`chrome.scripting.executeScript` call targeted by document ID. The collector
returns at most 80 visible semantic labels, with no input values or password
fields. These labels and the title can still be private task data, so the
native host must apply the same disclosure policy before any model request.

All action requests currently return `unsupported_operation`. The extension
cannot yet drive the user's Chrome pages. `packages/chrome-native-host/` now
builds a Swift native-messaging executable. It reads a configuration staged next
to the executable before bundle signing, checks Chrome's exact caller-origin
argument, connects to the fixed per-user SystemOne controller socket, verifies
that connected controller's audit-token/code-signing identity, and relays at most
64 KiB per framed message. Its test-only socket override is excluded from a
release build. `scripts/stage-chrome-native-host.mjs` writes an exact-origin
Chrome manifest and release controller trust pins; it **does not register** that
manifest with Chrome. The SystemOne controller listener and protocol handler do
not yet exist. An unpacked extension without the installed host will show `OFF`.

The host's origin argument and extension installation tag are not independent
proof that Chrome launched the process or which profile owns a message: a local
process can invoke a signed host with that argument. The future controller must
authenticate the host peer, validate every protocol message and task permit,
and treat tab/document bindings as scoped claims that require fresh checks.
Neither the host nor the extension currently authorizes an effect.

`npm run test:chrome-host` builds and ad-hoc signs a temporary host and
synthetic controller, then checks framed round-trip, wrong caller origin,
oversized input and wrong controller CDHash. A release-configured build compiles.
These checks do not open Chrome, verify extension-to-host integration, exercise
Stop, or establish a distributable signing identity.

Release packaging must place the host at its final absolute path and run
`node scripts/stage-chrome-native-host.mjs EXTENSION_ID HOST_PATH MANIFEST_PATH
CONTROLLER_SIGNING_ID --team-id TEAM_ID` (or `--cdhash CDHASH`) before signing
the bundle. The generated manifest must then be installed in Chrome's
per-user native-host registration location. This is a packager instruction,
not a current-profile test procedure; neither operation is automated yet.

Before an owner-run current-profile test, package/sign the host with its exact
extension manifest, register that manifest, pair the host with an authenticated
SystemOne task controller, and test the user-visible grant/revoke cycle.
Then add fixed semantic actions through host permits, fresh document checks,
Stop/reconnect handling, unsupported trusted-input behavior and real Chrome
profile cases. Keep file transfer disabled until its outbound and destination
enforcement is qualified. Test on a separate non-sensitive Chrome profile
first; an existing-profile check requires explicit owner participation.

Primary references checked for this slice:

- [Chrome activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab): toolbar invocation grants temporary tab access and cross-origin navigation revokes it.
- [Chrome scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting): document-targeted injection results include frame and document IDs (Chrome 106+).
- [Chrome webNavigation](https://developer.chrome.com/docs/extensions/reference/api/webNavigation): document IDs distinguish a frame's successive documents.
- [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging): native-host manifest, exact allowed extension origins, stdio framing and service-worker API limits.
