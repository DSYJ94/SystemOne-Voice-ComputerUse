import Darwin
import Foundation
import Security

public struct CodeIdentity: Equatable, Sendable {
    public let signingIdentifier: String
    public let teamIdentifier: String?
    public let cdHash: String

    public init(signingIdentifier: String, teamIdentifier: String?, cdHash: String) {
        self.signingIdentifier = signingIdentifier
        self.teamIdentifier = teamIdentifier
        self.cdHash = cdHash.lowercased()
    }
}

public struct PeerIdentity: Equatable, Sendable {
    public let pid: pid_t
    public let pidVersion: Int32
    public let effectiveUserID: uid_t
    public let effectiveGroupID: gid_t
    public let code: CodeIdentity

    public init(pid: pid_t, pidVersion: Int32, effectiveUserID: uid_t,
                effectiveGroupID: gid_t, code: CodeIdentity) {
        self.pid = pid
        self.pidVersion = pidVersion
        self.effectiveUserID = effectiveUserID
        self.effectiveGroupID = effectiveGroupID
        self.code = code
    }
}

public struct PeerRequirement: Sendable {
    public let effectiveUserID: uid_t
    public let signingIdentifier: String
    public let teamIdentifier: String?
    public let allowedCDHashes: Set<String>

    public init(effectiveUserID: uid_t, signingIdentifier: String,
                teamIdentifier: String? = nil, allowedCDHashes: Set<String> = []) throws {
        guard signingIdentifier.range(of: #"^[A-Za-z0-9.-]{1,200}$"#,
                                      options: .regularExpression) != nil else {
            throw PeerIdentityError.invalidRequirement
        }
        if let teamIdentifier,
           teamIdentifier.range(of: #"^[A-Z0-9]{10}$"#,
                                options: .regularExpression) == nil {
            throw PeerIdentityError.invalidRequirement
        }
        let normalized = Set(allowedCDHashes.map { $0.lowercased() })
        guard normalized.allSatisfy({
            $0.range(of: #"^[a-f0-9]{40,128}$"#, options: .regularExpression) != nil
        }) else { throw PeerIdentityError.invalidRequirement }
        guard teamIdentifier != nil || !normalized.isEmpty else {
            throw PeerIdentityError.missingTrustAnchor
        }
        self.effectiveUserID = effectiveUserID
        self.signingIdentifier = signingIdentifier
        self.teamIdentifier = teamIdentifier
        self.allowedCDHashes = normalized
    }

    fileprivate func validateIdentity(_ identity: PeerIdentity) throws {
        guard identity.effectiveUserID == effectiveUserID else {
            throw PeerIdentityError.requirementMismatch("effective user")
        }
        guard identity.code.signingIdentifier == signingIdentifier else {
            throw PeerIdentityError.requirementMismatch("signing identifier")
        }
        if let teamIdentifier {
            guard identity.code.teamIdentifier == teamIdentifier else {
                throw PeerIdentityError.requirementMismatch("team identifier")
            }
        }
        if !allowedCDHashes.isEmpty {
            guard allowedCDHashes.contains(identity.code.cdHash) else {
                throw PeerIdentityError.requirementMismatch("CDHash")
            }
        }
    }

    fileprivate func validateCode(_ code: SecCode) throws {
        guard let teamIdentifier else { return }
        let text = "anchor apple generic and identifier \"\(signingIdentifier)\" " +
            "and certificate leaf[subject.OU] = \"\(teamIdentifier)\""
        var requirement: SecRequirement?
        let createStatus = SecRequirementCreateWithString(text as CFString, [], &requirement)
        guard createStatus == errSecSuccess, let requirement else {
            throw PeerIdentityError.securityCall("SecRequirementCreateWithString", createStatus)
        }
        let validity = SecCodeCheckValidity(code, [], requirement)
        guard validity == errSecSuccess else {
            throw PeerIdentityError.requirementMismatch("Apple-anchored code requirement")
        }
    }
}

public enum PeerIdentityError: Error, Equatable, CustomStringConvertible {
    case invalidSocket
    case socketCall(String, Int32)
    case malformedAuditToken
    case peerCredentialMismatch
    case securityCall(String, OSStatus)
    case unsignedPeer
    case invalidRequirement
    case missingTrustAnchor
    case requirementMismatch(String)

