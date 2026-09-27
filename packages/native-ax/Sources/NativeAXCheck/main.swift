import Foundation
import NativeAX

final class FakeBackend: AXObservationBackend {
    typealias Handle = Int
    var valid = true
    var changed = false
    var foreign = false
    var childCount = 3

    func isCurrentTarget(_ target: AXTarget) -> Bool { valid }
    func root(for target: AXTarget) throws -> Int { 0 }
    func describe(_ handle: Int) throws -> AXDescription {
        AXDescription(role: handle == 0 ? "AXApplication" : "AXTextField",
                      label: handle == 1 && changed ? "Changed" : "Duplicate",
                      enabled: true, secure: handle == 2,
                      capabilities: handle == 2 ? [] : ["setValue"], bounds: nil)
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
private let registry = try NativeAXObservationRegistry(backend: backend, maxNodes: 3)
let first = try registry.observe(target)
check(first.nodes.count == 3, "node cap")
check(!first.complete, "truncated tree must be incomplete")
check(first.nodes[1].description.label == first.nodes[2].description.label,
      "duplicate labels remain separate nodes")
check(first.nodes[1].id != first.nodes[2].id, "observation-scoped IDs")
check(first.nodes[2].description.secure, "secure flag")
check(first.nodes[2].description.capabilities.isEmpty, "secure edit excluded")
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
    _ = try registry.resolve(observationID: first.id,
                             nodeID: first.nodes[1].id, target: target)
    fatalError("old observation reused")
} catch AXObservationError.staleObservation {}
backend.valid = false
do {
    _ = try registry.resolve(observationID: second.id,
                             nodeID: second.nodes[1].id, target: target)
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
print("NativeAXCheck: synthetic registry checks passed")
