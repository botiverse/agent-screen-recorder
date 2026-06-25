// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "macos-recorder",
  platforms: [
    .macOS(.v13)
  ],
  products: [
    .executable(name: "raft-record", targets: ["raft-record"])
  ],
  targets: [
    .executableTarget(name: "raft-record")
  ]
)
