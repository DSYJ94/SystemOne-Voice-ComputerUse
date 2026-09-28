import AppKit
import ApplicationServices
import CryptoKit
import Foundation

/// Development-only AppKit-side AX worker. All retained handles and prepared
/// actions stay on one private queue; Stop registers on a separate lock before
/// waiting for that queue. The Node controller owns the journal and admission.
final class DevNativeFieldWorker: @unchecked Sendable {
    private final class State {
        let taskID: String
        let target: AXTarget
        let backend: SystemAXBackend
        let registry: NativeAXObservationRegistry<SystemAXBackend>
        let observation: AXObservation
        let projectedControls: [[String: Any]]
        let fence: NativeValueFence
        let mode: String
        var preparedOnce = false
        var prepared: PreparedNativeValue<SystemAXBackend>?
        var preparedPress: PreparedNativePress<SystemAXBackend>?
        var preparationRef: String?
        var executionID: String?
        var permitRef: String?
        var actionDigest: String?
        var candidateSetDigest: String?
        var preparedCandidateID: String?
        var verifyCandidateID: String?
        var verifyValue: String?
        var expectedWindowTitle: String?

        init(taskID: String, target: AXTarget, backend: SystemAXBackend,
             registry: NativeAXObservationRegistry<SystemAXBackend>,
             observation: AXObservation, projectedControls: [[String: Any]],
             fence: NativeValueFence, mode: String) {
            self.taskID = taskID
            self.target = target
            self.backend = backend
            self.registry = registry
            self.observation = observation
            self.projectedControls = projectedControls
            self.fence = fence
            self.mode = mode
        }
    }

    private let queue = DispatchQueue(label: "com.aurium.systemone.dev.native-ax",
                                      qos: .userInitiated)
    private let stopLock = NSLock()
    private var stoppedTaskIDs = Set<String>()
    private var activeFence: (taskID: String, fence: NativeValueFence)?
    private var state: State? // Accessed only on queue.
    private var permitLedger: NativeWorkerPermitLedger? // Accessed only on queue.
    private var hostPublicKey: Curve25519.Signing.PublicKey? // Accessed only on queue.

    func installHostPublicKey(_ key: Curve25519.Signing.PublicKey) {
        queue.async { [self] in hostPublicKey = key }
    }

    func invalidateHostPublicKey() {
        queue.async { [self] in
            hostPublicKey = nil
            state?.fence.stop()
            state = nil
        }
    }

    func handle(_ data: Data, send: @escaping @Sendable (Data) -> Void) {
        guard data.count <= 16_384,
              let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              message["type"] as? String == "native_worker_request",
              let requestID = message["requestId"] as? String,
              let operation = message["operation"] as? String,
              let taskID = message["taskId"] as? String,
              Self.validID(requestID), Self.validID(taskID),
              ["observe", "prepare", "commit", "verify", "observe_press",
               "prepare_press", "commit_press", "verify_press", "stop"]
                .contains(operation) else {
            return // Malformed private request times out at the host.
        }
        if operation == "stop" {
            requestLocalStop(taskID)
            let fence = fenceForTask(taskID)
            DispatchQueue.global(qos: .userInitiated).async { [self] in
                fence?.stop()
                queue.async { [self] in
                    if state?.taskID == taskID { state = nil }
                    clearFence(taskID)
                    Self.sendReply(requestID, operation, result: true, using: send)
                }
            }
            return
        }
        queue.async { [self] in
            guard let parsed = (try? JSONSerialization.jsonObject(with: data))
                as? [String: Any] else { return }
            let result = process(parsed, operation: operation, taskID: taskID)
            Self.sendReply(requestID, operation, result: result, using: send)
        }
    }

    func requestLocalStop(_ taskID: String) {
        let fence: NativeValueFence?
        stopLock.lock()
        stoppedTaskIDs.insert(taskID)
        fence = activeFence?.taskID == taskID ? activeFence?.fence : nil
        stopLock.unlock()
        if let fence {
            DispatchQueue.global(qos: .userInitiated).async { fence.stop() }
        }
    }

