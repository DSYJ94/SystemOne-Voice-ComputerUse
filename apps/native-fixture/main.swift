import AppKit

@MainActor
final class FixtureApp: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var nameField: NSTextField?

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 180),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "SystemOne Fixture"
        window.center()

        let explanation = NSTextField(wrappingLabelWithString:
            "Synthetic test app. Only the Fixture Name field is available to the computer-use demo.")
        let label = NSTextField(labelWithString: "Fixture Name")
        let field = NSTextField()
        field.setAccessibilityLabel("Fixture Name")
        field.identifier = NSUserInterfaceItemIdentifier("fixture.name")
        nameField = field
        let reset = NSButton(title: "Reset", target: self, action: #selector(resetFixture))
        let stack = NSStackView(views: [explanation, label, field, reset])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView?.addSubview(stack)
        guard let content = window.contentView else { return }
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -20),
            stack.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            field.widthAnchor.constraint(equalTo: stack.widthAnchor),
            explanation.widthAnchor.constraint(equalTo: stack.widthAnchor)
        ])
        self.window = window
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldHandleReopen(_ sender: NSApplication,
        hasVisibleWindows flag: Bool) -> Bool {
        window?.makeKeyAndOrderFront(nil)
        return true
    }

    @objc private func resetFixture() { nameField?.stringValue = "" }
}

@main
struct Main {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = FixtureApp()
        app.delegate = delegate
        app.run()
        withExtendedLifetime(delegate) {}
    }
}
