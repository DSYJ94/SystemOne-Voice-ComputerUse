import AppKit
import ApplicationServices

// Value of Apple's kAXTrustedCheckOptionPrompt, verified against this SDK.
// Swift 6 rejects reading that imported mutable C global under strict concurrency.
private let axPromptKey = "AXTrustedCheckOptionPrompt"

@MainActor
final class NativeMock: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var panel: NSPanel?
    private var input: NSTextField?
    private var result: NSTextField?
    private var attemptEpoch = 0
    private var attemptPending = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Keep a Dock fallback in this test build: menu-bar managers can hide
        // third-party status items, leaving an accessory-only mock unreachable.
        NSApp.setActivationPolicy(.regular)

        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "S1 Mock"
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Open Command Panel", action: #selector(openPanel), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Stop", action: #selector(stop), keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Mock", action: #selector(quit), keyEquivalent: ""))
        for menuItem in menu.items { menuItem.target = self }
        item.menu = menu
        statusItem = item
        makePanel()
        openPanel()
    }

    func applicationShouldHandleReopen(_ sender: NSApplication,
        hasVisibleWindows flag: Bool) -> Bool {
        openPanel()
        return true
    }

    private func makePanel() {
        let window = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 290),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "SystemOne Mock"
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

        let title = NSTextField(labelWithString: "SystemOne — fixture test")
        title.font = .boldSystemFont(ofSize: 15)
        let explanation = NSTextField(wrappingLabelWithString:
            "Enter a synthetic value here, then choose Fill Fixture Name. Only the field in SystemOne Fixture can be changed.")
        explanation.textColor = .secondaryLabelColor

        let field = NSTextField()
        field.placeholderString = "Value to put in Fixture Name"
        field.setAccessibilityLabel("Command text")
        input = field

        let status = NSTextField(wrappingLabelWithString: "Ready for a mock request.")
        status.textColor = .secondaryLabelColor
        status.setAccessibilityLabel("Mock status")
        result = status

        let preview = NSButton(title: "Preview only", target: self, action: #selector(previewInput))
        let stopButton = NSButton(title: "Stop", target: self, action: #selector(stop))
        let hideButton = NSButton(title: "Hide", target: self, action: #selector(hidePanel))
        let actions = NSStackView(views: [preview, stopButton, hideButton])
        actions.orientation = .horizontal
        actions.spacing = 8

        let openFixture = NSButton(title: "Open Fixture", target: self,
                                   action: #selector(openFixtureApp))
        let requestAccess = NSButton(title: "Request Accessibility", target: self,
                                     action: #selector(requestAccessibility))
        let fillFixture = NSButton(title: "Fill Fixture Name", target: self,
                                   action: #selector(fillFixtureName))
        let fixtureActions = NSStackView(views: [openFixture, requestAccess, fillFixture])
        fixtureActions.orientation = .horizontal
        fixtureActions.spacing = 8

        let stack = NSStackView(views: [title, explanation, field, status, fixtureActions, actions])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        backdrop.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: backdrop.leadingAnchor, constant: 18),
            stack.trailingAnchor.constraint(equalTo: backdrop.trailingAnchor, constant: -18),
            stack.centerYAnchor.constraint(equalTo: backdrop.centerYAnchor),
            field.widthAnchor.constraint(equalTo: stack.widthAnchor),
            status.widthAnchor.constraint(equalTo: stack.widthAnchor),
            explanation.widthAnchor.constraint(equalTo: stack.widthAnchor)
        ])
        panel = window
    }

    @objc private func openPanel() {
        guard let panel else { return }
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
        panel.makeFirstResponder(input)
    }

    @objc private func previewInput() {
        let text = input?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        result?.stringValue = text.isEmpty
            ? "Enter some text first."
            : "Preview received. No action was sent."
    }

    @objc private func stop() {
        attemptEpoch += 1
        input?.stringValue = ""
        result?.stringValue = attemptPending
            ? "Stop requested. An in-flight fixture edit may still complete."
            : "Stopped. No actions were in flight."
    }

    private var fixtureURL: URL {
        Bundle.main.bundleURL.deletingLastPathComponent()
            .appendingPathComponent("SystemOne Fixture.app")
    }

    @objc private func openFixtureApp() {
        guard FileManager.default.fileExists(atPath: fixtureURL.path) else {
            result?.stringValue = "Fixture build is missing. Rebuild both test apps."
            return
        }
        result?.stringValue = NSWorkspace.shared.open(fixtureURL)
            ? "Fixture opened. Use a synthetic test value."
            : "macOS could not open the fixture."
    }

    @objc private func requestAccessibility() {
        let options = [axPromptKey: true] as CFDictionary
        let trusted = AXIsProcessTrustedWithOptions(options)
        result?.stringValue = trusted
            ? "Accessibility is already granted to this mock build."
            : "Grant access to SystemOne Mock if macOS prompts, then try Fill again."
    }

    @objc private func fillFixtureName() {
        guard !attemptPending else {
            result?.stringValue = "The previous fixture attempt is still unresolved."
            return
        }
        let value = input?.stringValue ?? ""
        guard !value.isEmpty && value.utf8.count <= 128 else {
            result?.stringValue = "Enter 1–128 bytes of synthetic test text."
            return
        }
        guard AXIsProcessTrustedWithOptions(nil) else {
            result?.stringValue = "Accessibility is not granted. Use Request Accessibility."
            return
        }
        let running = NSRunningApplication.runningApplications(
            withBundleIdentifier: "com.aurium.systemone.fixture"
        ).filter {
            $0.bundleURL?.resolvingSymlinksInPath().standardizedFileURL ==
                fixtureURL.resolvingSymlinksInPath().standardizedFileURL
        }
        guard running.count == 1 else {
            result?.stringValue = "Open the exact SystemOne Fixture first."
            return
        }

        let pid = running[0].processIdentifier
        let epoch = attemptEpoch
        let fixtureURL = fixtureURL
        attemptPending = true
        result?.stringValue = "Observing and setting the synthetic fixture field…"
        Task.detached { [weak self] in
            guard await self?.isCurrentAttempt(epoch) == true else {
                await self?.finishFixtureAttempt(.notDispatched("Stopped before dispatch."),
                                                 epoch: epoch)
                return
            }
            let outcome = FixtureAX.setName(pid: pid, fixtureURL: fixtureURL, value: value)
            await self?.finishFixtureAttempt(outcome, epoch: epoch)
        }
    }

    private func isCurrentAttempt(_ epoch: Int) -> Bool {
        attemptPending && epoch == attemptEpoch
    }

    private func finishFixtureAttempt(_ outcome: FixtureAXOutcome, epoch: Int) {
        attemptPending = false
        let stopped = epoch != attemptEpoch
        switch outcome {
        case .alreadyVerified:
            result?.stringValue = stopped
                ? "Stopped. The fixture already held that value."
                : "Verified: the fixture already held that value; no edit was sent."
        case .applied:
            result?.stringValue = stopped
                ? "Stopped. The fixture edit was applied; no further action will run."
                : "Verified: the synthetic Fixture Name field was changed."
        case .notDispatched(let reason):
            result?.stringValue = stopped ? "Stopped before edit. \(reason)" : reason
        case .unknown(let reason):
            result?.stringValue = "Outcome uncertain. Check the fixture field. \(reason)"
        }
    }

    @objc private func hidePanel() { panel?.orderOut(nil) }
    @objc private func quit() { NSApp.terminate(nil) }
}

@main
struct Main {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = NativeMock()
        app.delegate = delegate
        app.run()
        withExtendedLifetime(delegate) {}
    }
}
