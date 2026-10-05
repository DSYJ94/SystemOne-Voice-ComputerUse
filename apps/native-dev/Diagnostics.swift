import AppKit

/// JSON for a message, or nil. `try? JSONSerialization.data` does not protect: an invalid value
/// (NaN, a non-JSON type) raises an Objective-C exception that aborts the app, so check first.
func jsonData(_ object: Any) -> Data? {
    guard JSONSerialization.isValidJSONObject(object) else { return nil }
    return try? JSONSerialization.data(withJSONObject: object)
}

/// Local logs and problem reports, kept in ~/Library/Logs/SystemOne Dev (readable only by
/// the user). Nothing is sent anywhere: "Report a Problem…" writes a file and shows it.
@MainActor
enum Diagnostics {
    static let folder: URL = {
        let url = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/SystemOne Dev", isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return url
    }()

    /// A log file opened for appending, rotated to `.1` once it passes 2 MB.
    static func logFile(_ name: String) -> FileHandle? {
        let url = folder.appendingPathComponent(name)
        let manager = FileManager.default
        if let size = (try? manager.attributesOfItem(atPath: url.path))?[.size] as? Int, size > 2_000_000 {
            let old = folder.appendingPathComponent(name + ".1")
            try? manager.removeItem(at: old)
            try? manager.moveItem(at: url, to: old)
        }
        if !manager.fileExists(atPath: url.path) {
            manager.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o600])
        }
        let handle = try? FileHandle(forWritingTo: url)
        _ = try? handle?.seekToEnd()
        return handle
    }

    private static let appLog = logFile("app.log")

    static func log(_ message: String) {
        let line = "\(ISO8601DateFormatter().string(from: Date())) \(message)\n"
        appLog?.write(Data(line.utf8))
    }

    /// Writes a plain-text report (versions, permissions, settings, recent logs and request
    /// outlines) into the Logs folder and returns its location.
    static func writeReport(permissions: [(String, Bool)], settings: [(String, String)]) -> URL? {
        let process = ProcessInfo.processInfo
        var text = "SystemOne problem report — \(Date())\n"
        text += "macOS \(process.operatingSystemVersionString)\n"
        text += "App \(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev")\n\n"
        text += "Permissions\n" + permissions.map { "  \($0.0): \($0.1 ? "allowed" : "not allowed")" }.joined(separator: "\n") + "\n\n"
        text += "Settings\n" + settings.map { "  \($0.0): \($0.1)" }.joined(separator: "\n") + "\n\n"
        for name in ["app.log", "controller.log"] {
            let lines = (try? String(contentsOf: folder.appendingPathComponent(name), encoding: .utf8))?
                .split(separator: "\n").suffix(150) ?? []
            text += "Last lines of \(name)\n" + lines.joined(separator: "\n") + "\n\n"
        }
        // Recent requests in outline only: what was asked, the kinds of steps, how it ended.
        let traces = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/SystemOne-Dev/traces")
        let recent = ((try? FileManager.default.contentsOfDirectory(atPath: traces.path)) ?? []).sorted().suffix(10)
        text += "Recent requests\n"
        for file in recent {
            guard let body = try? String(contentsOf: traces.appendingPathComponent(file), encoding: .utf8) else { continue }
            var goal = "", steps: [String] = [], end = ""
            for line in body.split(separator: "\n") {
                guard let event = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any] else { continue }
                switch event["kind"] as? String {
                case "goal": goal = event["goal"] as? String ?? ""
                case "step": steps.append(event["chosen"] as? String ?? "?")
                case "stopped": end = "stopped: \(event["reason"] as? String ?? "")"
                case "end": if end.isEmpty { end = event["outcome"] as? String ?? "" }
                default: break
                }
            }
            text += "  \(file.prefix(19))  “\(goal)”  [\(steps.joined(separator: " → "))]  \(end)\n"
        }
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        let url = folder.appendingPathComponent("SystemOne report \(stamp).txt")
        guard FileManager.default.createFile(atPath: url.path, contents: Data(text.utf8), attributes: [.posixPermissions: 0o600]) else {
            return nil
        }
        return url
    }
}
