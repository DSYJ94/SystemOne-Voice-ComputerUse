import Darwin
import Foundation

/// Development read-only Chrome transport. The caller supplies a release-pinned
/// host requirement; merely possessing a native-messaging origin string is not
/// enough. The Node child still decides whether a tab claim is admissible.
final class DevChromeListener: @unchecked Sendable {
    enum ListenerError: Error { case invalidPath, existingSocket, socketFailure }

    private let path: String
    private let requirement: PeerRequirement
    private let onOpen: @Sendable (String) -> Void
    private let onMessage: @Sendable (String, Data) -> Void
    private let onClosed: @Sendable (String) -> Void
    private let readQueue = DispatchQueue(label: "com.aurium.systemone.dev.chrome-read",
                                          qos: .userInitiated)
    private let writeQueue = DispatchQueue(label: "com.aurium.systemone.dev.chrome-write",
                                           qos: .userInitiated)
    private let lock = NSLock()
    private var listener: Int32 = -1
    private var active: (id: String, descriptor: Int32)?
    private var stopped = false
    private var ownsPath = false

    init(path: String, requirement: PeerRequirement,
         onOpen: @escaping @Sendable (String) -> Void,
         onMessage: @escaping @Sendable (String, Data) -> Void,
         onClosed: @escaping @Sendable (String) -> Void) {
        self.path = path
        self.requirement = requirement
        self.onOpen = onOpen
        self.onMessage = onMessage
        self.onClosed = onClosed
    }