    private func process(_ message: [String: Any], operation: String,
                         taskID: String) -> Any {
        if isStopped(taskID) { return Self.failure(for: operation) }
        switch operation {
        case "observe": return observe(message, taskID: taskID)
        case "observe_press": return observe(message, taskID: taskID, press: true)
        case "prepare": return prepare(message, taskID: taskID)
        case "prepare_press": return preparePress(message, taskID: taskID)
        case "commit": return commit(message, taskID: taskID)
        case "commit_press": return commitPress(message, taskID: taskID)
        case "verify": return verify(message, taskID: taskID)
        case "verify_press": return verifyPress(message, taskID: taskID)
        default: return Self.failure(for: operation)
        }
    }

    private func observe(_ message: [String: Any], taskID: String,
                         press: Bool = false) -> Any {
        guard AXIsProcessTrustedWithOptions(nil),
              let bundleID = message["bundleId"] as? String,
              bundleID.range(of: "^[A-Za-z0-9.-]{3,160}$",
                             options: .regularExpression) != nil,
              bundleID != Bundle.main.bundleIdentifier,
              (!press || bundleID == "com.aurium.systemone.fixture") else { return [:] }
        let running = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
            .filter { !$0.isTerminated && $0.bundleURL != nil && $0.launchDate != nil }
        guard running.count == 1, let app = running.first,
              let bundleURL = app.bundleURL, let launchDate = app.launchDate else {
            return [:]
        }
        state?.fence.stop()
        state = nil
        let target = AXTarget(pid: app.processIdentifier, bundleID: bundleID,
            bundleURL: bundleURL, launchDate: launchDate,
            scopeRef: "native:\(UUID().uuidString)")
        do {
            let backend = SystemAXBackend()
            let registry = try NativeAXObservationRegistry(backend: backend,
                maxNodes: press ? 160 : 80,
                maxDepth: press ? 8 : 5,
                budget: press ? .seconds(3) : .seconds(2))
            let observation = try registry.observe(target)
            if isStopped(taskID) { return [:] }
            let fence = NativeValueFence()
            let controls: [[String: Any]] = observation.nodes.compactMap { node in
                let detail = node.description
                if press {
                    guard [kAXButtonRole as String, kAXMenuItemRole as String]
                        .contains(detail.role) else { return nil }
                    return ["id": node.id, "role": detail.role,
                        "label": detail.secure ? "" : String(detail.label.prefix(160)),
                        "enabled": detail.enabled, "secure": detail.secure,
                        "canPress": detail.capabilities.contains("press")]
                }
                guard [kAXTextFieldRole as String, kAXTextAreaRole as String]
                    .contains(detail.role) else { return nil }
                return ["id": node.id, "role": detail.role,
                    "label": detail.secure ? "" : String(detail.label.prefix(160)),
                    "enabled": detail.enabled, "secure": detail.secure,
                    "canSetValue": detail.capabilities.contains("setValue")]
            }
            state = State(taskID: taskID, target: target, backend: backend,
                registry: registry, observation: observation,
                projectedControls: controls, fence: fence,
                mode: press ? "press" : "fill")
            setFence(taskID, fence)
            var result: [String: Any] = ["observationId": observation.id,
                "scopeRef": observation.scopeRef, "bundleId": bundleID,
                "complete": observation.complete, "controls": controls]
            if press { result["windowTitles"] = try backend.windowTitles(for: target) }
            return result
        } catch { return [:] }
    }

