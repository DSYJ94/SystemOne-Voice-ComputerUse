import AppKit
import ApplicationServices
import AudioToolbox
import CoreAudio
import CoreWLAN
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

    func press(_ id: String) async throws {
        if id.hasPrefix("v") {
            // Text read from the screen image: a real click at its place.
            guard let box = visionRefs[id] else { throw AXError.stale }
            try activateTarget()
            click(at: CGPoint(x: box.midX, y: box.midY))
            return
        }
        if id.hasPrefix("t"), let bundle = domBundle, let index = Int(id.dropFirst()) {
            try dom.activateTab(bundle, index); return
        }
        if id.hasPrefix("d"), let bundle = domBundle {
            let reply = try dom.run(bundle, ["op": "press", "id": id])
            // Some pages ignore synthetic events. If nothing on the page reacted, click for real
            // at the element's place on screen, as a person would.
            try await Task.sleep(for: .milliseconds(300))
            let check = (try? dom.run(bundle, ["op": "changed"]))?["value"] as? [String: Any]
            let reacted = (check?["mutations"] as? Int ?? 1) > 0 || (check?["moved"] as? Bool ?? false)
            if !reacted, let point = reply["value"] as? [String: Any],
               let x = (point["x"] as? NSNumber)?.doubleValue, let y = (point["y"] as? NSNumber)?.doubleValue {
                try activateTarget()
                click(at: CGPoint(x: x, y: y))
            }
            return
        }
        guard let element = elements[id] else { throw AXError.stale }
        if AXUIElementPerformAction(element, kAXPressAction as CFString) == .success { return }
        guard let box = frame(of: element) else { throw AXError.actionFailed }
        try activateTarget()
        click(at: CGPoint(x: box.midX, y: box.midY))
    }

    func type(_ id: String, text: String) throws {
        if id.hasPrefix("v") {
            // A field found in the screen image: click into it, then type.
            guard let box = visionRefs[id] else { throw AXError.stale }
            try activateTarget()
            click(at: CGPoint(x: box.midX, y: box.midY))
            usleep(120_000)
            try typeKeys(text)
            return
        }
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
            Self.bringToFront(app)
            try await Task.sleep(for: .milliseconds(1_200))
            return
        }
        guard let appURL = NSWorkspace.shared.urlForApplication(toOpen: url) else { throw AXError.actionFailed }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        let app = try await NSWorkspace.shared.open([url], withApplicationAt: appURL, configuration: config)
        targetPID = app.processIdentifier
        try await Task.sleep(for: .milliseconds(1_500))
        Self.bringToFront(app)
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
            targetPID = running.processIdentifier
            guard Self.bringToFront(running) else { throw AXError.notFront }
            // No window open: ask the app to reopen, as clicking it in the Dock does (Finder opens one).
            let element = AXUIElementCreateApplication(running.processIdentifier)
            AXUIElementSetMessagingTimeout(element, 0.3)
            let standard = ((attribute(element, kAXWindowsAttribute) as [AXUIElement]?) ?? [])
                .filter { (attribute($0, kAXSubroleAttribute) as String?) == "AXStandardWindow" }
            if standard.isEmpty, let url = running.bundleURL {
                let config = NSWorkspace.OpenConfiguration()
                config.activates = true
                _ = try? await NSWorkspace.shared.openApplication(at: url, configuration: config)
                try await Task.sleep(for: .milliseconds(600))
            }
            try await Task.sleep(for: .milliseconds(300))
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
        Self.bringToFront(app)
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

    /// Whole-Mac actions that belong to no app.
    static func system(_ action: String) throws {
        switch action {
        case "sleep", "displaysleep":
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/pmset")
            process.arguments = [action == "sleep" ? "sleepnow" : "displaysleepnow"]
            try process.run()
        case "lock": postKey(12, [.maskControl, .maskCommand])          // Control-Command-Q
        case "darkmode":
            // Asks macOS once for permission to control System Events.
            var error: NSDictionary?
            NSAppleScript(source: "tell application \"System Events\" to tell appearance preferences to set dark mode to not dark mode")?
                .executeAndReturnError(&error)
            if error != nil { throw AXError.actionFailed }
        case "wifi_on", "wifi_off":
            guard let device = wifiDevice() else { throw AXError.actionFailed }
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/sbin/networksetup")
            process.arguments = ["-setairportpower", device, action == "wifi_on" ? "on" : "off"]
            try process.run()
            process.waitUntilExit()
            guard process.terminationStatus == 0 else { throw AXError.actionFailed }
        case "screenshot": postKey(20, [.maskCommand, .maskShift])     // Command-Shift-3
        default: throw AXError.actionFailed
        }
    }

    /// Whole-Mac state the agent cannot see in any window, so it can check what it changed.
    static func macState() -> [String: Any] {
        var state: [String: Any] = [:]
        let global = UserDefaults.standard.persistentDomain(forName: UserDefaults.globalDomain)
        state["darkMode"] = (global?["AppleInterfaceStyle"] as? String) == "Dark"
        if let wifi = CWWiFiClient.shared().interface() { state["wifiOn"] = wifi.powerOn() }
        var device = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultOutputDevice,
                                                 mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        if AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device) == noErr {
            var volume = Float32(0)
            size = UInt32(MemoryLayout<Float32>.size)
            address = AudioObjectPropertyAddress(mSelector: kAudioHardwareServiceDeviceProperty_VirtualMainVolume,
                                                 mScope: kAudioDevicePropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
            if AudioObjectGetPropertyData(device, &address, 0, nil, &size, &volume) == noErr { state["volume"] = Int(volume * 100) }
            var muted = UInt32(0)
            size = UInt32(MemoryLayout<UInt32>.size)
            address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyMute,
                                                 mScope: kAudioDevicePropertyScopeOutput, mElement: kAudioObjectPropertyElementMain)
            if AudioObjectGetPropertyData(device, &address, 0, nil, &size, &muted) == noErr { state["muted"] = muted != 0 }
        }
        return state
    }

    private static func wifiDevice() -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/networksetup")
        process.arguments = ["-listallhardwareports"]
        let pipe = Pipe()
        process.standardOutput = pipe
        guard (try? process.run()) != nil else { return nil }
        let text = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        process.waitUntilExit()
        let lines = text.components(separatedBy: "\n")
        guard let index = lines.firstIndex(where: { $0.contains("Wi-Fi") || $0.contains("AirPort") }),
              index + 1 < lines.count else { return nil }
        return lines[index + 1].replacingOccurrences(of: "Device: ", with: "").trimmingCharacters(in: .whitespaces)
    }

    /// Every System Settings pane on this Mac, named as in the Settings sidebar, read
    /// from the system's own pane extensions (so new panes appear without code changes).
    static let settingsPanes: [[String: String]] = {
        let root = URL(fileURLWithPath: "/System/Library/ExtensionKit/Extensions")
        let language = Locale.preferredLanguages.first.map { String($0.prefix(2)) } ?? "en"
        let items = (try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: nil)) ?? []
        return items.compactMap { url -> [String: String]? in
            guard url.pathExtension == "appex",
                  let info = NSDictionary(contentsOf: url.appendingPathComponent("Contents/Info.plist")) as? [String: Any],
                  let attributes = info["EXAppExtensionAttributes"] as? [String: Any],
                  attributes["EXExtensionPointIdentifier"] as? String == "com.apple.Settings.extension.ui",
                  let id = info["CFBundleIdentifier"] as? String else { return nil }
            let table = NSDictionary(contentsOf: url.appendingPathComponent("Contents/Resources/InfoPlist.loctable")) as? [String: Any]
            let strings = (table?[language] ?? table?["en"]) as? [String: Any]
            let name = (strings?["CFBundleDisplayName"] as? String) ?? (info["CFBundleDisplayName"] as? String) ?? ""
            return name.isEmpty ? nil : ["id": id, "name": name]
        }.sorted { ($0["name"] ?? "") < ($1["name"] ?? "") }
    }()

    private var menuRefs: [String: AXUIElement] = [:]
    private let vision = VisionReader()
    private var visionRefs: [String: CGRect] = [:]

    /// The target window's text read from its pixels, as pressable elements ("v0", "v1", …).
    func readScreenImage() async throws -> [[String: Any]] {
        guard let pid = targetPID else { throw AXError.noTarget }
        let found = try await vision.read(windowOf: pid)
        visionRefs = [:]
        return found.prefix(150).enumerated().map { index, item in
            let id = "v\(index)"
            visionRefs[id] = item.box
            return ["id": id, "role": "AXImageText", "label": item.text, "context": "read from the screen image",
                    "editable": false, "pressable": true]
        }
    }
    private var statusRefs: [String: (pid: pid_t, item: AXUIElement)] = [:]

    /// Every enabled command in the target app's menu bar, as paths ("File › Export › PDF…"),
    /// read from the app itself, so any app's menus work without app-specific code.
    func menuCommands() throws -> [String] {
        guard let pid = targetPID else { throw AXError.noTarget }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.3)
        guard let bar: AXUIElement = attribute(app, kAXMenuBarAttribute),
              let tops: [AXUIElement] = attribute(bar, kAXChildrenAttribute) else { throw AXError.noWindow }
        menuRefs = [:]
        var paths: [String] = []
        func walk(_ element: AXUIElement, _ prefix: String, _ depth: Int) {
            guard depth < 4, paths.count < 500, let children: [AXUIElement] = attribute(element, kAXChildrenAttribute) else { return }
            for child in children {
                let role: String = attribute(child, kAXRoleAttribute) ?? ""
                if role == "AXMenu" { walk(child, prefix, depth + 1); continue }
                guard role == "AXMenuItem" || role == "AXMenuBarItem" else { continue }
                let title = ((attribute(child, kAXTitleAttribute) as String?) ?? "").trimmingCharacters(in: .whitespaces)
                guard !title.isEmpty else { continue }
                let path = prefix.isEmpty ? title : "\(prefix) › \(title)"
                let submenu: [AXUIElement] = attribute(child, kAXChildrenAttribute) ?? []
                if submenu.isEmpty {
                    guard (attribute(child, kAXEnabledAttribute) as Bool?) ?? true, role == "AXMenuItem" else { continue }
                    menuRefs[path] = child
                    paths.append(path)
                } else {
                    walk(child, path, depth + 1)
                }
            }
        }
        for top in tops { walk(top, "", 0) }
        return paths
    }

    func pressMenu(_ path: String) throws {
        guard let item = menuRefs[path] else { throw AXError.stale }
        if let pid = targetPID, let app = NSRunningApplication(processIdentifier: pid) { Self.bringToFront(app) }
        guard AXUIElementPerformAction(item, kAXPressAction as CFString) == .success else { throw AXError.actionFailed }
    }

    /// The icons on the right of the menu bar (Wi‑Fi, Battery, Control Centre, Focus,
    /// other apps' status items), from every running process's extras menu bar.
    func statusItems() -> [[String: String]] {
        statusRefs = [:]
        var out: [[String: String]] = []
        for app in NSWorkspace.shared.runningApplications where !app.isTerminated {
            let element = AXUIElementCreateApplication(app.processIdentifier)
            AXUIElementSetMessagingTimeout(element, 0.1)
            guard let extras: AXUIElement = attribute(element, "AXExtrasMenuBar"),
                  let items: [AXUIElement] = attribute(extras, kAXChildrenAttribute) else { continue }
            for (index, item) in items.enumerated() {
                let label = [attribute(item, kAXTitleAttribute) as String?, attribute(item, kAXDescriptionAttribute) as String?,
                             attribute(item, kAXHelpAttribute) as String?].compactMap { $0 }.first { !$0.isEmpty }
                    ?? app.localizedName ?? "menu bar icon"
                let id = "s\(app.processIdentifier).\(index)"
                statusRefs[id] = (app.processIdentifier, item)
                out.append(["id": id, "name": "\(label) (\(app.localizedName ?? "system"))"])
            }
        }
        return out
    }

    /// Clicks a menu-bar icon; its menu or panel belongs to that process, which becomes the target.
    func pressStatusItem(_ id: String) throws {
        guard let (pid, item) = statusRefs[id] else { throw AXError.stale }
        guard AXUIElementPerformAction(item, kAXPressAction as CFString) == .success else { throw AXError.actionFailed }
        targetPID = pid
        followPanel(owner: pid)
    }

    /// A menu-bar click can open a panel that belongs to another process (the clock opens
    /// Notification Centre): read whichever of them now shows a window.
    private func followPanel(owner: pid_t) {
        usleep(350_000)
        let centre = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.notificationcenterui").first
        for candidate in [centre?.processIdentifier, owner].compactMap({ $0 }) {
            let element = AXUIElementCreateApplication(candidate)
            AXUIElementSetMessagingTimeout(element, 0.2)
            if let windows: [AXUIElement] = attribute(element, kAXWindowsAttribute), !windows.isEmpty {
                targetPID = candidate
                return
            }
        }
    }

    /// Opens Notification Centre (the clock in the menu bar) so notifications can be read
    /// and opened like any window.
    func openNotificationCentre() throws {
        _ = statusItems()
        guard let control = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.controlcenter").first,
              let (id, _) = statusRefs.first(where: { entry in
                  entry.value.pid == control.processIdentifier
                      && ((attribute(entry.value.item, kAXDescriptionAttribute) as String?) ?? "").localizedCaseInsensitiveContains("clock")
              }) else { throw AXError.actionFailed }
        try pressStatusItem(id)
        guard let centre = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.notificationcenterui").first,
              targetPID == centre.processIdentifier else { throw AXError.actionFailed }
    }

    /// Opens one System Settings pane directly and makes Settings the target.
    func openSettings(_ id: String) async throws {
        guard Self.settingsPanes.contains(where: { $0["id"] == id }),
              let url = URL(string: "x-apple.systempreferences:\(id)"), NSWorkspace.shared.open(url) else {
            throw AXError.actionFailed
        }
        try await Task.sleep(for: .milliseconds(900))
        if let settings = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.systempreferences").first {
            targetPID = settings.processIdentifier
            Self.bringToFront(settings)
        }
    }

    private static func postKey(_ code: CGKeyCode, _ flags: CGEventFlags) {
        for down in [true, false] {
            let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
            event?.flags = flags
            event?.post(tap: .cghidEventTap)
        }
    }

    static func installedApps() -> [String] {
        let roots = ["/Applications", "/System/Applications", "/System/Applications/Utilities",
                     NSHomeDirectory() + "/Applications"]
        return roots.flatMap { (try? FileManager.default.contentsOfDirectory(atPath: $0)) ?? [] }
            .filter { $0.hasSuffix(".app") }.map { String($0.dropLast(4)) }
    }

    // MARK: helpers

    /// Keys, clicks and typing go to whatever app is in front, so the target must really be
    /// there first; otherwise they would land in another app.
    private func activateTarget() throws {
        guard let pid = targetPID, let app = NSRunningApplication(processIdentifier: pid) else { throw AXError.noTarget }
        guard Self.bringToFront(app) else { throw AXError.notFront }
    }

    /// Whether `pid` is the app in front, asked of the app itself (no run-loop needed).
    static func isFront(_ pid: pid_t) -> Bool {
        let element = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(element, 0.3)
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, kAXFrontmostAttribute as CFString, &value) == .success
            && (value as? Bool) == true
    }

    /// Brings `app` to the front and confirms it. A plain activate() is ignored by macOS
    /// when SystemOne is not the active app, so this also asks through Accessibility and,
    /// failing that, Launch Services (what clicking the app in the Dock does).
    @discardableResult
    static func bringToFront(_ app: NSRunningApplication) -> Bool {
        let pid = app.processIdentifier
        if isFront(pid) { return true }
        if app.isHidden { app.unhide() }
        if #available(macOS 14, *) { NSApp.yieldActivation(to: app) }
        app.activate()
        let element = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(element, 0.3)
        AXUIElementSetAttributeValue(element, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        for attempt in 0..<16 {
            if isFront(pid) { return true }
            if attempt == 4, let url = app.bundleURL {
                let config = NSWorkspace.OpenConfiguration()
                config.activates = true
                NSWorkspace.shared.openApplication(at: url, configuration: config) { _, _ in }
            }
            usleep(50_000)
        }
        return isFront(pid)
    }

    // MARK: whole-Mac view and actions

    private var windowRefs: [String: (pid: pid_t, window: AXUIElement)] = [:]

    /// Every standard window of every regular app (front app first), so the agent can
    /// bring any of them forward directly. A slow app is skipped after 0.15 s.
    func windows() -> [[String: Any]] {
        let me = ProcessInfo.processInfo.processIdentifier
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let apps = NSWorkspace.shared.runningApplications
            .filter { $0.activationPolicy == .regular && $0.processIdentifier != me && !$0.isTerminated }
            .sorted { ($0.processIdentifier == front ? 0 : 1) < ($1.processIdentifier == front ? 0 : 1) }
            .prefix(30)
        windowRefs = [:]
        var out: [[String: Any]] = []
        for app in apps {
            let element = AXUIElementCreateApplication(app.processIdentifier)
            AXUIElementSetMessagingTimeout(element, 0.15)
            guard let list: [AXUIElement] = attribute(element, kAXWindowsAttribute) else { continue }
            for (index, window) in list.prefix(8).enumerated() {
                let subrole: String = attribute(window, kAXSubroleAttribute) ?? ""
                guard subrole == "AXStandardWindow" || subrole.isEmpty else { continue }
                let id = "w\(app.processIdentifier).\(index)"
                windowRefs[id] = (app.processIdentifier, window)
                let minimized: Bool = attribute(window, kAXMinimizedAttribute) ?? false
                var entry: [String: Any] = ["id": id, "app": app.localizedName ?? "app",
                                            "title": (attribute(window, kAXTitleAttribute) as String?) ?? "",
                                            "minimized": minimized, "hidden": app.isHidden,
                                            "front": app.processIdentifier == front && index == 0]
                if !minimized, let box = frame(of: window), let screen = Self.screen(containing: box) {
                    entry["display"] = screen.localizedName
                }
                out.append(entry)
                if out.count >= 60 { return out }
            }
        }
        return out
    }

    /// The display holding most of an Accessibility (top-left based) frame.
    static func screen(containing box: CGRect) -> NSScreen? {
        guard let primary = NSScreen.screens.first else { return nil }
        let cocoa = CGRect(x: box.minX, y: primary.frame.height - box.maxY, width: box.width, height: box.height)
        func overlap(_ screen: NSScreen) -> CGFloat {
            let shared = screen.frame.intersection(cocoa)
            return shared.isNull ? 0 : shared.width * shared.height
        }
        return NSScreen.screens.max { overlap($0) < overlap($1) }
    }

    /// Connected displays by name, and which one the pointer is on ("this monitor").
    static func displays() -> [[String: Any]] {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.enumerated().map { index, screen in
            ["name": screen.localizedName, "index": index, "pointer": NSMouseInRect(mouse, screen.frame, false),
             "main": index == 0]
        }
    }

    /// The front window of the target app in screen (bottom-left) coordinates, for the
    /// "Jev is working here" highlight, plus the name of its display.
    func targetWindow() -> (frame: CGRect, display: String)? {
        guard let pid = targetPID, let primary = NSScreen.screens.first else { return nil }
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 0.2)
        guard let window: AXUIElement = attribute(app, kAXFocusedWindowAttribute)
                ?? (attribute(app, kAXWindowsAttribute) as [AXUIElement]?)?.first,
              let box = frame(of: window) else { return nil }
        let cocoa = CGRect(x: box.minX, y: primary.frame.height - box.maxY, width: box.width, height: box.height)
        return (cocoa, Self.screen(containing: box)?.localizedName ?? "")
    }

    /// Brings one listed window (and its app) to the front, restoring it if minimised.
    func focus(window id: String) throws {
        guard let (pid, window) = windowRefs[id], let app = NSRunningApplication(processIdentifier: pid) else {
            throw AXError.stale
        }
        if app.isHidden { app.unhide() }
        AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
        AXUIElementPerformAction(window, kAXRaiseAction as CFString)
        AXUIElementSetAttributeValue(window, kAXMainAttribute as CFString, kCFBooleanTrue)
        guard Self.bringToFront(app) else { throw AXError.notFront }
        targetPID = pid
    }

    /// Acts on the front window of the target app: minimise, full screen, zoom or close.
    /// Acts on one listed window (`id`), or on the front window of the target app.
    func window(action: String, id: String? = nil) throws {
        let window: AXUIElement
        let app: NSRunningApplication
        if let id, !id.isEmpty {
            guard let (pid, listed) = windowRefs[id], let owner = NSRunningApplication(processIdentifier: pid) else {
                throw AXError.stale
            }
            window = listed
            app = owner
        } else {
            guard let pid = targetPID, let owner = NSRunningApplication(processIdentifier: pid) else { throw AXError.noTarget }
            let element = AXUIElementCreateApplication(pid)
            guard let front: AXUIElement = attribute(element, kAXFocusedWindowAttribute)
                    ?? (attribute(element, kAXWindowsAttribute) as [AXUIElement]?)?.first else { throw AXError.noWindow }
            window = front
            app = owner
        }
        switch action {
        case "minimize":
            guard AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanTrue) == .success
            else { throw AXError.actionFailed }
        case "fullscreen":
            let current: Bool = attribute(window, "AXFullScreen") ?? false
            guard AXUIElementSetAttributeValue(window, "AXFullScreen" as CFString,
                                               (!current ? kCFBooleanTrue : kCFBooleanFalse)) == .success
            else { throw AXError.actionFailed }
        case "zoom", "close":
            let attr = action == "zoom" ? kAXZoomButtonAttribute : kAXCloseButtonAttribute
            guard let button: AXUIElement = attribute(window, attr),
                  AXUIElementPerformAction(button, kAXPressAction as CFString) == .success else { throw AXError.actionFailed }
        case "hide_app":
            guard app.hide() else { throw AXError.actionFailed }
        case "left_half", "right_half", "top_half", "bottom_half", "maximize", "center", "next_display", "mouse_display",
             _ where action.hasPrefix("display_"):
            try place(window, action)
        default: throw AXError.actionFailed
        }
    }

    /// Moves and sizes a window on its display, another display, or the display under the
    /// pointer ("this monitor"), then reads it back: a window that refused (minimum size,
    /// full screen) is reported as not done instead of silently claimed.
    private func place(_ window: AXUIElement, _ action: String) throws {
        if (attribute(window, "AXFullScreen") as Bool?) == true {
            AXUIElementSetAttributeValue(window, "AXFullScreen" as CFString, kCFBooleanFalse)
            usleep(800_000)
        }
        let screens = NSScreen.screens
        guard let box = frame(of: window), let primary = screens.first else { throw AXError.actionFailed }
        // Accessibility frames are top-left based on the primary display; NSScreen's are bottom-left.
        let height = primary.frame.height
        let current = CGRect(x: box.minX, y: height - box.maxY, width: box.width, height: box.height)
        func overlap(_ screen: NSScreen) -> CGFloat {
            let shared = screen.frame.intersection(current)
            return shared.isNull ? 0 : shared.width * shared.height
        }
        let here = screens.max { overlap($0) < overlap($1) } ?? primary
        var screen = here
        if action == "next_display", let index = screens.firstIndex(of: here) { screen = screens[(index + 1) % screens.count] }
        if action == "mouse_display" { screen = screens.first { NSMouseInRect(NSEvent.mouseLocation, $0.frame, false) } ?? here }
        if action.hasPrefix("display_"), let index = Int(action.dropFirst(8)), screens.indices.contains(index) { screen = screens[index] }
        let area = screen.visibleFrame
        var target = area
        switch action {
        case "left_half": target.size.width = area.width / 2
        case "right_half": target.size.width = area.width / 2; target.origin.x = area.midX
        case "top_half": target.size.height = area.height / 2; target.origin.y = area.midY
        case "bottom_half": target.size.height = area.height / 2
        case "center", "next_display", "mouse_display", _ where action.hasPrefix("display_"):
            let size = CGSize(width: min(box.width, area.width), height: min(box.height, area.height))
            target = CGRect(x: area.midX - size.width / 2, y: area.midY - size.height / 2, width: size.width, height: size.height)
        default: break
        }
        var origin = CGPoint(x: target.minX, y: height - target.maxY)
        var size = target.size
        guard let position = AXValueCreate(.cgPoint, &origin), let extent = AXValueCreate(.cgSize, &size) else {
            throw AXError.actionFailed
        }
        // Size, position, size: a large window moved first can be clamped by the screen edge.
        AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, extent)
        AXUIElementSetAttributeValue(window, kAXPositionAttribute as CFString, position)
        AXUIElementSetAttributeValue(window, kAXSizeAttribute as CFString, extent)
        usleep(120_000)
        guard let after = frame(of: window) else { throw AXError.actionFailed }
        let landed = abs(after.minX - origin.x) < 40 && abs(after.minY - origin.y) < 40
            && abs(after.width - size.width) < 60 && abs(after.height - size.height) < 60
        if !landed { throw AXError.placementRefused }
    }

    /// System media and volume keys: they go to whatever is playing, wherever it is.
    static func media(_ name: String) throws {
        let codes: [String: Int32] = ["playpause": 16, "next": 17, "previous": 18,
                                      "volumeup": 0, "volumedown": 1, "mute": 7,
                                      "brightnessup": 2, "brightnessdown": 3]
        guard let code = codes[name] else { throw AXError.actionFailed }
        for down in [true, false] {
            let flags = NSEvent.ModifierFlags(rawValue: down ? 0xa00 : 0xb00)
            let data1 = Int((code << 16) | ((down ? 0xa : 0xb) << 8))
            NSEvent.otherEvent(with: .systemDefined, location: .zero, modifierFlags: flags, timestamp: 0,
                               windowNumber: 0, context: nil, subtype: 8, data1: data1, data2: -1)?
                .cgEvent?.post(tap: .cghidEventTap)
        }
    }

    /// Finds files or folders by name in the user's home (Spotlight index) and opens the
    /// best match: exact name first, then the shortest path.
    func openFile(named query: String) async throws {
        // Words such as "spreadsheet" or "pdf" describe the kind of file, not its name:
        // they are dropped from the search and used to prefer matching file types.
        let kinds: [String: [String]] = [
            "spreadsheet": ["xlsx", "xls", "numbers", "csv"], "sheet": ["xlsx", "xls", "numbers", "csv"],
            "pdf": ["pdf"], "presentation": ["key", "pptx", "ppt"], "deck": ["key", "pptx", "ppt"],
            "slides": ["key", "pptx", "ppt"], "document": ["docx", "doc", "pages", "txt", "md", "rtf"],
            "doc": ["docx", "doc", "pages"], "photo": ["jpg", "jpeg", "png", "heic"], "image": ["jpg", "jpeg", "png", "heic"],
            "picture": ["jpg", "jpeg", "png", "heic"], "screenshot": ["png"]]
        let filler: Set<String> = ["file", "files", "folder", "the", "my", "a", "an", "called", "named"]
        let words = query.lowercased().split(whereSeparator: { $0.isWhitespace }).map {
            String($0).trimmingCharacters(in: .punctuationCharacters) }
        let wantFolder = words.contains("folder")
        let extensions = Set(words.flatMap { kinds[$0] ?? kinds[String($0.dropLast())] ?? [] })
        let wanted = words.filter { kinds[$0] == nil && kinds[String($0.dropLast())] == nil && !filler.contains($0) }
            .joined(separator: " ")
        guard (2...120).contains(wanted.count) else { throw AXError.actionFailed }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/mdfind")
        process.arguments = ["-onlyin", NSHomeDirectory(), "-name", wanted]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        try process.run()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let paths = (String(data: data, encoding: .utf8) ?? "").split(separator: "\n").map(String.init)
            .filter { !$0.contains("/Library/") && !$0.split(separator: "/").contains { $0.hasPrefix(".") } }
        func rank(_ path: String) -> (Int, Int) {
            let url = URL(fileURLWithPath: path)
            var isDirectory: ObjCBool = false
            FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory)
            var score = 0
            if url.deletingPathExtension().lastPathComponent.lowercased() == wanted { score -= 4 }
            if extensions.contains(url.pathExtension.lowercased()) { score -= 2 }
            if wantFolder == isDirectory.boolValue { score -= 1 }
            return (score, path.count)
        }
        guard let best = paths.min(by: { rank($0) < rank($1) }) else { throw AXError.actionFailed }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        if let app = try? await NSWorkspace.shared.open(URL(fileURLWithPath: best), configuration: config) {
            targetPID = app.processIdentifier
        } else {
            guard NSWorkspace.shared.open(URL(fileURLWithPath: best)) else { throw AXError.actionFailed }
        }
        try await Task.sleep(for: .milliseconds(1_000))
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

    enum AXError: Error, CustomStringConvertible {
        case noTarget, noWindow, stale, actionFailed, notFront, placementRefused
        var description: String {
            switch self {
            case .noTarget: "no app to act on"
            case .noWindow: "the app has no window"
            case .stale: "that control is gone"
            case .actionFailed: "the action could not be performed"
            case .notFront: "macOS did not bring the app to the front"
            case .placementRefused: "the window did not end up there (it may have a minimum size)"
            }
        }
    }
}

private extension Array {
    func chunked(into size: Int) -> [[Element]] {
        stride(from: 0, to: count, by: size).map { Array(self[$0..<Swift.min($0 + size, count)]) }
    }
}
