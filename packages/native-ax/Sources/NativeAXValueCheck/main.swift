import Foundation
import NativeAX

private enum SyntheticError: Error { case failed }

private final class FakeBackend: AXValueActionBackend {
    typealias Handle = Int
    var current = true
    var changedLabel = false
    var failAfterSet = false
    var onSet: (() -> Void)?
    var onRead: (() -> Void)?
    var values = [1: "before", 2: "other", 3: "secret"]
    var setCalls = 0

    func isCurrentTarget(_ target: AXTarget) -> Bool { current }
    func root(for target: AXTarget) throws -> Int { 0 }
    func describe(_ handle: Int) throws -> AXDescription {
        let field = handle != 0
        return AXDescription(role: field ? "AXTextField" : "AXApplication",
            label: handle == 1 && changedLabel ? "Changed" : field ? "Duplicate" : "App",
            enabled: true, secure: handle == 3,
            capabilities: field && handle != 3 ? ["setValue"] : [], bounds: nil)
    }
    func children(of handle: Int, limit: Int) throws -> AXChildPage<Int> {
        AXChildPage(handles: handle == 0 ? Array([1, 2, 3].prefix(limit)) : [],
                    hasMore: handle == 0 && limit < 3)
    }
    func belongsToTarget(_ handle: Int, target: AXTarget) -> Bool { current }
    func value(of handle: Int) throws -> String {
        onRead?()
        guard let value = values[handle] else { throw SyntheticError.failed }
        return value
    }
    func setValue(_ value: String, on handle: Int) throws {
        onSet?()
        setCalls += 1
        values[handle] = value
        if failAfterSet { throw SyntheticError.failed }
    }
}

private final class ConcurrentAction: @unchecked Sendable {
    let prepared: PreparedNativeValue<FakeBackend>
    var outcome: NativeValueOutcome?
    init(_ prepared: PreparedNativeValue<FakeBackend>) { self.prepared = prepared }
}

private func check(_ condition: @autoclosure () -> Bool, _ message: String) {
    guard condition() else { fatalError(message) }
}

private let target = AXTarget(pid: 42, bundleID: "synthetic.fixture",
    bundleURL: URL(fileURLWithPath: "/tmp/Synthetic.app"),
    launchDate: Date(timeIntervalSince1970: 1), scopeRef: "synthetic-only")

private func scenario(_ body: (FakeBackend, NativeAXObservationRegistry<FakeBackend>,
                              AXObservation, NativeValueFence) throws -> Void) throws {
    let backend = FakeBackend()
    let registry = try NativeAXObservationRegistry(backend: backend, maxNodes: 8,
                                                    maxDepth: 2)
    let observation = try registry.observe(target)
    check(observation.complete, "complete synthetic observation")
    try body(backend, registry, observation, NativeValueFence())
}

private func ready(_ backend: FakeBackend,
                   _ registry: NativeAXObservationRegistry<FakeBackend>,
                   _ observation: AXObservation, _ fence: NativeValueFence,
                   nodeIndex: Int = 1) throws -> PreparedNativeValue<FakeBackend> {
    let result = try prepareNativeValue(backend: backend, registry: registry,
        target: target, observation: observation,
        nodeID: observation.nodes[nodeIndex].id, expectedLabel: "Duplicate",
        requestedValue: "new", fence: fence)
    guard case .ready(let prepared) = result else { throw SyntheticError.failed }
    return prepared
}

try scenario { backend, registry, observation, fence in
    let prepared = try ready(backend, registry, observation, fence)
    var boundaries = 0
    check(prepared.send(recordBoundary: { boundaries += 1 }) == .verified,
          "verified exact field value")
    check(backend.values[1] == "new" && backend.values[2] == "other",
          "only selected duplicate node changed")
    check(boundaries == 1 && backend.setCalls == 1, "one boundary and one setter")
    check(prepared.send(recordBoundary: { boundaries += 1 }) == .notDispatched,
          "prepared action cannot replay")
    check(boundaries == 1 && backend.setCalls == 1, "replay caused no effect")
}

try scenario { backend, registry, observation, fence in
    let prepared = try ready(backend, registry, observation, fence)
    fence.stop()
    var boundaries = 0
    check(prepared.send(recordBoundary: { boundaries += 1 }) == .notDispatched,
          "Stop before send fences action")
    check(boundaries == 0 && backend.setCalls == 0, "Stop sent no setter")
}

try scenario { backend, registry, observation, fence in
    let prepared = try ready(backend, registry, observation, fence)
    backend.changedLabel = true
    var boundaries = 0
    check(prepared.send(recordBoundary: { boundaries += 1 }) == .notDispatched,
          "changed node descriptor fences action")
    check(boundaries == 0 && backend.setCalls == 0, "stale node sent no setter")
}

