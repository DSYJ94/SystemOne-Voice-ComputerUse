import AppKit

/// Round, softly lit buttons for the glass bar, instead of bare system glyphs: an accent
/// orb (talk, run), a quiet glass orb (settings), and a red orb (stop). The talk orb pulses
/// while listening.
@MainActor
final class OrbButton: NSButton {
    enum Style { case accent, glass, danger }

    private let style: Style
    private let diameter: CGFloat
    private let symbol: String
    private var hovering = false
    private let pulse = CALayer()

    var isListening = false {
        didSet {
            guard isListening != oldValue else { return }
            updatePulse()
            needsDisplay = true
        }
    }

    init(symbol: String, label: String, style: Style, diameter: CGFloat) {
        self.style = style
        self.diameter = diameter
        self.symbol = symbol
        super.init(frame: NSRect(x: 0, y: 0, width: diameter, height: diameter))
        isBordered = false
        title = ""
        setButtonType(.momentaryChange)
        setAccessibilityLabel(label)
        toolTip = label
        wantsLayer = true
        layer?.masksToBounds = false
        pulse.frame = bounds
        pulse.cornerRadius = diameter / 2
        pulse.opacity = 0
        layer?.insertSublayer(pulse, at: 0)
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: diameter).isActive = true
        heightAnchor.constraint(equalToConstant: diameter).isActive = true
    }

    required init?(coder: NSCoder) { nil }

    override var intrinsicContentSize: NSSize { NSSize(width: diameter, height: diameter) }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect],
                                       owner: self))
    }

    override func mouseEntered(with event: NSEvent) { hovering = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovering = false; needsDisplay = true }

    override func draw(_ dirtyRect: NSRect) {
        let circle = NSBezierPath(ovalIn: bounds.insetBy(dx: 1, dy: 1))
        let pressed = isHighlighted
        switch style {
        case .accent:
            let base = isListening ? NSColor.systemRed : NSColor.controlAccentColor
            let top = base.blended(withFraction: hovering ? 0.32 : 0.22, of: .white) ?? base
            let bottom = base.blended(withFraction: pressed ? 0.25 : 0.08, of: .black) ?? base
            NSGradient(starting: top, ending: bottom)?.draw(in: circle, angle: -90)
            NSColor.white.withAlphaComponent(0.35).setStroke()
        case .danger:
            let base = NSColor.systemRed
            NSGradient(starting: base.blended(withFraction: hovering ? 0.3 : 0.18, of: .white) ?? base,
                       ending: base.blended(withFraction: pressed ? 0.25 : 0.05, of: .black) ?? base)?.draw(in: circle, angle: -90)
            NSColor.white.withAlphaComponent(0.3).setStroke()
        case .glass:
            NSColor.labelColor.withAlphaComponent(pressed ? 0.16 : hovering ? 0.11 : 0.06).setFill()
            circle.fill()
            NSColor.labelColor.withAlphaComponent(0.12).setStroke()
        }
        circle.lineWidth = 1
        circle.stroke()
        let pointSize = diameter * (style == .glass ? 0.42 : 0.44)
        let tint: NSColor = style == .glass ? .labelColor.withAlphaComponent(0.75) : .white
        let name = style == .accent && isListening ? "waveform" : symbol
        guard let image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: pointSize, weight: .semibold)
                .applying(.init(paletteColors: [tint]))) else { return }
        let size = image.size
        image.draw(in: NSRect(x: (bounds.width - size.width) / 2, y: (bounds.height - size.height) / 2,
                              width: size.width, height: size.height))
    }

    private func updatePulse() {
        pulse.removeAllAnimations()
        guard isListening, !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { pulse.opacity = 0; return }
        pulse.backgroundColor = NSColor.systemRed.withAlphaComponent(0.35).cgColor
        let grow = CABasicAnimation(keyPath: "transform.scale")
        grow.fromValue = 1
        grow.toValue = 1.45
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.8
        fade.toValue = 0
        let group = CAAnimationGroup()
        group.animations = [grow, fade]
        group.duration = 1.1
        group.repeatCount = .infinity
        group.timingFunction = CAMediaTimingFunction(name: .easeOut)
        pulse.add(group, forKey: "pulse")
    }
}

/// A request field that wraps and grows (up to `maxLines`) as words arrive, typed or
/// spoken, so the whole transcript stays visible instead of scrolling out of sight.
@MainActor
final class GrowingTextField: NSTextField {
    var maxLines = 5

    override var stringValue: String {
        didSet { invalidateIntrinsicContentSize() }
    }

    override func textDidChange(_ notification: Notification) {
        super.textDidChange(notification)
        invalidateIntrinsicContentSize()
    }

    private var measuredWidth: CGFloat = 0

    override func layout() {
        super.layout()
        // Re-measure only when the width changed, so layout cannot loop.
        if abs(bounds.width - measuredWidth) > 0.5 {
            measuredWidth = bounds.width
            invalidateIntrinsicContentSize()
        }
    }

    override var intrinsicContentSize: NSSize {
        guard let cell, let font else { return super.intrinsicContentSize }
        let width = bounds.width > 20 ? bounds.width : 400
        let text = currentEditor()?.string ?? stringValue
        let measuring = cell.copy() as? NSCell ?? cell
        measuring.stringValue = text.isEmpty ? (placeholderString ?? " ") : text
        let height = measuring.cellSize(forBounds: NSRect(x: 0, y: 0, width: width, height: .greatestFiniteMagnitude)).height
        let line = ceil(font.ascender - font.descender + font.leading)
        return NSSize(width: NSView.noIntrinsicMetric, height: min(max(height, line), line * CGFloat(maxLines) + 4))
    }
}
