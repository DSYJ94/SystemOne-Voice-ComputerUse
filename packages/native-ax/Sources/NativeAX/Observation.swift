import AppKit
import ApplicationServices
import Foundation

public struct AXTarget: Equatable, Sendable {
    public let pid: pid_t
    public let bundleID: String
    public let bundleURL: URL
    public let launchDate: Date
    public let scopeRef: String

    public init(pid: pid_t, bundleID: String, bundleURL: URL,
                launchDate: Date, scopeRef: String) {
        self.pid = pid
        self.bundleID = bundleID
        self.bundleURL = bundleURL
        self.launchDate = launchDate
        self.scopeRef = scopeRef
    }
}

public struct AXBounds: Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}

public struct AXDescription: Equatable, Sendable {
    public let role: String
    public let label: String
    public let enabled: Bool
    public let secure: Bool
    public let capabilities: [String]
    public let bounds: AXBounds?

    public init(role: String, label: String, enabled: Bool, secure: Bool,
                capabilities: [String], bounds: AXBounds?) {
        self.role = role
        self.label = label
        self.enabled = enabled
        self.secure = secure
        self.capabilities = capabilities
        self.bounds = bounds
    }
}

public struct AXChildPage<Handle> {
    public let handles: [Handle]
    public let hasMore: Bool

    public init(handles: [Handle], hasMore: Bool) {
        self.handles = handles
        self.hasMore = hasMore
    }
}

public protocol AXObservationBackend {
    associatedtype Handle
    func isCurrentTarget(_ target: AXTarget) -> Bool
    func root(for target: AXTarget) throws -> Handle
    func describe(_ handle: Handle) throws -> AXDescription
    func children(of handle: Handle, limit: Int) throws -> AXChildPage<Handle>
    func belongsToTarget(_ handle: Handle, target: AXTarget) -> Bool
}

public enum AXObservationError: Error, Equatable {
    case targetChanged
    case staleObservation
    case staleNode
    case secureRegion
    case invalidLimits
}

public struct AXObservedNode: Equatable, Sendable {
    public let id: String
    public let parentID: String?
    /// Bounded ancestor labels for display/candidate descriptions only.
    /// A later action must revalidate its retained handle and target.
    public let ancestorContext: String
    public let description: AXDescription
}

public enum AXObservationScope: Equatable, Sendable {
    case application
    /// A complete subtree is not proof that the whole application was covered.
    case subtree(sourceObservationID: String, sourceNodeID: String)
}

public enum AXCoverageGapReason: String, Equatable, Sendable {
    case nodeLimit
    case deadline
    case depthLimit
    case childrenTruncated
    case inaccessibleNode
    case inaccessibleChildren
    case foreignNode
    case secureContentOmitted
}

public struct AXCoverageGap: Equatable, Sendable {
    public let anchorNodeID: String?
    public let reason: AXCoverageGapReason

    public init(anchorNodeID: String?, reason: AXCoverageGapReason) {
        self.anchorNodeID = anchorNodeID
        self.reason = reason
    }
}

public struct AXObservation: Equatable, Sendable {
    public let id: String
    public let scopeRef: String
    public let scope: AXObservationScope
    public let nodes: [AXObservedNode]
    /// Bounded clues for drill-down. Their absence proves coverage only within
    /// this scope; it never proves unsupported AX content does not exist.
    public let coverageGaps: [AXCoverageGap]
    /** False means a target might be outside observed coverage in this scope. */
    public let complete: Bool
}

/// Retains native handles privately for one observation. This object must live
/// on a bounded serial worker, never the app's UI thread. It performs no action
/// and does not issue an execution permit. `resolve` rechecks a node but does
/// not by itself authorize using it; the host must revalidate at dispatch.
public final class NativeAXObservationRegistry<Backend: AXObservationBackend> {
    private let backend: Backend
    private let maxNodes: Int
    private let maxDepth: Int
    private let budget: Duration
    private var currentID: String?
    private var currentTarget: AXTarget?
    private var handles: [String: Backend.Handle] = [:]
    private var descriptions: [String: AXDescription] = [:]

    public init(backend: Backend, maxNodes: Int = 80, maxDepth: Int = 5,
                budget: Duration = .seconds(2)) throws {
        guard (1...256).contains(maxNodes), (0...8).contains(maxDepth),
              budget > .zero, budget <= .seconds(10) else {
            throw AXObservationError.invalidLimits
        }
        self.backend = backend
        self.maxNodes = maxNodes
        self.maxDepth = maxDepth
        self.budget = budget
    }

    public func observe(_ target: AXTarget) throws -> AXObservation {
        invalidate()
        guard backend.isCurrentTarget(target) else { throw AXObservationError.targetChanged }
        let root = try backend.root(for: target)
        return try collect(root, target: target, scope: .application)
    }

