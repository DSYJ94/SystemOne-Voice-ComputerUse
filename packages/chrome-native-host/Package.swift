// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SystemOneChromeNativeHost",
    platforms: [.macOS(.v15)],
    dependencies: [.package(path: "../protocol/swift")],
    targets: [
        .executableTarget(
            name: "SystemOneChromeNativeHost",
            dependencies: [.product(name: "PeerIdentity", package: "swift")],
            linkerSettings: [.linkedLibrary("bsm")]
        ),
        .executableTarget(
            name: "ChromeNativeHostCheck",
            dependencies: [.product(name: "PeerIdentity", package: "swift")],
            linkerSettings: [.linkedLibrary("bsm")]
        )
    ]
)
