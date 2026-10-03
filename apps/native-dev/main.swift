import AppKit
import ApplicationServices
import Carbon
import Darwin
import Foundation

private let systemOneHotkeySignature: OSType = 0x53314B59 // S1KY
private let openPanelHotkeyID: UInt32 = 1
private let stopHotkeyID: UInt32 = 2

/// Borderless glass bar that still accepts typing.
private final class GlassCommandPanel: NSPanel {
    /// Esc: stop the running task if there is one, otherwise hide the bar.
    var onCancel: (() -> Void)?
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }
    override func cancelOperation(_ sender: Any?) {
        if let onCancel { onCancel() } else { orderOut(nil) }
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
    let pressed = GetEventKind(eventRef) == UInt32(kEventHotKeyPressed)
    DispatchQueue.main.async { app.handleGlobalHotkey(actionID, pressed: pressed) }
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
    /// Per-task opt-in; on only when the launcher enabled Jev for this session. Fixture surface only.
    private var jevChoiceCheckbox: NSButton?
    /// Starts on only when the launcher (`npm start`) enabled Jev; Settings can
    /// turn it off or on for this session. The chip shows it while active.
    private var jevEnabled = ProcessInfo.processInfo.environment["SYSTEMONE_DECISION_PROVIDER"] == "jev"
    private var jevChip: NSTextField?
    private var settingsPopover: NSPopover?
    /// The one step proposal on screen; Return/"yes" allows exactly this one.
    private var pendingProposal: (requestID: String, proposalID: String)?
    /// A finished browse leaves its result page open until the next request.
    private var browseKeptOpen = false
    private var queuedRequestText: String?
    private var micButton: NSButton?
    private var runWhenTranscribed = false
    private var lastBrowserHint: String?
    /// The text of the request currently running; Return on it is a no-op.
    private var runningRequestText: String?
    /// The last app the user was in (never SystemOne), used as the agent's target.
    private var lastExternalApp: NSRunningApplication?
    /// The current transcript came from holding the hotkey; it runs on release.
    private var hotkeyDictation = false
    private var hotkeyPressedAt: Date?
    private var approvalRow: NSStackView?
    /// "Allow all" for one task, or the Settings switch for the whole session.
    /// Steps stay journaled, permitted one at a time and verified; Esc stops.
    private var autoAllowTaskID: String?
    /// On by default when the launcher enabled Jev: the user can sit back.
    /// Risky steps (send, buy, delete, passwords…) always ask regardless.
    private lazy var autoAllowSession = UserDefaults.standard.object(forKey: "autoAllowSteps") as? Bool ?? jevEnabled
    /// Owner-controlled, not a rule: ask before steps that look like send/buy/delete.
    private var askBeforeRisky = UserDefaults.standard.object(forKey: "askBeforeRisky") as? Bool ?? true
    private let voice = SpokenReplies()
    /// Listening briefly for a spoken yes/no after asking about a step.
    private var listeningForAnswer = false
    private let universalAX = UniversalAX()
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
        if CommandLine.arguments.contains("--check-host-lifecycle") {
            // Same startup order as a normal launch, against a throwaway journal.
            identityCheckSupport = FileManager.default.temporaryDirectory
                .appendingPathComponent("systemone-host-check-\(UUID().uuidString)", isDirectory: true)
            makeCommandPanel()
            observeHostLifecycle()
            startController()
            let deadline = Date().addingTimeInterval(8)
            while !hostActionsAvailable && controller?.isRunning == true && Date() < deadline {
                _ = RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.02))
            }
            print("hostActionsAvailable=\(hostActionsAvailable) sleeping=\(hostSleeping) sessionActive=\(hostSessionActive) sequence=\(hostSequence) acknowledged=\(hostAcknowledgedSequence) settled=\(hostInterruptionSettled) controllerRunning=\(controller?.isRunning == true) identity=\(controllerIdentityValid())")
            controllerInput?.fileHandleForWriting.closeFile()
            controller?.waitUntilExit()
            if let identityCheckSupport { try? FileManager.default.removeItem(at: identityCheckSupport) }
            exit(hostActionsAvailable ? 0 : 1)
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
        installMainMenu()
        voice.enabled = UserDefaults.standard.object(forKey: "speakReplies") as? Bool ?? true
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

    /// Standard app and Edit menus: Quit/Hide work like any Mac app, and
    /// Copy/Paste/Select All work in the bar's text field.
    private func installMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu(title: "SystemOne Dev")
        appMenu.addItem(withTitle: "About SystemOne Dev", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        let settings = NSMenuItem(title: "Open Command Panel", action: #selector(openPanel), keyEquivalent: ",")
        settings.target = self
        appMenu.addItem(settings)
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide SystemOne Dev", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let others = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        others.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "Show All", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit SystemOne Dev", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)
        NSApp.mainMenu = main
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
        let window = GlassCommandPanel(contentRect: NSRect(x: 0, y: 0, width: 680, height: 168),
                                       styleMask: [.borderless, .fullSizeContentView],
                                       backing: .buffered, defer: false)
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
        window.hasShadow = true
        window.isMovableByWindowBackground = true
        window.onCancel = { [weak self, weak window] in
            guard let self else { return }
            if self.pendingProposal != nil || (self.activeRequestID != nil && self.activeSurface == .browse) {
                self.stop()
            } else { window?.orderOut(nil) }
        }
        window.center()
        let content = NSView()
        let surface: NSView
        if #available(macOS 26.0, *) {
            let glass = NSGlassEffectView()
            glass.cornerRadius = 26
            glass.contentView = content
            surface = glass
        } else {
            let blur = NSVisualEffectView()
            blur.material = .hudWindow
            blur.blendingMode = .behindWindow
            blur.state = .active
            blur.wantsLayer = true
            blur.layer?.cornerRadius = 26
            blur.layer?.masksToBounds = true
            content.translatesAutoresizingMaskIntoConstraints = false
            blur.addSubview(content)
            NSLayoutConstraint.activate([
                content.leadingAnchor.constraint(equalTo: blur.leadingAnchor),
                content.trailingAnchor.constraint(equalTo: blur.trailingAnchor),
                content.topAnchor.constraint(equalTo: blur.topAnchor),
                content.bottomAnchor.constraint(equalTo: blur.bottomAnchor),
            ])
            surface = blur
        }
        window.contentView = surface

        func symbolButton(_ name: String, _ label: String, size: CGFloat = 22) -> NSButton {
            let button = NSButton()
            button.isBordered = false
            button.image = NSImage(systemSymbolName: name, accessibilityDescription: label)?
                .withSymbolConfiguration(.init(pointSize: size, weight: .regular))
            button.contentTintColor = .labelColor
            button.setAccessibilityLabel(label)
            button.toolTip = label
            return button
        }
        let talk = NSButton()
        talk.isBordered = false
        talk.image = NSImage(systemSymbolName: "mic.fill", accessibilityDescription: "Talk")?
            .withSymbolConfiguration(.init(pointSize: 22, weight: .medium))
        talk.contentTintColor = .controlAccentColor
        talk.setAccessibilityLabel("Talk: click to start, click again to finish")
        talk.toolTip = "Click to talk, click again when done (speech stays on this Mac)"
        talk.target = self
        talk.action = #selector(toggleTalk)
        micButton = talk
        let field = NSTextField()
        field.isBordered = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.font = .systemFont(ofSize: 19)
        field.placeholderString = "Tell SystemOne what to do…"
        field.setAccessibilityLabel("Task request")
        field.target = self
        field.action = #selector(runTaskRequest)
        field.cell?.sendsActionOnEndEditing = false
        taskField = field
        let chip = NSTextField(labelWithString: " Jev ")
        chip.font = .systemFont(ofSize: 11, weight: .semibold)
        chip.textColor = .secondaryLabelColor
        chip.wantsLayer = true
        chip.layer?.cornerRadius = 6
        chip.layer?.backgroundColor = NSColor.secondaryLabelColor.withAlphaComponent(0.15).cgColor
        chip.isHidden = !jevEnabled
        jevChip = chip
        chip.toolTip = "Jev (TypeSafe) chooses steps; this sends the task and visible control labels to TypeSafe."
        let more = symbolButton("gearshape", "Settings", size: 18)
        more.target = self
        more.action = #selector(showSettings(_:))
        let run = symbolButton("arrow.up.circle.fill", "Run request", size: 26)
        run.contentTintColor = .controlAccentColor
        run.target = self
        run.action = #selector(runTaskRequest)
        let stopButton = symbolButton("stop.circle", "Stop", size: 22)
        stopButton.target = self
        stopButton.action = #selector(stop)
        let bar = NSStackView(views: [talk, field, chip, more, run, stopButton])
        bar.orientation = .horizontal
        bar.alignment = .centerY
        bar.spacing = 12
        field.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let status = NSTextField(wrappingLabelWithString:
            "Hold the mic to speak, or type. Voice stays on this Mac.")
        status.font = .systemFont(ofSize: 12)
        status.textColor = .secondaryLabelColor
        status.maximumNumberOfLines = 2
        status.setAccessibilityLabel("Task status")
        commandStatus = status
        let target = NSTextField(labelWithString: "Open the panel from a target app.")
        target.font = .systemFont(ofSize: 11)
        target.textColor = .tertiaryLabelColor
        target.lineBreakMode = .byTruncatingTail
        commandTarget = target
        let permissions = NSButton(title: "Fix Accessibility…", target: self,
                                   action: #selector(openAccessibilityRecovery))
        permissions.bezelStyle = .inline
        permissions.isHidden = true
        accessibilityRecoveryButton = permissions
        let footer = NSStackView(views: [status, permissions])
        footer.orientation = .horizontal
        footer.alignment = .firstBaseline
        footer.spacing = 8
        func pill(_ title: String, _ action: Selector, prominent: Bool = false) -> NSButton {
            let button = NSButton(title: title, target: self, action: action)
            button.bezelStyle = .push
            button.controlSize = .regular
            if prominent { button.keyEquivalent = "\r"; button.bezelColor = .controlAccentColor }
            return button
        }
        let allowAll = pill("Allow all for this task", #selector(allowAllSteps))
        let stopStep = pill("Stop", #selector(stop))
        stopStep.keyEquivalent = "\u{1b}"
        let approvals = NSStackView(views: [pill("Allow", #selector(allowStep), prominent: true), allowAll, stopStep])
        approvals.orientation = .horizontal
        approvals.spacing = 8
        approvals.isHidden = true
        approvalRow = approvals
        let stack = NSStackView(views: [bar, footer, approvals, target])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 22),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -18),
            stack.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            bar.widthAnchor.constraint(equalTo: stack.widthAnchor),
            footer.widthAnchor.constraint(lessThanOrEqualTo: stack.widthAnchor),
            target.widthAnchor.constraint(lessThanOrEqualTo: stack.widthAnchor),
        ])
        speech.onText = { [weak self] text, isFinal in
            guard let self else { return }
            let answering = self.listeningForAnswer
            if isFinal { self.listeningForAnswer = false }
            if isFinal, let pending = self.pendingProposal {
                let reply = text.lowercased()
                if reply.range(of: #"^(yes|yeah|yep|allow|go ahead|ok|okay|do it|sure)\b"#, options: .regularExpression) != nil {
                    self.confirmProposal(pending, allow: true); return
                } else if reply.range(of: #"^(no|stop|cancel|don't|do not)\b"#, options: .regularExpression) != nil {
                    self.stop(); return
                }
                // Anything else said in the short answer window is noise; said with the
                // hotkey it is a new request, which replaces the waiting task below.
                if answering && !self.hotkeyDictation { return }
            }
            self.taskField?.stringValue = text
            self.finalSpeechText = isFinal ? text : nil
            // A browse request is safe to start straight from speech: nothing
            // acts before the user confirms the first proposed step.
            let fromHotkey = isFinal && (self.hotkeyDictation || self.runWhenTranscribed)
            if isFinal { self.hotkeyDictation = false; self.runWhenTranscribed = false }
            if isFinal, fromHotkey || self.jevEnabled {
                DispatchQueue.main.async { [weak self] in self?.runTaskRequest() }
            }
        }
        speech.onStatus = { [weak self] message in
            self?.commandStatus?.stringValue = message
        }
        speech.onCaptureChange = { [weak self] capturing in
            self?.updateMic()
            if !capturing { DispatchQueue.main.async { [weak self] in self?.hotkeyDictation = false } }
        }
        commandPanel = window
    }

    @objc private func showSettings(_ sender: NSButton) {
        if let settingsPopover, settingsPopover.isShown { settingsPopover.close(); return }
        func caption(_ text: String) -> NSTextField {
            let label = NSTextField(wrappingLabelWithString: text)
            label.font = .systemFont(ofSize: 11)
            label.textColor = .secondaryLabelColor
            label.preferredMaxLayoutWidth = 300
            return label
        }
        func row(_ title: String, _ button: NSButton?) -> NSStackView {
            let label = NSTextField(labelWithString: title)
            label.font = .systemFont(ofSize: 13)
            let views: [NSView] = button.map { [label, $0] } ?? [label]
            let stack = NSStackView(views: views)
            stack.orientation = .horizontal
            stack.spacing = 8
            return stack
        }
        func link(_ title: String, _ action: Selector) -> NSButton {
            let button = NSButton(title: title, target: self, action: action)
            button.bezelStyle = .inline
            return button
        }
        let heading = NSTextField(labelWithString: "Settings")
        heading.font = .boldSystemFont(ofSize: 14)
        let jevSwitch = NSSwitch()
        jevSwitch.state = jevEnabled ? .on : .off
        jevSwitch.target = self
        jevSwitch.action = #selector(toggleJev(_:))
        let jevRow = row("Let Jev choose each step", nil)
        jevRow.insertArrangedSubview(jevSwitch, at: 0)
        let jevNote = caption("Sends your request and the visible control labels to TypeSafe (jev-1.13.0). Off keeps everything on this Mac.")
        let autoSwitch = NSSwitch()
        autoSwitch.state = autoAllowSession ? .on : .off
        autoSwitch.target = self
        autoSwitch.action = #selector(toggleAutoAllow(_:))
        let autoRow = row("Auto-allow steps", nil)
        autoRow.insertArrangedSubview(autoSwitch, at: 0)
        let autoNote = caption("Jev acts without asking each time. Every step is still checked, and Esc or Control-Option-Escape stops.")
        let riskySwitch = NSSwitch()
        riskySwitch.state = askBeforeRisky ? .on : .off
        riskySwitch.target = self
        riskySwitch.action = #selector(toggleAskBeforeRisky(_:))
        let riskyRow = row("Ask before send / buy / delete", nil)
        riskyRow.insertArrangedSubview(riskySwitch, at: 0)
        let voiceRow = row("Voice: " + (speech.isAuthorized ? "ready (on this Mac)" : "not enabled"),
                           speech.isAuthorized ? nil : link("Enable", #selector(enableVoice)))
        let axGranted = hasAccessibilityAccess()
        let axRow = row("Accessibility: " + (axGranted ? "granted to this build" : "not granted to this build"),
                        link(axGranted ? "Details" : "Fix…", #selector(openAccessibilityRecovery)))
        let advanced = NSTextField(labelWithString: "Advanced")
        advanced.font = .boldSystemFont(ofSize: 12)
        advanced.textColor = .secondaryLabelColor
        let tools = NSStackView(views: [link("Show fields", #selector(showCapturedFields)),
                                        link("Developer tools", #selector(openDeveloperPanel))])
        tools.orientation = .horizontal
        tools.spacing = 6
        let speakSwitch = NSSwitch()
        speakSwitch.state = voice.enabled ? .on : .off
        speakSwitch.target = self
        speakSwitch.action = #selector(toggleSpeakReplies(_:))
        let speakRow = row("Speak replies", nil)
        speakRow.insertArrangedSubview(speakSwitch, at: 0)
        let stack = NSStackView(views: [heading, jevRow, jevNote, autoRow, autoNote, riskyRow, speakRow, voiceRow, axRow,
                                        advanced, tools])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.edgeInsets = NSEdgeInsets(top: 14, left: 16, bottom: 14, right: 16)
        let controller = NSViewController()
        controller.view = stack
        let popover = NSPopover()
        popover.behavior = .transient
        popover.contentViewController = controller
        settingsPopover = popover
        popover.show(relativeTo: sender.bounds, of: sender, preferredEdge: .maxY)
    }

    @objc private func toggleAskBeforeRisky(_ sender: NSSwitch) {
        askBeforeRisky = sender.state == .on
        UserDefaults.standard.set(askBeforeRisky, forKey: "askBeforeRisky")
    }

    @objc private func toggleAutoAllow(_ sender: NSSwitch) {
        autoAllowSession = sender.state == .on
        UserDefaults.standard.set(autoAllowSession, forKey: "autoAllowSteps")
    }

    @objc private func toggleSpeakReplies(_ sender: NSSwitch) {
        voice.enabled = sender.state == .on
        if !voice.enabled { voice.stop() }
        UserDefaults.standard.set(voice.enabled, forKey: "speakReplies")
    }

    /// Says `question`, then listens about five seconds for "yes" or "no".
    private func askAloud(_ question: String) {
        voice.say(question) { [weak self] in
            guard let self, self.pendingProposal != nil, self.speech.isAuthorized, !self.speech.isCapturing,
                  self.hostActionsAvailable else { return }
            self.listeningForAnswer = true
            self.speech.start()
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
                guard let self, self.listeningForAnswer else { return }
                self.listeningForAnswer = false
                if self.speech.isCapturing { self.speech.stop() }
            }
        }
    }

    @objc private func toggleJev(_ sender: NSSwitch) {
        setJevEnabled(sender.state == .on)
    }

    @objc private func toggleJevCheckbox(_ sender: NSButton) {
        setJevEnabled(sender.state == .on)
    }

    private func setJevEnabled(_ enabled: Bool) {
        jevEnabled = enabled
        jevChip?.isHidden = !enabled
        jevChoiceCheckbox?.state = enabled ? .on : .off
        commandStatus?.stringValue = enabled
            ? "Jev chooses steps; your request and visible control labels go to TypeSafe."
            : "Jev off. Requests stay on this Mac."
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
        // Quit must never hang on a stuck or already-settled task. After the
        // fence window, exit anyway; the controller sees its pipe close, and an
        // effect without a verified outcome stays journaled as unresolved.
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            guard let self, self.quitPending else { return }
            self.quitPending = false
            NSApp.reply(toApplicationShouldTerminate: true)
        }
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
        let jevChoice = NSButton(checkboxWithTitle:
            "Let Jev choose each fixture step (sends this synthetic window's title and button labels to TypeSafe)",
            target: nil, action: nil)
        jevChoice.state = jevEnabled ? .on : .off
        jevChoice.target = self
        jevChoice.action = #selector(toggleJevCheckbox(_:))
        jevChoice.setAccessibilityLabel("Let the Jev model choose fixture steps; sends fixture text to TypeSafe")
        jevChoiceCheckbox = jevChoice
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
                                        nativeValue, nativeActions, fixtureActions, jevChoice, fixtureRecoveryActions,
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
        let me = ProcessInfo.processInfo.processIdentifier
        lifecycleObservers.append(NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  app.processIdentifier != me else { return }
            Task { @MainActor [weak self] in self?.lastExternalApp = app }
        })
        if let session = CGSessionCopyCurrentDictionary() as? [String: Any] {
            // SDK constants, not literals: the console key's value is
            // "kCGSSessionOnConsoleKey", so a typed name silently never matched.
            hostSessionActive = session[kCGSessionOnConsoleKey as String] as? Bool == true
                && session[kCGSessionLoginDoneKey as String] as? Bool == true
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
            if object["type"] as? String == "agent_ax_request" {
                handleAgentRequest(object)
                continue
            }
            if object["type"] as? String == "browse_proposal" {
                guard let requestID = object["requestId"] as? String, requestID == activeRequestID,
                      let proposalID = object["proposalId"] as? String, let kind = object["kind"] as? String,
                      let label = object["label"] as? String else { continue }
                pendingProposal = (requestID, proposalID)
                let step = object["step"] as? Int ?? 0
                let host = (object["destinationUrl"] as? String).flatMap { URL(string: $0)?.host } ?? ""
                var action: String
                switch kind {
                case "fill": action = "type your words into “\(label)”"
                case "submit": action = "press “\(label)”"
                case "click", "press": action = "click “\(label)”"
                case "type": action = "type your words into “\(label)”"
                case "key", "scroll": action = label.split(separator: "(").first.map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? label
                case "open_url": action = "open \(label)"
                case "open_app": action = "open \(label)"
                case "navigate": action = "open “\(label)”" + (host.isEmpty ? "" : " (\(host))")
                default: action = "finish here; the goal looks done on “\(label)”"
                }
                let risky = object["risky"] as? Bool ?? false
                let appName = (object["app"] as? String).flatMap { $0.isEmpty || $0 == "no app" ? nil : $0 }
                if let appName, kind != "open_url", kind != "open_app" { action += " in \(appName)" }
                if !(risky && askBeforeRisky), autoAllowSession || autoAllowTaskID == requestID {
                    commandStatus?.stringValue = "Step \(step): Jev will \(action) (auto-allowed; Esc stops)."
                    confirmProposal((requestID, proposalID), allow: true)
                    continue
                }
                commandStatus?.stringValue = risky
                    ? "Step \(step): Jev wants to \(action). This could send, buy or delete something; Allow?"
                    : "Step \(step): Jev wants to \(action). Allow, or say “yes”."
                approvalRow?.isHidden = false
                commandPanel?.orderFrontRegardless()
                askAloud(risky ? "Should I \(action)? Say yes or no." : "Shall I \(action)?")
                continue
            }
            if object["type"] as? String == "decision" {
                guard let requestID = object["requestId"] as? String, requestID == activeRequestID,
                      let status = object["status"] as? String else { continue }
                let probability = (object["probability"] as? Double).map { String(format: "%.0f%%", $0 * 100) } ?? "n/a"
                let label = object["label"] as? String ?? ""
                let text: String
                switch status {
                case "selected": text = activeSurface == .browse ? "Jev picked “\(label)” (\(probability))."
                    : "Jev chose “\(label)” (\(probability)). Pressing, then verifying…"
                case "finish": text = "Jev thinks the goal is done (\(probability))."
                case "wait": text = "Jev chose to wait (\(probability)). Nothing was pressed."
                case "request_help": text = "Jev asked for help (\(probability)). Nothing was pressed."
                default: text = "Jev was not confident or unavailable (\(probability)). Nothing was pressed."
                }
                statusField?.stringValue = text
                commandStatus?.stringValue = text
                nativeOutput?.string = (nativeOutput?.string ?? "") + "\n" + text
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
            pendingProposal = nil
            approvalRow?.isHidden = true
            statusField?.stringValue = activeSurface == .agent || activeSurface == .browse
                ? "Paused: Jev was going in circles. Say it again, or break it into smaller steps."
                : "Task paused at its action or time limit. An earlier action may have taken effect. Inspect the result before starting again."
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
                if quitPending { quitPending = false; NSApp.reply(toApplicationShouldTerminate: true) } // the user asked to quit; any uncertainty stays journaled
            }
        case "blocked_recovery": statusField?.stringValue = "Task paused or effect unresolved. For a native task, use Check recovery; otherwise inspect its state and Stop."
        case "stopping": statusField?.stringValue = nativeActionActive
            ? "Fencing the native worker; a dispatched edit may already have happened…"
            : "Stopping browser and fencing future actions…"
        case "stopped": statusField?.stringValue = "Stopped. An already-sent action may have taken effect."
        case "busy": statusField?.stringValue = "A task is already active."
        case "error": statusField?.stringValue = "The request was rejected or failed. No success is claimed."
        case "browsing":
            statusField?.stringValue = "Jev is reading the page…"
        case "agent_working":
            statusField?.stringValue = "Jev is looking at the screen…"
        case "agent_done":
            pendingProposal = nil
            approvalRow?.isHidden = true
            statusField?.stringValue = "Done."
            voice.say("Done.")
        case "agent_needs_text":
            pendingProposal = nil
            approvalRow?.isHidden = true
            voice.say("What should it say?")
            statusField?.stringValue = "What should it say? Ask again with the words, e.g. “reply saying I'll be there at six”."
        case "agent_paused":
            pendingProposal = nil
            approvalRow?.isHidden = true
            voice.say("I'm not sure what to do next. Try saying it another way.")
            statusField?.stringValue = "Paused: Jev wasn't sure what to do next, or a step was declined. Try rephrasing."
        case "verified_browse":
            browseKeptOpen = true
            pendingProposal = nil
            approvalRow?.isHidden = true
            statusField?.stringValue = "Done. The result stays open; say or type a new request, or ■ closes it."
        case "browse_paused":
            pendingProposal = nil
            approvalRow?.isHidden = true
            statusField?.stringValue = "Paused: Jev wasn't confident, or a step was declined. Nothing else will run."
        case "ready":
            if requestID == activeRequestID { stopRequestID = nil }
            taskIntake.releaseIfReady(requestID: requestID)
            if activeRequestID == nil { runningRequestText = nil }
            pendingProposal = nil
            approvalRow?.isHidden = true
            if autoAllowTaskID == requestID { autoAllowTaskID = nil }
            browseKeptOpen = false
            if activeRequestID == nil, let queued = queuedRequestText {
                queuedRequestText = nil
                taskField?.stringValue = queued
                DispatchQueue.main.async { [weak self] in self?.runTaskRequest() }
            }
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
        if quitPending { quitPending = false; NSApp.reply(toApplicationShouldTerminate: true) } // the user asked to quit; any uncertainty stays journaled
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
        } else if let last = lastExternalApp, !last.isTerminated, let bundleID = last.bundleIdentifier,
                  let launchDate = last.launchDate {
            // Opened while SystemOne was in front: act on the app the user was just in.
            capturedApp = (bundleID, last.processIdentifier, launchDate)
            commandTarget?.stringValue = "Target: \(last.localizedName ?? bundleID)."
        } else {
            capturedApp = nil
            commandTarget?.stringValue = "No app in front yet. Ask to open a site or app, or switch to one first."
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

    /// Click to start listening, click again to finish. The first click asks
    /// for microphone and speech permission instead of failing silently.
    @objc private func toggleTalk() {
        if speech.isCapturing {
            speech.stop()
        } else if !speech.isAuthorized {
            commandStatus?.stringValue = "Allow Microphone and Speech Recognition for SystemOne, then click the mic again."
            speech.requestPermissions()
        } else if !hostActionsAvailable {
            commandStatus?.stringValue = "SystemOne is waiting for this Mac session to be active. Try again in a moment."
        } else {
            speech.start()
        }
        updateMic()
    }

    private func updateMic() {
        micButton?.contentTintColor = speech.isCapturing ? .systemRed : .controlAccentColor
        micButton?.image = NSImage(systemSymbolName: speech.isCapturing ? "waveform.circle.fill" : "mic.fill",
            accessibilityDescription: "Talk")?.withSymbolConfiguration(.init(pointSize: 22, weight: .medium))
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
        // Return approves a waiting step only when nothing new was typed or said.
        // A new request never approves the old one's step; it replaces that task.
        if let pending = pendingProposal {
            let typed = (taskField?.stringValue ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if typed.isEmpty || typed == runningRequestText {
                confirmProposal(pending, allow: true)
                return
            }
        }
        if activeRequestID != nil, (taskField?.stringValue ?? "") == runningRequestText {
            commandStatus?.stringValue = "Already working on that. Say or type something new to replace it, or press ■ to stop."
            return
        }
        if activeRequestID != nil, stopRequestID == nil, !browseKeptOpen {
            // A new request replaces whatever is running or waiting.
            queuedRequestText = taskField?.stringValue
            commandStatus?.stringValue = "Stopping the previous task, then starting this one…"
            stop()
            return
        }
        if browseKeptOpen, activeRequestID != nil, stopRequestID == nil {
            let raw = taskField?.stringValue ?? ""
            let spoken = finalSpeechText != nil && finalSpeechText == raw
            let text = spoken ? ScopedBrowse.normalizedSpeech(raw) : raw
            if ScopedBrowse.parse(text) != nil || text.isEmpty {
                // A different site: close the finished browser, then start fresh.
                queuedRequestText = raw
                commandStatus?.stringValue = "Closing the previous browser window…"
                stop()
                return
            }
            // A follow-up on the same page continues in the same window.
            guard jevEnabled, let input = controllerInput else {
                commandStatus?.stringValue = "Turn on “Let Jev choose each step” in Settings (⚙) to continue."
                return
            }
            taskField?.stringValue = text
            if spoken { finalSpeechText = text }
            guard taskIntake.continueBrowse(text: text, voice: spoken,
                send: { [weak self] in self?.send($0, through: input) == true }) else {
                commandStatus?.stringValue = "Could not continue in the open browser."
                return
            }
            browseKeptOpen = false
            commandStatus?.stringValue = "Continuing on the open page. Jev will propose each step."
            return
        }
        guard !speech.isCapturing else {
            // Return while listening means "that's it": finish and run.
            runWhenTranscribed = true
            speech.stop()
            return
        }
        guard let input = controllerInput, controller?.isRunning == true,
              activeRequestID == nil, stopRequestID == nil,
              !inspectionPending else {
            commandStatus?.stringValue = "Controller unavailable or another task is active."
            return
        }
        let text = taskField?.stringValue ?? ""
        let spoken = finalSpeechText != nil && finalSpeechText == text
        if jevEnabled, !text.lowercased().hasPrefix("privately ") {
            startAgent(text: spoken ? ScopedBrowse.normalizedSpeech(text) : text, spoken: spoken, input: input)
            return
        }
        let privateText = text.lowercased().hasPrefix("privately ") ? String(text.dropFirst(10)) : text
        let browseText = spoken ? ScopedBrowse.normalizedSpeech(privateText) : privateText
        if let browse = ScopedBrowse.parse(browseText) {
            guard jevEnabled else {
                commandStatus?.stringValue = "Turn on “Let Jev choose each step” in Settings (⚙) to browse."
                return
            }
            taskField?.stringValue = browseText
            if spoken { finalSpeechText = browseText }
            guard taskIntake.submit(.browse(text: browseText), originalText: browseText, voice: spoken,
                send: { [weak self] in self?.send($0, through: input) == true }) else {
                if hostActionsAvailable {
                    commandStatus?.stringValue = "Could not send the browse request to the controller."
                }
                return
            }
            browseKeptOpen = false
            commandStatus?.stringValue = "Opening \(browse.site) in a private browser window. Jev will propose each step for you to allow."
            return
        }
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
            commandStatus?.stringValue = "Try: go to wikipedia and search for Alan Turing · or Fill <field> with <value>."
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

    /// Control-Option-Space is push-to-talk: hold to speak, release to run.
    /// A quick tap only opens the bar. Control-Option-Escape stops.
    func handleGlobalHotkey(_ id: UInt32, pressed: Bool) {
        switch (id, pressed) {
        case (openPanelHotkeyID, true):
            openPanel()
            hotkeyPressedAt = Date()
            guard speech.isAuthorized, hostActionsAvailable, !speech.isCapturing else {
                if !speech.isAuthorized { commandStatus?.stringValue = "Click the mic once to allow voice; then hold Control-Option-Space to talk." }
                return
            }
            hotkeyDictation = true
            speech.start()
        case (openPanelHotkeyID, false):
            guard hotkeyDictation, let started = hotkeyPressedAt else { return }
            if Date().timeIntervalSince(started) < 0.35 {
                // A tap, not speech: keep the bar open and stay quiet.
                hotkeyDictation = false
                speech.cancel()
                commandStatus?.stringValue = "Hold Control-Option-Space and speak; release to run."
            } else {
                speech.stop()
            }
        case (stopHotkeyID, true): stop()
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
        var eventTypes = [EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                        eventKind: OSType(kEventHotKeyPressed)),
                          EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                        eventKind: OSType(kEventHotKeyReleased))]
        let handlerStatus = InstallEventHandler(GetApplicationEventTarget(),
            systemOneHotkeyHandler, 2, &eventTypes,
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
            send: { [weak self] in self?.send(self?.withDecisionChoice($0) ?? $0, through: input) == true }) else {
            statusField?.stringValue = "Could not send fixture navigation request."
            return
        }
        statusField?.stringValue = "Fixture navigation sent to the local controller…"
    }

    private func startAgent(text: String, spoken: Bool, input: Pipe) {
        guard !text.isEmpty else { return }
        guard hasAccessibilityAccess() else {
            showAccessibilityDenied()
            return
        }
        accessibilityRecoveryButton?.isHidden = true
        let me = ProcessInfo.processInfo.processIdentifier
        let target = capturedApp.flatMap { app in
            NSRunningApplication(processIdentifier: app.pid).flatMap { $0.isTerminated ? nil : $0 } }
            ?? lastExternalApp.flatMap { $0.isTerminated ? nil : $0 }
            ?? NSWorkspace.shared.runningApplications.first { $0.isActive && $0.processIdentifier != me }
        if let target { universalAX.setTarget(target.processIdentifier) }
        taskField?.stringValue = text
        if spoken { finalSpeechText = text }
        guard taskIntake.submit(.agent(text: text), originalText: text, voice: spoken,
            send: { [weak self] in self?.send($0, through: input) == true }) else {
            if hostActionsAvailable { commandStatus?.stringValue = "Could not send the request to the controller." }
            return
        }
        browseKeptOpen = false
        runningRequestText = text
        commandStatus?.stringValue = "Working on it\(target.map { " in \($0.localizedName ?? "the app")" } ?? "")…"
        // Give the target app the keyboard; the bar stays visible on top.
        target?.activate()
    }

    private func handleAgentRequest(_ object: [String: Any]) {
        guard let requestID = object["requestId"] as? String, let input = controllerInput else { return }
        let reply: (Bool, Any?, String?) -> Void = { [weak self] ok, value, error in
            var message: [String: Any] = ["type": "agent_ax_reply", "requestId": requestID, "ok": ok]
            if let value { message["value"] = value }
            if let error { message["error"] = error }
            _ = self?.send(message, through: input, limit: 60_000)
        }
        guard let taskID = object["taskId"] as? String, taskID == activeRequestID, activeSurface == .agent,
              stopRequestID == nil, hostActionsAvailable, let op = object["op"] as? String else {
            reply(false, nil, "not the active agent task"); return
        }
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                switch op {
                case "snapshot":
                    guard let snap = try? self.universalAX.snapshot() else {
                        // Nothing in front: Jev can still open a site or switch to an app.
                        reply(true, ["app": "no app", "bundleId": "", "pid": 0, "windowTitle": "", "url": "",
                                     "elements": [] as [Any], "truncated": false, "signature": "none",
                                     "runningApps": UniversalAX.runningApps()], nil)
                        return
                    }
                    var elements = snap.elements
                    var value: [String: Any] = [:]
                    repeat {
                        value = ["app": snap.app, "bundleId": snap.bundleID, "pid": Int(snap.pid),
                                 "windowTitle": snap.windowTitle, "url": snap.url, "elements": elements,
                                 "truncated": snap.truncated || elements.count < snap.elements.count,
                                 "signature": snap.signature, "runningApps": UniversalAX.runningApps(),
                                 "readMs": self.universalAX.lastReadMs, "visited": snap.visited, "via": snap.via]
                        if let hint = snap.hint, hint != self.lastBrowserHint {
                            // Once per distinct problem: how to enable the faster page read.
                            self.lastBrowserHint = hint
                            self.commandStatus?.stringValue = hint
                        }
                        let size = (try? JSONSerialization.data(withJSONObject: value).count) ?? 0
                        if size < 56_000 { break }
                        elements.removeLast(min(20, elements.count))
                    } while !elements.isEmpty
                    reply(true, value, nil)
                case "press": try self.universalAX.press(object["id"] as? String ?? ""); reply(true, nil, nil)
                case "copy": reply(true, try self.universalAX.copy(object["id"] as? String ?? ""), nil)
                case "close": try self.universalAX.close(object["id"] as? String ?? ""); reply(true, nil, nil)
                case "paste": try self.universalAX.paste(object["id"] as? String ?? ""); reply(true, nil, nil)
                case "type":
                    try self.universalAX.type(object["id"] as? String ?? "", text: object["text"] as? String ?? "")
                    reply(true, nil, nil)
                case "key": try self.universalAX.press(key: object["name"] as? String ?? ""); reply(true, nil, nil)
                case "scroll": try self.universalAX.scroll(down: object["down"] as? Bool ?? true); reply(true, nil, nil)
                case "open_url":
                    guard let text = object["url"] as? String, let url = URL(string: text),
                          ["https", "http"].contains(url.scheme ?? "") else { throw UniversalAX.AXError.actionFailed }
                    try await self.universalAX.open(url: url); reply(true, nil, nil)
                case "open_app":
                    try await self.universalAX.open(app: object["name"] as? String ?? ""); reply(true, nil, nil)
                case "quit_app":
                    try await self.universalAX.quit(app: object["name"] as? String ?? ""); reply(true, nil, nil)
                default: reply(false, nil, "unsupported operation")
                }
            } catch { reply(false, nil, String(describing: error)) }
        }
    }

    @objc private func allowStep() {
        if let pending = pendingProposal { confirmProposal(pending, allow: true) }
    }

    @objc private func allowAllSteps() {
        guard let pending = pendingProposal else { return }
        autoAllowTaskID = pending.requestID
        confirmProposal(pending, allow: true)
    }

    private func confirmProposal(_ pending: (requestID: String, proposalID: String), allow: Bool) {
        approvalRow?.isHidden = true
        guard let input = controllerInput, pending.requestID == activeRequestID else { pendingProposal = nil; return }
        pendingProposal = nil
        let sent = send(["type": "confirm_step", "requestId": UUID().uuidString.lowercased(),
                         "targetRequestId": pending.requestID, "proposalId": pending.proposalID,
                         "allow": allow], through: input)
        commandStatus?.stringValue = sent && allow ? "Allowed. Acting, then checking the page…"
            : "Step not allowed. Nothing was done."
    }

    private func withDecisionChoice(_ request: [String: Any]) -> [String: Any] {
        guard jevEnabled else { return request }
        var opted = request
        opted["decisionProvider"] = "jev"
        return opted
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
            send: { [weak self] in self?.send(self?.withDecisionChoice($0) ?? $0, through: input) == true }) else {
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
        voice.stop()
        listeningForAnswer = false
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
            if quitPending { quitPending = false; NSApp.reply(toApplicationShouldTerminate: true) } // the user asked to quit; any uncertainty stays journaled
        }
    }

    private func send(_ object: [String: Any], through pipe: Pipe,
                      limit: Int = 16_384) -> Bool {
        guard controllerIdentityValid() else { return false }
        if let type = object["type"] as? String,
           (type.hasPrefix("start_") || type == "continue_browse" || type == "replace_native_fixture"
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