    private func prepare(_ message: [String: Any], taskID: String) -> Any {
        guard let state, state.taskID == taskID, state.mode == "fill",
              !state.preparedOnce,
              let observationID = message["observationId"] as? String,
              observationID == state.observation.id,
              let candidateID = message["candidateId"] as? String,
              let node = state.observation.nodes.first(where: { $0.id == candidateID }),
              let value = message["value"] as? String, value.utf8.count <= 1_024,
              let executionID = message["executionId"] as? String,
              let permitRef = message["permitRef"] as? String,
              let actionDigest = message["actionDigest"] as? String,
              let candidateSetDigest = message["candidateSetDigest"] as? String,
              let policyRevision = message["policyRevision"] as? String,
              policyRevision == NativeWorkerPermitDigest.policyRevision,
              Self.validID(executionID), Self.validID(permitRef),
              Self.validDigest(actionDigest), Self.validDigest(candidateSetDigest),
              !node.description.secure else { return ["kind": "unsupported"] }
        guard let presented = state.projectedControls.first(where: {
                  $0["id"] as? String == candidateID }),
              let label = presented["label"] as? String,
              NativeWorkerPermitDigest.matches(
                  controls: state.projectedControls,
                  taskID: taskID, scopeRef: state.observation.scopeRef,
                  observationID: observationID, candidateID: candidateID,
                  label: label, value: value, policyRevision: policyRevision,
                  candidateSetDigest: candidateSetDigest,
                  actionDigest: actionDigest) else {
            return ["kind": "unsupported"]
        }
        state.preparedOnce = true
        do {
            let result = try prepareNativeValue(backend: state.backend,
                registry: state.registry, target: state.target,
                observation: state.observation, nodeID: candidateID,
                expectedLabel: node.description.label, requestedValue: value,
                fence: state.fence)
            switch result {
            case .matchedAtPreflight:
                state.verifyCandidateID = candidateID
                state.verifyValue = value
                return ["kind": "matched_at_preflight"]
            case .ready(let prepared):
                state.prepared = prepared
                state.preparationRef = UUID().uuidString
                state.executionID = executionID
                state.permitRef = permitRef
                state.actionDigest = actionDigest
                state.candidateSetDigest = candidateSetDigest
                state.preparedCandidateID = candidateID
                return ["kind": "ready", "preparationRef": state.preparationRef!]
            }
        } catch { return ["kind": "unsupported"] }
    }

    private func preparePress(_ message: [String: Any], taskID: String) -> Any {
        guard let state, state.taskID == taskID, state.mode == "press",
              state.target.bundleID == "com.aurium.systemone.fixture",
              !state.preparedOnce,
              let observationID = message["observationId"] as? String,
              observationID == state.observation.id,
              let candidateID = message["candidateId"] as? String,
              let node = state.observation.nodes.first(where: { $0.id == candidateID }),
              let expectedTitle = message["expectedWindowTitle"] as? String,
              node.description.role == (kAXButtonRole as String),
              ((expectedTitle == "SystemOne Fixture — Documents"
                && node.description.label == "Documents")
               || (expectedTitle == "SystemOne Fixture — Documents — Budget.xlsx selected"
                && node.description.label == "Budget.xlsx")
               || (expectedTitle == "SystemOne Fixture — Documents — Budget.xlsx opened"
                && node.description.label == "Open selected file")),
              let executionID = message["executionId"] as? String,
              let permitRef = message["permitRef"] as? String,
              let actionDigest = message["actionDigest"] as? String,
              let candidateSetDigest = message["candidateSetDigest"] as? String,
              let policyRevision = message["policyRevision"] as? String,
              Self.validID(executionID), Self.validID(permitRef),
              Self.validDigest(actionDigest), Self.validDigest(candidateSetDigest),
              NativeWorkerPermitDigest.pressMatches(
                  controls: state.projectedControls, taskID: taskID,
                  scopeRef: state.observation.scopeRef,
                  observationID: observationID, candidateID: candidateID,
                  role: node.description.role, label: node.description.label,
                  expectedWindowTitle: expectedTitle,
                  policyRevision: policyRevision,
                  candidateSetDigest: candidateSetDigest,
                  actionDigest: actionDigest) else {
            return ["kind": "unsupported"]
        }
        state.preparedOnce = true
        do {
            if expectedTitle == "SystemOne Fixture — Documents — Budget.xlsx selected" {
                guard try state.backend.windowTitles(for: state.target)
                    == ["SystemOne Fixture — Documents"] else {
                    return ["kind": "unsupported"]
                }
            } else if expectedTitle
                == "SystemOne Fixture — Documents — Budget.xlsx opened" {
                guard try state.backend.windowTitles(for: state.target)
                    == ["SystemOne Fixture — Documents — Budget.xlsx selected"] else {
                    return ["kind": "unsupported"]
                }
            }
            state.preparedPress = try prepareNativePress(backend: state.backend,
                registry: state.registry, target: state.target,
                observation: state.observation, nodeID: candidateID,
                expectedRole: node.description.role,
                expectedLabel: node.description.label, fence: state.fence)
            state.preparationRef = UUID().uuidString
            state.executionID = executionID
            state.permitRef = permitRef
            state.actionDigest = actionDigest
            state.candidateSetDigest = candidateSetDigest
            state.preparedCandidateID = candidateID
            state.expectedWindowTitle = expectedTitle
            return ["kind": "ready", "preparationRef": state.preparationRef!]
        } catch { return ["kind": "unsupported"] }
    }

