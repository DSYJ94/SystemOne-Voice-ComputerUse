import Darwin
import Foundation
import PeerIdentity

private let maxMessageBytes = 65_536
private let frameTimeoutMilliseconds: Int32 = 5_000

private enum BridgeError: Error {
    case invalidConfiguration
    case invalidCaller
    case malformedFrame
    case frameTooLarge
    case incompleteFrame
    case ioFailure
}

private struct Configuration: Decodable {
    let extensionId: String
    let controllerSigningIdentifier: String
    let controllerTeamIdentifier: String?
    let controllerCDHashes: [String]
    let testControllerSocketPath: String?

    var socketPath: String {
        #if DEBUG
        if let testControllerSocketPath { return testControllerSocketPath }
        #endif
        return FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/SystemOne/controller.sock").path
    }
}

private func config() throws -> Configuration {
    let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
    let path = executable.deletingLastPathComponent().appendingPathComponent("ChromeNativeHost.json")
    let attributes = try FileManager.default.attributesOfItem(atPath: path.path)
    guard let size = attributes[.size] as? NSNumber, size.intValue > 0,
          size.intValue <= 4_096 else { throw BridgeError.invalidConfiguration }
    let value = try JSONDecoder().decode(Configuration.self, from: Data(contentsOf: path))
    guard value.extensionId.range(of: "^[a-p]{32}$", options: .regularExpression) != nil,
          value.socketPath.hasPrefix("/"),
          !value.socketPath.utf8.contains(0),
          value.socketPath.utf8.count + 3 <= 104 else {
        throw BridgeError.invalidConfiguration
    }
    return value
}

private func unixAddress(_ path: String) -> (sockaddr_un, socklen_t) {
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(path.utf8.count + 3)
    withUnsafeMutablePointer(to: &address.sun_path) { pointer in
        pointer.withMemoryRebound(to: CChar.self, capacity: 104) { characters in
            _ = path.withCString { strlcpy(characters, $0, 104) }
        }
    }
    return (address, socklen_t(address.sun_len))
}

private func connectedController(_ configuration: Configuration) throws -> Int32 {
    let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else { throw BridgeError.ioFailure }
    do {
        var (address, length) = unixAddress(configuration.socketPath)
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(descriptor, $0, length)
            }
        }
        guard result == 0 else { throw BridgeError.ioFailure }
        let requirement = try PeerRequirement(
            effectiveUserID: geteuid(),
            signingIdentifier: configuration.controllerSigningIdentifier,
            teamIdentifier: configuration.controllerTeamIdentifier,
            allowedCDHashes: Set(configuration.controllerCDHashes))
        _ = try authenticateConnectedUnixPeer(socket: descriptor, requirement: requirement)
        return descriptor
    } catch {
        close(descriptor)
        throw error
    }
}

private func waitReadable(_ descriptor: Int32) throws {
    var pending = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
    while true {
        let result = poll(&pending, 1, frameTimeoutMilliseconds)
        if result > 0 { return }
        if result == 0 { throw BridgeError.incompleteFrame }
        if errno != EINTR { throw BridgeError.ioFailure }
    }
}

private func waitWritable(_ descriptor: Int32) throws {
    var pending = pollfd(fd: descriptor, events: Int16(POLLOUT), revents: 0)
    while true {
        let result = poll(&pending, 1, frameTimeoutMilliseconds)
        if result > 0 { return }
        if result == 0 { throw BridgeError.ioFailure }
        if errno != EINTR { throw BridgeError.ioFailure }
    }
}

private func makeNonblocking(_ descriptor: Int32) throws {
    let flags = fcntl(descriptor, F_GETFL)
    guard flags >= 0, fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0 else {
        throw BridgeError.ioFailure
    }
}

