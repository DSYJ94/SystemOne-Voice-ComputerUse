import ApplicationServices
import AppKit
import Foundation

enum FixtureAXOutcome: Sendable {
    case alreadyVerified
    case applied
    case notDispatched(String)
    case unknown(String)
}

/// Deliberately scoped to one synthetic field. A failed or timed-out setter is
/// unknown, because the fixture may have applied the value before AX returned.
enum FixtureAX {
    static func setName(pid: pid_t, fixtureURL: URL, value: String) -> FixtureAXOutcome {
        guard AXIsProcessTrustedWithOptions(nil) else {
            return .notDispatched("Accessibility access is not granted.")
        }
        guard let running = NSRunningApplication(processIdentifier: pid),
              running.bundleIdentifier == "com.aurium.systemone.fixture",
              running.bundleURL?.resolvingSymlinksInPath().standardizedFileURL ==
                fixtureURL.resolvingSymlinksInPath().standardizedFileURL else {
            return .notDispatched("The fixture process identity changed.")
        }
        guard let field = findNameField(pid: pid) else {
            return .notDispatched("The exact fixture field was not found.")
        }
        var fieldPID: pid_t = 0
        guard AXUIElementGetPid(field, &fieldPID) == .success && fieldPID == pid else {
            return .notDispatched("The fixture field belongs to another process.")
        }
        AXUIElementSetMessagingTimeout(field, 2.0)
        guard let before = attribute(field, kAXValueAttribute as String) as? String else {
            return .notDispatched("The fixture value could not be observed.")
        }
        if before == value { return .alreadyVerified }

        var settable = DarwinBoolean(false)
        let check = AXUIElementIsAttributeSettable(field, kAXValueAttribute as CFString, &settable)
        guard check == .success && settable.boolValue else {
            return .notDispatched("The fixture field is not settable.")
        }

        let error = AXUIElementSetAttributeValue(field, kAXValueAttribute as CFString,
                                                 value as CFString)
        guard error == .success else {
            return .unknown("Accessibility returned \(error.rawValue) after dispatch.")
        }
        guard let freshField = findNameField(pid: pid),
              let after = attribute(freshField, kAXValueAttribute as String) as? String else {
            return .unknown("The field could not be re-observed after dispatch.")
        }
        return after == value
            ? .applied
            : .unknown("The observed field does not match the requested value.")
    }

    private static func findNameField(pid: pid_t) -> AXUIElement? {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 2.0)
        guard let windows = attribute(app, kAXWindowsAttribute as String) as? [AXUIElement] else {
            return nil
        }
        let matchingWindows = windows.filter {
            (attribute($0, kAXTitleAttribute as String) as? String) == "SystemOne Fixture"
        }
        guard matchingWindows.count == 1 else { return nil }

        var matches: [AXUIElement] = []
        var remaining = 80
        visit(matchingWindows[0], depth: 0, remaining: &remaining, matches: &matches)
        return matches.count == 1 ? matches[0] : nil
    }

    private static func visit(_ element: AXUIElement, depth: Int, remaining: inout Int,
                              matches: inout [AXUIElement]) {
        guard depth <= 6 && remaining > 0 else { return }
        remaining -= 1
        let role = attribute(element, kAXRoleAttribute as String) as? String
        let label = attribute(element, kAXDescriptionAttribute as String) as? String
        if role == (kAXTextFieldRole as String) && label == "Fixture Name" {
            matches.append(element)
        }
        guard let children = attribute(element, kAXChildrenAttribute as String) as? [AXUIElement] else {
            return
        }
        for child in children {
            visit(child, depth: depth + 1, remaining: &remaining, matches: &matches)
        }
    }

    private static func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var result: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success
            ? result : nil
    }
}
