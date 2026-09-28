// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "NativeAX",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "NativeAX", targets: ["NativeAX"]),
        .executable(name: "NativeAXValueCheck", targets: ["NativeAXValueCheck"]),
    ],
    targets: [
        .target(name: "NativeAX"),
        .executableTarget(name: "NativeAXCheck", dependencies: ["NativeAX"]),
        .executableTarget(name: "NativeAXValueCheck", dependencies: ["NativeAX"]),
    ]
)
