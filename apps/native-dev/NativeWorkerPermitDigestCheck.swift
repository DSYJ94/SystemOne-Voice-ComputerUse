import Foundation

@main
struct NativeWorkerPermitDigestCheck {
    static func main() throws {
        guard CommandLine.arguments.count == 3 else {
            fatalError("expected candidate-set and action digests")
        }
        let controls: [[String: Any]] = [[
            "id": "node-1", "role": "AXTextField", "label": "Fixture Name",
            "enabled": true, "secure": false, "canSetValue": true,
        ]]
        let setDigest = try NativeWorkerPermitDigest.candidateSet(controls)
        let actionDigest = try NativeWorkerPermitDigest.action(
            taskID: "task-1", scopeRef: "native:scope-1",
            observationID: "obs-1", candidateID: "node-1",
            label: "Fixture Name", value: "fixture-123",
            policyRevision: NativeWorkerPermitDigest.policyRevision)
        guard setDigest == CommandLine.arguments[1],
              actionDigest == CommandLine.arguments[2] else {
            fatalError("Swift and TypeScript native permit digests differ")
        }
        func matches(_ set: String, _ action: String, _ policy: String) -> Bool {
            NativeWorkerPermitDigest.matches(controls: controls,
                taskID: "task-1", scopeRef: "native:scope-1",
                observationID: "obs-1", candidateID: "node-1",
                label: "Fixture Name", value: "fixture-123",
                policyRevision: policy, candidateSetDigest: set,
                actionDigest: action)
        }
        guard matches(setDigest, actionDigest,
                      NativeWorkerPermitDigest.policyRevision),
              !matches(String(repeating: "f", count: 64), actionDigest,
                       NativeWorkerPermitDigest.policyRevision),
              !matches(setDigest, String(repeating: "f", count: 64),
                       NativeWorkerPermitDigest.policyRevision),
              !matches(setDigest, actionDigest, "old-policy") else {
            fatalError("worker digest admission did not fail closed")
        }
        let altered = try NativeWorkerPermitDigest.action(
            taskID: "task-1", scopeRef: "native:scope-1",
            observationID: "obs-1", candidateID: "node-1",
            label: "Fixture Name", value: "different-value",
            policyRevision: NativeWorkerPermitDigest.policyRevision)
        guard altered != actionDigest else { fatalError("changed value kept digest") }
        print("PASS: worker digests match TypeScript; changed set, action, policy and value denied")
    }
}
