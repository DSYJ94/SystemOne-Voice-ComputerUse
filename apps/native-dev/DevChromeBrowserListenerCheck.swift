import Darwin
import Foundation

private final class Output: @unchecked Sendable {
    private let lock = NSLock()

    func send(_ value: [String: String]) {
        guard let body = try? JSONSerialization.data(withJSONObject: value) else { return }
        lock.lock()
        defer { lock.unlock() }
        FileHandle.standardOutput.write(body + Data([10]))
    }
}

/// Test-only process using the production DevChromeListener source. The
/// browser check owns its private socket, extension and disposable profile.
@main
struct DevChromeBrowserListenerCheck {
    static func main() throws {
        guard CommandLine.arguments.count == 3 else {
            throw NSError(domain: "SystemOne", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "socket path and host CDHash required"])
        }
        let path = CommandLine.arguments[1]
        let hostHash = CommandLine.arguments[2]
        let requirement = try PeerRequirement(
            effectiveUserID: geteuid(),
            signingIdentifier: "com.aurium.systemone.chromenativehost",
            allowedCDHashes: [hostHash])
        let output = Output()
        let listener = DevChromeListener(path: path, requirement: requirement,
            onOpen: { id in output.send(["type": "open", "connectionId": id]) },
            onMessage: { id, data in output.send(["type": "message",
                "connectionId": id, "base64": data.base64EncodedString()]) },
            onClosed: { id in output.send(["type": "closed", "connectionId": id]) })
        try listener.start()
        defer { listener.stop() }
        output.send(["type": "ready"])
        while let line = readLine() {
            guard let data = line.data(using: .utf8), data.count <= 90_000,
                  let value = try? JSONSerialization.jsonObject(with: data) as? [String: String],
                  let type = value["type"], let id = value["connectionId"] else { continue }
            if type == "close" { listener.closeConnection(id) }
            if type == "send", let encoded = value["base64"],
               let body = Data(base64Encoded: encoded), !body.isEmpty,
               body.count <= 65_536 { listener.send(body, to: id) }
        }
    }
}
