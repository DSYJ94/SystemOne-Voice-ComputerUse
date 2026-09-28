import AVFoundation
import Speech

@MainActor
final class OnDeviceSpeech {
    var onText: ((String, Bool) -> Void)?
    var onStatus: ((String) -> Void)?

    private let engine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var epoch = 0
    private var listening = false
    private var finishing = false
    var isCapturing: Bool { listening || finishing }

    func requestPermissions() {
        guard !listening && !finishing else { return }
        SFSpeechRecognizer.requestAuthorization { [weak self] speechStatus in
            Task { @MainActor [weak self] in
                guard let self else { return }
                guard speechStatus == .authorized else {
                    self.onStatus?("Speech recognition permission was not granted.")
                    return
                }
                AVCaptureDevice.requestAccess(for: .audio) { [weak self] allowed in
                    Task { @MainActor [weak self] in
                        self?.onStatus?(allowed
                            ? "Voice is ready. Hold Talk, then review and run the final transcript."
                            : "Microphone permission was not granted.")
                    }
                }
            }
        }
    }

    func start() {
        guard !listening && !finishing else { return }
        guard SFSpeechRecognizer.authorizationStatus() == .authorized,
              AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
            onStatus?("Choose Enable Voice to grant microphone and speech access, then hold Talk again.")
            return
        }
        guard let recognizer = SFSpeechRecognizer(locale: Locale.current),
              recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
            onStatus?("On-device speech recognition is unavailable for this Mac or language.")
            return
        }
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0 else {
            onStatus?("No usable microphone input is available.")
            return
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = true
        epoch += 1
        let currentEpoch = epoch
        self.recognizer = recognizer
        self.request = request
        input.installTap(onBus: 0, bufferSize: 1_024, format: format) { buffer, _ in
            request.append(buffer)
        }
        do {
            engine.prepare()
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            self.request = nil
            self.recognizer = nil
            onStatus?("Microphone could not start: \(error.localizedDescription)")
            return
        }
        listening = true
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let isFinal = result?.isFinal == true
            let failed = error != nil
            Task { @MainActor [weak self] in
                guard let self, self.epoch == currentEpoch else { return }
                if let text, !text.isEmpty { self.onText?(text, isFinal) }
                if isFinal {
                    self.onStatus?("Final transcript ready. Review it, then choose Run request.")
                    self.reset()
                } else if failed {
                    self.onStatus?("Speech recognition stopped without a final transcript. Try again.")
                    self.reset()
                }
            }
        }
        onStatus?("Listening on this Mac while Talk is held…")
    }

    func stop() {
        guard listening else { return }
        engine.stop()
        engine.inputNode.removeTap(onBus: 0)
        listening = false
        finishing = true
        request?.endAudio()
        onStatus?("Finishing on-device transcript…")
        let currentEpoch = epoch
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(4))
            guard let self, self.epoch == currentEpoch, self.finishing else { return }
            self.onStatus?("No final transcript arrived. Nothing was submitted.")
            self.reset()
        }
    }

    func cancel() {
        guard listening || finishing else { return }
        onStatus?("Voice capture cancelled. Nothing was submitted.")
        reset()
    }

    private func reset() {
        epoch += 1
        if engine.isRunning { engine.stop() }
        if listening { engine.inputNode.removeTap(onBus: 0) }
        task?.cancel()
        task = nil
        request = nil
        recognizer = nil
        listening = false
        finishing = false
    }
}
