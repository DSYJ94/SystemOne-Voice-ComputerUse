// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "NativeAX",
    platforms: [.macOS(.v14)],
    products: [.library(name: "NativeAX", targets: ["NativeAX"])],
    targets: [
        .target(name: "NativeAX"),
        .executableTarget(name: "NativeAXCheck", dependencies: ["NativeAX"]),
    ]
)
