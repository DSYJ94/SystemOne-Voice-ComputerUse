// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "ProtocolDigest",
    platforms: [.macOS(.v15)],
    products: [.library(name: "ProtocolDigest", targets: ["ProtocolDigest"])],
    targets: [
        .target(name: "ProtocolDigest"),
        .executableTarget(name: "DigestCheck", dependencies: ["ProtocolDigest"]),
        .testTarget(name: "ProtocolDigestTests", dependencies: ["ProtocolDigest"])
    ]
)
