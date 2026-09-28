import Foundation

@main
struct NativeHostPermitCheck {
    static func main() {
        guard CommandLine.arguments.count == 4,
              let key = NativeHostPermit.publicKey(CommandLine.arguments[1]),
              let data = CommandLine.arguments[2].data(using: .utf8),
              let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let nowMs = Int64(CommandLine.arguments[3]) else { exit(2) }
        let accepted = NativeHostPermit.verify(publicKey: key, message: message,
            taskID: "task-1", preparationRef: "prep-1",
            executionID: "execution-1", permitRef: "permit-1",
            scopeRef: "native:scope-1", observationID: "obs-1",
            candidateID: "node-1", candidateSetDigest: String(repeating: "a", count: 64),
            actionDigest: String(repeating: "b", count: 64), nowMs: nowMs)
        print(accepted ? "accepted" : "rejected")
    }
}
