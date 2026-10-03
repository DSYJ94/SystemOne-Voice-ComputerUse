import AppKit
import ApplicationServices
import Foundation

/// General Accessibility observer/actuator for the universal agent. It reads
/// the target app's focused window (including Chromium/WebKit web content) as
/// labelled elements, and performs one requested step at a time. It holds no
/// task authority: the app only calls it for the active, host-admitted agent
/// task, and the controller journals, permits and verifies every step.
@MainActor
final class UniversalAX {
    struct Snapshot {
        let app: String
        let bundleID: String
        let pid: pid_t
        let windowTitle: String
        let url: String
        let elements: [[String: Any]]
        let truncated: Bool
        let signature: String
    }

    private var elements: [String: AXUIElement] = [:]
    private var windowElement: AXUIElement?
    private(set) var targetPID: pid_t?

    static let interestingRoles: Set<String> = [
        "AXButton", "AXLink", "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox",
        "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXMenuItem",
        "AXMenuBarItem", "AXTab", "AXDisclosureTriangle", "AXCell", "AXSlider", "AXIncrementor"]
    static let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"]

    func setTarget(_ pid: pid_t) { targetPID = pid }

    // MARK: observe

    func snapshot() throws -> Snapshot {
        guard let pid = targetPID, let app = NSRunningApplication(processIdentifier: pid),
              !app.isTerminated else { throw AXError.noTarget }
        let appElement = AXUIElementCreateApplication(pid)
        // Chromium/Electron expose web content to assistive apps on request.
        AXUIElementSetAttributeValue(appElement, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        AXUIElementSetAttributeValue(appElement, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
        guard let window: AXUIElement = attribute(appElement, kAXFocusedWindowAttribute)
                ?? (attribute(appElement, kAXWindowsAttribute) as [AXUIElement]?)?.first else {
            throw AXError.noWindow
        }
        windowElement = window
        elements = [:]
        var collected: [[String: Any]] = []
        var visited = 0
        var queue: [(AXUIElement, String)] = [(window, "")]
        let windowFrame = frame(of: window)
        var url = ""
        let limit = 260
        while !queue.isEmpty && visited < 4_000 && collected.count < limit {
            let (element, context) = queue.removeFirst()
            visited += 1
            let role: String = attribute(element, kAXRoleAttribute) ?? ""
            if role == "AXWebArea", url.isEmpty, let value: URL = attribute(element, "AXURL") {
                url = value.absoluteString
            }
            let label = Self.label(of: element, role: role)
            if let entry = describe(element, role: role, label: label, context: context, window: windowFrame) {
                let id = "e\(collected.count)"
                elements[id] = element
                var described = entry
                described["id"] = id
                collected.append(described)
            }
            let nextContext = ["AXGroup", "AXList", "AXToolbar", "AXTabGroup", "AXTable", "AXOutline",
                               "AXSheet", "AXDialog", "AXWebArea"].contains(role) && !label.isEmpty
                ? String(label.prefix(60)) : context
            if let children: [AXUIElement] = attribute(element, kAXChildrenAttribute) {
                for child in children.prefix(400) { queue.append((child, nextContext)) }
            }
        }
        // Menu bar titles, plus the items of a menu that is currently open.
        if let bar: AXUIElement = attribute(appElement, kAXMenuBarAttribute),
           let items: [AXUIElement] = attribute(bar, kAXChildrenAttribute) {
            for item in items.prefix(20) where collected.count < limit + 40 {
                let title: String = attribute(item, kAXTitleAttribute) ?? ""
                guard !title.isEmpty, title != "Apple" else { continue }
                let id = "e\(collected.count)"
                elements[id] = item
                collected.append(["id": id, "role": "AXMenuBarItem", "label": title, "context": "menu bar",
                                  "editable": false, "pressable": true])
                let open: Bool = attribute(item, kAXSelectedAttribute) ?? false
                if open, let menus: [AXUIElement] = attribute(item, kAXChildrenAttribute) {
                    for menu in menus {
                        for entry in (attribute(menu, kAXChildrenAttribute) as [AXUIElement]?) ?? [] {
                            let entryTitle: String = attribute(entry, kAXTitleAttribute) ?? ""
                            let enabled: Bool = attribute(entry, kAXEnabledAttribute) ?? true
                            guard !entryTitle.isEmpty, enabled, collected.count < limit + 80 else { continue }
                            let entryID = "e\(collected.count)"
                            elements[entryID] = entry
                            collected.append(["id": entryID, "role": "AXMenuItem", "label": entryTitle,
                                              "context": "\(title) menu", "editable": false, "pressable": true])
                        }
                    }
                }
            }
        }
        let windowTitle: String = attribute(window, kAXTitleAttribute) ?? ""
        let focusedLabel = (attribute(appElement, kAXFocusedUIElementAttribute) as AXUIElement?)
            .map { Self.label(of: $0, role: attribute($0, kAXRoleAttribute) ?? "") } ?? ""
        let signature = "\(windowTitle)|\(url)|\(collected.count)|\(focusedLabel)|"
            + collected.map { "\($0["label"] ?? "")\($0["value"] ?? "")\($0["selected"] ?? "")" }.joined(separator: "¦")
        return Snapshot(app: app.localizedName ?? app.bundleIdentifier ?? "app", bundleID: app.bundleIdentifier ?? "",
                        pid: pid, windowTitle: windowTitle, url: url, elements: collected,
                        truncated: collected.count >= limit, signature: String(signature.hashValue))
    }

    private func describe(_ element: AXUIElement, role: String, label: String, context: String,
                          window: CGRect?) -> [String: Any]? {
        guard Self.interestingRoles.contains(role) || actions(element).contains(kAXPressAction as String) else {
            return nil
        }
        let enabled: Bool = attribute(element, kAXEnabledAttribute) ?? true
        guard enabled, !label.isEmpty else { return nil }
        let box = frame(of: element)
        if let box, (box.width < 2 || box.height < 2) { return nil }
        if let box, let window, !box.intersects(window.insetBy(dx: -4, dy: -4)) { return nil }
        let subrole: String = attribute(element, kAXSubroleAttribute) ?? ""
        let secure = subrole == "AXSecureTextField"
        var settable: DarwinBoolean = false
        AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable)
        let editable = Self.textRoles.contains(role) && settable.boolValue && !secure
        var entry: [String: Any] = ["role": role, "label": String(label.prefix(120)),
                                    "context": context, "editable": editable, "secure": secure,
                                    "pressable": actions(element).contains(kAXPressAction as String)
                                        || role == "AXLink" || role == "AXButton"]
        if Self.textRoles.contains(role), !secure, let value: String = attribute(element, kAXValueAttribute) {
            entry["value"] = String(value.prefix(80))
        }
        if let selected: Bool = attribute(element, kAXSelectedAttribute), selected { entry["selected"] = true }
        if role == "AXLink", let url: URL = attribute(element, "AXURL") { entry["url"] = url.absoluteString }
        return entry
    }

    static func label(of element: AXUIElement, role: String) -> String {
        func string(_ name: String) -> String {
            var value: AnyObject?
            guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success,
                  let text = value as? String else { return "" }
            return text.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        for name in [kAXTitleAttribute as String, kAXDescriptionAttribute as String] {
            let text = string(name)
            if !text.isEmpty { return text }
        }
        if !textRoles.contains(role) {
            let value = string(kAXValueAttribute as String)
            if !value.isEmpty, value.count < 160 { return value }
        }
        for name in ["AXPlaceholderValue", kAXHelpAttribute as String] {
            let text = string(name)
            if !text.isEmpty { return text }
        }
        // First static text below (e.g. a link or button whose label is a child).
        var queue: [AXUIElement] = []
        var value: AnyObject?
        if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success,
           let children = value as? [AXUIElement] { queue = Array(children.prefix(6)) }
        var depth = 0
        while !queue.isEmpty && depth < 12 {
            let child = queue.removeFirst()
            depth += 1
            for name in [kAXValueAttribute as String, kAXTitleAttribute as String, kAXDescriptionAttribute as String] {
                var text: AnyObject?
                if AXUIElementCopyAttributeValue(child, name as CFString, &text) == .success,
                   let found = text as? String, !found.trimmingCharacters(in: .whitespaces).isEmpty {
                    return found.replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                }
            }
            var grand: AnyObject?
            if AXUIElementCopyAttributeValue(child, kAXChildrenAttribute as CFString, &grand) == .success,
               let more = grand as? [AXUIElement] { queue.append(contentsOf: more.prefix(4)) }
        }
        return ""
    }

    // MARK: act

    func press(_ id: String) throws {
        guard let element = elements[id] else { throw AXError.stale }
        if AXUIElementPerformAction(element, kAXPressAction as CFString) == .success { return }
        guard let box = frame(of: element) else { throw AXError.actionFailed }
        try activateTarget()
        click(at: CGPoint(x: box.midX, y: box.midY))
    }

    func type(_ id: String, text: String) throws {
        guard let element = elements[id] else { throw AXError.stale }
        try activateTarget()
        AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        if AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFString) == .success,
           (attribute(element, kAXValueAttribute) as String?) == text {
            // Web fields also need input events; retype through the keyboard.
            if targetIsBrowser() { try keyboardReplace(text) }
            return
        }
        try keyboardReplace(text)
    }

    private func keyboardReplace(_ text: String) throws {
        key(code: 0, flags: .maskCommand) // Command-A selects the field's text
        usleep(60_000)
        for chunk in Array(text).chunked(into: 16) {
            let string = String(chunk)
            let utf16 = Array(string.utf16)
            for down in [true, false] {
                let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
                event?.keyboardSetUnicodeString(stringLength: utf16.count, unicodeString: utf16)
                event?.post(tap: .cghidEventTap)
            }
            usleep(15_000)
        }
    }

    static let keys: [String: (CGKeyCode, CGEventFlags)] = [
        "space": (49, []), "return": (36, []), "escape": (53, []), "tab": (48, []),
        "down": (125, []), "up": (126, []), "left": (123, []), "right": (124, []),
        "pagedown": (121, []), "pageup": (116, []), "back": (33, .maskCommand),
        "forward": (30, .maskCommand), "find": (3, .maskCommand), "newtab": (17, .maskCommand),
        "address": (37, .maskCommand), "reload": (15, .maskCommand)]

    func press(key name: String) throws {
        guard let (code, flags) = Self.keys[name] else { throw AXError.actionFailed }
        try activateTarget()
        key(code: code, flags: flags)
    }

    func scroll(down: Bool) throws {
        try activateTarget()
        if let window = windowElement, let box = frame(of: window) {
            CGWarpMouseCursorPosition(CGPoint(x: box.midX, y: box.midY))
        }
        let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1,
                            wheel1: down ? -600 : 600, wheel2: 0, wheel3: 0)
        event?.post(tap: .cghidEventTap)
    }

