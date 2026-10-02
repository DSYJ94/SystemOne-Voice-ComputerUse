import AppKit
import ApplicationServices
import Carbon
import Darwin
import Foundation

private let systemOneHotkeySignature: OSType = 0x53314B59 // S1KY
private let openPanelHotkeyID: UInt32 = 1
private let stopHotkeyID: UInt32 = 2

private final class HoldToTalkButton: NSButton {
    var onPress: (() -> Void)?
    var onRelease: (() -> Void)?

    override func mouseDown(with event: NSEvent) {
        onPress?()
        super.mouseDown(with: event)
        onRelease?()
    }
}

private func systemOneHotkeyHandler(_ event: EventHandlerCallRef?,
                                    _ eventRef: EventRef?,
                                    _ userData: UnsafeMutableRawPointer?) -> OSStatus {
    guard let eventRef, let userData else { return OSStatus(eventNotHandledErr) }
    var hotkeyID = EventHotKeyID(signature: 0, id: 0)
    let result = GetEventParameter(eventRef, EventParamName(kEventParamDirectObject),
                                   EventParamType(typeEventHotKeyID), nil,
                                   MemoryLayout<EventHotKeyID>.size, nil, &hotkeyID)
    guard result == noErr, hotkeyID.signature == systemOneHotkeySignature else {
        return OSStatus(eventNotHandledErr)
    }
    let app = Unmanaged<SystemOneDev>.fromOpaque(userData).takeUnretainedValue()
    let actionID = hotkeyID.id
    DispatchQueue.main.async { app.handleGlobalHotkey(actionID) }
    return noErr
}

