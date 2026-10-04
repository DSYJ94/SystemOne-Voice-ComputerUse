import AppKit
import ScreenCaptureKit
import Vision

/// Stage D: reads a window that exposes little or nothing to Accessibility (canvases, some
/// Electron apps, games, remote desktops) from its pixels, using Apple's on-device text
/// recognition. The screenshot never leaves this Mac and is not kept; only the recognised
/// text (like a control label) is offered to the agent, and a chosen text is clicked for
/// real at its place on screen. Needs Screen Recording permission, granted by the user.
@MainActor
final class VisionReader {
    struct Found: Sendable {
        let text: String
        /// Global screen rectangle, top-left origin (as CGEvent clicks use).
        let box: CGRect
    }

    static var permitted: Bool { CGPreflightScreenCaptureAccess() }

    /// Shows the system prompt (once) and lists SystemOne under Screen Recording.
    static func requestPermission() { _ = CGRequestScreenCaptureAccess() }

    /// The front window of `pid` as an image (for reading, or attached to a 👎 report).
    func capture(windowOf pid: pid_t) async throws -> (image: CGImage, frame: CGRect) {
        guard Self.permitted else { throw VisionError.notPermitted }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        let windows = content.windows.filter { $0.owningApplication?.processID == pid && $0.windowLayer == 0 && $0.frame.width > 80 }
        guard let window = windows.max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else {
            throw VisionError.noWindow
        }
        let scale = NSScreen.screens.first { $0.frame.intersects(window.frame) }?.backingScaleFactor ?? 2
        let config = SCStreamConfiguration()
        config.width = Int(window.frame.width * scale)
        config.height = Int(window.frame.height * scale)
        config.showsCursor = false
        let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window),
                                                               configuration: config)
        return (image, window.frame)
    }

    /// Text in the front window of `pid`, read from the screen image.
    func read(windowOf pid: pid_t) async throws -> [Found] {
        let (image, frame) = try await capture(windowOf: pid)
        return try await Task.detached(priority: .userInitiated) {
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true
            try VNImageRequestHandler(cgImage: image).perform([request])
            return (request.results ?? []).compactMap { observation -> Found? in
                guard let candidate = observation.topCandidates(1).first, candidate.confidence > 0.4 else { return nil }
                let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
                guard text.count >= 2, text.count <= 120 else { return nil }
                let normal = observation.boundingBox // bottom-left origin, 0…1 of the image
                let box = CGRect(x: frame.minX + normal.minX * frame.width, y: frame.minY + (1 - normal.maxY) * frame.height,
                                 width: normal.width * frame.width, height: normal.height * frame.height)
                return Found(text: text, box: box)
            }
        }.value
    }

    enum VisionError: Error, CustomStringConvertible {
        case notPermitted, noWindow
        var description: String {
            switch self {
            case .notPermitted: "Screen Recording is not allowed for SystemOne"
            case .noWindow: "no window to read"
            }
        }
    }
}
