import Darwin
import Foundation
import PeerIdentity

private func unixAddress(path: String) throws -> (sockaddr_un, socklen_t) {
    guard !path.utf8.contains(0), path.utf8.count + 3 <= 104 else {
        throw PeerIdentityError.invalidSocket
    }
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

private func client(path: String) throws -> Never {
    let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
    guard descriptor >= 0 else { throw PeerIdentityError.socketCall("socket", errno) }
    var (address, length) = try unixAddress(path: path)
    let result = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.connect(descriptor, $0, length)
        }
    }
    guard result == 0 else { throw PeerIdentityError.socketCall("connect", errno) }
    var marker: UInt8 = 1
    guard write(descriptor, &marker, 1) == 1 else {
        throw PeerIdentityError.socketCall("write", errno)
    }
    guard read(descriptor, &marker, 1) == 1 else {
        throw PeerIdentityError.socketCall("read", errno)
    }
    close(descriptor)
    exit(0)
}

private func verifyRequirementGuards() throws {
    do {
        _ = try PeerRequirement(effectiveUserID: geteuid(),
                                signingIdentifier: "com.aurium.systemone.peercheck")
        throw PeerIdentityError.requirementMismatch("identifier-only policy accepted")
    } catch PeerIdentityError.missingTrustAnchor {
        // Expected: an identifier is metadata until anchored by Team ID or CDHash.
    }
}

private func server(childPath: String, expectedRejection: String?) throws {
    try verifyRequirementGuards()
    let path = "/private/tmp/systemone-peer-\(getpid()).sock"
    unlink(path)
    defer { unlink(path) }
    _ = umask(0o077)
    let listener = socket(AF_UNIX, SOCK_STREAM, 0)
    guard listener >= 0 else { throw PeerIdentityError.socketCall("socket", errno) }
    defer { close(listener) }
    var (address, length) = try unixAddress(path: path)
    let bindResult = withUnsafePointer(to: &address) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.bind(listener, $0, length)
        }
    }
    guard bindResult == 0 else { throw PeerIdentityError.socketCall("bind", errno) }
    guard listen(listener, 1) == 0 else { throw PeerIdentityError.socketCall("listen", errno) }

    let process = Process()
    process.executableURL = URL(fileURLWithPath: childPath)
    process.arguments = ["--client", path]
    try process.run()
    defer {
        if process.isRunning {
            process.terminate()
            process.waitUntilExit()
        }
    }
    var listenerPoll = pollfd(fd: listener, events: Int16(POLLIN), revents: 0)
    guard poll(&listenerPoll, 1, 5_000) == 1 else {
        throw PeerIdentityError.socketCall("accept timeout", ETIMEDOUT)
    }
    let peer = accept(listener, nil, nil)
    guard peer >= 0 else { throw PeerIdentityError.socketCall("accept", errno) }
    defer { close(peer) }
    var marker: UInt8 = 0
    guard read(peer, &marker, 1) == 1 else { throw PeerIdentityError.socketCall("read", errno) }

    let hostCode = try currentCodeIdentity()
    let requirement = try PeerRequirement(
        effectiveUserID: geteuid(), signingIdentifier: hostCode.signingIdentifier,
        teamIdentifier: hostCode.teamIdentifier, allowedCDHashes: [hostCode.cdHash])
    var rejected: Error?
    do {
        let identity = try authenticateConnectedUnixPeer(socket: peer, requirement: requirement)
        print("accepted pid=\(identity.pid) pidVersion=\(identity.pidVersion) " +
              "identifier=\(identity.code.signingIdentifier) cdhash=\(identity.code.cdHash)")
    } catch {
        rejected = error
        print("rejected: \(error)")
    }
    marker = 1
    _ = write(peer, &marker, 1)
    process.waitUntilExit()
    guard process.terminationStatus == 0 else {
        throw PeerIdentityError.requirementMismatch("client termination")
    }
    if let expectedRejection {
        guard case let PeerIdentityError.requirementMismatch(actual)? = rejected,
              actual == expectedRejection else {
            throw PeerIdentityError.requirementMismatch("unexpected rejection reason or impostor accepted")
        }
    } else if let rejected {
        throw rejected
    }
}

do {
    let arguments = CommandLine.arguments
    if arguments.count == 3 && arguments[1] == "--client" {
        try client(path: arguments[2])
    }
    var childPath = arguments[0]
    var expectedRejection: String?
    var index = 1
    while index < arguments.count {
        switch arguments[index] {
        case "--child" where index + 1 < arguments.count:
            childPath = arguments[index + 1]
            index += 2
        case "--expect-reject" where index + 1 < arguments.count:
            expectedRejection = arguments[index + 1]
            index += 2
        default:
            throw PeerIdentityError.invalidRequirement
        }
    }
    try server(childPath: childPath, expectedRejection: expectedRejection)
} catch {
    FileHandle.standardError.write(Data("PeerIdentityCheck failed: \(error)\n".utf8))
    exit(1)
}
