import Darwin
import Foundation
import SQLite3

/// Worker-owned replay fence. A successful insert is durable before an AX
/// setter may run. It records identifiers and a digest, never field values.
/// This does not authenticate the host or replace a release-signed permit.
final class NativeWorkerPermitLedger {
    enum LedgerError: Error { case unsafePath, unavailable }

    private var database: OpaquePointer?

    init(path: URL) throws {
        let directory = path.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        try Self.checkOwnedPath(directory, mode: 0o700, directory: true)
        if FileManager.default.fileExists(atPath: path.path) {
            try Self.checkOwnedPath(path, mode: 0o600, directory: false)
        } else {
            let descriptor = open(path.path, O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, 0o600)
            guard descriptor >= 0 else { throw LedgerError.unsafePath }
            guard close(descriptor) == 0 else { throw LedgerError.unavailable }
        }
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(path.path, &database, flags, nil) == SQLITE_OK,
              let database else {
            if let database { sqlite3_close(database) }
            self.database = nil
            throw LedgerError.unavailable
        }
        do {
            try Self.checkOwnedPath(path, mode: 0o600, directory: false)
            try execute("PRAGMA journal_mode = DELETE;")
            try execute("PRAGMA synchronous = FULL;")
            try execute("PRAGMA busy_timeout = 1000;")
            try execute("CREATE TABLE IF NOT EXISTS consumed ("
                + "execution_id TEXT PRIMARY KEY, permit_ref TEXT NOT NULL UNIQUE, "
                + "task_id TEXT NOT NULL, action_digest TEXT NOT NULL);")
            try checkIntegrity()
        } catch {
            sqlite3_close(database)
            self.database = nil
            throw error
        }
    }

    deinit { if let database { sqlite3_close(database) } }

    /// Returns false for replay or storage failure. The caller must leave the
    /// effect unknown in either case and must not invoke the setter.
    func consume(executionID: String, permitRef: String, taskID: String,
                 actionDigest: String) -> Bool {
        guard let database,
              [executionID, permitRef, taskID].allSatisfy({
                  $0.range(of: "^[A-Za-z0-9_.:-]{1,160}$",
                           options: .regularExpression) != nil
              }),
              actionDigest.range(of: "^[a-f0-9]{64}$",
                                    options: .regularExpression) != nil else {
            return false
        }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database,
            "INSERT INTO consumed VALUES (?, ?, ?, ?)", -1,
            &statement, nil) == SQLITE_OK, let statement else { return false }
        defer { sqlite3_finalize(statement) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        guard sqlite3_bind_text(statement, 1, executionID, -1, transient) == SQLITE_OK,
              sqlite3_bind_text(statement, 2, permitRef, -1, transient) == SQLITE_OK,
              sqlite3_bind_text(statement, 3, taskID, -1, transient) == SQLITE_OK,
              sqlite3_bind_text(statement, 4, actionDigest, -1, transient) == SQLITE_OK else {
            return false
        }
        return sqlite3_step(statement) == SQLITE_DONE
    }

    private func execute(_ sql: String) throws {
        guard let database, sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else {
            throw LedgerError.unavailable
        }
    }

    private func checkIntegrity() throws {
        guard let database else { throw LedgerError.unavailable }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, "PRAGMA quick_check", -1,
                                 &statement, nil) == SQLITE_OK,
              let statement else { throw LedgerError.unavailable }
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW,
              String(cString: sqlite3_column_text(statement, 0)) == "ok",
              sqlite3_step(statement) == SQLITE_DONE else {
            throw LedgerError.unavailable
        }
    }

    private static func checkOwnedPath(_ path: URL, mode: Int,
                                       directory: Bool) throws {
        var info = stat()
        guard lstat(path.path, &info) == 0,
              info.st_uid == geteuid(),
              Int(info.st_mode & 0o777) == mode,
              directory ? (info.st_mode & S_IFMT) == S_IFDIR
                        : (info.st_mode & S_IFMT) == S_IFREG else {
            throw LedgerError.unsafePath
        }
    }
}
