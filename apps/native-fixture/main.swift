import AppKit

@MainActor
final class FixtureApp: NSObject, NSApplicationDelegate {
    private var window: NSWindow?
    private var nameField: NSTextField?
    private var resetStatus: NSTextField?
    private var fileButton: NSButton?
    private var openFileButton: NSButton?
    private var fileStatus: NSTextField?
    private var currentFolder: String?
    private var selectedFile = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.regular)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 500, height: 390),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "SystemOne Fixture"
        window.center()

        let explanation = NSTextField(wrappingLabelWithString:
            "Target app: enter the test value in SystemOne Mock, then choose Fill Fixture Name there. Use Reset here to clear the target field.")
        let label = NSTextField(labelWithString: "Fixture Name")
        let field = NSTextField()
        field.setAccessibilityLabel("Fixture Name")
        field.identifier = NSUserInterfaceItemIdentifier("fixture.name")
        nameField = field
        let reset = NSButton(title: "Reset", target: self, action: #selector(resetFixture))
        let status = NSTextField(labelWithString: "")
        status.setAccessibilityLabel("Reset status")
        resetStatus = status
        let fileHeading = NSTextField(labelWithString: "Synthetic file navigator")
        fileHeading.font = .boldSystemFont(ofSize: 13)
        let documents = NSButton(title: "Documents", target: self,
                                 action: #selector(showDocuments))
        documents.setAccessibilityLabel("Documents")
        let downloads = NSButton(title: "Downloads", target: self,
                                 action: #selector(showDownloads))
        downloads.setAccessibilityLabel("Downloads")
        let folders = NSStackView(views: [documents, downloads])
        folders.orientation = .horizontal
        folders.spacing = 10
        let file = NSButton(title: "Budget.xlsx", target: self,
                            action: #selector(selectFile))
        file.setAccessibilityLabel("Budget.xlsx")
        file.isHidden = true
        fileButton = file
        let openFile = NSButton(title: "Open selected file", target: self,
                                action: #selector(openSelectedFile))
        openFile.isHidden = true
        openFileButton = openFile
        let fileState = NSTextField(labelWithString: "No folder selected.")
        fileState.setAccessibilityLabel("Synthetic file status")
        fileStatus = fileState
        let stack = NSStackView(views: [explanation, label, field, reset, status,
                                        fileHeading, folders, file, openFile,
                                        fileState])
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
            explanation.widthAnchor.constraint(equalTo: stack.widthAnchor),
            fileState.widthAnchor.constraint(equalTo: stack.widthAnchor)
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

    @objc private func resetFixture() {
        nameField?.stringValue = ""
        resetStatus?.stringValue = "Reset completed. Fixture Name is empty."
        currentFolder = nil
        selectedFile = false
        fileButton?.isHidden = true
        openFileButton?.isHidden = true
        fileStatus?.stringValue = "No folder selected."
        window?.title = "SystemOne Fixture"
    }

    @objc private func showDocuments() { showFolder("Documents") }
    @objc private func showDownloads() { showFolder("Downloads") }

    private func showFolder(_ name: String) {
        currentFolder = name
        selectedFile = false
        fileButton?.isHidden = false
        openFileButton?.isHidden = true
        fileStatus?.stringValue = "\(name) folder visible; Budget.xlsx is not selected."
        window?.title = "SystemOne Fixture — \(name)"
    }

    @objc private func selectFile() {
        guard let currentFolder else { return }
        selectedFile = true
        openFileButton?.isHidden = false
        fileStatus?.stringValue = "Selected \(currentFolder)/Budget.xlsx; file remains closed."
        window?.title = "SystemOne Fixture — \(currentFolder) — Budget.xlsx selected"
    }

    @objc private func openSelectedFile() {
        guard let currentFolder, selectedFile else { return }
        fileStatus?.stringValue = "Opened \(currentFolder)/Budget.xlsx."
        window?.title = "SystemOne Fixture — \(currentFolder) — Budget.xlsx opened"
    }
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
