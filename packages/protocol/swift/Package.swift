// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ProtocolDigest",
    platforms: [.macOS(.v15)],
    products: [
        .library(name: "ProtocolDigest", targets: ["ProtocolDigest"]),
        .library(name: "PeerIdentity", targets: ["PeerIdentity"])
    ],
    targets: [
        .target(name: "ProtocolDigest"),
        .executableTarget(name: "DigestCheck", dependencies: ["ProtocolDigest"]),
        .target(
            name: "PeerIdentity",
            linkerSettings: [.linkedFramework("Security"), .linkedLibrary("bsm")]
        ),
        .executableTarget(
            name: "PeerIdentityCheck",
            dependencies: ["PeerIdentity"]
        ),
        .testTarget(name: "ProtocolDigestTests", dependencies: ["ProtocolDigest"])
    ]
)