    func start() throws {
        guard path.hasPrefix("/"), path.utf8.count + 3 <= 104,
              !path.utf8.contains(0),
              !FileManager.default.fileExists(atPath: path) else {
            throw ListenerError.invalidPath
        }
        var directory = stat()
        let parent = URL(fileURLWithPath: path).deletingLastPathComponent().path
        guard lstat(parent, &directory) == 0,
              (directory.st_mode & mode_t(S_IFMT)) == mode_t(S_IFDIR),
              directory.st_uid == geteuid(),
              (directory.st_mode & 0o077) == 0 else {
            throw ListenerError.invalidPath
        }
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw ListenerError.socketFailure }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(path.utf8.count + 3)
        withUnsafeMutablePointer(to: &address.sun_path) { pointer in
            pointer.withMemoryRebound(to: CChar.self, capacity: 104) { buffer in
                _ = path.withCString { strlcpy(buffer, $0, 104) }
            }
        }
        let addressLength = socklen_t(address.sun_len)
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(descriptor, $0, addressLength)
            }
        }
        guard bound == 0 else {
            Darwin.close(descriptor)
            throw ListenerError.existingSocket
        }
        guard chmod(path, 0o600) == 0,
              Darwin.listen(descriptor, 1) == 0 else {
            Darwin.close(descriptor)
            unlink(path)
            throw ListenerError.socketFailure
        }
        lock.lock()
        listener = descriptor
        ownsPath = true
        lock.unlock()
        readQueue.async { [self] in acceptLoop(descriptor) }
    }

    func stop() {
        let previous: (listener: Int32, active: Int32, ownsPath: Bool)
        lock.lock()
        stopped = true
        previous = (listener, active?.descriptor ?? -1, ownsPath)
        listener = -1
        ownsPath = false
        lock.unlock()
        if previous.active >= 0 { shutdown(previous.active, SHUT_RDWR) }
        if previous.listener >= 0 { Darwin.close(previous.listener) }
        if previous.ownsPath { unlink(path) }
    }

    func closeConnection(_ connectionID: String) {
        let descriptor: Int32
        lock.lock()
        descriptor = active?.id == connectionID ? active!.descriptor : -1
        lock.unlock()
        if descriptor >= 0 { shutdown(descriptor, SHUT_RDWR) }
    }

    func send(_ data: Data, to connectionID: String) {
        guard !data.isEmpty, data.count <= 65_536 else {
            closeConnection(connectionID)
            return
        }
        let copy: Int32
        lock.lock()
        copy = active?.id == connectionID ? dup(active!.descriptor) : -1
        lock.unlock()
        guard copy >= 0 else { return }
        writeQueue.async { [self] in
            defer { Darwin.close(copy) }
            do { try writeFrame(copy, data) }
            catch { closeConnection(connectionID) }
        }
    }

    private func acceptLoop(_ descriptor: Int32) {
        while !isStopped() {
            var ready = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
            let result = poll(&ready, 1, 500)
            if result == 0 || (result < 0 && errno == EINTR) { continue }
            if result < 0 { break }
            let client = accept(descriptor, nil, nil)
            if client < 0 { continue }
            let id = UUID().uuidString.lowercased()
            var attached = false
            do {
                _ = try authenticateConnectedUnixPeer(socket: client,
                                                      requirement: requirement)
                let flags = fcntl(client, F_GETFL)
                guard flags >= 0, fcntl(client, F_SETFL, flags | O_NONBLOCK) == 0 else {
                    throw ListenerError.socketFailure
                }
                lock.lock()
                let canAttach = !stopped && active == nil
                if canAttach { active = (id, client); attached = true }
                lock.unlock()
                if attached {
                    onOpen(id)
                    try readMessages(client, connectionID: id)
                }
            } catch { /* The peer or frame failed closed. */ }
            if attached {
                lock.lock()
                if active?.id == id { active = nil }
                lock.unlock()
                shutdown(client, SHUT_RDWR)
                Darwin.close(client)
                onClosed(id)
            } else { Darwin.close(client) }
        }
    }

    private func readMessages(_ descriptor: Int32, connectionID: String) throws {
        while !isStopped() {
            var ready = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
            let status = poll(&ready, 1, 500)
            if status == 0 || (status < 0 && errno == EINTR) { continue }
            if status < 0 { throw ListenerError.socketFailure }
            guard let header = try readExact(descriptor, count: 4) else { return }
            let bytes = [UInt8](header)
            let count = Int(UInt32(bytes[0]) | (UInt32(bytes[1]) << 8)
                | (UInt32(bytes[2]) << 16) | (UInt32(bytes[3]) << 24))
            guard count > 0, count <= 32_768,
                  let body = try readExact(descriptor, count: count) else {
                throw ListenerError.socketFailure
            }
            onMessage(connectionID, body)
        }
    }

    private func readExact(_ descriptor: Int32, count: Int) throws -> Data? {
        var bytes = Data()
        while bytes.count < count {
            var ready = pollfd(fd: descriptor, events: Int16(POLLIN), revents: 0)
            guard poll(&ready, 1, 5_000) > 0 else { throw ListenerError.socketFailure }
            var chunk = [UInt8](repeating: 0, count: min(count - bytes.count, 16_384))
            let capacity = chunk.count
            let received = chunk.withUnsafeMutableBytes {
                Darwin.read(descriptor, $0.baseAddress, capacity)
            }
            if received == 0 { return nil }
            if received < 0 {
                if errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK { continue }
                throw ListenerError.socketFailure
            }
            bytes.append(contentsOf: chunk.prefix(received))
        }
        return bytes
    }

    private func writeFrame(_ descriptor: Int32, _ body: Data) throws {
        let size = UInt32(body.count)
        let header = Data([UInt8(truncatingIfNeeded: size),
                           UInt8(truncatingIfNeeded: size >> 8),
                           UInt8(truncatingIfNeeded: size >> 16),
                           UInt8(truncatingIfNeeded: size >> 24)])
        try writeAll(descriptor, header + body)
    }

    private func writeAll(_ descriptor: Int32, _ data: Data) throws {
        try data.withUnsafeBytes { raw in
            guard let base = raw.baseAddress else { throw ListenerError.socketFailure }
            var offset = 0
            while offset < raw.count {
                var ready = pollfd(fd: descriptor, events: Int16(POLLOUT), revents: 0)
                guard poll(&ready, 1, 5_000) > 0 else { throw ListenerError.socketFailure }
                let count = Darwin.write(descriptor, base.advanced(by: offset), raw.count - offset)
                if count < 0 {
                    if errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK { continue }
                    throw ListenerError.socketFailure
                }
                if count == 0 { throw ListenerError.socketFailure }
                offset += count
            }
        }
    }

    private func isStopped() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return stopped
    }
}
