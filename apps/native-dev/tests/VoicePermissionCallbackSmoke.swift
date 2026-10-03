import Dispatch
import Foundation
import Speech

@main
struct VoicePermissionCallbackSmoke {
    @MainActor private static var retained: [OnDeviceSpeech] = []

    @MainActor static func main() {
        let denied = OnDeviceSpeech(speechAuthorization: { completion in
            DispatchQueue.global().async { completion(.denied) }
        })
        retained.append(denied)
        denied.onStatus = { status in
            guard status == "Speech recognition permission was not granted." else {
                fputs("unexpected status: \(status)\n", stderr)
                exit(2)
            }
            checkMicrophone(allowed: false)
        }
        denied.requestPermissions()
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) {
            fputs("authorization callback timed out\n", stderr)
            exit(3)
        }
        RunLoop.main.run()
    }

    @MainActor private static func checkMicrophone(allowed: Bool) {
        let speech = OnDeviceSpeech(
            speechAuthorization: { completion in
                DispatchQueue.global().async { completion(.authorized) }
            },
            microphoneAuthorization: { completion in
                DispatchQueue.global().async { completion(allowed) }
            })
        retained.append(speech)
        speech.onStatus = { status in
            let expected = allowed
                ? "Voice is ready. Click the mic, speak, then click it again."
                : "Microphone permission was not granted."
            guard status == expected else {
                fputs("unexpected status: \(status)\n", stderr)
                exit(4)
            }
            if allowed {
                print("background speech and microphone callbacks returned to main actor")
                exit(0)
            }
            checkMicrophone(allowed: true)
        }
        speech.requestPermissions()
    }
}
