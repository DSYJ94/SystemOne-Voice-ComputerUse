import AppKit
import ApplicationServices
import Foundation

public protocol AXValueActionBackend: AXObservationBackend {
    /// Read only inside the native worker for a compare-before-write check.
    /// The prior value must not be serialized into a model/provider view.
    func value(of handle: Handle) throws -> String
    func setValue(_ value: String, on handle: Handle) throws
}

public enum NativeValueActionError: Error, Equatable {
    case unsupportedControl
    case invalidValue
    case targetChanged
    case stopped
}

public enum NativeValueOutcome: Equatable {
    case notDispatched
    case verified
    /// A setter may have taken effect even when it returned an error or its
    /// result could not be re-observed. The host must keep the journal unknown.
    case unknown
}

enum NativeDispatchResult {
    case notDispatched
    case returned
    case unknown
}

/// One-use local gate. Stop waits for an action already inside `run` to return,
/// then prevents any later action. It cannot undo a completed action or bound
/// an AX call that ignores its per-element messaging timeout. The UI must call
/// Stop off the main thread when waiting for this fence.
public final class NativeActionFence: @unchecked Sendable {
    private let dispatchLock = NSLock()
    private let stateLock = NSLock()
    private var used = false
    private var stopRequested = false

    public init() {}

    public func stop() {
        stateLock.lock()
        stopRequested = true
        stateLock.unlock()
        // Acknowledgement waits until any setter inside run has returned.
        dispatchLock.lock()
        dispatchLock.unlock()
    }

    public var isStopped: Bool {
        stateLock.lock()
        defer { stateLock.unlock() }
        return stopRequested
    }

    func run(_ operation: () -> NativeDispatchResult) -> NativeDispatchResult {
        dispatchLock.lock()
        defer { dispatchLock.unlock() }
        guard !used, !isStopped else { return .notDispatched }
        used = true
        return operation()
    }
}

/// Kept for existing value-action callers; the same one-use barrier also
/// protects other native semantic actions.
public typealias NativeValueFence = NativeActionFence

public enum NativeValuePreparation<Backend: AXValueActionBackend> {
    /// Current value matched before an action; the host still owns final
    /// completion and must treat a later change as fresh interference.
    case matchedAtPreflight
    case ready(PreparedNativeValue<Backend>)
}

/// A private observation-scoped native handle and prior value. The owner must
/// persist its dispatch boundary through `recordBoundary` before AX receives a
/// setter. A proposal or serialized node ID alone cannot invoke this object.
public final class PreparedNativeValue<Backend: AXValueActionBackend> {
    private let backend: Backend
    private let registry: NativeAXObservationRegistry<Backend>
    private let target: AXTarget
    private let observationID: String
    private let nodeID: String
    private let expectedLabel: String
    private let priorValue: String
    private let requestedValue: String
    private let fence: NativeValueFence

    fileprivate init(backend: Backend, registry: NativeAXObservationRegistry<Backend>,
                     target: AXTarget, observationID: String, nodeID: String,
                     expectedLabel: String, priorValue: String, requestedValue: String,
                     fence: NativeValueFence) {
        self.backend = backend
        self.registry = registry
        self.target = target
        self.observationID = observationID
        self.nodeID = nodeID
        self.expectedLabel = expectedLabel
        self.priorValue = priorValue
        self.requestedValue = requestedValue
        self.fence = fence
    }

    /// Synchronous worker call. `recordBoundary` must commit durably or throw.
    /// No AX setter is sent if that callback fails or the target changed.
    public func send(recordBoundary: () throws -> Void) -> NativeValueOutcome {
        let dispatched = fence.run {
            let handle: Backend.Handle
            do {
                handle = try registry.resolve(observationID: observationID,
                                              nodeID: nodeID, target: target)
                guard try supported(handle),
                      try backend.value(of: handle) == priorValue,
                      !fence.isStopped else {
                    return .notDispatched
                }
                try recordBoundary()
                if fence.isStopped { return .notDispatched }
            } catch { return .notDispatched }
            do { try backend.setValue(requestedValue, on: handle) }
            catch { return .unknown }
            return .returned
        }
        switch dispatched {
        case .notDispatched: return .notDispatched
        case .unknown: return .unknown
        case .returned: break
        }
        do {
            let handle = try registry.resolve(observationID: observationID,
                                              nodeID: nodeID, target: target)
            let matched = try supported(handle)
                && backend.value(of: handle) == requestedValue
            return matched && !fence.isStopped ? .verified : .unknown
        } catch { return .unknown }
    }

    private func supported(_ handle: Backend.Handle) throws -> Bool {
        let description = try backend.describe(handle)
        return !description.secure && description.enabled
            && description.label == expectedLabel
            && [kAXTextFieldRole as String, kAXTextAreaRole as String]
                .contains(description.role)
            && description.capabilities.contains("setValue")
            && backend.belongsToTarget(handle, target: target)
    }
}

/// The host chooses a concrete observed node; the worker binds that node to an
/// exact target, label and prior value. Duplicate labels remain distinct IDs.
public func prepareNativeValue<Backend: AXValueActionBackend>(
    backend: Backend, registry: NativeAXObservationRegistry<Backend>,
    target: AXTarget, observation: AXObservation, nodeID: String,
    expectedLabel: String, requestedValue: String,
    fence: NativeValueFence
) throws -> NativeValuePreparation<Backend> {
    guard requestedValue.utf8.count <= 4_096 else {
        throw NativeValueActionError.invalidValue
    }
    guard observation.scopeRef == target.scopeRef,
          !expectedLabel.isEmpty,
          let candidate = observation.nodes.first(where: { $0.id == nodeID }),
          candidate.description.label == expectedLabel,
          candidate.description.enabled, !candidate.description.secure,
          [kAXTextFieldRole as String, kAXTextAreaRole as String]
            .contains(candidate.description.role),
          candidate.description.capabilities.contains("setValue") else {
        throw NativeValueActionError.unsupportedControl
    }
    guard !fence.isStopped else { throw NativeValueActionError.stopped }
    let handle: Backend.Handle
    do {
        handle = try registry.resolve(observationID: observation.id,
                                      nodeID: nodeID, target: target)
    } catch { throw NativeValueActionError.targetChanged }
    let before = try backend.value(of: handle)
    if before == requestedValue { return .matchedAtPreflight }
    return .ready(PreparedNativeValue(backend: backend, registry: registry,
                                      target: target, observationID: observation.id,
                                      nodeID: nodeID, expectedLabel: expectedLabel,
                                      priorValue: before, requestedValue: requestedValue,
                                      fence: fence))
}
