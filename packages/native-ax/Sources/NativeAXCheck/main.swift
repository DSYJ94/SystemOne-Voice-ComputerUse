import Foundation
import NativeAX

final class FakeBackend: AXObservationBackend {
    typealias Handle = Int
    var valid = true
    var changed = false
    var foreign = false
    var childCount = 4

    func isCurrentTarget(_ target: AXTarget) -> Bool { valid }
    func root(for target: AXTarget) throws -> Int { 0 }
    func describe(_ handle: Int) throws -> AXDescription {
        AXDescription(role: handle == 0 ? "AXApplication" : "AXTextField",
                      label: handle == 1 && changed ? "Changed"
                          : handle == 3 ? "Private" : "Duplicate",
                      enabled: true, secure: handle == 3,
                      capabilities: ["setValue"], bounds: nil)
    }
    func children(of handle: Int, limit: Int) throws -> AXChildPage<Int> {
        guard handle == 0 else { return AXChildPage(handles: [], hasMore: false) }
        return AXChildPage(handles: Array(1...min(childCount, limit)),
                           hasMore: childCount > limit)
    }
    func belongsToTarget(_ handle: Int, target: AXTarget) -> Bool {
        !(foreign && handle == 1)
    }
}

private func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else { fatalError(message) }
}

let target = AXTarget(pid: 42, bundleID: "synthetic.fixture",
                      bundleURL: URL(fileURLWithPath: "/tmp/Synthetic.app"),
                      launchDate: Date(timeIntervalSince1970: 1),
                      scopeRef: "synthetic-only")
private let backend = FakeBackend()
private let registry = try NativeAXObservationRegistry(backend: backend, maxNodes: 4)
let first = try registry.observe(target)
check(first.nodes.count == 4, "node cap")
check(!first.complete, "truncated tree must be incomplete")
check(first.scope == .application, "initial scope is the whole app")
check(first.coverageGaps.contains { $0.reason == .childrenTruncated },
      "child cap has an explicit coverage gap")
check(first.nodes[1].ancestorContext.contains("AXApplication"),
      "child retains bounded parent context")
check(first.nodes[1].description.label == first.nodes[2].description.label,
      "duplicate labels remain separate nodes")
check(first.nodes[1].id != first.nodes[2].id, "observation-scoped IDs")
check(first.nodes[3].description.secure, "secure flag")
check(first.nodes[3].description.label.isEmpty, "secure label omitted")
check(first.nodes[3].description.capabilities.isEmpty, "secure edit excluded")
check(first.coverageGaps.contains { $0.reason == .secureContentOmitted },
      "secure subtree is an explicit coverage gap")
let freshHandle = try registry.resolve(observationID: first.id,
                                       nodeID: first.nodes[1].id, target: target)
check(freshHandle == 1, "fresh handle")
backend.changed = true
do {
    _ = try registry.resolve(observationID: first.id,
                             nodeID: first.nodes[1].id, target: target)
    fatalError("changed node reused")
} catch AXObservationError.staleNode {}
backend.changed = false
let second = try registry.observe(target)
do {
    _ = try registry.observeSubtree(observationID: second.id,
                                    nodeID: second.nodes[3].id, target: target)
    fatalError("secure region observed")
} catch AXObservationError.secureRegion {}
let retainedHandle = try registry.resolve(observationID: second.id,
    nodeID: second.nodes[1].id, target: target)
check(retainedHandle == 1,
      "rejected secure drill preserves prior observation")
let subtree = try registry.observeSubtree(observationID: second.id,
                                          nodeID: second.nodes[1].id,
                                          target: target)
check(subtree.scope == .subtree(sourceObservationID: second.id,
                                sourceNodeID: second.nodes[1].id),
      "drill-down is explicitly scoped to an old observed node")
check(subtree.complete && subtree.nodes.count == 1,
      "a complete subtree does not imply whole-app coverage")
check(subtree.coverageGaps.isEmpty, "complete subtree has no coverage gaps")
do {
    _ = try registry.resolve(observationID: second.id,
                             nodeID: second.nodes[1].id, target: target)
    fatalError("old observation reused")
} catch AXObservationError.staleObservation {}
backend.valid = false
do {
    _ = try registry.resolve(observationID: subtree.id,
                             nodeID: subtree.nodes[0].id, target: target)
    fatalError("changed target reused")
} catch AXObservationError.staleNode {}
do {
    _ = try registry.observe(target)
    fatalError("changed target observed")
} catch AXObservationError.targetChanged {}
backend.valid = true
backend.foreign = true
backend.childCount = 1
let third = try registry.observe(target)
check(!third.complete && third.nodes.count == 1,
      "foreign child skipped and coverage incomplete")
check(third.coverageGaps.contains { $0.reason == .foreignNode },
      "foreign child recorded as a coverage gap")
let depthRegistry = try NativeAXObservationRegistry(backend: backend,
    maxNodes: 8, maxDepth: 0)
let shallow = try depthRegistry.observe(target)
check(!shallow.complete && shallow.coverageGaps == [
    AXCoverageGap(anchorNodeID: shallow.nodes[0].id, reason: .depthLimit)
], "depth-limited observation does not claim absence")
print("NativeAXCheck: synthetic registry checks passed")
