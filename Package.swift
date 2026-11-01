// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "Photochooser",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Photochooser", targets: ["Photochooser"])
    ],
    targets: [
        .executableTarget(name: "Photochooser"),
        .testTarget(name: "PhotochooserTests", dependencies: ["Photochooser"])
    ]
)
