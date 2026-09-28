import Foundation
import NativeAX

private enum FixtureError: Error { case boundary, lostReply }

final class FolderBackend: AXPressActionBackend {
    typealias Handle = Int
    var page = "home"
    var changedLabel = false
    var throwAfterEffect = false
    var presses = 0

    func isCurrentTarget(_ target: AXTarget) -> Bool { true }
    func root(for target: AXTarget) throws -> Int { 0 }
    func describe(_ handle: Int) throws -> AXDescription {
        switch handle {
        case 0:
            return AXDescription(role: "AXApplication", label: "Fixture",
                enabled: true, secure: false, capabilities: [], bounds: nil)
        case 1:
            return AXDescription(role: "AXButton",
                label: changedLabel ? "Downloads" : "Documents",
                enabled: true, secure: false, capabilities: ["press"], bounds: nil)
        case 2:
            return AXDescription(role: "AXStaticText", label: "Budget.xlsx",
                enabled: true, secure: false, capabilities: [], bounds: nil)
        default: fatalError("unexpected handle")
        }
    }
    func children(of handle: Int, limit: Int) throws -> AXChildPage<Int> {
        guard handle == 0 else { return AXChildPage(handles: [], hasMore: false) }
        let handles = page == "home" ? [1] : [2]
        return AXChildPage(handles: Array(handles.prefix(limit)),
                           hasMore: handles.count > limit)
    }
    func belongsToTarget(_ handle: Int, target: AXTarget) -> Bool { true }
    func press(_ handle: Int) throws {
        precondition(handle == 1)
        presses += 1
        page = "documents"
        if throwAfterEffect { throw FixtureError.lostReply }
    }
}

private func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else { fatalError(message) }
}

let target = AXTarget(pid: 42, bundleID: "synthetic.folder",
    bundleURL: URL(fileURLWithPath: "/tmp/Synthetic.app"),
    launchDate: Date(timeIntervalSince1970: 1), scopeRef: "synthetic-folder")
let backend = FolderBackend()
let registry = try NativeAXObservationRegistry(backend: backend)
let first = try registry.observe(target)
let folder = first.nodes.first { $0.description.label == "Documents" }!

let stoppedFence = NativeActionFence()
let stopped = try prepareNativePress(backend: backend, registry: registry,
    target: target, observation: first, nodeID: folder.id,
    expectedRole: "AXButton", expectedLabel: "Documents", fence: stoppedFence)
stoppedFence.stop()
check(stopped.send(recordBoundary: { fatalError("stopped boundary") }) == .notDispatched,
      "Stop must fence the native call")
check(backend.presses == 0, "Stop must not press")

let boundaryFence = NativeActionFence()
let failedBoundary = try prepareNativePress(backend: backend, registry: registry,
    target: target, observation: first, nodeID: folder.id,
    expectedRole: "AXButton", expectedLabel: "Documents", fence: boundaryFence)
check(failedBoundary.send(recordBoundary: { throw FixtureError.boundary }) == .notDispatched,
      "failed durable boundary must not send AXPress")
check(backend.presses == 0, "failed boundary must not press")

let changedDuringBoundary = try prepareNativePress(backend: backend,
    registry: registry, target: target, observation: first, nodeID: folder.id,
    expectedRole: "AXButton", expectedLabel: "Documents",
    fence: NativeActionFence())
check(changedDuringBoundary.send(recordBoundary: {
    backend.changedLabel = true
}) == .notDispatched, "changed control during journal write must not press")
check(backend.presses == 0, "changed control at boundary sent AXPress")
backend.changedLabel = false

backend.changedLabel = true
let staleFence = NativeActionFence()
do {
    _ = try prepareNativePress(backend: backend, registry: registry,
        target: target, observation: first, nodeID: folder.id,
        expectedRole: "AXButton", expectedLabel: "Documents", fence: staleFence)
    fatalError("changed target should be rejected")
} catch NativePressActionError.targetChanged {}
backend.changedLabel = false

let actionFence = NativeActionFence()
let action = try prepareNativePress(backend: backend, registry: registry,
    target: target, observation: first, nodeID: folder.id,
    expectedRole: "AXButton", expectedLabel: "Documents", fence: actionFence)
var boundaries = 0
check(action.send(recordBoundary: { boundaries += 1 }) == .returnedUnverified,
      "AXPress receipt alone cannot prove folder navigation")
check(boundaries == 1 && backend.presses == 1, "one boundary and one press")
check(action.send(recordBoundary: { fatalError("replayed boundary") }) == .notDispatched,
      "a prepared action is one-use")
let second = try registry.observe(target)
check(second.nodes.contains { $0.description.label == "Budget.xlsx" },
      "fresh observation must see target document")
check(!second.nodes.contains { $0.description.label == "Documents" },
      "old navigation control must not remain current")

backend.page = "home"
let third = try registry.observe(target)
let secondFolder = third.nodes.first { $0.description.label == "Documents" }!
backend.throwAfterEffect = true
let uncertain = try prepareNativePress(backend: backend, registry: registry,
    target: target, observation: third, nodeID: secondFolder.id,
    expectedRole: "AXButton", expectedLabel: "Documents",
    fence: NativeActionFence())
check(uncertain.send(recordBoundary: {}) == .unknown,
      "a lost AXPress reply must be unknown even when the fixture changed")
check(backend.page == "documents", "unknown action may still have had an effect")
print("NativeAXPressCheck: guarded press and independent observation passed")
