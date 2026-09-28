import CoreFoundation
import CryptoKit
import Foundation

/// Verifies a controller-signed, short-lived claim against the worker's own
/// retained observation and preparation. Host code identity must be checked
/// by the AppKit parent before it accepts the public key from its child pipe.
enum NativeHostPermit {
    private static let domain = "systemone.native.commit.v1"
    private static let fields: Set<String> = ["executionId", "permitRef", "taskId",
        "taskEpoch", "goalRevision", "scopeRef", "observationId", "candidateId",
        "candidateSetDigest", "actionDigest", "policyRevision", "leaseGeneration"]

    static func publicKey(_ encoded: String) -> Curve25519.Signing.PublicKey? {
        guard let bytes = decodeBase64URL(encoded), bytes.count == 32 else { return nil }
        return try? Curve25519.Signing.PublicKey(rawRepresentation: bytes)
    }

    static func verify(publicKey: Curve25519.Signing.PublicKey,
                       message: [String: Any], taskID: String,
                       preparationRef: String, executionID: String,
                       permitRef: String, scopeRef: String,
                       observationID: String, candidateID: String,
                       candidateSetDigest: String, actionDigest: String,
                       policyRevision: String = NativeWorkerPermitDigest.policyRevision,
                       nowMs: Int64 = Int64(Date().timeIntervalSince1970 * 1_000)) -> Bool {
        guard let permit = message["permit"] as? [String: Any],
              Set(permit.keys) == fields,
              message["preparationRef"] as? String == preparationRef,
              let signatureText = message["signature"] as? String,
              let signature = decodeBase64URL(signatureText),
              signature.count == 64,
              let expiry = message["expiresAtMs"] as? NSNumber,
              CFGetTypeID(expiry) != CFBooleanGetTypeID(),
              expiry.int64Value > nowMs,
              expiry.int64Value <= nowMs + 30_000,
              permit["taskId"] as? String == taskID,
              permit["executionId"] as? String == executionID,
              permit["permitRef"] as? String == permitRef,
              permit["scopeRef"] as? String == scopeRef,
              permit["observationId"] as? String == observationID,
              permit["candidateId"] as? String == candidateID,
              permit["candidateSetDigest"] as? String == candidateSetDigest,
              permit["actionDigest"] as? String == actionDigest,
              permit["policyRevision"] as? String == policyRevision,
              integerOne(permit["taskEpoch"]),
              integerOne(permit["goalRevision"]),
              integerOne(permit["leaseGeneration"]) else { return false }
        let claim: [String: Any] = ["domain": domain, "permit": permit,
            "preparationRef": preparationRef, "expiresAtMs": expiry]
        guard let canonical = try? CanonicalJSON.encode(claim) else { return false }
        return publicKey.isValidSignature(signature, for: Data(canonical.utf8))
    }

    private static func integerOne(_ value: Any?) -> Bool {
        guard let number = value as? NSNumber,
              CFGetTypeID(number) != CFBooleanGetTypeID() else { return false }
        return number.int64Value == 1 && number.doubleValue == 1
    }

    private static func decodeBase64URL(_ input: String) -> Data? {
        guard input.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil,
              input.count <= 128 else { return nil }
        let padded = input.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
            .padding(toLength: (input.count + 3) / 4 * 4, withPad: "=", startingAt: 0)
        return Data(base64Encoded: padded)
    }
}