    /// Drill into one retained node without trusting a label or global search.
    /// This invalidates every handle from the prior observation. The returned
    /// completeness flag applies only to this subtree, never the whole app.
    public func observeSubtree(observationID: String, nodeID: String,
                               target: AXTarget) throws -> AXObservation {
        let root = try resolve(observationID: observationID, nodeID: nodeID,
                               target: target)
        guard descriptions[nodeID]?.secure == false else {
            throw AXObservationError.secureRegion
        }
        invalidate()
        return try collect(root, target: target,
                           scope: .subtree(sourceObservationID: observationID,
                                           sourceNodeID: nodeID))
    }

    private func collect(_ root: Backend.Handle, target: AXTarget,
                         scope: AXObservationScope) throws -> AXObservation {
        let observationID = UUID().uuidString
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: budget)
        var queue: [(Backend.Handle, String?, Int)] = [(root, nil, 0)]
        var nodes: [AXObservedNode] = []
        var gaps: [AXCoverageGap] = []
        var incomplete = false
        var paths: [String: String] = [:]
        func mark(_ reason: AXCoverageGapReason, anchor: String?) {
            incomplete = true
            if gaps.count < 32 {
                gaps.append(AXCoverageGap(anchorNodeID: anchor, reason: reason))
            }
        }

        while !queue.isEmpty {
            if nodes.count >= maxNodes {
                mark(.nodeLimit, anchor: queue.first?.1)
                break
            }
            if clock.now >= deadline {
                mark(.deadline, anchor: queue.first?.1)
                break
            }
            let (handle, parentID, depth) = queue.removeFirst()
            let description: AXDescription
            do { description = Self.sanitized(try backend.describe(handle)) }
            catch {
                mark(.inaccessibleNode, anchor: parentID)
                continue
            }
            guard backend.belongsToTarget(handle, target: target) else {
                mark(.foreignNode, anchor: parentID)
                continue
            }
            guard clock.now < deadline else {
                mark(.deadline, anchor: parentID)
                break
            }
            let nodeID = "\(observationID):\(nodes.count)"
            let ancestorContext = parentID.flatMap { paths[$0] } ?? ""
            nodes.append(AXObservedNode(id: nodeID, parentID: parentID,
                                        ancestorContext: ancestorContext,
                                        description: description))
            handles[nodeID] = handle
            descriptions[nodeID] = description
            let segment = description.secure ? description.role
                : description.label.isEmpty ? description.role
                : "\(description.role): \(description.label.prefix(80))"
            paths[nodeID] = String((ancestorContext.isEmpty ? segment
                : ancestorContext + " / " + segment).suffix(160))
            if description.secure {
                mark(.secureContentOmitted, anchor: nodeID)
                continue
            }
            if depth >= maxDepth {
                // Child count is not read at this depth; absence is unproven.
                mark(.depthLimit, anchor: nodeID)
                continue
            }
            do {
                let remaining = maxNodes - nodes.count - queue.count
                if remaining <= 0 {
                    mark(.nodeLimit, anchor: nodeID)
                    continue
                }
                let page = try backend.children(of: handle, limit: remaining)
                if clock.now >= deadline {
                    mark(.deadline, anchor: nodeID)
                    break
                }
                if page.hasMore { mark(.childrenTruncated, anchor: nodeID) }
                queue.append(contentsOf: page.handles.map { ($0, nodeID, depth + 1) })
            } catch { mark(.inaccessibleChildren, anchor: nodeID) }
        }
        guard backend.isCurrentTarget(target) else {
            invalidate()
            throw AXObservationError.targetChanged
        }
        currentID = observationID
        currentTarget = target
        return AXObservation(id: observationID, scopeRef: target.scopeRef,
                             scope: scope, nodes: nodes,
                             coverageGaps: gaps, complete: !incomplete)
    }

    /// Returns a local handle only while this observation and its descriptor
    /// still match. Callers may not serialize the handle or reuse it after a
    /// new observation. A separate dispatch permit is still required.
    public func resolve(observationID: String, nodeID: String,
                        target: AXTarget) throws -> Backend.Handle {
        guard currentID == observationID, currentTarget == target else {
            throw AXObservationError.staleObservation
        }
        guard backend.isCurrentTarget(target), let handle = handles[nodeID],
              let prior = descriptions[nodeID],
              backend.belongsToTarget(handle, target: target),
              (try? Self.sanitized(backend.describe(handle))) == prior else {
            throw AXObservationError.staleNode
        }
        return handle
    }

    public func invalidate() {
        currentID = nil
        currentTarget = nil
        handles.removeAll()
        descriptions.removeAll()
    }

    private static func sanitized(_ description: AXDescription) -> AXDescription {
        guard description.secure else { return description }
        return AXDescription(role: description.role, label: "",
                             enabled: description.enabled, secure: true,
                             capabilities: [], bounds: description.bounds)
    }
}
