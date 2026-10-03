import AppKit
import Foundation

/// Reads and acts on the user's own active browser tab through the browser's
/// AppleScript JavaScript bridge (dom-agent.js). Much faster and more exact
/// than Accessibility for web pages. Needs, once: Chrome › View › Developer ›
/// Allow JavaScript from Apple Events (Safari: Develop menu), and the macOS
/// prompt allowing SystemOne to control the browser.
@MainActor
final class BrowserDOM {
    /// Browsers with an AppleScript "execute JavaScript in a tab" command.
    static let chromium: Set<String> = ["com.google.Chrome", "com.google.Chrome.beta", "com.brave.Browser",
                                        "com.microsoft.edgemac", "com.vivaldi.Vivaldi"]
    static let safari = "com.apple.Safari"

    enum DOMError: Error, CustomStringConvertible {
        case unavailable(String)
        case failed(String)
        var description: String {
            switch self { case .unavailable(let text), .failed(let text): text }
        }
    }

    private lazy var source: String? = Bundle.main.url(forResource: "dom-agent", withExtension: "js")
        .flatMap { try? String(contentsOf: $0, encoding: .utf8) }
    /// Why the last attempt fell back to Accessibility (shown once to the user).
    private(set) var lastProblem: String?

    static func supports(_ bundleID: String) -> Bool { chromium.contains(bundleID) || bundleID == safari }

    func run(_ bundleID: String, _ request: [String: Any]) throws -> [String: Any] {
        guard let source else { throw DOMError.unavailable("dom-agent.js missing from the app bundle") }
        guard let data = try? JSONSerialization.data(withJSONObject: request),
              let json = String(data: data, encoding: .utf8) else { throw DOMError.failed("bad request") }
        let javascript = "(\(source))(\(json))"
        let escaped = javascript.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        let script = bundleID == Self.safari
            ? "tell application id \"\(bundleID)\" to do JavaScript \"\(escaped)\" in current tab of front window"
            : "tell application id \"\(bundleID)\" to execute active tab of front window javascript \"\(escaped)\""
        var error: NSDictionary?
        guard let result = NSAppleScript(source: script)?.executeAndReturnError(&error) else {
            let message = (error?[NSAppleScript.errorMessage] as? String) ?? "AppleScript failed"
            let code = (error?[NSAppleScript.errorNumber] as? Int) ?? 0
            lastProblem = code == -1743
                ? "Allow SystemOne to control your browser in System Settings › Privacy & Security › Automation."
                : message.localizedCaseInsensitiveContains("JavaScript")
                    ? "For faster browsing, turn on View › Developer › Allow JavaScript from Apple Events in your browser."
                    : message
            throw DOMError.unavailable(lastProblem!)
        }
        guard let text = result.stringValue, let reply = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any]
        else { throw DOMError.failed("unreadable page reply") }
        lastProblem = nil
        guard reply["ok"] as? Bool == true else { throw DOMError.failed(reply["error"] as? String ?? "page action failed") }
        return reply
    }
}
