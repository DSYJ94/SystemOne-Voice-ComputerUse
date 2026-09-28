import AppKit
import ApplicationServices
import Foundation

public protocol AXPressActionBackend: AXObservationBackend {
    func press(_ handle: Handle) throws
}

public enum NativePressActionError: Error, Equatable {
    case unsupportedControl
    case targetChanged
    case stopped
}

public enum NativePressOutcome: Equatable {
    case notDispatched
    /// AXPress returned, but the requested destination or effect has not yet
    /// been independently observed. The host must not call this completion.
    case returnedUnverified
    /// AXPress may have taken effect before an error or timeout.
    case unknown
}

/// An exact observation-scoped control, retained only inside the native worker.
/// The host must admit the effect, issue one-use authority, and durably record
/// the dispatch boundary before `press` is sent.
public final class PreparedNativePress<Backend: AXPressActionBackend> {
    private let backend: Backend
    private let registry: NativeAXObservationRegistry<Backend>
    private let target: AXTarget
    private let observationID: String
    private let nodeID: String
    private let expectedRole: String
    private let expectedLabel: String
    private let fence: NativeActionFence

    fileprivate init(backend: Backend, registry: NativeAXObservationRegistry<Backend>,
                     target: AXTarget, observationID: String, nodeID: String,
                     expectedRole: String, expectedLabel: String,
                     fence: NativeActionFence) {
        self.backend = backend
        self.registry = registry
        self.target = target
        self.observationID = observationID
        self.nodeID = nodeID
        self.expectedRole = expectedRole
        self.expectedLabel = expectedLabel
        self.fence = fence
    }

    public func send(recordBoundary: () throws -> Void) -> NativePressOutcome {
        let result = fence.run {
            let handle: Backend.Handle
            do {
                handle = try registry.resolve(observationID: observationID,
                                              nodeID: nodeID, target: target)
                let detail = try backend.describe(handle)
                guard detail.role == expectedRole,
                      detail.label == expectedLabel,
                      detail.enabled, !detail.secure,
                      detail.capabilities.contains("press"),
                      backend.belongsToTarget(handle, target: target),
                      !fence.isStopped else { return .notDispatched }
                try recordBoundary()
                guard !fence.isStopped,
                      (try? registry.resolve(observationID: observationID,
                                             nodeID: nodeID, target: target)) != nil else {
                    return .notDispatched
                }
            } catch { return .notDispatched }
            do { try backend.press(handle) }
            catch { return .unknown }
            return .returned
        }
        switch result {
        case .notDispatched: return .notDispatched
        case .returned: return .returnedUnverified
        case .unknown: return .unknown
        }
    }
}

/// A label identifies a candidate for the host, but never authorizes it.
/// The concrete node ID and role must still match this retained observation.
public func prepareNativePress<Backend: AXPressActionBackend>(
    backend: Backend, registry: NativeAXObservationRegistry<Backend>,
    target: AXTarget, observation: AXObservation, nodeID: String,
    expectedRole: String, expectedLabel: String,
    fence: NativeActionFence
) throws -> PreparedNativePress<Backend> {
    guard observation.scopeRef == target.scopeRef,
          !expectedLabel.isEmpty,
          [kAXButtonRole as String, kAXMenuItemRole as String]
            .contains(expectedRole),
          let candidate = observation.nodes.first(where: { $0.id == nodeID }),
          candidate.description.role == expectedRole,
          candidate.description.label == expectedLabel,
          candidate.description.enabled, !candidate.description.secure,
          candidate.description.capabilities.contains("press") else {
        throw NativePressActionError.unsupportedControl
    }
    guard !fence.isStopped else { throw NativePressActionError.stopped }
    do {
        _ = try registry.resolve(observationID: observation.id,
                                 nodeID: nodeID, target: target)
    } catch { throw NativePressActionError.targetChanged }
    return PreparedNativePress(backend: backend, registry: registry,
        target: target, observationID: observation.id, nodeID: nodeID,
        expectedRole: expectedRole, expectedLabel: expectedLabel, fence: fence)
}
