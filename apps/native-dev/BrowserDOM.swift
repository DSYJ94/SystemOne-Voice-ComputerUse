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

    /// The front window's tabs (title, URL) and which one is active (1-based).
    func tabs(_ bundleID: String) throws -> (active: Int, tabs: [(title: String, url: String)]) {
        let safari = bundleID == Self.safari
        let script = """
        tell application id "\(bundleID)"
          set w to front window
          set out to ""
          repeat with i from 1 to count of tabs of w
            set t to tab i of w
            set out to out & (\(safari ? "name" : "title") of t) & (ASCII character 9) & (URL of t) & (ASCII character 10)
          end repeat
          return (\(safari ? "index of current tab of w" : "active tab index of w") as text) & (ASCII character 10) & out
        end tell
        """
        let text = try execute(script)
        var lines = text.components(separatedBy: "\n")
        let active = Int(lines.removeFirst()) ?? 1
        let tabs = lines.filter { !$0.isEmpty }.map { line -> (title: String, url: String) in
            let parts = line.components(separatedBy: "\t")
            return (parts.first ?? "", parts.count > 1 ? parts[1] : "")
        }
        return (active, tabs)
    }

    /// Makes tab `index` (1-based) of the front window active.
    func activateTab(_ bundleID: String, _ index: Int) throws {
        _ = try execute(bundleID == Self.safari
            ? "tell application id \"\(bundleID)\" to set current tab of front window to tab \(index) of front window"
            : "tell application id \"\(bundleID)\" to set active tab index of front window to \(index)")
    }

    /// Closes tab `index` (1-based) of the front window.
    func closeTab(_ bundleID: String, _ index: Int) throws {
        _ = try execute("tell application id \"\(bundleID)\" to close tab \(index) of front window")
    }

    private func execute(_ source: String) throws -> String {
        var error: NSDictionary?
        guard let result = NSAppleScript(source: source)?.executeAndReturnError(&error) else {
            throw DOMError.failed((error?[NSAppleScript.errorMessage] as? String) ?? "AppleScript failed")
        }
        return result.stringValue ?? ""
    }

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
