import Foundation

/// The development UI's one-writer intake. This prepares a committed command,
/// sends exactly one typed request, and records it as active only after delivery.
/// The controller still validates every command and owns effect authority.
@MainActor
final class DevTaskIntake {
    enum Surface: Equatable {
        case managed, managedNavigation, portal, native, nativeNavigation
        case nativeLocate, nativeOpen, chrome

        var usesNativeWorker: Bool {
            switch self {
            case .native, .nativeNavigation, .nativeLocate, .nativeOpen: true
            default: false
            }
        }
    }

    enum NativeTarget {
        case captured(bundleID: String, pid: Int, launchMillis: Int64)
        case explicit(bundleID: String)
    }

    enum Intent {
        case managedFill(url: String, field: String, value: String)
        case managedNavigate(url: String, label: String, destination: String)
        case portal(url: String)
        case nativeFill(target: NativeTarget, field: String, value: String)
        case fixtureDocuments
        case fixtureFile(open: Bool)
        case chromeFill(connectionID: String, grantID: String, url: String,
                        field: String, value: String)

        var surface: Surface {
            switch self {
            case .managedFill: .managed
            case .managedNavigate: .managedNavigation
            case .portal: .portal
            case .nativeFill: .native
            case .fixtureDocuments: .nativeNavigation
            case .fixtureFile(let open): open ? .nativeOpen : .nativeLocate
            case .chromeFill: .chrome
            }
        }

        fileprivate var commandText: String {
            switch self {
            case .managedFill(let url, let field, let value):
                "Fill \(field) on \(url) with text: \(value)"
            case .managedNavigate(let url, let label, let destination):
                "Navigate via \(label) on \(url) to \(destination)"
            case .portal(let url):
                "Download fixture invoice INV-105 from \(url)"
            case .nativeFill(let target, let field, let value):
                switch target {
                case .captured:
                    "Fill \(field) with \(value)"
                case .explicit(let bundleID):
                    "Fill \(field) in \(bundleID) with text: \(value)"
                }
            case .fixtureDocuments:
                "Navigate synthetic fixture to Documents"
            case .fixtureFile(let open):
                open ? "Open synthetic fixture file Documents/Budget.xlsx"
                     : "Locate synthetic fixture file Documents/Budget.xlsx"
            case .chromeFill(_, _, let url, let field, let value):
                "Fill \(field) in existing Chrome tab \(url) with text: \(value)"
            }
        }

        fileprivate func request(taskID: String, command: [String: Any]) -> [String: Any] {
            switch self {
            case .managedFill(let url, let field, let value):
                return ["type": "start_fill", "requestId": taskID, "url": url,
                 "fieldLabel": field, "value": value, "command": command]
            case .managedNavigate(let url, let label, let destination):
                return ["type": "start_navigate", "requestId": taskID, "url": url,
                 "linkLabel": label, "destinationUrl": destination,
                 "command": command]
            case .portal(let url):
                return ["type": "start_portal_workflow", "requestId": taskID,
                 "url": url, "command": command]
            case .nativeFill(let target, let field, let value):
                var request: [String: Any] = ["type": "start_native_fill",
                    "requestId": taskID, "fieldLabel": field, "value": value,
                    "command": command]
                switch target {
                case .captured(let bundleID, let pid, let launchMillis):
                    request["bundleId"] = bundleID
                    request["targetPid"] = pid
                    request["targetLaunchMillis"] = launchMillis
                case .explicit(let bundleID):
                    request["bundleId"] = bundleID
                }
                return request
            case .fixtureDocuments:
                return ["type": "start_native_press", "requestId": taskID,
                    "bundleId": "com.aurium.systemone.fixture",
                    "folderName": "Documents",
                    "expectedWindowTitle": "SystemOne Fixture — Documents",
                    "command": command]
            case .fixtureFile(let open):
                return ["type": open ? "start_native_open" : "start_native_locate",
                    "requestId": taskID, "bundleId": "com.aurium.systemone.fixture",
                    "folderName": "Documents", "fileName": "Budget.xlsx",
                    "expectedWindowTitle": open
                        ? "SystemOne Fixture — Documents — Budget.xlsx opened"
                        : "SystemOne Fixture — Documents — Budget.xlsx selected",
                    "command": command]
            case .chromeFill(let connectionID, let grantID, _, let field, let value):
                return ["type": "start_chrome_fill", "requestId": taskID,
                    "connectionId": connectionID, "grantId": grantID,
                    "fieldLabel": field, "value": value, "command": command]
            }
        }
    }