    /// Opens a URL in the default browser and makes that browser the target.
    func open(url: URL) async throws {
        guard let appURL = NSWorkspace.shared.urlForApplication(toOpen: url) else { throw AXError.actionFailed }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        let app = try await NSWorkspace.shared.open([url], withApplicationAt: appURL, configuration: config)
        targetPID = app.processIdentifier
        try await Task.sleep(for: .milliseconds(1_500))
    }

    /// Opens or activates an installed app by its display name.
    func open(app name: String) async throws {
        let roots = ["/Applications", "/System/Applications", "/System/Applications/Utilities",
                     NSHomeDirectory() + "/Applications"]
        let wanted = name.lowercased()
        var found: URL?
        for root in roots {
            let items = (try? FileManager.default.contentsOfDirectory(atPath: root)) ?? []
            if let match = items.first(where: { $0.lowercased() == wanted + ".app" }) {
                found = URL(fileURLWithPath: root).appendingPathComponent(match); break
            }
        }
        guard let found else { throw AXError.actionFailed }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        let app = try await NSWorkspace.shared.openApplication(at: found, configuration: config)
        targetPID = app.processIdentifier
        try await Task.sleep(for: .milliseconds(1_200))
    }

    static func installedApps() -> [String] {
        let roots = ["/Applications", "/System/Applications", "/System/Applications/Utilities"]
        return roots.flatMap { (try? FileManager.default.contentsOfDirectory(atPath: $0)) ?? [] }
            .filter { $0.hasSuffix(".app") }.map { String($0.dropLast(4)) }
    }

