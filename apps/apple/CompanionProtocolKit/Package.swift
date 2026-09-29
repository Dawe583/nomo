// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "CompanionProtocolKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "CompanionProtocolKit", targets: ["CompanionProtocolKit"])
    ],
    targets: [
        .target(name: "CompanionProtocolKit"),
        .testTarget(
            name: "CompanionProtocolKitTests",
            dependencies: ["CompanionProtocolKit"]
        )
    ]
)