try scenario { backend, registry, observation, fence in
    let prepared = try ready(backend, registry, observation, fence)
    backend.values[1] = "human edit"
    var boundaries = 0
    check(prepared.send(recordBoundary: { boundaries += 1 }) == .notDispatched,
          "changed prior field value fences action")
    check(boundaries == 0 && backend.setCalls == 0, "interference sent no setter")
}

try scenario { backend, registry, observation, fence in
    let prepared = try ready(backend, registry, observation, fence)
    backend.failAfterSet = true
    var boundaries = 0
    check(prepared.send(recordBoundary: { boundaries += 1 }) == .unknown,
          "setter error after effect is unknown")
    check(boundaries == 1 && backend.setCalls == 1 && backend.values[1] == "new",
          "unknown effect remains recorded")
}

try scenario { backend, registry, observation, fence in
    let prepared = try ready(backend, registry, observation, fence)
    check(prepared.send(recordBoundary: { throw SyntheticError.failed }) == .notDispatched,
          "failed durable boundary sends no setter")
    check(backend.setCalls == 0, "failed boundary caused no effect")
}

try scenario { backend, registry, observation, fence in
    let enteredSetter = DispatchSemaphore(value: 0)
    let releaseSetter = DispatchSemaphore(value: 0)
    let stopFinished = DispatchSemaphore(value: 0)
    let actionFinished = DispatchSemaphore(value: 0)
    backend.onSet = {
        enteredSetter.signal()
        releaseSetter.wait()
    }
    let action = ConcurrentAction(try ready(backend, registry, observation, fence))
    DispatchQueue.global().async {
        action.outcome = action.prepared.send(recordBoundary: {})
        actionFinished.signal()
    }
    check(enteredSetter.wait(timeout: .now() + 2) == .success,
          "setter entered before Stop")
    DispatchQueue.global().async {
        fence.stop()
        stopFinished.signal()
    }
    check(stopFinished.wait(timeout: .now() + .milliseconds(50)) == .timedOut,
          "Stop acknowledged while AX setter was still in flight")
    releaseSetter.signal()
    check(stopFinished.wait(timeout: .now() + 2) == .success,
          "Stop did not finish after setter returned")
    check(actionFinished.wait(timeout: .now() + 2) == .success,
          "action did not settle")
    check(fence.isStopped && backend.setCalls == 1,
          "Stop fence did not preserve one setter")
    check(action.prepared.send(recordBoundary: {}) == .notDispatched,
          "late retry sent another native setter")
}

try scenario { backend, registry, observation, fence in
    let prepared = try ready(backend, registry, observation, fence)
    let enteredRead = DispatchSemaphore(value: 0)
    let releaseRead = DispatchSemaphore(value: 0)
    let actionFinished = DispatchSemaphore(value: 0)
    let stopFinished = DispatchSemaphore(value: 0)
    backend.onRead = {
        enteredRead.signal()
        releaseRead.wait()
    }
    let action = ConcurrentAction(prepared)
    DispatchQueue.global().async {
        action.outcome = action.prepared.send(recordBoundary: {})
        actionFinished.signal()
    }
    check(enteredRead.wait(timeout: .now() + 2) == .success,
          "preflight read entered")
    DispatchQueue.global().async {
        fence.stop()
        stopFinished.signal()
    }
    for _ in 0..<100 where !fence.isStopped { usleep(1_000) }
    check(fence.isStopped, "Stop request was not registered during preflight")
    releaseRead.signal()
    check(actionFinished.wait(timeout: .now() + 2) == .success,
          "preflight did not settle after Stop")
    check(stopFinished.wait(timeout: .now() + 2) == .success,
          "Stop acknowledgement did not arrive")
    check(action.outcome == .notDispatched && backend.setCalls == 0,
          "Stop during preflight sent a native setter")
}

try scenario { backend, registry, observation, fence in
    do {
        _ = try prepareNativeValue(backend: backend, registry: registry,
            target: target, observation: observation,
            nodeID: observation.nodes[3].id, expectedLabel: "Duplicate",
            requestedValue: "new", fence: fence)
        fatalError("secure field was offered for action")
    } catch NativeValueActionError.unsupportedControl {}
}

try scenario { backend, registry, observation, fence in
    backend.values[1] = "new"
    let match = try prepareNativeValue(backend: backend, registry: registry,
        target: target, observation: observation,
        nodeID: observation.nodes[1].id, expectedLabel: "Duplicate",
        requestedValue: "new", fence: fence)
    guard case .matchedAtPreflight = match else {
        fatalError("matching current value was not distinguished from a setter")
    }
    check(backend.setCalls == 0, "matching value sent a setter")
    fence.stop()
    do {
        _ = try prepareNativeValue(backend: backend, registry: registry,
            target: target, observation: observation,
            nodeID: observation.nodes[1].id, expectedLabel: "Duplicate",
            requestedValue: "new", fence: fence)
        fatalError("stopped preparation was reported as a match")
    } catch NativeValueActionError.stopped {}
}

print("NativeAXValueCheck: guarded native field action checks passed")
