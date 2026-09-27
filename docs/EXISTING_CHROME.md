# Existing Chrome bridge: first source slice

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
cannot yet drive the user's Chrome pages. The native messaging host
`com.aurium.systemone.chrome` has not been packaged or registered; the host
handshake is currently exercised only by a mocked Chrome API test. An unpacked
extension without that host will show `OFF`. Do not claim existing-Chrome beta
support from this test.

Before an owner-run current-profile test, implement and sign the native host,
register a manifest allowing only the packaged extension ID, pair the host with
the SystemOne task controller, and test the user-visible grant/revoke cycle.
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
