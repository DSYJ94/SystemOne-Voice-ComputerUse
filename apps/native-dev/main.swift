import AppKit
import ApplicationServices
import Foundation

@MainActor
final class SystemOneDev: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var panel: NSPanel?
    private var urlField: NSTextField?
    private var labelField: NSTextField?
    private var valueField: NSTextField?
    private var statusField: NSTextField?
    private var nativeBundleField: NSTextField?
    private var nativeOutput: NSTextView?
    private var inspectionEpoch = 0
    private var inspectionPending = false
    private var controller: Process?
    private var controllerInput: Pipe?
    private var controllerOutput: Pipe?
    private var outputBuffer = Data()
    private var activeRequestID: String?
    private var stopRequestID: String?
    private var quitPending = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Development fallback: a hidden menu-bar item remains reachable from
        // the Dock. Release packaging will use the agent-app lifecycle.
        NSApp.setActivationPolicy(.regular)
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "S1 Dev"
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Open Command Panel", action: #selector(openPanel), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Stop", action: #selector(stop), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit SystemOne Dev", action: #selector(quit), keyEquivalent: ""))
        for entry in menu.items { entry.target = self }
        item.menu = menu
        statusItem = item
        makePanel()
        startController()
        openPanel()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication,
        hasVisibleWindows flag: Bool) -> Bool {
        openPanel()
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        controllerOutput?.fileHandleForReading.readabilityHandler = nil
        controllerInput?.fileHandleForWriting.closeFile()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard activeRequestID != nil, controller?.isRunning == true else { return .terminateNow }
        quitPending = true
        stop()
        return .terminateLater
    }

    private func makePanel() {
        let window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 560, height: 620),
                             styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "SystemOne Dev"
        window.isFloatingPanel = true
        window.isOpaque = false
        window.backgroundColor = .clear
        window.center()
        let backdrop = NSVisualEffectView(frame: window.contentView?.bounds ?? .zero)
        backdrop.material = .popover
        backdrop.blendingMode = .behindWindow
        backdrop.state = .active
        backdrop.autoresizingMask = [.width, .height]
        window.contentView = backdrop

        let heading = NSTextField(labelWithString: "Managed browser — field fill")
        heading.font = .boldSystemFont(ofSize: 16)
        let explanation = NSTextField(wrappingLabelWithString:
            "Choose an HTTPS page and one visible text field. This development build opens a fresh Chromium profile and verifies only that field's current value. Do not enter credentials.")
        explanation.textColor = .secondaryLabelColor
        let url = NSTextField()
        url.placeholderString = "https://example.com/form"
        url.setAccessibilityLabel("Approved page URL")
        urlField = url
        let label = NSTextField()
        label.placeholderString = "Exact visible field label"
        label.setAccessibilityLabel("Field label")
        labelField = label
        let value = NSTextField()
        value.placeholderString = "Text to place in the field"
        value.setAccessibilityLabel("Field value")
        valueField = value
        let status = NSTextField(wrappingLabelWithString: "Starting local controller…")
        status.textColor = .secondaryLabelColor
        status.setAccessibilityLabel("SystemOne status")
        statusField = status
        let fill = NSButton(title: "Fill field", target: self, action: #selector(startFill))
        let stopButton = NSButton(title: "Stop", target: self, action: #selector(stop))
        let hide = NSButton(title: "Hide", target: self, action: #selector(hidePanel))
        let actions = NSStackView(views: [fill, stopButton, hide])
        actions.orientation = .horizontal
        actions.spacing = 8

        let nativeHeading = NSTextField(labelWithString: "Native app — read-only inspection")
        nativeHeading.font = .boldSystemFont(ofSize: 16)
        let nativeExplanation = NSTextField(wrappingLabelWithString:
            "Enter one running app's exact bundle ID. Accessibility labels and supported actions stay in this local panel; field values are not read.")
        nativeExplanation.textColor = .secondaryLabelColor
        let bundle = NSTextField()
        bundle.placeholderString = "App bundle ID, e.g. com.aurium.systemone.fixture"
        bundle.setAccessibilityLabel("Native app bundle ID")
        nativeBundleField = bundle
        let access = NSButton(title: "Request Accessibility", target: self,
                              action: #selector(requestAccessibility))
        let inspect = NSButton(title: "Inspect app", target: self,
                               action: #selector(inspectNativeApp))
        let nativeActions = NSStackView(views: [access, inspect])
        nativeActions.orientation = .horizontal
        nativeActions.spacing = 8
        let output = NSTextView()
        output.isEditable = false
        output.isSelectable = true
        output.drawsBackground = false
        output.font = .systemFont(ofSize: 12)
        output.string = "No native app inspected."
        nativeOutput = output
        let scroll = NSScrollView()
        scroll.documentView = output
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        scroll.heightAnchor.constraint(equalToConstant: 120).isActive = true
        let stack = NSStackView(views: [heading, explanation, url, label, value,
                                        status, actions, nativeHeading,
                                        nativeExplanation, bundle, nativeActions, scroll])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 9
        stack.translatesAutoresizingMaskIntoConstraints = false
        backdrop.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: backdrop.leadingAnchor, constant: 18),
            stack.trailingAnchor.constraint(equalTo: backdrop.trailingAnchor, constant: -18),
            stack.centerYAnchor.constraint(equalTo: backdrop.centerYAnchor),
            url.widthAnchor.constraint(equalTo: stack.widthAnchor),
            label.widthAnchor.constraint(equalTo: stack.widthAnchor),
            value.widthAnchor.constraint(equalTo: stack.widthAnchor),
            status.widthAnchor.constraint(equalTo: stack.widthAnchor),
            explanation.widthAnchor.constraint(equalTo: stack.widthAnchor),
            nativeExplanation.widthAnchor.constraint(equalTo: stack.widthAnchor),
            bundle.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        panel = window
    }

    private func startController() {
        guard let node = Bundle.main.object(forInfoDictionaryKey: "SystemOneNodeExecutable") as? String,
              let script = Bundle.main.object(forInfoDictionaryKey: "SystemOneControllerScript") as? String,
              FileManager.default.isExecutableFile(atPath: node),
              FileManager.default.fileExists(atPath: script) else {
            statusField?.stringValue = "Development controller configuration is missing. Rebuild the app."
            return
        }
        let support = FileManager.default.urls(for: .applicationSupportDirectory,
                                               in: .userDomainMask)[0]
            .appendingPathComponent("SystemOne-Dev", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: support,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
            let process = Process()
            let input = Pipe()
            let output = Pipe()
            process.executableURL = URL(fileURLWithPath: node)
            process.arguments = [script, support.appendingPathComponent("attempts.sqlite").path]
            process.standardInput = input
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            output.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                Task { @MainActor [weak self] in self?.receiveOutput(data) }
            }
            process.terminationHandler = { [weak self] ended in
                let code = ended.terminationStatus
                Task { @MainActor [weak self] in self?.controllerExited(code) }
            }
            try process.run()
            controller = process
            controllerInput = input
            controllerOutput = output
        } catch {
            statusField?.stringValue = "Could not start the local controller. Rebuild and retry."
        }
    }

    private func receiveOutput(_ data: Data) {
        if data.isEmpty { return }
        outputBuffer.append(data)
        guard outputBuffer.count <= 32_768 else {
            statusField?.stringValue = "Controller protocol exceeded its limit. Stop and relaunch."
            controller?.terminate()
            return
        }
        while let newline = outputBuffer.firstIndex(of: 10) {
            let line = Data(outputBuffer[..<newline])
            outputBuffer.removeSubrange(...newline)
            guard line.count <= 16_384,
                  let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
                  object["type"] as? String == "status",
                  let requestID = object["requestId"] as? String,
                  let phase = object["phase"] as? String else {
                statusField?.stringValue = "Controller returned an invalid status. Stop and relaunch."
                continue
            }
            showStatus(requestID: requestID, phase: phase)
        }
    }

    private func showStatus(requestID: String, phase: String) {
        if requestID == "startup" && phase == "ready" {
            statusField?.stringValue = "Ready. Only the approved page origin can load."
            return
        }
        guard requestID == activeRequestID || requestID == stopRequestID else { return }
        switch phase {
        case "starting": statusField?.stringValue = "Opening a fresh managed Chromium profile…"
        case "observing": statusField?.stringValue = "Checking the exact visible field…"
        case "dispatching": statusField?.stringValue = "Filling the field; Stop may not undo this edit."
        case "verified_dom_fill":
            statusField?.stringValue = "Verified: this page's field holds the supplied text. Inspect it, then press Stop to close this browser."
        case "unsupported": statusField?.stringValue = "Field absent, ambiguous or outside observed coverage. No fill sent."
        case "uncertain":
            statusField?.stringValue = "Outcome or browser fence uncertain. Inspect the page before retrying."
            if requestID == stopRequestID {
                stopRequestID = nil
                if quitPending { quitPending = false; NSApp.reply(toApplicationShouldTerminate: false) }
            }
        case "blocked_recovery": statusField?.stringValue = "Earlier effect unresolved. Re-observation is required before another task."
        case "stopping": statusField?.stringValue = "Stopping browser and fencing future actions…"
        case "stopped": statusField?.stringValue = "Stopped. An already-sent edit may have taken effect."
        case "busy": statusField?.stringValue = "A task is already active."
        case "error": statusField?.stringValue = "The request was rejected or failed. No success is claimed."
        case "ready": if requestID == activeRequestID { activeRequestID = nil }
        default: statusField?.stringValue = "Unrecognized controller status."
        }
        if phase == "stopped" && requestID == stopRequestID {
            activeRequestID = nil
            stopRequestID = nil
            if quitPending { quitPending = false; NSApp.reply(toApplicationShouldTerminate: true) }
        }
    }

    private func controllerExited(_ code: Int32) {
        controller = nil
        controllerInput = nil
        controllerOutput?.fileHandleForReading.readabilityHandler = nil
        controllerOutput = nil
        if activeRequestID != nil {
            statusField?.stringValue = "Controller exited (\(code)); task outcome uncertain."
        } else {
            statusField?.stringValue = "Controller exited (\(code)); relaunch the development app."
        }
        if quitPending { quitPending = false; NSApp.reply(toApplicationShouldTerminate: false) }
    }

    @objc private func openPanel() {
        guard let panel else { return }
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(urlField)
    }

    @objc private func startFill() {
        guard let input = controllerInput, controller?.isRunning == true,
              activeRequestID == nil, stopRequestID == nil,
              !inspectionPending else {
            statusField?.stringValue = "Controller unavailable or a task is active."
            return
        }
        let url = urlField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let field = labelField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let value = valueField?.stringValue ?? ""
        guard let parsed = URLComponents(string: url),
              parsed.user == nil, parsed.password == nil,
              parsed.scheme == "https" || (parsed.scheme == "http" && parsed.host == "127.0.0.1"),
              !field.isEmpty, field.count <= 160,
              value.utf8.count <= 1_024 else {
            statusField?.stringValue = "Use an HTTPS page (or 127.0.0.1), an exact field label and at most 1,024 bytes."
            return
        }
        let taskID = UUID().uuidString.lowercased()
        let command: [String: Any] = [
            "type": "command", "protocolVersion": "2.0", "messageId": UUID().uuidString.lowercased(),
            "taskId": taskID, "taskEpoch": 1, "goalRevision": 1,
            "source": "text", "mode": "command", "utteranceId": UUID().uuidString.lowercased(),
            "utteranceRevision": 1,
            "text": "Fill \(field) on \(url) with supplied text", "isFinal": true,
            "createdAt": ISO8601DateFormatter().string(from: Date()),
            "originSurface": ["adapter": "native", "surfaceId": "systemone-panel",
                "appBundleId": "com.aurium.systemone.dev", "windowId": "command-panel",
                "contentRevision": taskID],
        ]
        let request: [String: Any] = ["type": "start_fill", "requestId": taskID,
            "url": url, "fieldLabel": field, "value": value, "command": command]
        guard send(request, through: input) else {
            statusField?.stringValue = "Could not send the request to the controller."
            return
        }
        activeRequestID = taskID
        statusField?.stringValue = "Request sent to the local controller…"
    }

    @objc private func stop() {
        if inspectionPending {
            inspectionEpoch += 1
            inspectionPending = false
            nativeOutput?.string = "Inspection stopped. No native action was sent."
            return
        }
        guard let target = activeRequestID, let input = controllerInput else {
            statusField?.stringValue = "No active task to stop."
            return
        }
        guard stopRequestID == nil else { return }
        let stopID = UUID().uuidString.lowercased()
        stopRequestID = stopID
        let request: [String: Any] = ["type": "stop",
            "requestId": stopID, "targetRequestId": target]
        if send(request, through: input) {
            statusField?.stringValue = "Stop requested; waiting for the browser fence…"
        } else {
            stopRequestID = nil
            statusField?.stringValue = "Stop delivery failed. Task outcome is uncertain."
            if quitPending { quitPending = false; NSApp.reply(toApplicationShouldTerminate: false) }
        }
    }

    private func send(_ object: [String: Any], through pipe: Pipe) -> Bool {
        guard let data = try? JSONSerialization.data(withJSONObject: object),
              data.count <= 16_384 else { return false }
        do {
            try pipe.fileHandleForWriting.write(contentsOf: data + Data([10]))
            return true
        } catch { return false }
    }

    @objc private func requestAccessibility() {
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        nativeOutput?.string = AXIsProcessTrustedWithOptions(options)
            ? "Accessibility is granted to this SystemOne Dev build."
            : "Accessibility is not yet granted to this build. Grant it in macOS settings if prompted."
    }

    @objc private func inspectNativeApp() {
        guard !inspectionPending, activeRequestID == nil else {
            nativeOutput?.string = "Another task is active. Stop it first."
            return
        }
        guard AXIsProcessTrustedWithOptions(nil) else {
            nativeOutput?.string = "Accessibility is not granted to this SystemOne Dev build."
            return
        }
        let bundleID = nativeBundleField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard bundleID.range(of: "^[A-Za-z0-9.-]{3,160}$", options: .regularExpression) != nil else {
            nativeOutput?.string = "Enter one exact app bundle ID."
            return
        }
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
            .filter { !$0.isTerminated && $0.bundleURL != nil && $0.launchDate != nil }
        guard running.count == 1, let app = running.first,
              let bundleURL = app.bundleURL, let launchDate = app.launchDate else {
            nativeOutput?.string = "Exactly one running app with that bundle ID is required."
            return
        }
        let target = AXTarget(pid: app.processIdentifier, bundleID: bundleID,
                              bundleURL: bundleURL, launchDate: launchDate,
                              scopeRef: "native-observe:\(UUID().uuidString)")
        inspectionEpoch += 1
        let epoch = inspectionEpoch
        inspectionPending = true
        nativeOutput?.string = "Inspecting the Accessibility tree off the UI thread…"
        Task.detached(priority: .userInitiated) { [weak self] in
            let result: String
            do {
                let registry = try NativeAXObservationRegistry(backend: SystemAXBackend(),
                    maxNodes: 80, maxDepth: 5, budget: .seconds(2))
                let observation = try registry.observe(target)
                let controls = observation.nodes.filter {
                    !$0.description.secure && !$0.description.label.isEmpty
                }
                let lines = controls.prefix(12).map { node in
                    let detail = node.description
                    let capabilities = detail.capabilities.isEmpty
                        ? "read-only" : detail.capabilities.joined(separator: ", ")
                    return "\(detail.role): \(detail.label) [\(capabilities)]"
                }
                result = "Observed \(observation.nodes.count) nodes; "
                    + (observation.complete ? "coverage complete" : "coverage incomplete")
                    + ". No field values read.\n" + lines.joined(separator: "\n")
            } catch {
                result = "Native observation unavailable: \(error). No action was sent."
            }
            await MainActor.run { [weak self] in
                guard let self, self.inspectionPending,
                      self.inspectionEpoch == epoch else { return }
                self.inspectionPending = false
                self.nativeOutput?.string = result
            }
        }
    }

    @objc private func hidePanel() { panel?.orderOut(nil) }
    @objc private func quit() { NSApp.terminate(nil) }
}

@main
struct Main {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = SystemOneDev()
        app.delegate = delegate
        app.run()
        withExtendedLifetime(delegate) {}
    }
}
