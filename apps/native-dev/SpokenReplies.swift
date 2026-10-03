import AVFoundation
import Foundation

/// Short spoken replies ("Done.", "Should I send this?") so the user can sit
/// back. Uses the system voice on this Mac; nothing is sent anywhere.
@MainActor
final class SpokenReplies: NSObject, AVSpeechSynthesizerDelegate {
    private let synthesizer = AVSpeechSynthesizer()
    private var finished: (() -> Void)?
    var enabled = true

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    var isSpeaking: Bool { synthesizer.isSpeaking }

    /// Speaks `text`, replacing anything still being said; `then` runs when it finishes.
    func say(_ text: String, then: (() -> Void)? = nil) {
        guard enabled else { then?(); return }
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
        finished = then
        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 1.08
        synthesizer.speak(utterance)
    }

    func stop() {
        finished = nil
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        Task { @MainActor [weak self] in
            let next = self?.finished
            self?.finished = nil
            next?()
        }
    }
}