    // MARK: helpers

    private func activateTarget() throws {
        guard let pid = targetPID, let app = NSRunningApplication(processIdentifier: pid) else { throw AXError.noTarget }
        if !app.isActive { app.activate(); usleep(180_000) }
    }

    private func targetIsBrowser() -> Bool {
        guard let pid = targetPID, let id = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier else { return false }
        return ["com.google.Chrome", "com.apple.Safari", "company.thebrowser.Browser", "com.microsoft.edgemac",
                "com.brave.Browser", "org.mozilla.firefox"].contains(id)
    }

    private func key(code: CGKeyCode, flags: CGEventFlags) {
        for down in [true, false] {
            let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
            event?.flags = flags
            event?.post(tap: .cghidEventTap)
        }
    }

    private func click(at point: CGPoint) {
        for type in [CGEventType.leftMouseDown, .leftMouseUp] {
            CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: .left)?
                .post(tap: .cghidEventTap)
        }
    }

    private func actions(_ element: AXUIElement) -> [String] {
        var names: CFArray?
        guard AXUIElementCopyActionNames(element, &names) == .success else { return [] }
        return (names as? [String]) ?? []
    }

    private func frame(of element: AXUIElement) -> CGRect? {
        guard let position: AXValue = attribute(element, kAXPositionAttribute),
              let size: AXValue = attribute(element, kAXSizeAttribute) else { return nil }
        var point = CGPoint.zero, extent = CGSize.zero
        AXValueGetValue(position, .cgPoint, &point)
        AXValueGetValue(size, .cgSize, &extent)
        return CGRect(origin: point, size: extent)
    }

    private func attribute<T>(_ element: AXUIElement, _ name: String) -> T? {
        var value: AnyObject?
        guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else { return nil }
        if T.self == AXUIElement.self, let value, CFGetTypeID(value) == AXUIElementGetTypeID() {
            return (value as! AXUIElement) as? T
        }
        if T.self == AXValue.self, let value, CFGetTypeID(value) == AXValueGetTypeID() {
            return (value as! AXValue) as? T
        }
        return value as? T
    }

    enum AXError: Error { case noTarget, noWindow, stale, actionFailed }
}

private extension Array {
    func chunked(into size: Int) -> [[Element]] {
        stride(from: 0, to: count, by: size).map { Array(self[$0..<Swift.min($0 + size, count)]) }
    }
}
