# Repeatable development signing and Accessibility

On 30 September the owner showed a captured Kimi target followed by an
Accessibility denial, while Settings showed SystemOne Dev enabled. The running
app was the `ax-preflight` build. Its designated requirement was a `cdhash` and
`security find-identity -v -p codesigning` reported zero valid identities.
An ad-hoc build's identity changes with its signed code. A stale grant is the
leading explanation, but the Settings row's stored identity was not inspected;
a grant for another copy or a required restart cannot be excluded. No code
change may treat the toggle as permission or bypass Accessibility checks.

The owner has a regular Apple ID. Apple supports local development through
Xcode's Personal Team; eventual Developer ID distribution and notarization
require program membership. See [Apple membership comparison](https://developer.apple.com/support/compare-memberships/),
[certificate management](https://help.apple.com/xcode/mac/current/en.lproj/dev154b28f09.html)
and [signing requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements).

## Owner setup

1. Install/open Xcode. In Settings, choose Apple Accounts (Accounts in some
   versions), add your Apple ID and select its Personal Team.
2. Open Manage Certificates, choose **+**, then **Apple Development**. Keep the
   certificate/private key in your Keychain; do not share credentials or keys.
3. Quit SystemOne Dev with Command–Q, then run:

   ```sh
   cd '/Users/daryl/.codex/worktrees/task-lifecycle/SystemOne-Voice-ComputerUse'
   npm run configure:dev-signing
   npm run run:native-dev
   ```

   The configurator pins the sole available Apple Development or Developer ID
   Application certificate's fingerprint in this checkout's ignored `.build`
   directory. If multiple certificates are present, use
   `npm run configure:dev-signing -- --identity <fingerprint>`.
   It does not create/import a certificate, export keys or modify TCC.
4. Renew Accessibility for the new certificate-signed build once. Capture the
   target, then choose Show fields. If denied, **Accessibility…** displays this
   process's exact app path and signing mode. **Reveal This App** selects that
   bundle in Finder. Remove the stale SystemOne Dev entry in Settings → Privacy
   & Security → Accessibility and add the exact bundle. Quit/reopen, recapture
   the target and retry Show fields.

Success: this process reports granted and Show fields reaches observation.
Kimi's field coverage is a separate compatibility check; an enabled switch
alone is not success.

The normal build and final seal of the movable development bundle honor the
pin. A missing/revoked pin fails before native compilation rather than silently
falling back. The launcher detects a changed pin and requires quitting before
rebuilding. `SYSTEMONE_CODESIGN_IDENTITY` remains an explicit override; after
changing it, run `npm run build:native-dev`. Explicit `-` and unconfigured
builds use disposable ad-hoc signing and may need fresh grants after rebuilds.

## Remaining evidence

No real certificate or grant was created during this fix. Once configured,
record the designated requirement before/after rebuilding with
`codesign -d -r- '<exact app path>'`; confirm it remains certificate-based and
Show fields stays authorized after relaunch. Expiry/revocation or a changed
signing class may still require another grant. This is local development
signing, not v1 distribution.
