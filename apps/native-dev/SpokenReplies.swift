import AVFoundation
import Foundation

/// How SystemOne answers out loud. Sounds (default): short earcons for done / couldn't
/// finish, and speech only where words matter (answers, "Should I …?"). Voice: also says
/// "Done." Silent: nothing. Everything stays on this Mac.
@MainActor
final class SpokenReplies: NSObject, AVSpeechSynthesizerDelegate {
    enum Mode: String, CaseIterable { case sounds, voice, silent }

    private let synthesizer = AVSpeechSynthesizer()
    private let earcons = Earcons()
    private var finished: (() -> Void)?
    var mode: Mode {
        didSet { UserDefaults.standard.set(mode.rawValue, forKey: "replyMode") }
    }

    override init() {
        let stored = UserDefaults.standard.string(forKey: "replyMode").flatMap(Mode.init(rawValue:))
        let legacyOff = UserDefaults.standard.object(forKey: "speakReplies") as? Bool == false
        mode = stored ?? (legacyOff ? .silent : .sounds)
        super.init()
        synthesizer.delegate = self
    }

    /// Kept for older call sites: false only when silent.
    var enabled: Bool {
        get { mode != .silent }
        set { mode = newValue ? (mode == .silent ? .sounds : mode) : .silent }
    }

    var isSpeaking: Bool { synthesizer.isSpeaking }

    /// The most natural English voice installed: Premium, then Enhanced, then the default,
    /// never the novelty voices. Better ones are a free download in System Settings.
    static var bestVoice: AVSpeechSynthesisVoice? {
        let language = Locale.preferredLanguages.first ?? "en-US"
        let candidates = AVSpeechSynthesisVoice.speechVoices().filter {
            $0.language.hasPrefix(String(language.prefix(2))) && !$0.identifier.contains("speech.synthesis.voice")
        }
        return candidates.max { a, b in
            (a.quality.rawValue, a.language == language ? 1 : 0) < (b.quality.rawValue, b.language == language ? 1 : 0)
        } ?? AVSpeechSynthesisVoice(language: language)
    }

    /// "Ava (Premium)" or "Samantha (basic)", for Settings.
    static var voiceDescription: String {
        guard let voice = bestVoice else { return "System voice" }
        let quality = switch voice.quality {
        case .premium: "Premium"
        case .enhanced: "Enhanced"
        default: "basic"
        }
        return "\(voice.name) (\(quality))"
    }

    static var hasNaturalVoice: Bool { (bestVoice?.quality ?? .default) != .default }

    /// A status cue: an earcon in Sounds mode, the words in Voice mode, nothing when silent.
    func cue(_ cue: Earcons.Cue, words: String? = nil) {
        switch mode {
        case .silent: return
        case .sounds: earcons.play(cue)
        case .voice: if let words { say(words, essential: true) } else { earcons.play(cue) }
        }
    }

    /// Speaks `text` (replacing anything still being said); `then` runs when it finishes.
    /// Non-essential speech (status words) is skipped in Sounds mode.
    func say(_ text: String, essential: Bool = true, then: (() -> Void)? = nil) {
        guard mode != .silent, essential || mode == .voice else { then?(); return }
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
        finished = then
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = Self.bestVoice
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 1.04
        utterance.pitchMultiplier = 1.0
        utterance.prefersAssistiveTechnologySettings = false
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
