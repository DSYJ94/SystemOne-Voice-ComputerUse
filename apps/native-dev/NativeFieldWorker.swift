import AppKit
import ApplicationServices
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
        let fence: NativeValueFence
        var preparedOnce = false
        var prepared: PreparedNativeValue<SystemAXBackend>?
        var preparationRef: String?
        var executionID: String?
        var permitRef: String?
        var verifyCandidateID: String?
        var verifyValue: String?

        init(taskID: String, target: AXTarget, backend: SystemAXBackend,
             registry: NativeAXObservationRegistry<SystemAXBackend>,
             observation: AXObservation, fence: NativeValueFence) {
            self.taskID = taskID
            self.target = target
            self.backend = backend
            self.registry = registry
            self.observation = observation
            self.fence = fence
        }
    }

    private let queue = DispatchQueue(label: "com.aurium.systemone.dev.native-ax",
                                      qos: .userInitiated)
    private let stopLock = NSLock()
    private var stoppedTaskIDs = Set<String>()
    private var activeFence: (taskID: String, fence: NativeValueFence)?
    private var state: State? // Accessed only on queue.

    func handle(_ data: Data, send: @escaping @Sendable (Data) -> Void) {
        guard data.count <= 16_384,
              let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              message["type"] as? String == "native_worker_request",
              let requestID = message["requestId"] as? String,
              let operation = message["operation"] as? String,
              let taskID = message["taskId"] as? String,
              Self.validID(requestID), Self.validID(taskID),
              ["observe", "prepare", "commit", "verify", "stop"].contains(operation) else {
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
        case "prepare": return prepare(message, taskID: taskID)
        case "commit": return commit(message, taskID: taskID)
        case "verify": return verify(message, taskID: taskID)
        default: return Self.failure(for: operation)
        }
    }

    private func observe(_ message: [String: Any], taskID: String) -> Any {
        guard AXIsProcessTrustedWithOptions(nil),
              let bundleID = message["bundleId"] as? String,
              bundleID.range(of: "^[A-Za-z0-9.-]{3,160}$",
                             options: .regularExpression) != nil else { return [:] }
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
                maxNodes: 80, maxDepth: 5, budget: .seconds(2))
            let observation = try registry.observe(target)
            if isStopped(taskID) { return [:] }
            let fence = NativeValueFence()
            state = State(taskID: taskID, target: target, backend: backend,
                registry: registry, observation: observation, fence: fence)
            setFence(taskID, fence)
            let controls: [[String: Any]] = observation.nodes.compactMap { node in
                let detail = node.description
                guard [kAXTextFieldRole as String, kAXTextAreaRole as String]
                    .contains(detail.role) else { return nil }
                return ["id": node.id, "role": detail.role,
                    "label": detail.secure ? "" : String(detail.label.prefix(160)),
                    "enabled": detail.enabled, "secure": detail.secure,
                    "canSetValue": detail.capabilities.contains("setValue")]
            }
            return ["observationId": observation.id,
                "scopeRef": observation.scopeRef, "bundleId": bundleID,
                "complete": observation.complete, "controls": controls]
        } catch { return [:] }
    }

    private func prepare(_ message: [String: Any], taskID: String) -> Any {
        guard let state, state.taskID == taskID,
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
              Self.validID(executionID), Self.validID(permitRef),
              Self.validDigest(actionDigest), Self.validDigest(candidateSetDigest),
              !node.description.secure else { return ["kind": "unsupported"] }
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
                return ["kind": "ready", "preparationRef": state.preparationRef!]
            }
        } catch { return ["kind": "unsupported"] }
    }

    private func commit(_ message: [String: Any], taskID: String) -> Any {
        guard let state, state.taskID == taskID,
              let prepared = state.prepared,
              let preparationRef = message["preparationRef"] as? String,
              let executionID = message["executionId"] as? String,
              let permitRef = message["permitRef"] as? String,
              preparationRef == state.preparationRef,
              executionID == state.executionID,
              permitRef == state.permitRef else { return "unknown" }
        state.prepared = nil // One-use before the AX call.
        // The host committed the durable boundary before sending this private
        // message. Release IPC must verify a signed host permit here.
        switch prepared.send(recordBoundary: {}) {
        case .verified: return "verified"
        case .notDispatched: return "not_dispatched"
        case .unknown: return "unknown"
        }
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
        case "observe": return [:]
        case "prepare": return ["kind": "unsupported"]
        case "commit": return "not_dispatched"
        case "verify", "stop": return false
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
