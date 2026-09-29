// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "VoidDesignSystem",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "VoidDesignSystem", targets: ["VoidDesignSystem"])
    ],
    targets: [
        .target(name: "VoidDesignSystem"),
        .testTarget(
            name: "VoidDesignSystemTests",
            dependencies: ["VoidDesignSystem"]
        )
    ]
)
