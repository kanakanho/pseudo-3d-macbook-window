// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "Pseudo3DWindow",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "Pseudo3DWindow",
            linkerSettings: [.linkedFramework("IOKit"), .linkedFramework("WebKit"), .linkedFramework("AVFoundation")]
        ),
    ],
    swiftLanguageModes: [.v5]
)
