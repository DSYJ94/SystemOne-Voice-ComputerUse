import AppKit

/// Shows where Jev is working: a soft accent-coloured outline around the window it is
/// acting on, on whichever display that is, with a small "Jev" tag. It never takes
/// clicks or focus, follows each step, and fades out when the task ends. The glass bar
/// itself stays where the user is.
@MainActor
final class ActivityHighlight {
    private var panel: NSPanel?
    private var tag: NSTextField?
    var enabled = UserDefaults.standard.object(forKey: "showActivityHighlight") as? Bool ?? true

    func show(around frame: CGRect, app: String) {
        guard enabled, frame.width > 40, frame.height > 40 else { hide(); return }
        let panel = self.panel ?? makePanel()
        let outset = frame.insetBy(dx: -6, dy: -6)
        panel.setFrame(outset, display: true)
        tag?.stringValue = "  Jev · \(app)  "
        if !panel.isVisible {
            panel.alphaValue = 0
            panel.orderFrontRegardless()
            let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
            NSAnimationContext.runAnimationGroup { context in
                context.duration = reduceMotion ? 0 : 0.18
                panel.animator().alphaValue = 1
            }
        } else {
            panel.orderFrontRegardless()
        }
    }

    func hide() {
        guard let panel, panel.isVisible else { return }
        let reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = reduceMotion ? 0 : 0.35
            panel.animator().alphaValue = 0
        }, completionHandler: { panel.orderOut(nil) })
    }

    private func makePanel() -> NSPanel {
        let panel = NSPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
        panel.setAccessibilityElement(false)
        let outline = NSView()
        outline.wantsLayer = true
        outline.layer?.borderColor = NSColor.controlAccentColor.withAlphaComponent(0.9).cgColor
        outline.layer?.borderWidth = 3
        outline.layer?.cornerRadius = 14
        outline.layer?.shadowColor = NSColor.controlAccentColor.cgColor
        outline.layer?.shadowOpacity = 0.7
        outline.layer?.shadowRadius = 10
        outline.layer?.shadowOffset = .zero
        outline.autoresizingMask = [.width, .height]
        panel.contentView = outline
        let label = NSTextField(labelWithString: "  Jev  ")
        label.font = .systemFont(ofSize: 11, weight: .semibold)
        label.textColor = .white
        label.drawsBackground = true
        label.backgroundColor = NSColor.controlAccentColor
        label.wantsLayer = true
        label.layer?.cornerRadius = 7
        label.layer?.masksToBounds = true
        label.translatesAutoresizingMaskIntoConstraints = false
        outline.addSubview(label)
        NSLayoutConstraint.activate([
            label.topAnchor.constraint(equalTo: outline.topAnchor, constant: 8),
            label.leadingAnchor.constraint(equalTo: outline.leadingAnchor, constant: 14),
        ])
        tag = label
        self.panel = panel
        return panel
    }
}
