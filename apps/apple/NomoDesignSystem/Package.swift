// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "NomoDesignSystem",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "NomoDesignSystem", targets: ["NomoDesignSystem"])
    ],
    targets: [
        .target(name: "NomoDesignSystem"),
        .testTarget(
            name: "NomoDesignSystemTests",
            dependencies: ["NomoDesignSystem"]
        )
    ]
)
