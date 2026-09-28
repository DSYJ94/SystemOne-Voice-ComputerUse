import Foundation

@main
struct NativeWorkerPermitDigestCheck {
    static func main() throws {
        guard CommandLine.arguments.count == 7 else {
            fatalError("expected field, folder and file candidate/action digests")
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
        let pressControls: [[String: Any]] = [[
            "id": "node-2", "role": "AXButton", "label": "Documents",
            "enabled": true, "secure": false, "canPress": true,
        ]]
        let pressSet = try NativeWorkerPermitDigest.candidateSet(pressControls)
        let pressAction = try NativeWorkerPermitDigest.pressAction(
            taskID: "task-1", scopeRef: "native:scope-1",
            observationID: "obs-1", candidateID: "node-2",
            role: "AXButton", label: "Documents",
            expectedWindowTitle: "SystemOne Fixture — Documents",
            policyRevision: NativeWorkerPermitDigest.pressPolicyRevision)
        guard pressSet == CommandLine.arguments[3],
              pressAction == CommandLine.arguments[4],
              NativeWorkerPermitDigest.pressMatches(controls: pressControls,
                  taskID: "task-1", scopeRef: "native:scope-1",
                  observationID: "obs-1", candidateID: "node-2",
                  role: "AXButton", label: "Documents",
                  expectedWindowTitle: "SystemOne Fixture — Documents",
                  policyRevision: NativeWorkerPermitDigest.pressPolicyRevision,
                  candidateSetDigest: pressSet, actionDigest: pressAction),
              !NativeWorkerPermitDigest.pressMatches(controls: pressControls,
                  taskID: "task-1", scopeRef: "native:scope-1",
                  observationID: "obs-1", candidateID: "node-2",
                  role: "AXButton", label: "Documents",
                  expectedWindowTitle: "SystemOne Fixture — Downloads",
                  policyRevision: NativeWorkerPermitDigest.pressPolicyRevision,
                  candidateSetDigest: pressSet, actionDigest: pressAction) else {
            fatalError("native press digest or expected title binding changed")
        }
        let fileControls: [[String: Any]] = [[
            "id": "file-node", "role": "AXButton", "label": "Budget.xlsx",
            "enabled": true, "secure": false, "canPress": true,
        ], [
            "id": "open-node", "role": "AXButton",
            "label": "Open selected file",
            "enabled": true, "secure": false, "canPress": true,
        ]]
        let fileSet = try NativeWorkerPermitDigest.candidateSet(fileControls)
        let fileAction = try NativeWorkerPermitDigest.pressAction(
            taskID: "task-1", scopeRef: "native:scope-1",
            observationID: "obs-2", candidateID: "file-node",
            role: "AXButton", label: "Budget.xlsx",
            expectedWindowTitle:
                "SystemOne Fixture — Documents — Budget.xlsx selected",
            policyRevision: NativeWorkerPermitDigest.pressPolicyRevision)
        guard fileSet == CommandLine.arguments[5],
              fileAction == CommandLine.arguments[6],
              NativeWorkerPermitDigest.pressMatches(controls: fileControls,
                  taskID: "task-1", scopeRef: "native:scope-1",
                  observationID: "obs-2", candidateID: "file-node",
                  role: "AXButton", label: "Budget.xlsx",
                  expectedWindowTitle:
                      "SystemOne Fixture — Documents — Budget.xlsx selected",
                  policyRevision: NativeWorkerPermitDigest.pressPolicyRevision,
                  candidateSetDigest: fileSet, actionDigest: fileAction),
              !NativeWorkerPermitDigest.pressMatches(controls: fileControls,
                  taskID: "task-1", scopeRef: "native:scope-1",
                  observationID: "obs-2", candidateID: "open-node",
                  role: "AXButton", label: "Open selected file",
                  expectedWindowTitle:
                      "SystemOne Fixture — Documents — Budget.xlsx selected",
                  policyRevision: NativeWorkerPermitDigest.pressPolicyRevision,
                  candidateSetDigest: fileSet, actionDigest: fileAction) else {
            fatalError("file selection digest admitted an Open control")
        }
        print("PASS: field, folder and file digests match TypeScript; changed bindings denied")
    }
}