    private func commit(_ message: [String: Any], taskID: String) -> Any {
        guard Set(message.keys) == ["type", "requestId", "operation", "taskId",
              "executionId", "permitRef", "preparationRef", "permit",
              "expiresAtMs", "signature"],
              let state, state.taskID == taskID,
              let prepared = state.prepared,
              let preparationRef = message["preparationRef"] as? String,
              let executionID = message["executionId"] as? String,
              let permitRef = message["permitRef"] as? String,
              let actionDigest = state.actionDigest,
              let candidateSetDigest = state.candidateSetDigest,
              let candidateID = state.preparedCandidateID,
              let hostPublicKey,
              preparationRef == state.preparationRef,
              executionID == state.executionID,
              permitRef == state.permitRef else { return "unknown" }
        state.prepared = nil // One-use before the AX call.
        guard NativeHostPermit.verify(publicKey: hostPublicKey,
            message: message, taskID: taskID,
            preparationRef: preparationRef, executionID: executionID,
            permitRef: permitRef, scopeRef: state.observation.scopeRef,
            observationID: state.observation.id, candidateID: candidateID,
            candidateSetDigest: candidateSetDigest,
            actionDigest: actionDigest) else { return "unknown" }
        // The host committed its boundary before this message. Independently
        // consume in the worker before the AX setter; a restarted worker must
        // never reuse this execution ID or permit reference.
        if permitLedger == nil {
            let support = FileManager.default.urls(for: .applicationSupportDirectory,
                in: .userDomainMask)[0]
                .appendingPathComponent("SystemOne-Dev", isDirectory: true)
            permitLedger = try? NativeWorkerPermitLedger(path: support
                .appendingPathComponent("native-worker-permits.sqlite"))
        }
        guard permitLedger?.consume(executionID: executionID, permitRef: permitRef,
                                    taskID: taskID, actionDigest: actionDigest) == true else {
            return "unknown"
        }
        // The per-process signature is tied to the checked child code identity
        // only in the bundled build. Release signing and peer qualification remain.
        switch prepared.send(recordBoundary: {
            if state.expectedWindowTitle
                == "SystemOne Fixture — Documents — Budget.xlsx selected" {
                guard try state.backend.windowTitles(for: state.target)
                    == ["SystemOne Fixture — Documents"] else {
                    throw NativePressActionError.targetChanged
                }
            } else if state.expectedWindowTitle
                == "SystemOne Fixture — Documents — Budget.xlsx opened" {
                guard try state.backend.windowTitles(for: state.target)
                    == ["SystemOne Fixture — Documents — Budget.xlsx selected"] else {
                    throw NativePressActionError.targetChanged
                }
            }
        }) {
        case .verified: return "verified"
        case .notDispatched: return "not_dispatched"
        case .unknown: return "unknown"
        }
    }

