import Darwin
import Foundation
import PeerIdentity

private enum CheckError: Error {
    case failed(String)
}

private let extensionId = String(repeating: "a", count: 32)

private func address(_ path: String) -> (sockaddr_un, socklen_t) {
    var value = sockaddr_un()
    value.sun_family = sa_family_t(AF_UNIX)
    value.sun_len = UInt8(path.utf8.count + 3)
    withUnsafeMutablePointer(to: &value.sun_path) { pointer in
        pointer.withMemoryRebound(to: CChar.self, capacity: 104) { characters in
            _ = path.withCString { strlcpy(characters, $0, 104) }
        }
    }
    return (value, socklen_t(value.sun_len))
}

private func waitReadable(_ fd: Int32) throws {
    var value = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
    guard poll(&value, 1, 5_000) > 0 else { throw CheckError.failed("read timeout") }
}

private func readExact(_ fd: Int32, count: Int) throws -> Data {
    var result = Data()
    while result.count < count {
        try waitReadable(fd)
        var buffer = [UInt8](repeating: 0, count: count - result.count)
        let capacity = buffer.count
        let length = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, capacity) }
        guard length > 0 else { throw CheckError.failed("short read") }
        result.append(contentsOf: buffer.prefix(length))
    }
    return result
}

private func frame(_ value: String) -> Data {
    let body = Data(value.utf8)
    let size = UInt32(body.count)
    return Data([UInt8(truncatingIfNeeded: size), UInt8(truncatingIfNeeded: size >> 8),
                 UInt8(truncatingIfNeeded: size >> 16), UInt8(truncatingIfNeeded: size >> 24)]) + body
}

private func readFrame(_ fd: Int32) throws -> String {
    let header = [UInt8](try readExact(fd, count: 4))
    let count = Int(UInt32(header[0]) | (UInt32(header[1]) << 8)
        | (UInt32(header[2]) << 16) | (UInt32(header[3]) << 24))
    guard count > 0 && count <= 65_536,
          let text = String(data: try readExact(fd, count: count), encoding: .utf8) else {
        throw CheckError.failed("invalid response frame")
    }
    return text
}

private func launchHost(_ binary: String, origin: String) throws -> (Process, Pipe, Pipe) {
    let process = Process()
    let input = Pipe()
    let output = Pipe()
    process.executableURL = URL(fileURLWithPath: binary)
    process.arguments = [origin]
    process.standardInput = input
    process.standardOutput = output
    process.standardError = Pipe()
    try process.run()
    return (process, input, output)
}

private func waitForExit(_ process: Process) throws {
    for _ in 0..<300 {
        if !process.isRunning { process.waitUntilExit(); return }
        usleep(10_000)
    }
    process.terminate()
    process.waitUntilExit()
    throw CheckError.failed("host exit timeout")
}

private func oneRun(binary: String, directory: String, wrongHash: Bool) throws {
    let socketPath = "\(directory)/controller-\(wrongHash ? "bad" : "ok").sock"
    unlink(socketPath)
    defer { unlink(socketPath) }
    _ = umask(0o077)
    let listener = socket(AF_UNIX, SOCK_STREAM, 0)
    guard listener >= 0 else { throw CheckError.failed("listener socket") }
    defer { close(listener) }
    var (socketAddress, socketLength) = address(socketPath)
    let bound = withUnsafePointer(to: &socketAddress) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.bind(listener, $0, socketLength)
        }
    }
    guard bound == 0, listen(listener, 1) == 0 else {
        throw CheckError.failed("listener bind")
    }
    let identity = try currentCodeIdentity()
    let config: [String: Any] = [
        "extensionId": extensionId,
        "testControllerSocketPath": socketPath,
        "controllerSigningIdentifier": identity.signingIdentifier,
        "controllerTeamIdentifier": identity.teamIdentifier as Any? ?? NSNull(),
        "controllerCDHashes": [wrongHash ? String(repeating: "f", count: 40) : identity.cdHash],
    ]
    let bytes = try JSONSerialization.data(withJSONObject: config)
    try bytes.write(to: URL(fileURLWithPath: directory).appendingPathComponent("ChromeNativeHost.json"))
    let (process, input, output) = try launchHost(binary,
        origin: "chrome-extension://\(extensionId)/")
    defer {
        input.fileHandleForWriting.closeFile()
        if process.isRunning { process.terminate() }
        process.waitUntilExit()
    }
    try waitReadable(listener)
    let client = accept(listener, nil, nil)
    guard client >= 0 else { throw CheckError.failed("controller accept") }
    defer { close(client) }
    let peer = try inspectConnectedUnixPeer(socket: client)
    guard peer.code.signingIdentifier == "com.aurium.systemone.chromenativehost" else {
        throw CheckError.failed("unexpected host signing identity")
    }
    if wrongHash {
        try waitForExit(process)
        guard process.terminationStatus != 0 else {
            throw CheckError.failed("wrong controller CDHash was accepted")
        }
        return
    }
    let sent = frame("{\"type\":\"hello\",\"challenge\":\"test\"}")
    input.fileHandleForWriting.write(sent)
    guard try readFrame(client) == "{\"type\":\"hello\",\"challenge\":\"test\"}" else {
        throw CheckError.failed("Chrome to controller frame changed")
    }
    let reply = frame("{\"type\":\"hello_ack\",\"challenge\":\"test\"}")
    _ = reply.withUnsafeBytes { Darwin.write(client, $0.baseAddress, $0.count) }
    guard try readFrame(output.fileHandleForReading.fileDescriptor)
        == "{\"type\":\"hello_ack\",\"challenge\":\"test\"}" else {
        throw CheckError.failed("controller to Chrome frame changed")
    }
    let (oversized, oversizedInput, _) = try launchHost(binary,
        origin: "chrome-extension://\(extensionId)/")
    defer { oversizedInput.fileHandleForWriting.closeFile() }
    try waitReadable(listener)
    let oversizedClient = accept(listener, nil, nil)
    guard oversizedClient >= 0 else { throw CheckError.failed("oversized accept") }
    defer { close(oversizedClient) }
    oversizedInput.fileHandleForWriting.write(Data([1, 0, 1, 0])) // 65,537 bytes
    try waitForExit(oversized)
    guard oversized.terminationStatus != 0 else {
        throw CheckError.failed("oversized Chrome frame was accepted")
    }
    let (impostor, impostorInput, _) = try launchHost(binary,
        origin: "chrome-extension://\(String(repeating: "b", count: 32))/")
    defer { impostorInput.fileHandleForWriting.closeFile() }
    try waitForExit(impostor)
    guard impostor.terminationStatus != 0 else {
        throw CheckError.failed("wrong extension origin was accepted")
    }
}

do {
    guard CommandLine.arguments.count == 3 else { throw CheckError.failed("usage") }
    try oneRun(binary: CommandLine.arguments[1], directory: CommandLine.arguments[2], wrongHash: false)
    try oneRun(binary: CommandLine.arguments[1], directory: CommandLine.arguments[2], wrongHash: true)
    print("PASS: Chrome framing and controller peer checks; no browser was opened")
} catch {
    FileHandle.standardError.write(Data("ChromeNativeHostCheck failed: \(error)\n".utf8))
    exit(1)
}