    private(set) var activeRequestID: String?
    private(set) var activeSurface: Surface?
    private(set) var activeGoalRevision = 1
    private var replacement: (taskID: String, sourceID: String, surface: Surface, mode: String, revision: Int)?
    var replacementRequestID: String? { replacement?.taskID }

    @discardableResult
    func submit(_ intent: Intent, originalText: String? = nil, voice: Bool = false,
                send: ([String: Any]) -> Bool) -> Bool {
        guard activeRequestID == nil else { return false }
        let taskID = UUID().uuidString.lowercased()
        let command: [String: Any] = [
            "type": "command", "protocolVersion": "2.0",
            "messageId": UUID().uuidString.lowercased(),
            "taskId": taskID, "taskEpoch": 1, "goalRevision": 1,
            "source": voice ? "voice" : "text", "mode": "command",
            "utteranceId": UUID().uuidString.lowercased(),
            "utteranceRevision": 1,
            "text": originalText ?? intent.commandText, "isFinal": true,
            "createdAt": ISO8601DateFormatter().string(from: Date()),
            "originSurface": ["adapter": "native", "surfaceId": "systemone-panel",
                "appBundleId": "com.aurium.systemone.dev",
                "windowId": "command-panel", "contentRevision": taskID],
        ]
        guard send(intent.request(taskID: taskID, command: command)) else { return false }
        activeRequestID = taskID
        activeSurface = intent.surface
        return true
    }

    /// A correction keeps the old writer until the host returns a linked task.
    /// Delivery is a final explicit command, not a Resume intent or admission.
    func replaceFixture(_ intent: Intent, send: ([String: Any]) -> Bool) -> Bool {
        guard let sourceID = activeRequestID, replacement == nil,
              let surface = activeSurface,
              [.nativeNavigation, .nativeLocate, .nativeOpen].contains(surface),
              intent.surface != surface else { return false }
        let mode: String
        switch intent {
        case .fixtureDocuments: mode = "navigate"
        case .fixtureFile(let open): mode = open ? "open" : "locate"
        default: return false
        }
        let taskID = UUID().uuidString.lowercased()
        let revision = activeGoalRevision + 1
        let command: [String: Any] = ["type": "command", "protocolVersion": "2.0",
            "messageId": UUID().uuidString.lowercased(), "taskId": sourceID,
            "taskEpoch": 1, "goalRevision": revision, "source": "text", "mode": "command",
            "utteranceId": UUID().uuidString.lowercased(), "utteranceRevision": 1,
            "text": intent.commandText, "isFinal": true,
            "createdAt": ISO8601DateFormatter().string(from: Date()),
            "originSurface": ["adapter": "native", "surfaceId": "systemone-panel",
                "appBundleId": "com.aurium.systemone.dev", "windowId": "command-panel",
                "contentRevision": sourceID]]
        var payload = intent.request(taskID: taskID, command: command)
        payload.removeValue(forKey: "type"); payload.removeValue(forKey: "requestId")
        guard send(["type": "replace_native_fixture", "requestId": taskID,
            "targetRequestId": sourceID, "mode": mode, "replacement": payload]) else { return false }
        replacement = (taskID, sourceID, intent.surface, mode, revision)
        return true
    }

    func acceptReplacement(_ object: [String: Any]) -> Bool {
        guard let pending = replacement, activeRequestID == pending.sourceID,
              Set(object.keys) == ["type", "requestId", "targetRequestId", "taskId", "taskEpoch", "goalRevision", "mode"],
              object["type"] as? String == "native_replacement_task",
              object["requestId"] as? String == pending.taskID,
              object["taskId"] as? String == pending.taskID,
              object["targetRequestId"] as? String == pending.sourceID,
              object["taskEpoch"] as? Int == 1,
              object["goalRevision"] as? Int == pending.revision,
              object["mode"] as? String == pending.mode else { return false }
        activeRequestID = pending.taskID; activeSurface = pending.surface
        activeGoalRevision = pending.revision; replacement = nil
        return true
    }

    func rejectReplacement(requestID: String) {
        if replacement?.taskID == requestID { replacement = nil }
    }

    func releaseIfReady(requestID: String) {
        guard requestID == activeRequestID else { return }
        activeRequestID = nil
        activeSurface = nil
        activeGoalRevision = 1
        replacement = nil
    }

}