@MainActor
final class SystemOneDev: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let taskIntake = DevTaskIntake()
    private var activeRequestID: String? { taskIntake.activeRequestID }
    private var activeSurface: DevTaskIntake.Surface? { taskIntake.activeSurface }
    private var nativeActionActive: Bool {
        activeSurface?.usesNativeWorker == true
    }
    private var statusItem: NSStatusItem?
    private var panel: NSPanel?
    private var commandPanel: NSPanel?
    private var taskField: NSTextField?
    private var commandStatus: NSTextField?
    private var commandTarget: NSTextField?
    private var accessibilityRecoveryButton: NSButton?
    private var capturedApp: (bundleID: String, pid: pid_t, launchDate: Date)?
    private var hasAccessibilityAccess: () -> Bool = {
        AXIsProcessTrustedWithOptions(nil)
    }
    private var promptForAccessibility: () -> Void = {
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
    }
    private var finalSpeechText: String?
    private let speech = OnDeviceSpeech()
    private var urlField: NSTextField?
    private var labelField: NSTextField?
    private var valueField: NSTextField?
    private var statusField: NSTextField?
    private var shortcutField: NSTextField?
    private var focusField: NSTextField?
    private var hotkeyHandler: EventHandlerRef?
    private var openHotkey: EventHotKeyRef?
    private var stopHotkey: EventHotKeyRef?
    private var nativeBundleField: NSTextField?
    private var nativeLabelField: NSTextField?
    private var nativeValueField: NSTextField?
    private var nativeRegionField: NSTextField?
    private var nativeOutput: NSTextView?
    private var chromeLabelField: NSTextField?
    private var chromeValueField: NSTextField?
    private var chromeConnectionID: String?
    private var chromeGrantID: String?
    private var chromeURL: String?
    private let nativeWorker = DevNativeFieldWorker()
    private let nativeInspector = NativeInspectionSession()
    private var chromeListener: DevChromeListener?
    private var inspectionEpoch = 0
    private var inspectionPending = false
    private var controller: Process?
    private var controllerRequirement: RunningProcessRequirement?
    private var nativePermitKeyAccepted = false
    private var controllerInput: Pipe?
    private var controllerOutput: Pipe?
    private var outputBuffer = Data()
    private var fixtureTaskPaused = false
    private var recoveryRequestID: String?
    private let recoveryUISession = UUID().uuidString.lowercased()
    private var recoveryAlert: NSAlert?
    private var stopRequestID: String?
    private var quitPending = false
    private var identityCheckSupport: URL?
    private var lifecycleObservers: [NSObjectProtocol] = []
    private var hostSleeping = false
    private var hostSessionActive = true
    private var hostSequence = 0
    private var hostAcknowledgedSequence = 0
    private var hostInterruptionSettled = false
    private var hostActionsAvailable: Bool {
        !hostSleeping && hostSessionActive && hostSequence > 0
            && hostAcknowledgedSequence == hostSequence && hostInterruptionSettled
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        if CommandLine.arguments.contains("--check-accessibility-recovery") {
            makeCommandPanel()
            var trusted = false
            var prompted = false
            hasAccessibilityAccess = { trusted }
            promptForAccessibility = { prompted = true }
            showAccessibilityDenied()
            let identity = DevAccessibilityIdentity.current()
            let details = identity.recoveryText(trusted: false)
            let denied = accessibilityRecoveryButton?.isHidden == false
                && details.contains(Bundle.main.bundleURL.path)
                && details.contains("denied") && !prompted
            trusted = true
            recheckAccessibility()
            let granted = accessibilityRecoveryButton?.isHidden == true
                && commandStatus?.stringValue.hasPrefix("Accessibility is granted") == true
                && !prompted
            let signingAvailable = !identity.signingDescription.hasPrefix("Signing identity unavailable")
            print(denied && granted && signingAvailable
                ? "PASS: exact-build recovery (\(identity.isAdHoc ? "ad-hoc" : "certificate")) and fresh permission recheck, no OS prompt"
                : "FAIL: Accessibility recovery identity or recheck")
            exit(denied && granted && signingAvailable ? 0 : 1)
        }
        if CommandLine.arguments.contains("--check-no-target-field-preview") {
            makeCommandPanel()
            var queried = false
            var prompted = false
            hasAccessibilityAccess = { queried = true; return false }
            promptForAccessibility = { prompted = true }
            showCapturedFields()
            let clearTargetMessage = commandStatus?.stringValue
                == "Focus a target app, then reopen SystemOne before showing fields."
            let passed = clearTargetMessage && !queried && !prompted
            print(passed ? "PASS: no target avoids Accessibility checks"
                         : "FAIL: no target queried or prompted for Accessibility")
            exit(passed ? 0 : 1)
        }
        if CommandLine.arguments.contains("--check-command-window-visibility") {
            makeCommandPanel()
            guard let commandPanel else {
                fputs("FAIL: command window was not created\n", stderr)
                exit(1)
            }
            let behavior = commandPanel.collectionBehavior
            let managed = behavior.contains(.managed) && !behavior.contains(.transient)
            let staysVisible = !commandPanel.hidesOnDeactivate
                && commandPanel.level.rawValue > NSWindow.Level.normal.rawValue
            print(managed && staysVisible
                ? "PASS: command window participates in Mission Control and stays above apps on deactivation"
                : "FAIL: command window hides or loses floating visibility on deactivation (hides=\(commandPanel.hidesOnDeactivate), level=\(commandPanel.level.rawValue), managed=\(managed))")
            exit(managed && staysVisible ? 0 : 1)
        }
        if CommandLine.arguments.contains("--check-controller-identity") {
            identityCheckSupport = FileManager.default.temporaryDirectory
                .appendingPathComponent("systemone-controller-id-\(UUID().uuidString)",
                                    isDirectory: true)
            startController()
            guard let process = controller, controllerRequirement != nil else {
                fputs("Controller identity check failed to start.\n", stderr)
                if let identityCheckSupport {
                    try? FileManager.default.removeItem(at: identityCheckSupport)
                }
                exit(1)
            }
            let keyDeadline = Date().addingTimeInterval(3)
            while !nativePermitKeyAccepted && process.isRunning && Date() < keyDeadline {
                _ = RunLoop.current.run(mode: .default,
                                        before: Date().addingTimeInterval(0.01))
            }
            let permitKeyAccepted = nativePermitKeyAccepted
            controllerOutput?.fileHandleForReading.readabilityHandler = nil
            controllerInput?.fileHandleForWriting.closeFile()
            process.waitUntilExit()
            let success = permitKeyAccepted && process.terminationStatus == 0
            if let identityCheckSupport {
                try? FileManager.default.removeItem(at: identityCheckSupport)
            }
            print(success ? "PASS: bundled controller identity and permit key accepted"
                          : "FAIL: bundled controller identity, permit key or exit")
            exit(success ? 0 : 1)
        }
        // Development fallback: a hidden menu-bar item remains reachable from
        // the Dock. Release packaging will use the agent-app lifecycle.
        NSApp.setActivationPolicy(.regular)
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "S1 Dev"
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Open Command Panel", action: #selector(openPanel), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Open Developer Tools", action: #selector(openDeveloperPanel), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Stop", action: #selector(stop), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit SystemOne Dev", action: #selector(quit), keyEquivalent: ""))
        for entry in menu.items { entry.target = self }
        item.menu = menu
        statusItem = item
        makePanel()
        makeCommandPanel()
        registerGlobalHotkeys()
        observeHostLifecycle()
        startController()
        startChromeListener()
        openPanel()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication,
        hasVisibleWindows flag: Bool) -> Bool {
        openPanel()
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        for observer in lifecycleObservers {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
        }
        unregisterGlobalHotkeys()
        speech.cancel()
        if nativeActionActive, let activeRequestID {
            nativeWorker.requestLocalStop(activeRequestID)
        }
        chromeListener?.stop()
        controllerOutput?.fileHandleForReading.readabilityHandler = nil
        controllerInput?.fileHandleForWriting.closeFile()
    }

    private func makeCommandPanel() {
        let window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 540, height: 225),
                             styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "SystemOne"
        window.delegate = self
        window.isFloatingPanel = true
        window.level = .floating
        window.hidesOnDeactivate = false
        // A floating panel defaults to hiding from Mission Control. Keep the
        // compact command window selectable in macOS window overviews.
        window.collectionBehavior = [.managed, .participatesInCycle,
                                     .canJoinAllSpaces, .fullScreenAuxiliary]
        window.isOpaque = false
        window.backgroundColor = .clear
        window.center()
        let backdrop = NSVisualEffectView(frame: window.contentView?.bounds ?? .zero)
        backdrop.material = .popover
        backdrop.blendingMode = .behindWindow
        backdrop.state = .active
        backdrop.autoresizingMask = [.width, .height]
        window.contentView = backdrop
        let target = NSTextField(wrappingLabelWithString: "Open the panel from a target app.")
        target.textColor = .secondaryLabelColor
        commandTarget = target
        let field = NSTextField()
        field.placeholderString = "Fill Field with value · or Fill Field on https://… with value"
        field.setAccessibilityLabel("Task request")
        taskField = field
        let enableVoice = NSButton(title: "Enable Voice", target: self,
                                   action: #selector(enableVoice))
        let talk = HoldToTalkButton(title: "Hold Talk", target: nil, action: nil)
        talk.onPress = { [weak self] in
            guard let self, self.hostActionsAvailable else { return }
            self.speech.start()
        }
        talk.onRelease = { [weak self] in self?.speech.stop() }
        let run = NSButton(title: "Run request", target: self,
                           action: #selector(runTaskRequest))
        let stop = NSButton(title: "Stop", target: self, action: #selector(stop))
        let fields = NSButton(title: "Show fields", target: self,
                              action: #selector(showCapturedFields))
        let permissions = NSButton(title: "Accessibility…", target: self,
                                   action: #selector(openAccessibilityRecovery))
        permissions.isHidden = true
        accessibilityRecoveryButton = permissions
        let actions = NSStackView(views: [enableVoice, talk, fields, run, stop])
        actions.orientation = .horizontal
        actions.spacing = 8
        let status = NSTextField(wrappingLabelWithString:
            "Voice stays on this Mac. Review the final transcript before running.")
        status.textColor = .secondaryLabelColor
        status.setAccessibilityLabel("Task status")
        commandStatus = status
        let stack = NSStackView(views: [target, field, actions, permissions, status])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        backdrop.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: backdrop.leadingAnchor, constant: 18),
            stack.trailingAnchor.constraint(equalTo: backdrop.trailingAnchor, constant: -18),
            stack.centerYAnchor.constraint(equalTo: backdrop.centerYAnchor),
            target.widthAnchor.constraint(equalTo: stack.widthAnchor),
            field.widthAnchor.constraint(equalTo: stack.widthAnchor),
            status.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        speech.onText = { [weak self] text, isFinal in
            self?.taskField?.stringValue = text
            self?.finalSpeechText = isFinal ? text : nil
        }
        speech.onStatus = { [weak self] message in
            self?.commandStatus?.stringValue = message
        }
        commandPanel = window
    }

    func windowWillClose(_ notification: Notification) {
        if let closing = notification.object as? NSWindow, closing === commandPanel {
            speech.cancel()
        }
    }

    func applicationDidResignActive(_ notification: Notification) {
        speech.cancel()
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard activeRequestID != nil, controller?.isRunning == true else { return .terminateNow }
        quitPending = true
        stop()
        return .terminateLater
    }

    private func makePanel() {
        let window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 560, height: 850),
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

        let heading = NSTextField(labelWithString: "Managed browser — fill or navigate")
        heading.font = .boldSystemFont(ofSize: 16)
        let explanation = NSTextField(wrappingLabelWithString:
            "Choose an HTTPS page and an exact visible field or link label. Fill verifies the current field value; page scripts may transmit the text when it changes. Navigate requires the exact expected link URL and verifies arrival there. This opens a fresh Chromium profile. Use disposable text; do not enter credentials.")
        explanation.textColor = .secondaryLabelColor
        let url = NSTextField()
        url.placeholderString = "https://example.com/form"
        url.setAccessibilityLabel("Approved page URL")
        urlField = url
        let label = NSTextField()
        label.placeholderString = "Exact visible field or link label"
        label.setAccessibilityLabel("Field or link label")
        labelField = label
        let value = NSTextField()
        value.placeholderString = "Text to fill, or exact expected link URL"
        value.setAccessibilityLabel("Field value or expected link URL")
        valueField = value
        let status = NSTextField(wrappingLabelWithString: "Starting local controller…")
        status.textColor = .secondaryLabelColor
        status.setAccessibilityLabel("SystemOne status")
        statusField = status
        let shortcuts = NSTextField(wrappingLabelWithString: "Registering global shortcuts…")
        shortcuts.textColor = .secondaryLabelColor
        shortcutField = shortcuts
        let focus = NSTextField(wrappingLabelWithString: "No external app captured. Enter the target explicitly.")
        focus.textColor = .secondaryLabelColor
        focusField = focus
        let fill = NSButton(title: "Fill field", target: self, action: #selector(startFill))
        let navigate = NSButton(title: "Navigate link", target: self,
                                action: #selector(startManagedNavigate))
        let stopButton = NSButton(title: "Stop", target: self, action: #selector(stop))
        let hide = NSButton(title: "Hide", target: self, action: #selector(hidePanel))
        let actions = NSStackView(views: [fill, navigate, stopButton, hide])
        actions.orientation = .horizontal
        actions.spacing = 8
        let portal = NSButton(title: "Download fixture INV-105", target: self,
                              action: #selector(startPortalWorkflow))
        portal.setAccessibilityLabel("Run fixed multi-step invoice fixture")

        let nativeHeading = NSTextField(labelWithString: "Native app — inspect or fill one field")
        nativeHeading.font = .boldSystemFont(ofSize: 16)
        let nativeExplanation = NSTextField(wrappingLabelWithString:
            "Enter one running app's exact bundle ID. Accessibility labels and supported actions stay in this local panel; field values are not read.")
        nativeExplanation.textColor = .secondaryLabelColor
        let bundle = NSTextField()
        bundle.placeholderString = "App bundle ID, e.g. com.aurium.systemone.fixture"
        bundle.setAccessibilityLabel("Native app bundle ID")
        nativeBundleField = bundle
        let nativeLabel = NSTextField()
        nativeLabel.placeholderString = "Exact native field label"
        nativeLabel.setAccessibilityLabel("Native field label")
        nativeLabelField = nativeLabel
        let nativeValue = NSTextField()
        nativeValue.placeholderString = "Text to place in the native field"
        nativeValue.setAccessibilityLabel("Native field value")
        nativeValueField = nativeValue
        let access = NSButton(title: "Request Accessibility", target: self,
                              action: #selector(requestAccessibility))
        let inspect = NSButton(title: "Inspect app", target: self,
                               action: #selector(inspectNativeApp))
        let region = NSTextField()
        region.placeholderString = "Shown region #"
        region.setAccessibilityLabel("Number of displayed native region to inspect")
        region.widthAnchor.constraint(equalToConstant: 130).isActive = true
        nativeRegionField = region
        let drill = NSButton(title: "Inspect region", target: self,
                             action: #selector(inspectNativeRegion))
        let regionActions = NSStackView(views: [region, drill])
        regionActions.orientation = .horizontal
        regionActions.spacing = 8
        let nativeFill = NSButton(title: "Fill native field", target: self,
                                  action: #selector(startNativeFill))
        let fixtureDocuments = NSButton(title: "Documents",
            target: self, action: #selector(startFixtureDocuments))
        fixtureDocuments.setAccessibilityLabel("Navigate synthetic Fixture to Documents")
        let fixtureLocate = NSButton(title: "Locate Budget.xlsx",
            target: self, action: #selector(startFixtureLocate))
        fixtureLocate.setAccessibilityLabel("Select synthetic Documents/Budget.xlsx without opening")
        let fixtureOpen = NSButton(title: "Open Budget.xlsx",
            target: self, action: #selector(startFixtureOpen))
        fixtureOpen.setAccessibilityLabel("Open synthetic Documents/Budget.xlsx")
        let fixtureRecovery = NSButton(title: "Check recovery", target: self,
            action: #selector(checkNativeRecovery))
        let fixtureReplacement = NSButton(title: "Replace fixture goal…", target: self,
            action: #selector(replaceNativeFixture))
        let fieldReplacement = NSButton(title: "Replace field goal…", target: self,
            action: #selector(replaceNativeField))
        let fixtureRecoveryActions = NSStackView(views: [fixtureRecovery, fixtureReplacement, fieldReplacement])
        fixtureRecoveryActions.orientation = .horizontal
        fixtureRecoveryActions.spacing = 8
        let fixtureActions = NSStackView(views: [fixtureDocuments, fixtureLocate,
                                                 fixtureOpen])
        fixtureActions.orientation = .horizontal
        fixtureActions.spacing = 8
        let nativeActions = NSStackView(views: [access, inspect, nativeFill])
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
        scroll.heightAnchor.constraint(equalToConstant: 100).isActive = true
        let chromeHeading = NSTextField(labelWithString: "Existing Chrome — local fixture field")
        chromeHeading.font = .boldSystemFont(ofSize: 16)
        let chromeExplanation = NSTextField(wrappingLabelWithString:
            "Open the synthetic portal in your existing Chrome profile, click the SystemOne extension on that tab, then fill its Find invoice field. Use disposable text: page scripts may send it over the network. This verifies only the current DOM value.")
        chromeExplanation.textColor = .secondaryLabelColor
        let chromeLabel = NSTextField()
        chromeLabel.placeholderString = "Exact label: Find invoice"
        chromeLabel.stringValue = "Find invoice"
        chromeLabel.setAccessibilityLabel("Existing Chrome field label")
        chromeLabelField = chromeLabel
        let chromeValue = NSTextField()
        chromeValue.placeholderString = "Synthetic search text"
        chromeValue.setAccessibilityLabel("Existing Chrome field value")
        chromeValueField = chromeValue
        let chromeFill = NSButton(title: "Fill existing Chrome field", target: self,
                                  action: #selector(startChromeFill))
        let stack = NSStackView(views: [shortcuts, focus, heading, explanation,
                                        url, label, value, status, actions, portal, nativeHeading,
                                        nativeExplanation, bundle, nativeLabel,
                                        nativeValue, nativeActions, fixtureActions, fixtureRecoveryActions,
                                        regionActions, scroll,
                                        chromeHeading, chromeExplanation,
                                        chromeLabel, chromeValue, chromeFill])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 7
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
            shortcuts.widthAnchor.constraint(equalTo: stack.widthAnchor),
            focus.widthAnchor.constraint(equalTo: stack.widthAnchor),
            explanation.widthAnchor.constraint(equalTo: stack.widthAnchor),
            nativeExplanation.widthAnchor.constraint(equalTo: stack.widthAnchor),
            bundle.widthAnchor.constraint(equalTo: stack.widthAnchor),
            nativeLabel.widthAnchor.constraint(equalTo: stack.widthAnchor),
            nativeValue.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scroll.widthAnchor.constraint(equalTo: stack.widthAnchor),
            chromeExplanation.widthAnchor.constraint(equalTo: stack.widthAnchor),
            chromeLabel.widthAnchor.constraint(equalTo: stack.widthAnchor),
            chromeValue.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
        panel = window
        window.orderOut(nil)
    }

    // Documented workspace session notifications are separate from ordinary
    // app deactivation: switching to the target app must not cancel a task.
    // These notifications alone do not establish physical screen-lock coverage.
    private func observeHostLifecycle() {
        if let session = CGSessionCopyCurrentDictionary() as? [String: Any] {
            hostSessionActive = session["kCGSessionOnConsoleKey"] as? Bool == true
                && session["kCGSessionLoginDoneKey"] as? Bool == true
        } else { hostSessionActive = false }
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.willSleepNotification, NSWorkspace.didWakeNotification,
                     NSWorkspace.sessionDidResignActiveNotification,
                     NSWorkspace.sessionDidBecomeActiveNotification] {
            lifecycleObservers.append(center.addObserver(forName: name, object: nil,
                queue: .main) { [weak self] notification in
                let name = notification.name
                Task { @MainActor [weak self] in self?.hostLifecycleChanged(name) }
            })
        }
    }

    private func hostLifecycleChanged(_ name: Notification.Name) {
        switch name {
        case NSWorkspace.willSleepNotification: hostSleeping = true
        case NSWorkspace.didWakeNotification: hostSleeping = false
        case NSWorkspace.sessionDidResignActiveNotification: hostSessionActive = false
        case NSWorkspace.sessionDidBecomeActiveNotification: hostSessionActive = true
        default: return
        }
        hostInterruptionSettled = false
        if hostSleeping || !hostSessionActive {
            speech.cancel()
            finalSpeechText = nil
            dismissRecoverySheet()
            capturedApp = nil
            chromeConnectionID = nil; chromeGrantID = nil; chromeURL = nil
            if nativeActionActive, let activeRequestID { nativeWorker.requestLocalStop(activeRequestID) }
            inspectionEpoch += 1
            let epoch = inspectionEpoch
            Task { [weak self] in
                guard let self else { return }
                await self.nativeInspector.cancel()
                if self.inspectionEpoch == epoch { self.inspectionPending = false }
            }
            commandStatus?.stringValue = "Session interrupted. The active task will be stopped."
        }
        publishHostLifecycle()
    }

    private func publishHostLifecycle() {
        guard hostSequence < Int.max, let input = controllerInput else { return }
        hostSequence += 1
        hostInterruptionSettled = false
        _ = send(["type": "host_lifecycle", "requestId": UUID().uuidString.lowercased(),
                  "sequence": hostSequence, "sleeping": hostSleeping,
                  "sessionActive": hostSessionActive], through: input)
    }

    private func startController() {
        nativePermitKeyAccepted = false
        nativeWorker.invalidateHostPublicKey()
        let bundled = Bundle.main.object(forInfoDictionaryKey: "SystemOneBundledRuntime") as? Bool == true
        let node = bundled
            ? Bundle.main.bundleURL.appendingPathComponent("Contents/Frameworks/node").path
            : Bundle.main.object(forInfoDictionaryKey: "SystemOneNodeExecutable") as? String
        let script = bundled
            ? Bundle.main.resourceURL?.appendingPathComponent(
                "runtime/packages/runtime/src/native-managed-controller.ts").path
            : Bundle.main.object(forInfoDictionaryKey: "SystemOneControllerScript") as? String
        let browsers = Bundle.main.resourceURL?.appendingPathComponent("browsers").path
        let hasBundledBrowsers = browsers.map {
            FileManager.default.fileExists(atPath: $0)
        } ?? false
        guard let node, let script,
              FileManager.default.isExecutableFile(atPath: node),
              FileManager.default.fileExists(atPath: script),
              !bundled || hasBundledBrowsers else {
            statusField?.stringValue = "Development controller configuration is missing. Rebuild the app."
            return
        }
        let support = identityCheckSupport ?? FileManager.default.urls(
            for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("SystemOne-Dev", isDirectory: true)
        do {
            let requirement: RunningProcessRequirement?
            if bundled {
                guard let hash = Bundle.main.object(forInfoDictionaryKey:
                    "SystemOneControllerNodeCDHash") as? String else {
                    throw PeerIdentityError.missingTrustAnchor
                }
                requirement = try RunningProcessRequirement(
                    signingIdentifier: "com.aurium.systemone.bundlednode",
                    allowedCDHashes: [hash])
            } else {
                requirement = nil // External-source development build only.
            }
            try FileManager.default.createDirectory(at: support,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700])
            let process = Process()
            let input = Pipe()
            let output = Pipe()
            process.executableURL = URL(fileURLWithPath: node)
            process.arguments = [script, support.appendingPathComponent("attempts.sqlite").path]
            var environment = ProcessInfo.processInfo.environment
            environment["SYSTEMONE_HOST_LIFECYCLE_REQUIRED"] = "1"
            if bundled, let browsers { environment["PLAYWRIGHT_BROWSERS_PATH"] = browsers }
            process.environment = environment
            process.standardInput = input
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            try process.run()
            do {
                if let requirement {
                    guard process.isRunning else { throw PeerIdentityError.invalidRequirement }
                    _ = try authenticateRunningProcess(
                        pid: process.processIdentifier, requirement: requirement)
                    guard process.isRunning else { throw PeerIdentityError.invalidRequirement }
                }
            } catch {
                if process.isRunning { process.terminate() }
                throw error
            }
            controller = process
            controllerRequirement = requirement
            controllerInput = input
            controllerOutput = output
            output.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                Task { @MainActor [weak self] in self?.receiveOutput(data) }
            }
            process.terminationHandler = { [weak self] ended in
                let code = ended.terminationStatus
                Task { @MainActor [weak self] in self?.controllerExited(code) }
            }
            publishHostLifecycle()
        } catch {
            statusField?.stringValue = "Controller identity or launch failed. Rebuild and retry."
        }
    }

    private func controllerIdentityValid() -> Bool {
        guard let process = controller, process.isRunning else { return false }
        guard let requirement = controllerRequirement else { return true }
        do {
            _ = try authenticateRunningProcess(pid: process.processIdentifier,
                                               requirement: requirement)
            return process.isRunning
        } catch {
            if nativeActionActive, let activeRequestID {
                nativeWorker.requestLocalStop(activeRequestID)
            }
            nativeWorker.invalidateHostPublicKey()
            chromeListener?.stop()
            if process.isRunning { process.terminate() }
            statusField?.stringValue = "Controller identity changed; task outcome uncertain."
            return false
        }
    }

    private func startChromeListener() {
        // The development listener is opt-in. Release packaging must supply
        // signed, pinned app/host identities and a managed socket lifecycle.
        guard controllerIdentityValid(),
              let extensionID = Bundle.main.object(forInfoDictionaryKey:
                "SystemOneChromeExtensionId") as? String,
              extensionID.range(of: "^[a-p]{32}$", options: .regularExpression) != nil,
              let hostID = Bundle.main.object(forInfoDictionaryKey:
                "SystemOneChromeHostSigningIdentifier") as? String,
              let hashes = Bundle.main.object(forInfoDictionaryKey:
                "SystemOneChromeHostCDHashes") as? [String] else { return }
        let teamID = Bundle.main.object(forInfoDictionaryKey:
            "SystemOneChromeHostTeamIdentifier") as? String
        let support = FileManager.default.urls(for: .applicationSupportDirectory,
                                               in: .userDomainMask)[0]
            .appendingPathComponent("SystemOne-Dev", isDirectory: true)
        do {
            let requirement = try PeerRequirement(effectiveUserID: geteuid(),
                signingIdentifier: hostID, teamIdentifier: teamID,
                allowedCDHashes: Set(hashes))
            let listener = DevChromeListener(
                path: support.appendingPathComponent("controller.sock").path,
                requirement: requirement,
                onOpen: { [weak self] connectionID in
                    DispatchQueue.main.async { [weak self] in
                        self?.sendChromeControl(["type": "chrome_port_open",
                            "connectionId": connectionID, "extensionId": extensionID])
                    }
                },
                onMessage: { [weak self] connectionID, data in
                    DispatchQueue.main.async { [weak self] in
                        self?.sendChromeControl(["type": "chrome_port_message",
                            "connectionId": connectionID,
                            "base64": data.base64EncodedString()])
                    }
                },
                onClosed: { [weak self] connectionID in
                    DispatchQueue.main.async { [weak self] in
                        self?.sendChromeControl(["type": "chrome_port_closed",
                            "connectionId": connectionID])
                    }
                })
            try listener.start()
            chromeListener = listener
        } catch {
            statusField?.stringValue = "Existing Chrome listener unavailable: \(error)."
        }
    }

    private func sendChromeControl(_ object: [String: Any]) {
        guard let pipe = controllerInput, send(object, through: pipe,
            limit: 65_536) else {
            chromeListener?.stop()
            chromeListener = nil
            statusField?.stringValue = "Existing Chrome controller link unavailable."
            return
        }
    }

    private func receiveOutput(_ data: Data) {
        if data.isEmpty { return }
        guard controllerIdentityValid() else { return }
        outputBuffer.append(data)
        guard outputBuffer.count <= 131_072 else {
            statusField?.stringValue = "Controller protocol exceeded its limit. Stop and relaunch."
            controller?.terminate()
            return
        }
        while let newline = outputBuffer.firstIndex(of: 10) {
            let line = Data(outputBuffer[..<newline])
            outputBuffer.removeSubrange(...newline)
            guard line.count <= 65_536,
                  let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any]
            else {
                statusField?.stringValue = "Controller returned invalid data. Stop and relaunch."
                continue
            }
            if object["type"] as? String == "host_lifecycle_status" {
                guard Set(object.keys) == ["type", "sequence", "sessionAvailable", "interruptionSettled"],
                      let sequence = object["sequence"] as? Int, sequence == hostSequence,
                      let available = object["sessionAvailable"] as? Bool,
                      available == (!hostSleeping && hostSessionActive),
                      let settled = object["interruptionSettled"] as? Bool else { continue }
                hostAcknowledgedSequence = sequence
                hostInterruptionSettled = settled
                if hostActionsAvailable {
                    commandStatus?.stringValue = "Session available. Submit a new task explicitly."
                }
                continue
            }
            if object["type"] as? String == "native_worker_request" {
                guard nativePermitKeyAccepted else {
                    statusField?.stringValue = "Native permit key unavailable; outcome uncertain."
                    controller?.terminate()
                    return
                }
                nativeWorker.handle(line) { [weak self] reply in
                    Task { @MainActor [weak self] in
                        self?.sendRaw(reply)
                    }
                }
                continue
            }
            if object["type"] as? String == "native_permit_key" {
                guard !nativePermitKeyAccepted,
                      Set(object.keys) == ["type", "publicKey"],
                      let encoded = object["publicKey"] as? String,
                      let key = NativeHostPermit.publicKey(encoded) else {
                    statusField?.stringValue = "Invalid native permit key; outcome uncertain."
                    controller?.terminate()
                    return
                }
                nativePermitKeyAccepted = true
                nativeWorker.installHostPublicKey(key)
                continue
            }
            if object["type"] as? String == "chrome_port_send",
               let connectionID = object["connectionId"] as? String,
               let payload = object["payload"] as? [String: Any],
               let data = try? JSONSerialization.data(withJSONObject: payload),
               data.count <= 65_536 {
                chromeListener?.send(data, to: connectionID)
                continue
            }
            if object["type"] as? String == "chrome_port_close",
               let connectionID = object["connectionId"] as? String {
                chromeListener?.closeConnection(connectionID)
                continue
            }
            if object["type"] as? String == "chrome_observation",
               let connectionID = object["connectionId"] as? String,
               let grantID = object["grantId"] as? String,
               let title = object["title"] as? String,
               let url = object["url"] as? String,
               let elements = object["elements"] as? [[String: Any]] {
                guard hostActionsAvailable else { continue }
                let labels = elements.prefix(12).compactMap { item -> String? in
                    guard let role = item["role"] as? String,
                          let label = item["label"] as? String else { return nil }
                    return "\(role): \(label)"
                }
                chromeConnectionID = connectionID
                chromeGrantID = grantID
                chromeURL = url
                nativeOutput?.string = "Existing Chrome tab: \(title)\n\(url)\n"
                    + labels.joined(separator: "\n")
                statusField?.stringValue = "Existing Chrome tab observed. No action was sent."
                continue
            }
            if object["type"] as? String == "native_replacement_task" {
                if taskIntake.acceptReplacement(object) { dismissRecoverySheet() }
                continue
            }
            if object["type"] as? String == "native_recovery_prompt" {
                guard hostActionsAvailable else { continue }
                presentNativeRecovery(object)
                continue
            }
            guard
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
        if requestID == "startup" {
            statusField?.stringValue = phase == "host_unavailable"
                ? "Waiting for the active session and interruption fence."
                : phase == "ready"
                ? "Ready. Only the approved page origin can load."
                : "Earlier task unresolved. Inspect the private task record before starting again."
            return
        }
        if requestID == taskIntake.replacementRequestID {
            taskIntake.rejectReplacement(requestID: requestID)
            statusField?.stringValue = "Replacement rejected or blocked. Inspect the current task state."
            commandStatus?.stringValue = statusField?.stringValue ?? "Replacement blocked."
            return
        }
        guard requestID == activeRequestID || requestID == stopRequestID else { return }
        if requestID == activeRequestID {
            if ["native_paused", "paused_budget", "blocked_recovery"].contains(phase) {
                fixtureTaskPaused = true
            } else if ["ready", "stopped", "replacing_native_task", "observing_native_navigation",
                       "observing_native_locate", "observing_native_open"].contains(phase) {
                fixtureTaskPaused = false
            }
        }
        switch phase {
        case "host_unavailable":
            statusField?.stringValue = "Session interrupted. Waiting for Stop to settle; wake will not resume the task."
            if requestID == activeRequestID { stopRequestID = nil }
            taskIntake.releaseIfReady(requestID: requestID)
        case "starting": statusField?.stringValue = "Opening a fresh managed Chromium profile…"
        case "observing": statusField?.stringValue = activeSurface == .managedNavigation
            ? "Checking the exact visible link and destination…"
            : "Checking the exact visible field…"
        case "observing_native":
            statusField?.stringValue = "Checking the exact native app and field…"
        case "observing_native_navigation":
            statusField?.stringValue = "Checking the synthetic Fixture's Documents control and current window…"
        case "observing_native_locate":
            statusField?.stringValue = "Finding synthetic Documents/Budget.xlsx with fresh observations…"
        case "observing_native_open":
            statusField?.stringValue = "Checking synthetic Documents/Budget.xlsx before opening…"
        case "observing_chrome":
            statusField?.stringValue = "Rechecking the exact existing Chrome tab and field…"
        case "dispatching": statusField?.stringValue = activeSurface == .managedNavigation
            ? "Navigating; Stop may not undo a request already sent."
            : "Filling the field; Stop may not undo this edit."
        case "verified_dom_fill":
            statusField?.stringValue = "Verified: this page's field holds the supplied text. Inspect it, then press Stop to close this browser."
        case "verified_navigation":
            statusField?.stringValue = "Verified: the browser reached the exact expected URL. This does not prove a named item was opened. Inspect it, then press Stop."
        case "portal_located":
            statusField?.stringValue = "Fixture invoice INV-105 located by exact ID, title and account. Opening it…"
        case "portal_opened":
            statusField?.stringValue = "Exact fixture invoice detail verified. Downloading it…"
        case "portal_downloaded":
            statusField?.stringValue = "Fixture download verified. Saving to the private fixture output folder…"
        case "verified_portal_download":
            statusField?.stringValue = "Verified: INV-105 was found, opened, downloaded and saved in SystemOne-Dev/fixture-output."
        case "portal_paused":
            statusField?.stringValue = "Fixture workflow paused. Inspect the private task record before retrying."
        case "replacing_native_task":
            statusField?.stringValue = "Fencing the old fixture task before executing the replacement goal…"
        case "checking_native_recovery":
            statusField?.stringValue = "Checking the native fixture checkpoint…"
        case "native_paused":
            statusField?.stringValue = "Native task paused. Check recovery or Stop before starting another task."
        case "paused_budget":
            statusField?.stringValue = "Task paused at its action or time limit. An earlier action may have taken effect. Inspect the result before starting again."
        case "verified_native_fill":
            statusField?.stringValue = "Verified: the native field holds the supplied text."
        case "verified_native_navigation":
            statusField?.stringValue = "Verified: the Fixture window shows Documents. Budget.xlsx has not been selected or opened."
        case "verified_native_locate":
            statusField?.stringValue = "Verified: Documents/Budget.xlsx is selected in the Fixture and remains closed."
        case "verified_native_open":
            statusField?.stringValue = "Verified: the synthetic Fixture reports Documents/Budget.xlsx opened."
        case "verified_chrome_dom_fill":
            statusField?.stringValue = "Verified: the existing Chrome field currently holds the supplied text. No server save is claimed."
        case "already_matched":
            statusField?.stringValue = activeSurface == .nativeOpen
                ? "Verified: the synthetic file was already open; no press was sent."
                : activeSurface == .nativeLocate
                    ? "Verified: Documents/Budget.xlsx was already selected and closed; no press was sent."
                    : activeSurface == .nativeNavigation
                    ? "Verified: the Fixture was already showing Documents; no press was sent."
                    : "Verified: the field already held that text; no setter was sent."
        case "unsupported": statusField?.stringValue = activeSurface == .nativeOpen
            ? "The synthetic path or control was absent, ambiguous or changed. File opening was not verified."
            : activeSurface == .nativeLocate
                ? "The synthetic path or control was absent, ambiguous or changed. File selection was not verified."
                : activeSurface == .nativeNavigation
                ? "Documents control absent, ambiguous or outside observed coverage. No press sent."
                : "Field absent, ambiguous or outside observed coverage. No fill sent."
        case "uncertain":
            statusField?.stringValue = nativeActionActive
                ? "Native outcome uncertain. Inspect the target app before retrying."
                : "Outcome or browser fence uncertain. Inspect the page before retrying."
            if requestID == stopRequestID {
                stopRequestID = nil
                if quitPending { quitPending = false; NSApp.reply(toApplicationShouldTerminate: false) }
            }
        case "blocked_recovery": statusField?.stringValue = "Task paused or effect unresolved. For a native task, use Check recovery; otherwise inspect its state and Stop."
        case "stopping": statusField?.stringValue = nativeActionActive
            ? "Fencing the native worker; a dispatched edit may already have happened…"
            : "Stopping browser and fencing future actions…"
        case "stopped": statusField?.stringValue = "Stopped. An already-sent action may have taken effect."
        case "busy": statusField?.stringValue = "A task is already active."
        case "error": statusField?.stringValue = "The request was rejected or failed. No success is claimed."
        case "ready":
            if requestID == activeRequestID { stopRequestID = nil }
            taskIntake.releaseIfReady(requestID: requestID)
        default: statusField?.stringValue = "Unrecognized controller status."
        }
        if phase == "stopped" && requestID == stopRequestID {
            if let activeRequestID {
                taskIntake.releaseIfReady(requestID: activeRequestID)
            }
            stopRequestID = nil
            if quitPending { quitPending = false; NSApp.reply(toApplicationShouldTerminate: true) }
        }
        if phase != "ready", let message = statusField?.stringValue {
            commandStatus?.stringValue = message
        }
    }

    private func controllerExited(_ code: Int32) {
        dismissRecoverySheet()
        nativePermitKeyAccepted = false
        nativeWorker.invalidateHostPublicKey()
        chromeListener?.stop()
        chromeListener = nil
        if nativeActionActive, let activeRequestID {
            nativeWorker.requestLocalStop(activeRequestID)
        }
        controller = nil
        controllerRequirement = nil
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
        guard let commandPanel else { return }
        let frontmost = NSWorkspace.shared.frontmostApplication
        if let frontmost, frontmost.processIdentifier != ProcessInfo.processInfo.processIdentifier,
           !frontmost.isTerminated, let bundleID = frontmost.bundleIdentifier,
           let launchDate = frontmost.launchDate,
           bundleID.range(of: "^[A-Za-z0-9.-]{3,160}$",
                          options: .regularExpression) != nil {
            let name = frontmost.localizedName ?? frontmost.bundleIdentifier ?? "an unnamed app"
            capturedApp = (bundleID, frontmost.processIdentifier, launchDate)
            commandTarget?.stringValue = "Target: \(name) (\(bundleID))."
            focusField?.stringValue = "Previously focused: \(name) (PID \(frontmost.processIdentifier)). Select a target explicitly."
        } else {
            capturedApp = nil
            commandTarget?.stringValue = "No target app captured. Focus an app, then reopen this panel."
            focusField?.stringValue = "No external app captured. Enter the target explicitly."
        }
        NSApp.activate(ignoringOtherApps: true)
        commandPanel.makeKeyAndOrderFront(nil)
        commandPanel.makeFirstResponder(taskField)
    }

    @objc private func openDeveloperPanel() {
        guard let panel else { return }
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(urlField)
    }

    @objc private func enableVoice() {
        guard hostActionsAvailable else { return }
        speech.requestPermissions()
    }

    @objc private func showCapturedFields() {
        guard let capturedApp else {
            commandStatus?.stringValue =
                "Focus a target app, then reopen SystemOne before showing fields."
            return
        }
        guard hostActionsAvailable else { return }
        guard let app = NSRunningApplication.runningApplications(
                withBundleIdentifier: capturedApp.bundleID).first,
              app.processIdentifier == capturedApp.pid,
              app.launchDate == capturedApp.launchDate,
              let bundleURL = app.bundleURL else {
            self.capturedApp = nil
            commandStatus?.stringValue =
                "The target app changed. Focus it and reopen SystemOne."
            return
        }
        if !hasAccessibilityAccess() {
            showAccessibilityDenied()
            return
        }
        accessibilityRecoveryButton?.isHidden = true
        let target = AXTarget(pid: capturedApp.pid, bundleID: capturedApp.bundleID,
            bundleURL: bundleURL, launchDate: capturedApp.launchDate,
            scopeRef: "command-preview:\(UUID().uuidString)")
        commandStatus?.stringValue = "Reading editable field labels without their values…"
        Task { [weak self] in
            guard let self else { return }
            do {
                let preview = try await self.nativeInspector.editableLabels(target)
                let names = preview.labels.prefix(5).joined(separator: ", ")
                self.commandStatus?.stringValue = names.isEmpty
                    ? "No labeled editable field observed. No action sent."
                    : "Observed fields: \(names)"
                      + (preview.complete ? "" : " (coverage incomplete)")
            } catch {
                self.commandStatus?.stringValue = "Field observation unavailable: \(error)."
            }
        }
    }

    @objc private func runTaskRequest() {
        guard !speech.isCapturing else {
            commandStatus?.stringValue = "Wait for a final transcript before running a request."
            return
        }
        guard let input = controllerInput, controller?.isRunning == true,
              activeRequestID == nil, stopRequestID == nil,
              !inspectionPending else {
            commandStatus?.stringValue = "Controller unavailable or another task is active."
            return
        }
        let text = taskField?.stringValue ?? ""
        if let managed = ScopedManagedFill.parse(text) {
            let intent = DevTaskIntake.Intent.managedFill(url: managed.url,
                field: managed.fieldLabel, value: managed.value)
            guard taskIntake.submit(intent, originalText: text,
                voice: finalSpeechText == text,
                send: { [weak self] in self?.send($0, through: input) == true }) else {
                commandStatus?.stringValue = "Could not send browser request to the controller."
                return
            }
            commandStatus?.stringValue = "Opening an isolated Chromium page and checking the field…"
            return
        }
        if text.range(of: " on ", options: .caseInsensitive) != nil {
            commandStatus?.stringValue = "Use an exact HTTPS URL (or local 127.0.0.1) for a browser request. No action sent."
            return
        }
        guard let parsed = ScopedNativeFill.parse(text) else {
            commandStatus?.stringValue = "Supported: Fill <field> with <value>, or Fill <field> on <HTTPS URL> with <value>."
            return
        }
        guard let capturedApp,
              NSRunningApplication.runningApplications(withBundleIdentifier: capturedApp.bundleID)
                .filter({ !$0.isTerminated }).count == 1,
              let current = NSRunningApplication.runningApplications(
                withBundleIdentifier: capturedApp.bundleID).first,
              current.processIdentifier == capturedApp.pid,
              current.launchDate == capturedApp.launchDate else {
            commandStatus?.stringValue = "The captured app changed. Focus it and reopen the panel."
            return
        }
        guard hasAccessibilityAccess() else {
            showAccessibilityDenied()
            return
        }
        accessibilityRecoveryButton?.isHidden = true
        let target = DevTaskIntake.NativeTarget.captured(
            bundleID: capturedApp.bundleID, pid: Int(capturedApp.pid),
            launchMillis: Int64((capturedApp.launchDate.timeIntervalSince1970
                * 1_000).rounded()))
        let intent = DevTaskIntake.Intent.nativeFill(target: target,
            field: parsed.fieldLabel, value: parsed.value)
        guard taskIntake.submit(intent, originalText: text,
            voice: finalSpeechText == text,
            send: { [weak self] in self?.send($0, through: input) == true }) else {
            commandStatus?.stringValue = "Could not send request to the controller."
            return
        }
        commandStatus?.stringValue = "Observing the captured app and exact field…"
    }

    func handleGlobalHotkey(_ id: UInt32) {
        switch id {
        case openPanelHotkeyID: openPanel()
        case stopHotkeyID: stop()
        default: break
        }
    }

    private func showAccessibilityDenied() {
        accessibilityRecoveryButton?.isHidden = false
        commandStatus?.stringValue = "This running build is not authorized. Choose Accessibility… to locate the exact app and recheck its grant."
    }

    @objc private func openAccessibilityRecovery() {
        let identity = DevAccessibilityIdentity.current()
        let alert = NSAlert()
        alert.messageText = "Accessibility for this SystemOne build"
        alert.informativeText = identity.recoveryText(trusted: hasAccessibilityAccess())
        alert.addButton(withTitle: "Reveal This App")
        alert.addButton(withTitle: "Request Access")
        alert.addButton(withTitle: "Recheck")
        alert.addButton(withTitle: "Cancel")
        switch alert.runModal() {
        case .alertFirstButtonReturn:
            NSWorkspace.shared.activateFileViewerSelecting([identity.bundleURL])
        case .alertSecondButtonReturn:
            promptForAccessibility()
        case .alertThirdButtonReturn:
            recheckAccessibility()
        default: break
        }
    }

    private func recheckAccessibility() {
        if hasAccessibilityAccess() {
            accessibilityRecoveryButton?.isHidden = true
            commandStatus?.stringValue = "Accessibility is granted to this running build. Choose Show fields to observe the captured target."
        } else { showAccessibilityDenied() }
    }

    private func registerGlobalHotkeys() {
        var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                      eventKind: OSType(kEventHotKeyPressed))
        let handlerStatus = InstallEventHandler(GetApplicationEventTarget(),
            systemOneHotkeyHandler, 1, &eventType,
            Unmanaged.passUnretained(self).toOpaque(), &hotkeyHandler)
        guard handlerStatus == noErr else {
            shortcutField?.stringValue = "Global shortcuts unavailable (handler \(handlerStatus)); use the menu or Dock."
            return
        }
        let modifiers = UInt32(controlKey | optionKey)
        let openStatus = RegisterEventHotKey(UInt32(kVK_Space), modifiers,
            EventHotKeyID(signature: systemOneHotkeySignature, id: openPanelHotkeyID),
            GetApplicationEventTarget(), OptionBits(kEventHotKeyExclusive), &openHotkey)
        let stopStatus = RegisterEventHotKey(UInt32(kVK_Escape), modifiers,
            EventHotKeyID(signature: systemOneHotkeySignature, id: stopHotkeyID),
            GetApplicationEventTarget(), OptionBits(kEventHotKeyExclusive), &stopHotkey)
        if openStatus != noErr || stopStatus != noErr {
            unregisterGlobalHotkeys()
            shortcutField?.stringValue = "Global shortcuts unavailable (open \(openStatus), Stop \(stopStatus)); use the menu or Dock."
            return
        }
        shortcutField?.stringValue = "Control–Option–Space: open panel · Control–Option–Escape: Stop"
    }

    private func unregisterGlobalHotkeys() {
        if let openHotkey { UnregisterEventHotKey(openHotkey); self.openHotkey = nil }
        if let stopHotkey { UnregisterEventHotKey(stopHotkey); self.stopHotkey = nil }
        if let hotkeyHandler { RemoveEventHandler(hotkeyHandler); self.hotkeyHandler = nil }
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
        let intent = DevTaskIntake.Intent.managedFill(url: url, field: field, value: value)
        guard taskIntake.submit(intent,
            send: { [weak self] in self?.send($0, through: input) == true }) else {
            statusField?.stringValue = "Could not send the request to the controller."
            return
        }
        statusField?.stringValue = "Request sent to the local controller…"
    }

    @objc private func startManagedNavigate() {
        guard let input = controllerInput, controller?.isRunning == true,
              activeRequestID == nil, stopRequestID == nil,
              !inspectionPending else {
            statusField?.stringValue = "Controller unavailable or a task is active."
            return
        }
        let url = urlField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let label = labelField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let destination = valueField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard let start = URLComponents(string: url),
              let target = URLComponents(string: destination),
              start.user == nil, start.password == nil,
              target.user == nil, target.password == nil,
              start.scheme == "https" || (start.scheme == "http" && start.host == "127.0.0.1"),
              target.scheme == start.scheme, target.host == start.host,
              target.port == start.port, target.fragment == nil,
              !label.isEmpty, label.count <= 160,
              url.utf8.count <= 2_048, destination.utf8.count <= 2_048 else {
            statusField?.stringValue = "Use a page URL, exact link label and expected URL on the same approved origin."
            return
        }
        let intent = DevTaskIntake.Intent.managedNavigate(url: url,
            label: label, destination: destination)
        guard taskIntake.submit(intent,
            send: { [weak self] in self?.send($0, through: input) == true }) else {
            statusField?.stringValue = "Could not send navigation to the controller."
            return
        }
        statusField?.stringValue = "Navigation request sent to the local controller…"
    }

    @objc private func startPortalWorkflow() {
        guard let input = controllerInput, controller?.isRunning == true,
              activeRequestID == nil, stopRequestID == nil,
              !inspectionPending else {
            statusField?.stringValue = "Controller unavailable or a task is active."
            return
        }
        let url = urlField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard let parsed = URLComponents(string: url), parsed.scheme == "http",
              parsed.host == "127.0.0.1", parsed.port != nil,
              parsed.path == "/", parsed.query == nil,
              parsed.fragment == nil, parsed.user == nil, parsed.password == nil,
              url.utf8.count <= 200 else {
            statusField?.stringValue = "Enter the synthetic portal's exact http://127.0.0.1:<port>/ URL first."
            return
        }
        guard taskIntake.submit(.portal(url: url),
            send: { [weak self] in self?.send($0, through: input) == true }) else {
            statusField?.stringValue = "Could not send fixture workflow request."
            return
        }
        statusField?.stringValue = "Fixture workflow sent to the local controller…"
    }

    @objc private func startNativeFill() {
        guard let input = controllerInput, controller?.isRunning == true,
              activeRequestID == nil, stopRequestID == nil,
              !inspectionPending else {
            statusField?.stringValue = "Controller unavailable or a task is active."
            return
        }
        guard AXIsProcessTrustedWithOptions(nil) else {
            nativeOutput?.string = "Accessibility is not granted to this SystemOne Dev build."
            return
        }
        let bundleID = nativeBundleField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let field = nativeLabelField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let value = nativeValueField?.stringValue ?? ""
        guard bundleID != Bundle.main.bundleIdentifier,
              bundleID.range(of: "^[A-Za-z0-9.-]{3,160}$",
                             options: .regularExpression) != nil,
              !field.isEmpty, field.count <= 160,
              value.utf8.count <= 1_024 else {
            nativeOutput?.string = "Enter an exact app bundle ID and field label, with at most 1,024 value bytes."
            return
        }
        let intent = DevTaskIntake.Intent.nativeFill(
            target: .explicit(bundleID: bundleID), field: field, value: value)
        guard taskIntake.submit(intent,
            send: { [weak self] in self?.send($0, through: input) == true }) else {
            nativeOutput?.string = "Could not send native request to the controller."
            return
        }
        statusField?.stringValue = "Native request sent to the local controller…"
    }

    @objc private func startFixtureDocuments() {
        guard let input = controllerInput, controller?.isRunning == true,
              activeRequestID == nil, stopRequestID == nil,
              !inspectionPending else {
            statusField?.stringValue = "Controller unavailable or a task is active."
            return
        }
        guard AXIsProcessTrustedWithOptions(nil) else {
            statusField?.stringValue = "Accessibility is not granted to this SystemOne Dev build."
            return
        }
        guard taskIntake.submit(.fixtureDocuments,
            send: { [weak self] in self?.send($0, through: input) == true }) else {
            statusField?.stringValue = "Could not send fixture navigation request."
            return
        }
        statusField?.stringValue = "Fixture navigation sent to the local controller…"
    }

    @objc private func startFixtureLocate() {
        startFixtureFileWorkflow(open: false)
    }

    @objc private func startFixtureOpen() {
        startFixtureFileWorkflow(open: true)
    }

    private func startFixtureFileWorkflow(open: Bool) {
        guard let input = controllerInput, controller?.isRunning == true,
              activeRequestID == nil, stopRequestID == nil,
              !inspectionPending else {
            statusField?.stringValue = "Controller unavailable or a task is active."
            return
        }
        guard AXIsProcessTrustedWithOptions(nil) else {
            statusField?.stringValue = "Accessibility is not granted to this SystemOne Dev build."
            return
        }
        guard taskIntake.submit(.fixtureFile(open: open),
            send: { [weak self] in self?.send($0, through: input) == true }) else {
            statusField?.stringValue = "Could not send fixture file request."
            return
        }
        statusField?.stringValue = open
            ? "Synthetic file opening sent to the local controller…"
            : "Synthetic file selection sent to the local controller…"
    }

    @objc private func startChromeFill() {
        guard let input = controllerInput, controller?.isRunning == true,
              activeRequestID == nil, stopRequestID == nil,
              let connectionID = chromeConnectionID,
              let grantID = chromeGrantID, let url = chromeURL else {
            statusField?.stringValue = "Connect the extension to a synthetic portal tab first."
            return
        }
        let field = chromeLabelField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let value = chromeValueField?.stringValue ?? ""
        guard field == "Find invoice", value.utf8.count <= 1_024,
              let parsed = URLComponents(string: url), parsed.scheme == "http",
              parsed.host == "127.0.0.1" else {
            statusField?.stringValue = "Only the loopback fixture's Find invoice field is supported."
            return
        }
        let intent = DevTaskIntake.Intent.chromeFill(connectionID: connectionID,
            grantID: grantID, url: url, field: field, value: value)
        guard taskIntake.submit(intent,
            send: { [weak self] in self?.send($0, through: input) == true }) else {
            statusField?.stringValue = "Could not send the Chrome request."
            return
        }
        statusField?.stringValue = "Existing Chrome request sent to the local controller…"
    }

    @objc private func replaceNativeField() {
        guard hostActionsAvailable, activeSurface == .native, let target = activeRequestID,
              let window = panel, let input = controllerInput, fixtureTaskPaused,
              stopRequestID == nil, taskIntake.replacementRequestID == nil else { return }
        dismissRecoverySheet()
        let alert = NSAlert()
        alert.messageText = "Replace the paused field goal?"
        alert.informativeText = "Enter an exact field label and literal value for the original target app. The old task will be cancelled and stopped first. Earlier edits remain; the changed goal needs a fresh observation and verification."
        alert.addButton(withTitle: "Keep Paused")
        alert.addButton(withTitle: "Replace Goal")
        let field = NSTextField(string: "")
        field.placeholderString = "Exact field label"
        field.setAccessibilityLabel("Replacement field label")
        let value = NSTextField(string: "")
        value.placeholderString = "Literal value (may be empty)"
        value.setAccessibilityLabel("Replacement literal value")
        let fields = NSStackView(views: [field, value])
        fields.orientation = .vertical; fields.spacing = 8
        fields.frame = NSRect(x: 0, y: 0, width: 360, height: 64)
        field.widthAnchor.constraint(equalToConstant: 360).isActive = true
        value.widthAnchor.constraint(equalToConstant: 360).isActive = true
        alert.accessoryView = fields
        recoveryAlert = alert
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self, self.recoveryAlert === alert else { return }
            self.recoveryAlert = nil
            guard response == .alertSecondButtonReturn, self.activeRequestID == target,
                  self.hostActionsAvailable, self.stopRequestID == nil else { return }
            if !self.taskIntake.replaceField(field: field.stringValue, value: value.stringValue,
                send: { self.send($0, through: input) }) {
                self.commandStatus?.stringValue = "Replacement was unchanged, invalid or could not be delivered. Check the current task state."
            }
        }
    }

    @objc private func replaceNativeFixture() {
        guard let surface = activeSurface,
              [DevTaskIntake.Surface.nativeNavigation, .nativeLocate, .nativeOpen].contains(surface),
              let target = activeRequestID, let window = panel, let input = controllerInput,
              stopRequestID == nil, taskIntake.replacementRequestID == nil, fixtureTaskPaused else { return }
        dismissRecoverySheet()
        let choices: [(String, DevTaskIntake.Intent)] = [
            ("Navigate to Documents", .fixtureDocuments),
            ("Locate Budget.xlsx", .fixtureFile(open: false)),
            ("Open Budget.xlsx", .fixtureFile(open: true))].filter { $0.1.surface != surface }
        let alert = NSAlert()
        alert.messageText = "Replace the paused synthetic fixture goal?"
        alert.informativeText = "The old task will be cancelled and fenced first. Its earlier actions remain. The selected goal starts a fresh task with fresh limits."
        alert.addButton(withTitle: "Keep Paused")
        for choice in choices { alert.addButton(withTitle: choice.0) }
        recoveryAlert = alert
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self, self.recoveryAlert === alert else { return }
            self.recoveryAlert = nil
            let index = response.rawValue - NSApplication.ModalResponse.alertSecondButtonReturn.rawValue
            guard index >= 0, index < choices.count, self.activeRequestID == target,
                  self.stopRequestID == nil else { return }
            _ = self.taskIntake.replaceFixture(choices[index].1,
                send: { self.send($0, through: input) })
        }
    }

    @objc private func checkNativeRecovery() {
        guard let surface = activeSurface,
              [DevTaskIntake.Surface.native, .nativeNavigation, .nativeLocate, .nativeOpen].contains(surface),
              let target = activeRequestID, let input = controllerInput,
              stopRequestID == nil, recoveryAlert == nil, taskIntake.replacementRequestID == nil, fixtureTaskPaused else { return }
        let requestID = UUID().uuidString.lowercased()
        recoveryRequestID = requestID
        _ = send(["type": "prepare_native_recovery", "requestId": requestID,
                  "targetRequestId": target, "uiSessionRef": recoveryUISession], through: input)
    }

    private func dismissRecoverySheet() {
        recoveryRequestID = nil
        if let alert = recoveryAlert { panel?.endSheet(alert.window, returnCode: .abort) }
        recoveryAlert = nil
    }

    private func presentNativeRecovery(_ object: [String: Any]) {
        guard object["requestId"] as? String == recoveryRequestID,
              let target = activeRequestID, object["targetRequestId"] as? String == target,
              object["taskId"] as? String == target,
              object["uiSessionRef"] as? String == recoveryUISession,
              object["actorRef"] as? String == "native-dev-ui",
              object["state"] as? String == "paused",
              let epoch = object["taskEpoch"] as? Int, epoch == 1,
              let revision = object["goalRevision"] as? Int, revision == taskIntake.activeGoalRevision,
              let promptID = object["promptId"] as? String,
              let digest = object["presentationDigest"] as? String,
              let checkpoint = object["checkpointRef"] as? String,
              let checkpointDigest = object["checkpointDigest"] as? String,
              let observation = object["recoveryObservationId"] as? String,
              let presentation = object["presentation"] as? [String: Any],
              Set(presentation.keys) == ["title", "text", "resumeLabel", "cancelLabel"],
              let title = presentation["title"] as? String,
              let text = presentation["text"] as? String,
              presentation["resumeLabel"] as? String == "Resume",
              presentation["cancelLabel"] as? String == "Keep Paused",
              (try? CanonicalJSON.digest(presentation)) == digest,
              let window = panel, let input = controllerInput,
              stopRequestID == nil, recoveryAlert == nil else { return }
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = text
        alert.addButton(withTitle: "Resume")
        alert.addButton(withTitle: "Keep Paused")
        recoveryAlert = alert
        alert.beginSheetModal(for: window) { [weak self] response in
            guard let self, self.recoveryAlert === alert else { return }
            self.recoveryAlert = nil
            self.recoveryRequestID = nil
            guard self.activeRequestID == target, self.stopRequestID == nil else { return }
            var control: [String: Any] = ["requestId": UUID().uuidString.lowercased(),
                "targetRequestId": target, "uiSessionRef": self.recoveryUISession]
            if response == .alertFirstButtonReturn {
                control["type"] = "resume_native_task"
                control["intent"] = ["type": "resume_request", "protocolVersion": "2.0",
                    "messageId": UUID().uuidString.lowercased(), "taskId": target,
                    "taskEpoch": epoch, "goalRevision": revision, "issuer": "native_ui",
                    "actorRef": "native-dev-ui", "uiSessionRef": self.recoveryUISession,
                    "promptId": promptID, "presentationDigest": digest,
                    "checkpointRef": checkpoint, "checkpointDigest": checkpointDigest,
                    "recoveryObservationId": observation,
                    "createdAt": ISO8601DateFormatter().string(from: Date())]
            } else {
                control["type"] = "cancel_native_recovery"
                control["promptId"] = promptID
            }
            _ = self.send(control, through: input)
        }
        // A queued acknowledgment records the actual visible sheet, not merely
        // a descriptor received from the controller.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.recoveryAlert === alert, alert.window.isVisible,
                  self.activeRequestID == target, self.stopRequestID == nil else { return }
            _ = self.send(["type": "native_recovery_presented",
                "requestId": UUID().uuidString.lowercased(), "targetRequestId": target,
                "uiSessionRef": self.recoveryUISession, "promptId": promptID,
                "presentationDigest": digest], through: input)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 20) { [weak self] in
            guard let self, self.recoveryAlert === alert else { return }
            window.endSheet(alert.window, returnCode: .abort)
        }
    }

    @objc private func stop() {
        dismissRecoverySheet()
        speech.cancel()
        if inspectionPending {
            inspectionEpoch += 1
            let epoch = inspectionEpoch
            nativeOutput?.string = "Stopping native inspection…"
            Task { [weak self] in
                guard let self else { return }
                await self.nativeInspector.cancel()
                guard self.inspectionEpoch == epoch else { return }
                self.inspectionPending = false
                self.nativeOutput?.string = "Inspection stopped. No native action was sent."
            }
            return
        }
        guard let target = activeRequestID, let input = controllerInput else {
            statusField?.stringValue = "No active task to stop."
            return
        }
        guard stopRequestID == nil else { return }
        if nativeActionActive { nativeWorker.requestLocalStop(target) }
        let stopID = UUID().uuidString.lowercased()
        stopRequestID = stopID
        let request: [String: Any] = ["type": "stop",
            "requestId": stopID, "targetRequestId": target]
        if send(request, through: input) {
            statusField?.stringValue = nativeActionActive
                ? "Stop requested; waiting for the native worker fence…"
                : "Stop requested; waiting for the browser fence…"
        } else {
            stopRequestID = nil
            statusField?.stringValue = "Stop delivery failed. Task outcome is uncertain."
            if quitPending { quitPending = false; NSApp.reply(toApplicationShouldTerminate: false) }
        }
    }

    private func send(_ object: [String: Any], through pipe: Pipe,
                      limit: Int = 16_384) -> Bool {
        guard controllerIdentityValid() else { return false }
        if let type = object["type"] as? String,
           (type.hasPrefix("start_") || type == "replace_native_fixture"
            || type == "replace_native_field" || type == "prepare_native_recovery" || type == "native_recovery_presented"
            || type == "resume_native_task"), !hostActionsAvailable {
            commandStatus?.stringValue = "Waiting for the active session and interruption fence."
            return false
        }
        guard let data = try? JSONSerialization.data(withJSONObject: object),
              data.count <= limit else { return false }
        do {
            try pipe.fileHandleForWriting.write(contentsOf: data + Data([10]))
            return true
        } catch { return false }
    }

    private func sendRaw(_ data: Data) {
        guard data.count <= 16_384, let pipe = controllerInput,
              controllerIdentityValid() else { return }
        do { try pipe.fileHandleForWriting.write(contentsOf: data + Data([10])) }
        catch { statusField?.stringValue = "Native worker reply failed; task outcome uncertain." }
    }

    @objc private func requestAccessibility() {
        let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        nativeOutput?.string = AXIsProcessTrustedWithOptions(options)
            ? "Accessibility is granted to this SystemOne Dev build."
            : "Accessibility is not yet granted to this build. Grant it in macOS settings if prompted."
    }

    @objc private func inspectNativeApp() {
        guard hostActionsAvailable else { return }
        guard !inspectionPending, activeRequestID == nil else {
            nativeOutput?.string = "Another task is active. Stop it first."
            return
        }
        guard AXIsProcessTrustedWithOptions(nil) else {
            nativeOutput?.string = "Accessibility is not granted to this SystemOne Dev build."
            return
        }
        let bundleID = nativeBundleField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard bundleID != Bundle.main.bundleIdentifier,
              bundleID.range(of: "^[A-Za-z0-9.-]{3,160}$", options: .regularExpression) != nil else {
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
        let inspector = nativeInspector
        Task.detached(priority: .userInitiated) { [weak self] in
            let result: String
            do {
                result = try await inspector.inspect(target)
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

    @objc private func inspectNativeRegion() {
        guard hostActionsAvailable else { return }
        guard !inspectionPending, activeRequestID == nil else {
            nativeOutput?.string = "Another task is active. Stop it first."
            return
        }
        let bundleID = nativeBundleField?.stringValue.trimmingCharacters(
            in: .whitespacesAndNewlines) ?? ""
        guard bundleID != Bundle.main.bundleIdentifier,
              let indexText = nativeRegionField?.stringValue.trimmingCharacters(
                in: .whitespacesAndNewlines),
              let index = Int(indexText), index >= 0, index < 24 else {
            nativeOutput?.string = "Enter a displayed region number from 0 to 23."
            return
        }
        inspectionEpoch += 1
        let epoch = inspectionEpoch
        inspectionPending = true
        nativeOutput?.string = "Inspecting the numbered region off the UI thread…"
        let inspector = nativeInspector
        Task.detached(priority: .userInitiated) { [weak self] in
            let result: String
            do {
                result = try await inspector.drill(bundleID: bundleID,
                                                   displayedIndex: index)
            } catch {
                result = "Region inspection unavailable: \(error). No action was sent."
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