    public var description: String {
        switch self {
        case .invalidSocket: return "invalid socket"
        case let .socketCall(name, code): return "\(name) failed with errno \(code)"
        case .malformedAuditToken: return "malformed peer audit token"
        case .peerCredentialMismatch: return "peer credential sources disagree"
        case let .securityCall(name, status): return "\(name) failed with OSStatus \(status)"
        case .unsignedPeer: return "peer has no usable code identity"
        case .invalidRequirement: return "invalid peer requirement"
        case .missingTrustAnchor: return "peer requirement needs Team ID or pinned CDHash"
        case let .requirementMismatch(field): return "peer requirement mismatch: \(field)"
        }
    }
}

/// Inspect a currently connected local-domain socket. The returned identity is
/// tied to the kernel-provided audit token and dynamically validated code object.
/// Call this before decoding messages and keep the connection open while binding
/// the resulting identity to its in-process endpoint capability.
public func inspectConnectedUnixPeer(socket: Int32) throws -> PeerIdentity {
    try inspectPeer(socket: socket).identity
}

/// Authenticate a connected local peer against host-owned policy. Team-ID mode
/// also evaluates an Apple-anchored dynamic code requirement; comparing Team ID
/// metadata alone is not an authentication decision.
public func authenticateConnectedUnixPeer(
    socket: Int32, requirement: PeerRequirement
) throws -> PeerIdentity {
    let inspected = try inspectPeer(socket: socket)
    try requirement.validateIdentity(inspected.identity)
    try requirement.validateCode(inspected.code)
    return inspected.identity
}

private func inspectPeer(socket: Int32) throws -> (identity: PeerIdentity, code: SecCode) {
    guard socket >= 0 else { throw PeerIdentityError.invalidSocket }
    var token = audit_token_t()
    var tokenLength = socklen_t(MemoryLayout<audit_token_t>.size)
    guard getsockopt(socket, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &tokenLength) == 0 else {
        throw PeerIdentityError.socketCall("LOCAL_PEERTOKEN", errno)
    }
    guard tokenLength == MemoryLayout<audit_token_t>.size else {
        throw PeerIdentityError.malformedAuditToken
    }

    let pid = audit_token_to_pid(token)
    let pidVersion = audit_token_to_pidversion(token)
    let effectiveUserID = audit_token_to_euid(token)
    let effectiveGroupID = audit_token_to_egid(token)
    guard pid > 0 && pidVersion > 0 else { throw PeerIdentityError.malformedAuditToken }

    var socketUserID: uid_t = 0
    var socketGroupID: gid_t = 0
    guard getpeereid(socket, &socketUserID, &socketGroupID) == 0 else {
        throw PeerIdentityError.socketCall("getpeereid", errno)
    }
    guard socketUserID == effectiveUserID && socketGroupID == effectiveGroupID else {
        throw PeerIdentityError.peerCredentialMismatch
    }

    let dynamicCode = try dynamicCode(for: token)
    let codeIdentity = try validatedCodeIdentity(dynamicCode)
    let identity = PeerIdentity(pid: pid, pidVersion: pidVersion,
                                effectiveUserID: effectiveUserID,
                                effectiveGroupID: effectiveGroupID, code: codeIdentity)
    return (identity, dynamicCode)
}

/// Resolve the running host's validated identity. Test utilities use this to
/// create a pinned same-binary requirement; production requirements must come
/// from signed release configuration rather than learning a peer at runtime.
public func currentCodeIdentity() throws -> CodeIdentity {
    var code: SecCode?
    let status = SecCodeCopySelf([], &code)
    guard status == errSecSuccess, let code else {
        throw PeerIdentityError.securityCall("SecCodeCopySelf", status)
    }
    return try validatedCodeIdentity(code)
}

private func dynamicCode(for token: audit_token_t) throws -> SecCode {
    var copy = token
    let tokenData = withUnsafeBytes(of: &copy) { Data($0) }
    let attributes = [kSecGuestAttributeAudit as String: tokenData] as CFDictionary
    var code: SecCode?
    let status = SecCodeCopyGuestWithAttributes(nil, attributes, [], &code)
    guard status == errSecSuccess, let code else {
        throw PeerIdentityError.securityCall("SecCodeCopyGuestWithAttributes", status)
    }
    return code
}

private func validatedCodeIdentity(_ code: SecCode) throws -> CodeIdentity {
    let validity = SecCodeCheckValidity(code, [], nil)
    guard validity == errSecSuccess else {
        throw PeerIdentityError.securityCall("SecCodeCheckValidity", validity)
    }

    var staticCode: SecStaticCode?
    let staticStatus = SecCodeCopyStaticCode(code, [], &staticCode)
    guard staticStatus == errSecSuccess, let staticCode else {
        throw PeerIdentityError.securityCall("SecCodeCopyStaticCode", staticStatus)
    }

    var rawInformation: CFDictionary?
    let infoStatus = SecCodeCopySigningInformation(
        staticCode, SecCSFlags(rawValue: kSecCSSigningInformation), &rawInformation)
    guard infoStatus == errSecSuccess,
          let information = rawInformation as? [String: Any],
          let signingIdentifier = information[kSecCodeInfoIdentifier as String] as? String,
          let hashData = information[kSecCodeInfoUnique as String] as? Data,
          !signingIdentifier.isEmpty, !hashData.isEmpty else {
        if infoStatus != errSecSuccess {
            throw PeerIdentityError.securityCall("SecCodeCopySigningInformation", infoStatus)
        }
        throw PeerIdentityError.unsignedPeer
    }
    let cdHash = hashData.map { String(format: "%02x", $0) }.joined()
    let teamIdentifier = information[kSecCodeInfoTeamIdentifier as String] as? String
    return CodeIdentity(signingIdentifier: signingIdentifier,
                        teamIdentifier: teamIdentifier, cdHash: cdHash)
}
