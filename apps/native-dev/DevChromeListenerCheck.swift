import Darwin
import Foundation

private final class Captured: @unchecked Sendable {
    let opened = DispatchSemaphore(value: 0)
    let received = DispatchSemaphore(value: 0)
    private let lock = NSLock()
    private var id: String?
    private var data: Data?

    func open(_ value: String) {
        lock.lock(); id = value; lock.unlock()
        opened.signal()
    }
    func message(_ value: Data) {
        lock.lock(); data = value; lock.unlock()
        received.signal()
    }
    func snapshot() -> (String?, Data?) {
        lock.lock(); defer { lock.unlock() }
        return (id, data)
    }
}

private enum CheckError: Error { case failed(String) }

private func frame(_ text: String) -> Data {
    let body = Data(text.utf8)
    let size = UInt32(body.count)
    return Data([UInt8(truncatingIfNeeded: size),
                 UInt8(truncatingIfNeeded: size >> 8),
                 UInt8(truncatingIfNeeded: size >> 16),
                 UInt8(truncatingIfNeeded: size >> 24)]) + body
}

private func readExact(_ descriptor: Int32, count: Int) throws -> Data {
    var result = Data()
    while result.count < count {
        var ready = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
        guard poll(&ready, 1, 5_000) > 0 else { throw CheckError.failed("host reply timeout") }
        var bytes = [UInt8](repeating: 0, count: count - result.count)
        let capacity = bytes.count
        let length = bytes.withUnsafeMutableBytes { Darwin.read(descriptor, $0.baseAddress, capacity) }
        guard length > 0 else { throw CheckError.failed("host reply ended") }
        result.append(contentsOf: bytes.prefix(length))
    }
    return result
}

private func readFrame(_ descriptor: Int32) throws -> Data {
    let header = [UInt8](try readExact(descriptor, count: 4))
    let count = Int(UInt32(header[0]) | (UInt32(header[1]) << 8)
        | (UInt32(header[2]) << 16) | (UInt32(header[3]) << 24))
    guard count > 0, count <= 65_536 else { throw CheckError.failed("bad host reply") }
    return try readExact(descriptor, count: count)
}

@main
struct DevChromeListenerCheck {
    static func main() throws {
        guard CommandLine.arguments.count == 5 else {
            throw CheckError.failed("usage: CHECK HOST DIRECTORY HOST_CDHASH SELF_CDHASH")
        }
        let host = CommandLine.arguments[1]
        let directory = CommandLine.arguments[2]
        let hostHash = CommandLine.arguments[3]
        let selfHash = CommandLine.arguments[4]
        let socket = URL(fileURLWithPath: directory).appendingPathComponent("controller.sock").path
        let config: [String: Any] = [
            "extensionId": String(repeating: "a", count: 32),
            "controllerSigningIdentifier": "com.aurium.systemone.devlistenercheck",
            "controllerTeamIdentifier": NSNull(),
            "controllerCDHashes": [selfHash],
            "testControllerSocketPath": socket,
        ]
        let configPath = URL(fileURLWithPath: host).deletingLastPathComponent()
            .appendingPathComponent("ChromeNativeHost.json")
        try JSONSerialization.data(withJSONObject: config).write(to: configPath)
        let requirement = try PeerRequirement(effectiveUserID: geteuid(),
            signingIdentifier: "com.aurium.systemone.chromenativehost",
            allowedCDHashes: [hostHash])
        let capture = Captured()
        let listener = DevChromeListener(path: socket, requirement: requirement,
            onOpen: { capture.open($0) },
            onMessage: { _, data in capture.message(data) },
            onClosed: { _ in })
        try listener.start()
        defer { listener.stop() }
        let process = Process()
        let input = Pipe()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: host)
        process.arguments = ["chrome-extension://\(String(repeating: "a", count: 32))/"]
        process.standardInput = input
        process.standardOutput = output
        process.standardError = Pipe()
        try process.run()
        defer {
            input.fileHandleForWriting.closeFile()
            if process.isRunning { process.terminate() }
            process.waitUntilExit()
        }
        guard capture.opened.wait(timeout: .now() + 5) == .success else {
            throw CheckError.failed("signed Chrome host was not authenticated")
        }
        let hello = "{\"type\":\"hello\",\"challenge\":\"synthetic\"}"
        try input.fileHandleForWriting.write(contentsOf: frame(hello))
        let receivedInTime = capture.received.wait(timeout: .now() + 5) == .success
        let (connectionID, received) = capture.snapshot()
        guard receivedInTime, received == Data(hello.utf8), let connectionID else {
            throw CheckError.failed("host frame did not reach the listener")
        }
        let ack = "{\"type\":\"hello_ack\",\"challenge\":\"synthetic\"}"
        listener.send(Data(ack.utf8), to: connectionID)
        guard try readFrame(output.fileHandleForReading.fileDescriptor) == Data(ack.utf8) else {
            throw CheckError.failed("listener reply did not reach the host")
        }
        listener.stop()
        if process.isRunning { process.terminate() }
        process.waitUntilExit()

        let wrongSocket = URL(fileURLWithPath: directory)
            .appendingPathComponent("wrong-controller.sock").path
        var wrongConfig = config
        wrongConfig["testControllerSocketPath"] = wrongSocket
        try JSONSerialization.data(withJSONObject: wrongConfig).write(to: configPath)
        let wrongRequirement = try PeerRequirement(effectiveUserID: geteuid(),
            signingIdentifier: "com.aurium.systemone.chromenativehost",
            allowedCDHashes: [String(repeating: "f", count: 40)])
        let rejected = Captured()
        let wrongListener = DevChromeListener(path: wrongSocket,
            requirement: wrongRequirement,
            onOpen: { rejected.open($0) }, onMessage: { _, _ in }, onClosed: { _ in })
        try wrongListener.start()
        defer { wrongListener.stop() }
        let wrongHost = Process()
        wrongHost.executableURL = URL(fileURLWithPath: host)
        wrongHost.arguments = ["chrome-extension://\(String(repeating: "a", count: 32))/"]
        wrongHost.standardInput = Pipe()
        wrongHost.standardOutput = Pipe()
        wrongHost.standardError = Pipe()
        try wrongHost.run()
        defer {
            if wrongHost.isRunning { wrongHost.terminate() }
            wrongHost.waitUntilExit()
        }
        guard rejected.opened.wait(timeout: .now() + 1) == .timedOut else {
            throw CheckError.failed("wrong host CDHash was accepted")
        }
        print("PASS: signed host/listener frames; wrong host CDHash rejected; no Chrome opened")
    }
}
