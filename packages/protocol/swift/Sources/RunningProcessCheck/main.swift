import Foundation
import PeerIdentity

guard CommandLine.arguments.count == 4 else {
    fatalError("usage: RunningProcessCheck SIGNED_BINARY SIGNING_ID CDHASH")
}
let path = CommandLine.arguments[1]
let signingID = CommandLine.arguments[2]
let hash = CommandLine.arguments[3]
let child = Process()
child.executableURL = URL(fileURLWithPath: path)
child.arguments = ["-e", "setInterval(() => {}, 1000)"]
child.standardOutput = FileHandle.nullDevice
child.standardError = FileHandle.nullDevice
try child.run()
defer {
    if child.isRunning { child.terminate() }
    child.waitUntilExit()
}
let requirement = try RunningProcessRequirement(
    signingIdentifier: signingID, allowedCDHashes: [hash])
let found = try authenticateRunningProcess(
    pid: child.processIdentifier, requirement: requirement)
guard child.isRunning, found.signingIdentifier == signingID,
      found.cdHash == hash.lowercased() else {
    fatalError("running process identity changed")
}
for (badID, badHash, reason) in [
    ("com.aurium.systemone.wrong", hash, "signing identifier"),
    (signingID, String(repeating: "f", count: 40), "CDHash"),
] {
    do {
        let denied = try RunningProcessRequirement(
            signingIdentifier: badID, allowedCDHashes: [badHash])
        _ = try authenticateRunningProcess(pid: child.processIdentifier,
                                           requirement: denied)
        fatalError("wrong \(reason) was accepted")
    } catch PeerIdentityError.requirementMismatch(let actual) where actual == reason {
        // Expected.
    }
}
print("PASS: running child code identity pinned; wrong identifier and CDHash rejected")
