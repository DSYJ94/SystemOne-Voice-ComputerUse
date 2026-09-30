import Foundation
import Security

/// Reports this process's code identity, not a Settings toggle or another app.
struct DevAccessibilityIdentity {
    let bundleURL: URL
    let signingDescription: String
    let isAdHoc: Bool

    static func current() -> DevAccessibilityIdentity {
        let url = Bundle.main.bundleURL
        var running: SecCode?
        var code: SecStaticCode?
        var raw: CFDictionary?
        guard SecCodeCopySelf([], &running) == errSecSuccess, let running,
              SecCodeCopyStaticCode(running, [], &code) == errSecSuccess, let code,
              SecCodeCopySigningInformation(code,
                SecCSFlags(rawValue: kSecCSSigningInformation), &raw) == errSecSuccess,
              let info = raw as? [String: Any],
              let flags = info[kSecCodeInfoFlags as String] as? NSNumber else {
            return DevAccessibilityIdentity(bundleURL: url,
                signingDescription: "Signing identity unavailable; no permission is inferred.",
                isAdHoc: false)
        }
        let adHoc = flags.uint32Value & SecCodeSignatureFlags.adhoc.rawValue != 0
        return DevAccessibilityIdentity(bundleURL: url,
            signingDescription: adHoc
                ? "Ad-hoc development build. Rebuilding changes its identity; an old enabled entry may not authorize this build."
                : "Certificate-signed build. macOS still requires your grant for this exact app.",
            isAdHoc: adHoc)
    }

    func recoveryText(trusted: Bool) -> String {
        "macOS permission for this running process: \(trusted ? "granted" : "denied").\n\n"
        + "Exact app:\n\(bundleURL.path)\n\n\(signingDescription)\n\n"
        + "If denied, remove the stale SystemOne Dev entry and add this exact app in Accessibility settings. "
        + "Quit and reopen after changing the grant. "
        + (isAdHoc ? "For repeatable development builds, configure certificate signing as described in docs/DEVELOPMENT_SIGNING.md." : "")
    }
}
