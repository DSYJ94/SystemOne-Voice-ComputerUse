import Foundation

/// The worker independently reconstructs the host's protocol-2 digest inputs.
/// A digest proves consistency with the observed candidate set; it is not a
/// signature or a replacement for an authenticated, durable execution permit.
enum NativeWorkerPermitDigest {
    static let policyRevision = "native-ax-policy-v1"
    static let pressPolicyRevision = "native-ax-press-fixture-v1"

    static func candidateSet(_ controls: [[String: Any]]) throws -> String {
        try CanonicalJSON.digest(controls)
    }

    static func action(taskID: String, scopeRef: String, observationID: String,
                       candidateID: String, label: String, value: String,
                       policyRevision: String) throws -> String {
        try CanonicalJSON.digest([
            "taskId": taskID,
            "scopeRef": scopeRef,
            "observationId": observationID,
            "candidateId": candidateID,
            "label": label,
            "valueDigest": CanonicalJSON.digest(value),
            "policyRevision": policyRevision,
        ])
    }

    static func matches(controls: [[String: Any]], taskID: String,
                        scopeRef: String, observationID: String,
                        candidateID: String, label: String, value: String,
                        policyRevision: String, candidateSetDigest: String,
                        actionDigest: String) -> Bool {
        guard policyRevision == Self.policyRevision,
              let expectedSet = try? candidateSet(controls),
              let expectedAction = try? action(taskID: taskID, scopeRef: scopeRef,
                  observationID: observationID, candidateID: candidateID,
                  label: label, value: value, policyRevision: policyRevision) else {
            return false
        }
        return candidateSetDigest == expectedSet && actionDigest == expectedAction
    }

    static func pressAction(taskID: String, scopeRef: String,
                            observationID: String, candidateID: String,
                            role: String, label: String,
                            expectedWindowTitle: String,
                            policyRevision: String) throws -> String {
        try CanonicalJSON.digest([
            "taskId": taskID, "scopeRef": scopeRef,
            "observationId": observationID, "candidateId": candidateID,
            "role": role, "label": label,
            "expectedWindowTitle": expectedWindowTitle,
            "policyRevision": policyRevision,
        ])
    }

    static func pressMatches(controls: [[String: Any]], taskID: String,
                             scopeRef: String, observationID: String,
                             candidateID: String, role: String, label: String,
                             expectedWindowTitle: String,
                             policyRevision: String,
                             candidateSetDigest: String,
                             actionDigest: String) -> Bool {
        guard policyRevision == pressPolicyRevision,
              let set = try? candidateSet(controls),
              let action = try? pressAction(taskID: taskID,
                  scopeRef: scopeRef, observationID: observationID,
                  candidateID: candidateID, role: role, label: label,
                  expectedWindowTitle: expectedWindowTitle,
                  policyRevision: policyRevision) else { return false }
        return candidateSetDigest == set && actionDigest == action
    }
}
