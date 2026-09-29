import AppKit
import Foundation

private enum NativeInspectionError: Error {
    case noCurrentObservation
    case wrongTarget
    case indexNotDisplayed
}

/// Development-only, read-only AX drill-down. It retains handles inside this
/// actor, never exports them, and issues no task admission or action permit.
actor NativeInspectionSession {
    private var registry: NativeAXObservationRegistry<SystemAXBackend>?
    private var target: AXTarget?
    private var observation: AXObservation?

    func editableLabels(_ target: AXTarget) throws -> (labels: [String], complete: Bool) {
        let registry = try NativeAXObservationRegistry(backend: SystemAXBackend(),
            maxNodes: 80, maxDepth: 5, budget: .seconds(2))
        let observed = try registry.observe(target)
        let labels = observed.nodes.compactMap { node -> String? in
            let detail = node.description
            guard detail.enabled, !detail.secure,
                  detail.capabilities.contains("setValue"),
                  !detail.label.isEmpty else { return nil }
            return detail.label
        }
        return (Array(Set(labels)).sorted(), observed.complete)
    }

    func inspect(_ target: AXTarget) throws -> String {
        cancel()
        let registry = try NativeAXObservationRegistry(backend: SystemAXBackend(),
            maxNodes: 80, maxDepth: 5, budget: .seconds(2))
        let observation = try registry.observe(target)
        self.registry = registry
        self.target = target
        self.observation = observation
        return summary(observation)
    }

    func drill(bundleID: String, displayedIndex: Int) throws -> String {
        guard let registry, let target, let observation else {
            throw NativeInspectionError.noCurrentObservation
        }
        guard target.bundleID == bundleID else {
            throw NativeInspectionError.wrongTarget
        }
        guard displayedIndex >= 0,
              displayedIndex < min(24, observation.nodes.count) else {
            throw NativeInspectionError.indexNotDisplayed
        }
        let node = observation.nodes[displayedIndex]
        let subtree = try registry.observeSubtree(observationID: observation.id,
            nodeID: node.id, target: target)
        self.observation = subtree
        return summary(subtree)
    }

    func cancel() {
        registry?.invalidate()
        registry = nil
        target = nil
        observation = nil
    }

    private func summary(_ observation: AXObservation) -> String {
        let scope: String
        switch observation.scope {
        case .application: scope = "app"
        case .subtree: scope = "subtree only"
        }
        var lines = ["Observed \(observation.nodes.count) nodes in \(scope); "
            + (observation.complete ? "coverage complete here"
               : "coverage incomplete here")
            + ". No field values read or actions sent."]
        for (index, node) in observation.nodes.prefix(24).enumerated() {
            let detail = node.description
            let label = detail.secure ? "[secure label omitted]"
                : Self.display(detail.label)
            let context = Self.display(node.ancestorContext)
            let capabilities = detail.capabilities.isEmpty
                ? "read-only" : detail.capabilities.joined(separator: ", ")
            lines.append("[\(index)] \(Self.display(detail.role)): \(label) "
                + "[\(capabilities)]"
                + (context.isEmpty ? "" : " in \(context)"))
        }
        if observation.nodes.count > 24 {
            lines.append("Only the first 24 nodes are displayed; inspect a "
                + "shown parent to narrow the scope.")
        }
        for gap in observation.coverageGaps.prefix(8) {
            let index = gap.anchorNodeID.flatMap { anchor in
                observation.nodes.firstIndex { $0.id == anchor }
            }
            lines.append("Coverage gap: \(gap.reason.rawValue)"
                + (index.map { " near [\($0)]" } ?? ""))
        }
        if observation.coverageGaps.count > 8 {
            lines.append("Additional coverage gaps omitted.")
        }
        return lines.joined(separator: "\n")
    }

    private static func display(_ value: String) -> String {
        String(value.replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
            .replacingOccurrences(of: "\t", with: " ").prefix(160))
    }
}