    private func commitPress(_ message: [String: Any], taskID: String) -> Any {
        guard Set(message.keys) == ["type", "requestId", "operation", "taskId",
              "executionId", "permitRef", "preparationRef", "permit",
              "expiresAtMs", "signature"],
              let state, state.taskID == taskID, state.mode == "press",
              let prepared = state.preparedPress,
              let preparationRef = message["preparationRef"] as? String,
              let executionID = message["executionId"] as? String,
              let permitRef = message["permitRef"] as? String,
              let actionDigest = state.actionDigest,
              let candidateSetDigest = state.candidateSetDigest,
              let candidateID = state.preparedCandidateID,
              let hostPublicKey,
              preparationRef == state.preparationRef,
              executionID == state.executionID,
              permitRef == state.permitRef else { return "unknown" }
        state.preparedPress = nil
        guard NativeHostPermit.verify(publicKey: hostPublicKey,
            message: message, taskID: taskID,
            preparationRef: preparationRef, executionID: executionID,
            permitRef: permitRef, scopeRef: state.observation.scopeRef,
            observationID: state.observation.id, candidateID: candidateID,
            candidateSetDigest: candidateSetDigest,
            actionDigest: actionDigest,
            policyRevision: NativeWorkerPermitDigest.pressPolicyRevision) else {
            return "unknown"
        }
        if permitLedger == nil {
            let support = FileManager.default.urls(for: .applicationSupportDirectory,
                in: .userDomainMask)[0]
                .appendingPathComponent("SystemOne-Dev", isDirectory: true)
            permitLedger = try? NativeWorkerPermitLedger(path: support
                .appendingPathComponent("native-worker-permits.sqlite"))
        }
        guard permitLedger?.consume(executionID: executionID,
            permitRef: permitRef, taskID: taskID,
            actionDigest: actionDigest) == true else { return "unknown" }
        switch prepared.send(recordBoundary: {}) {
        case .returnedUnverified: return "returned_unverified"
        case .notDispatched: return "not_dispatched"
        case .unknown: return "unknown"
        }
    }

    private func verifyPress(_ message: [String: Any], taskID: String) -> Any {
        guard let state, state.taskID == taskID, state.mode == "press",
              let expectedTitle = message["expectedWindowTitle"] as? String,
              ["SystemOne Fixture — Documents",
               "SystemOne Fixture — Documents — Budget.xlsx selected",
               "SystemOne Fixture — Documents — Budget.xlsx opened"]
                .contains(expectedTitle),
              (state.expectedWindowTitle == nil
                || expectedTitle == state.expectedWindowTitle),
              state.target.bundleID == "com.aurium.systemone.fixture" else {
            return false
        }
        do {
            let titles = try state.backend.windowTitles(for: state.target)
            return titles == [expectedTitle] && !isStopped(taskID)
        } catch { return false }
    }

    private func verify(_ message: [String: Any], taskID: String) -> Any {
        guard let state, state.taskID == taskID,
              let observationID = message["observationId"] as? String,
              observationID == state.observation.id,
              let candidateID = message["candidateId"] as? String,
              candidateID == state.verifyCandidateID,
              let value = message["value"] as? String,
              value == state.verifyValue else { return false }
        do {
            let handle = try state.registry.resolve(observationID: observationID,
                nodeID: candidateID, target: state.target)
            return try state.backend.value(of: handle) == value && !isStopped(taskID)
        } catch { return false }
    }

    private func isStopped(_ taskID: String) -> Bool {
        stopLock.lock()
        defer { stopLock.unlock() }
        return stoppedTaskIDs.contains(taskID)
    }

    private func fenceForTask(_ taskID: String) -> NativeValueFence? {
        stopLock.lock()
        defer { stopLock.unlock() }
        return activeFence?.taskID == taskID ? activeFence?.fence : nil
    }

    private func setFence(_ taskID: String, _ fence: NativeValueFence) {
        stopLock.lock()
        activeFence = (taskID, fence)
        stopLock.unlock()
    }

    private func clearFence(_ taskID: String) {
        stopLock.lock()
        if activeFence?.taskID == taskID { activeFence = nil }
        stopLock.unlock()
    }

    private static func validID(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9_.:-]{1,160}$",
                       options: .regularExpression) != nil
    }

    private static func validDigest(_ value: String) -> Bool {
        value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    }

    private static func failure(for operation: String) -> Any {
        switch operation {
        case "observe", "observe_press": return [:]
        case "prepare", "prepare_press": return ["kind": "unsupported"]
        case "commit", "commit_press": return "not_dispatched"
        case "verify", "verify_press", "stop": return false
        default: return [:]
        }
    }

    private static func sendReply(_ requestID: String, _ operation: String,
                                  result: Any, using send: @Sendable (Data) -> Void) {
        let reply: [String: Any] = ["type": "native_worker_reply",
            "requestId": requestID, "operation": operation, "result": result]
        if let data = try? JSONSerialization.data(withJSONObject: reply),
           data.count <= 16_384 { send(data) }
    }
}
