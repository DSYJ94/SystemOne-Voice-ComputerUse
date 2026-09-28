import Dispatch
import Foundation
import Speech

@main
struct VoicePermissionCallbackSmoke {
    @MainActor static func main() {
        let speech = OnDeviceSpeech(speechAuthorization: { completion in
            DispatchQueue.global().async { completion(.denied) }
        })
        speech.onStatus = { status in
            guard status == "Speech recognition permission was not granted." else {
                fputs("unexpected status: \(status)\n", stderr)
                exit(2)
            }
            print("background authorization callback returned to main actor")
            exit(0)
        }
        speech.requestPermissions()
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            fputs("authorization callback timed out\n", stderr)
            exit(3)
        }
        RunLoop.main.run()
    }
}