private func readExactly(_ descriptor: Int32, count: Int, allowCleanEOF: Bool = false) throws -> Data? {
    var result = Data()
    while result.count < count {
        try waitReadable(descriptor)
        var chunk = [UInt8](repeating: 0, count: min(count - result.count, 16_384))
        let capacity = chunk.count
        let received = chunk.withUnsafeMutableBytes { Darwin.read(descriptor, $0.baseAddress, capacity) }
        if received == 0 {
            if allowCleanEOF && result.isEmpty { return nil }
            throw BridgeError.incompleteFrame
        }
        if received < 0 {
            if errno == EINTR { continue }
            if errno == EAGAIN || errno == EWOULDBLOCK { continue }
            throw BridgeError.ioFailure
        }
        result.append(contentsOf: chunk.prefix(received))
    }
    return result
}

private func readFrame(_ descriptor: Int32) throws -> Data? {
    guard let header = try readExactly(descriptor, count: 4, allowCleanEOF: true) else { return nil }
    let bytes = [UInt8](header)
    let b0 = UInt32(bytes[0])
    let b1 = UInt32(bytes[1]) << 8
    let b2 = UInt32(bytes[2]) << 16
    let b3 = UInt32(bytes[3]) << 24
    let length = b0 | b1 | b2 | b3
    guard length > 0 else { throw BridgeError.malformedFrame }
    guard length <= maxMessageBytes else { throw BridgeError.frameTooLarge }
    return try readExactly(descriptor, count: Int(length))
}

private func writeAll(_ descriptor: Int32, bytes: Data) throws {
    try bytes.withUnsafeBytes { raw in
        guard let base = raw.baseAddress else { throw BridgeError.ioFailure }
        var offset = 0
        while offset < raw.count {
            try waitWritable(descriptor)
            let written = Darwin.write(descriptor, base.advanced(by: offset), raw.count - offset)
            if written < 0 {
                if errno == EINTR { continue }
                if errno == EAGAIN || errno == EWOULDBLOCK { continue }
                throw BridgeError.ioFailure
            }
            if written == 0 { throw BridgeError.ioFailure }
            offset += written
        }
    }
}

private func writeFrame(_ descriptor: Int32, message: Data) throws {
    guard !message.isEmpty, message.count <= maxMessageBytes else { throw BridgeError.frameTooLarge }
    let size = UInt32(message.count)
    let prefix = Data([
        UInt8(truncatingIfNeeded: size), UInt8(truncatingIfNeeded: size >> 8),
        UInt8(truncatingIfNeeded: size >> 16), UInt8(truncatingIfNeeded: size >> 24),
    ])
    try writeAll(descriptor, bytes: prefix)
    try writeAll(descriptor, bytes: message)
}

private func bridge(_ controller: Int32) throws {
    while true {
        var descriptors = [
            pollfd(fd: STDIN_FILENO, events: Int16(POLLIN), revents: 0),
            pollfd(fd: controller, events: Int16(POLLIN), revents: 0),
        ]
        let ready = descriptors.withUnsafeMutableBufferPointer {
            poll($0.baseAddress, nfds_t($0.count), -1)
        }
        if ready < 0 {
            if errno == EINTR { continue }
            throw BridgeError.ioFailure
        }
        if descriptors[0].revents != 0 {
            guard let message = try readFrame(STDIN_FILENO) else { return }
            try writeFrame(controller, message: message)
        }
        if descriptors[1].revents != 0 {
            guard let message = try readFrame(controller) else { return }
            try writeFrame(STDOUT_FILENO, message: message)
        }
    }
}

do {
    let configuration = try config()
    guard CommandLine.arguments.count == 2,
          CommandLine.arguments[1] == "chrome-extension://\(configuration.extensionId)/" else {
        throw BridgeError.invalidCaller
    }
    let controller = try connectedController(configuration)
    defer { close(controller) }
    try makeNonblocking(controller)
    try makeNonblocking(STDOUT_FILENO)
    try bridge(controller)
} catch {
    // Native messaging reserves stdout exclusively for framed JSON. Never log
    // payloads, task data or profile metadata, including on failure.
    FileHandle.standardError.write(Data("SystemOne Chrome host unavailable: \(error)\n".utf8))
    exit(1)
}
