# Existing Chrome bridge: source status

Updated 28 September 2026. This is B19 implementation work, not a usable
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

The source now accepts one fixed `fill` action, but the host admits it only
for a synthetic portal-shaped loopback page and the exact `Find invoice` label.
The panel supplies the final typed command and value. The host requests a fresh,
complete observation, selects one editable candidate, records a value digest
and one-use permit, and persists a dispatch boundary before messaging the
extension. The extension rechecks the document, retained node, label and
duplicate fields before setting a nonsecure input; it checks the current DOM
value afterward. A matched DOM value does **not** prove form submission,
server persistence or trusted user input. Input events can trigger page scripts
and outbound writes, so the host records `EXTERNAL_WRITE` as a possible effect;
the development panel calls for disposable synthetic text. Stop fences future actions but cannot
undo an already-dispatched edit. Unknown delivery blocks another task until
explicit recovery. A loopback URL and page title do not authenticate the
fixture process; this remains a development-only scope.
The controller now reports the extension Stop fence before a delayed action
receipt arrives and keeps the task slot occupied until that receipt settles.

`packages/chrome-native-host/` now
builds a Swift native-messaging executable. It reads a configuration staged next
to the executable before bundle signing, checks Chrome's exact caller-origin
argument, connects to the fixed per-user SystemOne controller socket, verifies
that connected controller's audit-token/code-signing identity, and relays at most
64 KiB per framed message. Its test-only socket override is excluded from a
release build. `scripts/stage-chrome-native-host.mjs` writes an exact-origin
Chrome manifest and release controller trust pins; it **does not register** that
manifest with Chrome. The development AppKit build now has an opt-in local
listener. It authenticates the connected host's audit-token/code-signing
identity against a pinned CDHash or Apple-anchored Team ID before forwarding
frames on its private controller pipe. The Node session checks exact
extension/profile-session/tab/frame/document/URL claims, requests one bounded
observation and displays labels locally. Malformed, replayed,
expired or changed replies close the session. An unpacked extension without
the installed host will show `OFF`.

The host's origin argument and extension installation tag are not independent
proof that Chrome launched the process or which profile owns a message: a local
process can invoke a signed host with that argument. The controller must
continue validating every protocol message and future task permit, and treat
tab/document bindings as scoped claims that require fresh checks.
Only the host's development fill authority admits the narrow effect above.
Release policy and profile qualification remain open.

`npm run test:chrome-host` builds and ad-hoc signs a temporary host and
synthetic controller, then checks framed round-trip, wrong caller origin,
oversized input and wrong controller CDHash. A release-configured build compiles.
`zsh scripts/build-chrome-dev-bridge.sh EXACT_EXTENSION_ID` stages an ad-hoc
development host, app and exact-origin manifest under ignored `.build/`, but
does not register the manifest or touch a Chrome profile. Its host configuration
is outside a signed release bundle and is not a production trust anchor.
`zsh scripts/check-chrome-dev-listener.sh` checks a signed temporary host and
listener exchange. Synthetic tests now cover the controller/extension fill
contract, host journal boundary and Stop after dispatch. A temporary MV3 test
extension using the production semantic functions confirms that separate
`chrome.scripting.executeScript` calls in Playwright Chromium retain the
observation-scoped handle, reject a duplicate field and reject the old handle
after reload. This checks an actual isolated extension world but does not
exercise the production extension's native-host messages. These checks do not
open the owner's Chrome, verify a real installed extension-to-host action, or
establish a distributable signing identity.

Release packaging must place the host at its final absolute path and run
`node scripts/stage-chrome-native-host.mjs EXTENSION_ID HOST_PATH MANIFEST_PATH
CONTROLLER_SIGNING_ID --team-id TEAM_ID` (or `--cdhash CDHASH`) before signing
the bundle. `scripts/register-chrome-native-host.mjs` now validates the staged
manifest, matching configuration, executable and `codesign --verify --strict`
before installing its exact bytes in Chrome's per-user native-host directory.
It refuses an existing different registration, and `remove` refuses to delete
a changed registration. This is a deliberate installation command; no build or
test calls it against the owner's home. On a separate non-sensitive test account
after placing the signed host at its final path, the commands are:

```sh
node scripts/register-chrome-native-host.mjs install /absolute/staged/com.aurium.systemone.chrome.json
node scripts/register-chrome-native-host.mjs verify /absolute/staged/com.aurium.systemone.chrome.json
node scripts/register-chrome-native-host.mjs remove /absolute/staged/com.aurium.systemone.chrome.json
```

Chrome requires an absolute executable path in its macOS manifest and uses
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` for the
default user-level registration. A moved app needs a new manifest at its final
path. This helper does not yet provide an update transaction or install the
extension. It does not establish which Chrome profile launched the host.

Before an owner-run current-profile test, first qualify the installed
exact-origin manifest, host/app signing pair, activeTab grant/revoke cycle,
read-only observation and fixed loopback field action in a separate
non-sensitive Chrome profile. The temporary MV3 test establishes isolated-world
handle persistence only in Playwright Chromium; test it again in the installed
bridge, followed by Stop and reconnection.
Broader actions require effect classification and site-specific policy; Chrome
may reject synthetic input where trusted user gestures are required. Keep file
transfer disabled until outbound and destination enforcement is qualified. An
existing-profile check requires explicit owner participation.

Primary references checked for this slice:

- [Chrome activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab): toolbar invocation grants temporary tab access and cross-origin navigation revokes it.
- [Chrome scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting): document-targeted injection results include frame and document IDs (Chrome 106+).
- [Chrome webNavigation](https://developer.chrome.com/docs/extensions/reference/api/webNavigation): document IDs distinguish a frame's successive documents.
- [Chrome native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging): native-host manifest, exact allowed extension origins, stdio framing and service-worker API limits.
