import AppKit

@MainActor
final class NativeMock: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var panel: NSPanel?
    private var input: NSTextField?
    private var result: NSTextField?

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
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 210),
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

        let title = NSTextField(labelWithString: "SystemOne — UI mock")
        title.font = .boldSystemFont(ofSize: 15)
        let explanation = NSTextField(wrappingLabelWithString:
            "Type a request to preview it. This build cannot control apps or browsers.")
        explanation.textColor = .secondaryLabelColor

        let field = NSTextField()
        field.placeholderString = "What would you like to do?"
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

        let stack = NSStackView(views: [title, explanation, field, status, actions])
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
        input?.stringValue = ""
        result?.stringValue = "Stopped. No actions were in flight."
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
