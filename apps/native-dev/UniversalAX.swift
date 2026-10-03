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
        /// Layout only (controls, values, selection): identifies a screen, for loop limits.
        let signature: String
        let visited: Int
        /// Layout plus visible text: tells whether a step changed anything (a new song title counts).
        var contentSignature = ""
        /// Page scroll position, when read from the page.
        var scrollY: Int?
        /// "dom" when read through the browser's page, else "ax".
        var via = "ax"
        /// Why the page could not be read directly (shown once), if relevant.
        var hint: String?
    }

    private let dom = BrowserDOM()
    /// Bundle ID of the browser whose page supplied the last snapshot.
    private var domBundle: String?

    private var elements: [String: AXUIElement] = [:]
    private var windowElement: AXUIElement?
    private(set) var targetPID: pid_t?

    nonisolated static let interestingRoles: Set<String> = [
        "AXButton", "AXLink", "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox",
        "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXMenuItem",
        "AXMenuBarItem", "AXTab", "AXDisclosureTriangle", "AXCell", "AXSlider", "AXIncrementor"]
    nonisolated static let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox"]

    func setTarget(_ pid: pid_t) { targetPID = pid }

    // MARK: observe

    /// Roles whose children are only their own label text: never walked into.
    nonisolated static let leafRoles: Set<String> = [
        "AXStaticText", "AXImage", "AXButton", "AXLink", "AXTextField", "AXTextArea", "AXSearchField", "AXCheckBox",
        "AXRadioButton", "AXPopUpButton", "AXMenuButton", "AXSlider", "AXIncrementor", "AXComboBox", "AXDisclosureTriangle"]

    /// Milliseconds the last snapshot took, for traces.
    private(set) var lastReadMs = 0

    func snapshot() throws -> Snapshot {
        let started = Date()
        defer { lastReadMs = Int(Date().timeIntervalSince(started) * 1000) }
        guard let pid = targetPID, let app = NSRunningApplication(processIdentifier: pid),
              !app.isTerminated else { throw AXError.noTarget }
        domBundle = nil
        var hint: String?
        if let bundle = app.bundleIdentifier, BrowserDOM.supports(bundle) {
            do { return try domSnapshot(app: app, bundle: bundle) }
            catch { hint = dom.lastProblem }
        }
        var snap = try axSnapshot(app: app, pid: pid)
        snap.hint = hint
        return snap
    }

    /// The browser's active tab, read from its DOM in one round-trip.
    private func domSnapshot(app: NSRunningApplication, bundle: String) throws -> Snapshot {
        let reply = try dom.run(bundle, ["op": "snapshot"])
        guard let value = reply["value"] as? [String: Any], let elements = value["elements"] as? [[String: Any]] else {
            throw BrowserDOM.DOMError.failed("unexpected page snapshot")
        }
        domBundle = bundle
        let title = value["title"] as? String ?? ""
        let url = value["url"] as? String ?? ""
        // The page cannot see the browser's tab strip; list tabs from the browser
        // itself so the agent can switch to or close a tab directly by name.
        var tabElements: [[String: Any]] = []
        if let (active, tabs) = try? dom.tabs(bundle) {
            for (index, tab) in tabs.enumerated() {
                let label = tab.title.isEmpty ? (tab.url.isEmpty ? "New Tab" : tab.url) : tab.title
                tabElements.append(["id": "t\(index + 1)", "role": "AXTab", "label": String(label.prefix(120)),
                                    "context": "browser tab \(index + 1) of \(tabs.count)", "url": tab.url,
                                    "editable": false, "pressable": true, "closable": true,
                                    "selected": index + 1 == active])
            }
        }
        // The layout signature ignores free text (clocks, video time), so a ticking
        // page is still the same screen; the content signature includes it.
        let structural = (tabElements + elements).filter { ($0["role"] as? String) != "AXStaticText" }
        let signature = "\(title)|\(url)|\(value["scrollY"] ?? 0)|"
            + structural.map { "\($0["role"] ?? "")\($0["label"] ?? "")\($0["value"] ?? "")\($0["selected"] ?? "")" }
                .joined(separator: "¦")
        var snap = Snapshot(app: app.localizedName ?? bundle, bundleID: bundle, pid: app.processIdentifier,
                            windowTitle: title, url: url, elements: tabElements + elements,
                            truncated: value["truncated"] as? Bool ?? false,
                            signature: String(signature.hashValue), visited: elements.count)
        snap.contentSignature = String((signature + Self.texts(of: elements)).hashValue)
        snap.scrollY = (value["scrollY"] as? NSNumber)?.intValue
        snap.via = "dom"
        return snap
    }

    private func axSnapshot(app: NSRunningApplication, pid: pid_t) throws -> Snapshot {
        let appElement = AXUIElementCreateApplication(pid)
        // A busy app must not stall the agent: each AX call gives up after 0.5 s.
        AXUIElementSetMessagingTimeout(appElement, 0.5)
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
        var texts = 0
        var queue: [(AXUIElement, String)] = [(window, "")]
        var head = 0
        let windowFrame = frame(of: window)
        var url = ""
        let limit = 260
        while head < queue.count && visited < 3_000 && collected.count < limit {
            let (element, context) = queue[head]
            head += 1
            visited += 1
            // One batched IPC per node instead of a call per attribute.
            let node = Node(element)
            let role = node.role
            if role == "AXWebArea", url.isEmpty, let value: URL = attribute(element, "AXURL") {
                url = value.absoluteString
            }
            if role == "AXStaticText", texts < 80, let text = node.value as? String,
               case let clean = text.trimmingCharacters(in: .whitespacesAndNewlines), (2...160).contains(clean.count) {
                // Plain text on screen, so the agent can read and copy it.
                texts += 1
                let id = "e\(collected.count)"
                elements[id] = element
                collected.append(["id": id, "role": "AXStaticText", "label": clean, "context": context,
                                  "editable": false, "pressable": false])
            } else if let entry = describe(element, node: node, context: context, window: windowFrame) {
                let id = "e\(collected.count)"
                elements[id] = element
                var described = entry
                described["id"] = id
                collected.append(described)
            }
            // Leaf controls hold only their label text, and a branch entirely
            // outside the window (far down a long page) cannot be acted on.
            if Self.leafRoles.contains(role) { continue }
            if let box = node.frame, let windowFrame, box.width > 0, box.height > 0,
               !box.intersects(windowFrame.insetBy(dx: -40, dy: -40)) { continue }
            let grouping = ["AXGroup", "AXList", "AXToolbar", "AXTabGroup", "AXTable", "AXOutline",
                            "AXSheet", "AXDialog", "AXWebArea"].contains(role)
            let groupLabel = grouping ? (node.title.isEmpty ? node.desc : node.title) : ""
            let nextContext = !groupLabel.isEmpty ? String(groupLabel.prefix(60)) : context
            for child in node.children.prefix(400) { queue.append((child, nextContext)) }
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
        let signature = "\(windowTitle)|\(url)|\(focusedLabel)|"
            + collected.filter { ($0["role"] as? String) != "AXStaticText" }
                .map { "\($0["role"] ?? "")\($0["label"] ?? "")\($0["value"] ?? "")\($0["selected"] ?? "")" }
                .joined(separator: "¦")
        var snap = Snapshot(app: app.localizedName ?? app.bundleIdentifier ?? "app", bundleID: app.bundleIdentifier ?? "",
                            pid: pid, windowTitle: windowTitle, url: url, elements: collected,
                            truncated: collected.count >= limit, signature: String(signature.hashValue), visited: visited)
        snap.contentSignature = String((signature + Self.texts(of: collected)).hashValue)
        return snap
    }

    private static func texts(of elements: [[String: Any]]) -> String {
        elements.filter { ($0["role"] as? String) == "AXStaticText" }.map { "\($0["label"] ?? "")" }.joined(separator: "¦")
    }

    /// The attributes the walk needs, fetched in one call.
    struct Node {
        let role: String, subrole: String, title: String, desc: String, placeholder: String
        let value: Any?, children: [AXUIElement], enabled: Bool, selected: Bool, frame: CGRect?

        static let names: [String] = [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute,
                                      "AXPlaceholderValue", kAXValueAttribute, kAXChildrenAttribute, kAXEnabledAttribute,
                                      kAXSelectedAttribute, kAXPositionAttribute, kAXSizeAttribute]

        init(_ element: AXUIElement) {
            var raw: CFArray?
            AXUIElementCopyMultipleAttributeValues(element, Node.names as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &raw)
            let values = (raw as? [AnyObject]) ?? []
            func item(_ index: Int) -> AnyObject? {
                guard index < values.count else { return nil }
                let value = values[index]
                if CFGetTypeID(value) == AXValueGetTypeID(), AXValueGetType(value as! AXValue) == .axError { return nil }
                return value
            }
            func text(_ index: Int) -> String {
                ((item(index) as? String) ?? "").replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
                    .trimmingCharacters(in: .whitespacesAndNewlines)
            }
            role = (item(0) as? String) ?? ""
            subrole = (item(1) as? String) ?? ""
            title = text(2); desc = text(3); placeholder = text(4)
            value = item(5)
            children = (item(6) as? [AXUIElement]) ?? []
            enabled = (item(7) as? Bool) ?? true
            selected = (item(8) as? Bool) ?? false
            var point = CGPoint.zero, extent = CGSize.zero
            if let position = item(9), CFGetTypeID(position) == AXValueGetTypeID(),
               let size = item(10), CFGetTypeID(size) == AXValueGetTypeID(),
               AXValueGetValue(position as! AXValue, .cgPoint, &point), AXValueGetValue(size as! AXValue, .cgSize, &extent) {
                frame = CGRect(origin: point, size: extent)
            } else { frame = nil }
        }

        /// Label from already-fetched attributes; nil if a child lookup is needed.
        var quickLabel: String? {
            if !title.isEmpty { return title }
            if !desc.isEmpty { return desc }
            if !UniversalAX.textRoles.contains(role), let text = value as? String {
                let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !clean.isEmpty, clean.count < 160 { return clean }
            }
            if !placeholder.isEmpty { return placeholder }
            return nil
        }
    }

    private func describe(_ element: AXUIElement, node: Node, context: String, window: CGRect?) -> [String: Any]? {
        let role = node.role
        // Generic web/app containers count only when they are clickable.
        let generic = role == "AXGroup" || role == "AXImage"
        guard Self.interestingRoles.contains(role) || (generic && actions(element).contains(kAXPressAction as String)) else {
            return nil
        }
        guard node.enabled else { return nil }
        if let box = node.frame, (box.width < 2 || box.height < 2) { return nil }
        if let box = node.frame, let window, !box.intersects(window.insetBy(dx: -4, dy: -4)) { return nil }
        let label = node.quickLabel ?? Self.label(of: element, role: role)
        guard !label.isEmpty else { return nil }
        let secure = node.subrole == "AXSecureTextField"
        var settable: DarwinBoolean = false
        if Self.textRoles.contains(role) { AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) }
        let editable = Self.textRoles.contains(role) && settable.boolValue && !secure
        var entry: [String: Any] = ["role": role, "label": String(label.prefix(120)), "context": context,
                                    "editable": editable, "secure": secure,
                                    "pressable": !Self.textRoles.contains(role) || role == "AXComboBox"]
        if Self.textRoles.contains(role), !secure, let value = node.value as? String { entry["value"] = String(value.prefix(80)) }
        if node.selected { entry["selected"] = true }
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
        if id.hasPrefix("t"), let bundle = domBundle, let index = Int(id.dropFirst()) {
            try dom.activateTab(bundle, index); return
        }
        if id.hasPrefix("d"), let bundle = domBundle { _ = try dom.run(bundle, ["op": "press", "id": id]); return }
        guard let element = elements[id] else { throw AXError.stale }
        if AXUIElementPerformAction(element, kAXPressAction as CFString) == .success { return }
        guard let box = frame(of: element) else { throw AXError.actionFailed }
        try activateTarget()
        click(at: CGPoint(x: box.midX, y: box.midY))
    }

    func type(_ id: String, text: String) throws {
        if id.hasPrefix("d"), let bundle = domBundle {
            _ = try dom.run(bundle, ["op": "type", "id": id, "text": text]); return
        }
        guard let element = elements[id] else { throw AXError.stale }
        try activateTarget()
        AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        // Multi-line text (notes, documents, message bodies) is appended, never replaced.
        if (attribute(element, kAXRoleAttribute) as String?) == "AXTextArea" {
            let existing: String = attribute(element, kAXValueAttribute) ?? ""
            usleep(60_000)
            key(code: 125, flags: .maskCommand) // Command-Down: end of text
            try typeKeys(existing.isEmpty ? text : "\n" + text)
            return
        }
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
        try typeKeys(text)
    }

    private func typeKeys(_ text: String) throws {
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

    /// Copies an element's text (value, else label) to the clipboard and returns it.
    /// Closes a browser tab by its listed position.
    /// Closes one tab ("t3") or several ("t2,t4,t5"), highest index first so the others keep their place.
    func close(_ ids: String) throws {
        guard let bundle = domBundle else { throw AXError.stale }
        let indexes = try ids.split(separator: ",").map { id -> Int in
            guard id.hasPrefix("t"), let index = Int(id.dropFirst()) else { throw AXError.stale }
            return index
        }
        guard !indexes.isEmpty else { throw AXError.stale }
        for index in Set(indexes).sorted(by: >) { try dom.closeTab(bundle, index) }
    }

    func copy(_ id: String) throws -> String {
        if id.hasPrefix("d"), let bundle = domBundle {
            guard let text = try dom.run(bundle, ["op": "copy", "id": id])["value"] as? String, !text.isEmpty else {
                throw AXError.actionFailed
            }
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            return text
        }
        guard let element = elements[id] else { throw AXError.stale }
        let role: String = attribute(element, kAXRoleAttribute) ?? ""
        let value: String = attribute(element, kAXValueAttribute) ?? ""
        let text = value.isEmpty ? Self.label(of: element, role: role) : value
        guard !text.isEmpty else { throw AXError.actionFailed }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        return text
    }

    /// Pastes the clipboard into a field (appending in multi-line text).
    func paste(_ id: String) throws {
        if id.hasPrefix("d"), let bundle = domBundle {
            let text = NSPasteboard.general.string(forType: .string) ?? ""
            _ = try dom.run(bundle, ["op": "paste", "id": id, "text": text]); return
        }
        guard let element = elements[id] else { throw AXError.stale }
        try activateTarget()
        AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        usleep(60_000)
        if (attribute(element, kAXRoleAttribute) as String?) == "AXTextArea" { key(code: 125, flags: .maskCommand) }
        key(code: 9, flags: .maskCommand) // Command-V
    }

    static let keys: [String: (CGKeyCode, CGEventFlags)] = [
        "space": (49, []), "return": (36, []), "escape": (53, []), "tab": (48, []),
        "down": (125, []), "up": (126, []), "left": (123, []), "right": (124, []),
        "pagedown": (121, []), "pageup": (116, []), "back": (33, .maskCommand),
        "forward": (30, .maskCommand), "find": (3, .maskCommand), "newtab": (17, .maskCommand),
        "address": (37, .maskCommand), "reload": (15, .maskCommand), "closetab": (13, .maskCommand),
        "nexttab": (48, .maskControl), "prevtab": (48, [.maskControl, .maskShift]), "undo": (6, .maskCommand)]

    func press(key name: String) throws {
        guard let (code, flags) = Self.keys[name] else { throw AXError.actionFailed }
        try activateTarget()
        key(code: code, flags: flags)
    }

    func scroll(down: Bool) throws {
        if let bundle = domBundle { _ = try dom.run(bundle, ["op": "scroll", "down": down]); return }
        try activateTarget()
        if let window = windowElement, let box = frame(of: window) {
            CGWarpMouseCursorPosition(CGPoint(x: box.midX, y: box.midY))
        }
        let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1,
                            wheel1: down ? -600 : 600, wheel2: 0, wheel3: 0)
        event?.post(tap: .cghidEventTap)
    }

    /// Opens a URL in the default browser and makes that browser the target.
    /// Opens `url`. In a browser that is in front, it loads in the current tab (like the
    /// address bar) unless a new tab was asked for; otherwise the default browser opens it.
    func open(url: URL, newTab: Bool) async throws {
        if !newTab, let pid = targetPID, let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
           let bundle = app.bundleIdentifier, BrowserDOM.supports(bundle), (try? dom.navigate(bundle, url)) != nil {
            app.activate()
            try await Task.sleep(for: .milliseconds(1_200))
            return
        }
        guard let appURL = NSWorkspace.shared.urlForApplication(toOpen: url) else { throw AXError.actionFailed }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        let app = try await NSWorkspace.shared.open([url], withApplicationAt: appURL, configuration: config)
        targetPID = app.processIdentifier
        try await Task.sleep(for: .milliseconds(1_500))
    }

    /// Regular apps the user has open, excluding SystemOne itself.
    static func runningApps() -> [String] {
        let me = ProcessInfo.processInfo.processIdentifier
        return NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular && $0.processIdentifier != me && !$0.isTerminated }
            .compactMap(\.localizedName)
    }

    /// Switches to a running app by name, or opens an installed one.
    func open(app name: String) async throws {
        let me = ProcessInfo.processInfo.processIdentifier
        if let running = NSWorkspace.shared.runningApplications.first(where: {
            $0.activationPolicy == .regular && $0.processIdentifier != me
                && $0.localizedName?.lowercased() == name.lowercased() }) {
            running.activate()
            targetPID = running.processIdentifier
            try await Task.sleep(for: .milliseconds(500))
            return
        }
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

    /// Quits a running app by name, as Command-Q does (the app may still ask to save).
    func quit(app name: String) async throws {
        let me = ProcessInfo.processInfo.processIdentifier
        let plain = { (text: String) in text.replacingOccurrences(of: "\u{200E}", with: "")
            .replacingOccurrences(of: "\u{200F}", with: "").trimmingCharacters(in: .whitespaces).lowercased() }
        guard let running = NSWorkspace.shared.runningApplications.first(where: {
            $0.activationPolicy == .regular && $0.processIdentifier != me
                && plain($0.localizedName ?? "") == plain(name) }) else { throw AXError.actionFailed }
        guard running.terminate() else { throw AXError.actionFailed }
        for _ in 0..<20 where !running.isTerminated { try await Task.sleep(for: .milliseconds(100)) }
        if targetPID == running.processIdentifier {
            targetPID = NSWorkspace.shared.frontmostApplication.flatMap { $0.processIdentifier == me ? nil : $0.processIdentifier }
        }
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
