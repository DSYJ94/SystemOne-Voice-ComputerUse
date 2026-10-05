import AVFoundation

/// SystemOne's own short sounds, generated on the fly (no files): soft sine tones with gentle
/// fades, quiet enough to sit under music. Distinct shapes so they are recognisable without
/// looking: done rises, "couldn't finish" falls, listening ticks up and down.
@MainActor
final class Earcons {
    enum Cue { case listening, heard, done, failed, question }

    private let engine = AVAudioEngine()
    private let player = AVAudioPlayerNode()
    private let format = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1)!

    init() {
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        engine.mainMixerNode.outputVolume = 0.55
    }

    func play(_ cue: Cue) {
        // (frequency Hz, start s, length s, level)
        let notes: [(Double, Double, Double, Double)] = switch cue {
        case .listening: [(880, 0, 0.07, 0.35), (1318.5, 0.06, 0.09, 0.3)]       // A5 → E6: "go ahead"
        case .heard: [(1318.5, 0, 0.06, 0.25), (880, 0.05, 0.08, 0.22)]          // E6 → A5: "got it"
        case .done: [(659.3, 0, 0.16, 0.32), (987.8, 0.09, 0.18, 0.3), (1318.5, 0.18, 0.32, 0.26)] // E5 B5 E6
        case .failed: [(523.3, 0, 0.18, 0.3), (392, 0.13, 0.32, 0.28)]           // C5 → G4, soft
        case .question: [(784, 0, 0.12, 0.28), (987.8, 0.1, 0.2, 0.26)]           // G5 → B5, lifts like a question
        }
        guard let buffer = render(notes) else { return }
        // macOS stops the engine when the output device changes (headphones, a display's
        // speakers); playing on a stopped engine raises an exception that aborts the app.
        if !engine.isRunning {
            engine.prepare()
            do { try engine.start() } catch { return }
        }
        guard engine.isRunning else { return }
        player.scheduleBuffer(buffer, at: nil, options: .interrupts)
        if !player.isPlaying { player.play() }
    }

    private func render(_ notes: [(Double, Double, Double, Double)]) -> AVAudioPCMBuffer? {
        let rate = format.sampleRate
        let total = notes.map { $0.1 + $0.2 }.max() ?? 0
        let frames = AVAudioFrameCount((total + 0.05) * rate)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames), let data = buffer.floatChannelData?[0] else {
            return nil
        }
        buffer.frameLength = frames
        for index in 0..<Int(frames) { data[index] = 0 }
        for (frequency, start, length, level) in notes {
            let first = Int(start * rate)
            let count = Int(length * rate)
            for offset in 0..<count where first + offset < Int(frames) {
                let t = Double(offset) / rate
                // Quick attack, exponential decay: a bell-like tone rather than a beep.
                let envelope = min(1, t / 0.008) * exp(-4.5 * t / length)
                let tone = sin(2 * .pi * frequency * t) + 0.18 * sin(4 * .pi * frequency * t)
                data[first + offset] += Float(level * envelope * tone)
            }
        }
        return buffer
    }
}
