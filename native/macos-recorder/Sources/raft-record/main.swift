import AVFoundation
import AppKit
import CoreGraphics
import Foundation
import ScreenCaptureKit

struct WindowInfo: Encodable {
  let id: UInt32
  let title: String
  let app: String
  let x: Int
  let y: Int
  let width: Int
  let height: Int
}

enum CLIError: Error, CustomStringConvertible {
  case usage(String)
  case windowNotFound(String)
  case invalidOutput(String)
  case screenRecordingPermissionRequired
  case noFramesCaptured(String)

  var description: String {
    switch self {
    case .usage(let message):
      return message
    case .windowNotFound(let name):
      return "No visible window matched: \(name)"
    case .invalidOutput(let path):
      return "Invalid output path: \(path)"
    case .screenRecordingPermissionRequired:
      return "Screen Recording permission is required for this terminal/agent process. Grant it in System Settings > Privacy & Security > Screen & System Audio Recording, then restart the terminal/agent process."
    case .noFramesCaptured(let output):
      return "No frames were captured; no video was written. Check Screen Recording permission and whether the target window is visible. Output: \(output)"
    }
  }
}

@main
struct RaftRecord {
  static func main() async {
    _ = NSApplication.shared
    do {
      try await run(Array(CommandLine.arguments.dropFirst()))
    } catch {
      fputs("\(error)\n", stderr)
      exit(1)
    }
  }

  static func run(_ args: [String]) async throws {
    guard let command = args.first else {
      printHelp()
      return
    }

    let flags = parseFlags(Array(args.dropFirst()))

    switch command {
    case "list-windows":
      let windows = try await visibleWindows()
      let data = try JSONEncoder.pretty.encode(windows)
      print(String(decoding: data, as: UTF8.self))

    case "record":
      guard let windowName = flags["window"] else {
        throw CLIError.usage("Missing --window")
      }
      guard let output = flags["output"] else {
        throw CLIError.usage("Missing --output")
      }
      let duration = flags["duration"].flatMap(Double.init)
      try await recordWindow(named: windowName, output: output, duration: duration)

    case "help", "--help", "-h":
      printHelp()

    default:
      throw CLIError.usage("Unknown command: \(command)")
    }
  }

  static func printHelp() {
    print("""
    raft-record

    Commands:
      list-windows
      record --window <name> --output <file.mp4> [--duration <seconds>]
    """)
  }
}

func parseFlags(_ args: [String]) -> [String: String] {
  var result: [String: String] = [:]
  var index = 0
  while index < args.count {
    let token = args[index]
    if token.hasPrefix("--") {
      let key = String(token.dropFirst(2))
      if index + 1 < args.count && !args[index + 1].hasPrefix("--") {
        result[key] = args[index + 1]
        index += 2
      } else {
        result[key] = "true"
        index += 1
      }
    } else {
      index += 1
    }
  }
  return result
}

func visibleWindows() async throws -> [WindowInfo] {
  let content = try await SCShareableContent.excludingDesktopWindows(
    false,
    onScreenWindowsOnly: true
  )

  return content.windows
    .filter { window in
      guard window.frame.width > 20, window.frame.height > 20 else { return false }
      return !(window.title ?? "").isEmpty || window.owningApplication != nil
    }
    .map { window in
      WindowInfo(
        id: window.windowID,
        title: window.title ?? "",
        app: window.owningApplication?.applicationName ?? "",
        x: Int(window.frame.origin.x.rounded()),
        y: Int(window.frame.origin.y.rounded()),
        width: Int(window.frame.width.rounded()),
        height: Int(window.frame.height.rounded())
      )
    }
    .sorted { lhs, rhs in
      if lhs.app == rhs.app { return lhs.title < rhs.title }
      return lhs.app < rhs.app
    }
}

func recordWindow(named windowName: String, output: String, duration: Double?) async throws {
  guard CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() else {
    throw CLIError.screenRecordingPermissionRequired
  }

  let content = try await SCShareableContent.excludingDesktopWindows(
    false,
    onScreenWindowsOnly: true
  )
  guard let window = findWindow(named: windowName, in: content.windows) else {
    throw CLIError.windowNotFound(windowName)
  }

  let outputURL = URL(fileURLWithPath: output)
  let outputDir = outputURL.deletingLastPathComponent()
  try FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
  if FileManager.default.fileExists(atPath: outputURL.path) {
    try FileManager.default.removeItem(at: outputURL)
  }

  let width = max(2, Int(window.frame.width.rounded()))
  let height = max(2, Int(window.frame.height.rounded()))
  let recorder = try WindowRecorder(outputURL: outputURL, width: width, height: height)

  let configuration = SCStreamConfiguration()
  configuration.width = width
  configuration.height = height
  configuration.minimumFrameInterval = CMTime(value: 1, timescale: 30)
  configuration.queueDepth = 6
  configuration.pixelFormat = kCVPixelFormatType_32BGRA
  configuration.showsCursor = true

  let filter = SCContentFilter(desktopIndependentWindow: window)
  let stream = SCStream(filter: filter, configuration: configuration, delegate: recorder)
  try stream.addStreamOutput(recorder, type: .screen, sampleHandlerQueue: recorder.queue)

  let stopController = StopController(stream: stream, recorder: recorder)
  recorder.onStreamStoppedWithError = { error in
    fputs("ScreenCaptureKit stopped: \(error)\n", stderr)
    stopController.stopAndExit()
  }
  let signalSources = installSignalHandler {
    stopController.stopAndExit()
  }
  defer { _ = signalSources }

  try await stream.startCapture()

  if let duration {
    try await Task.sleep(nanoseconds: UInt64(max(0, duration) * 1_000_000_000))
    try await stream.stopCapture()
    await recorder.finish()
    if recorder.capturedFrameCount == 0 {
      throw CLIError.noFramesCaptured(output)
    }
  } else {
    while true {
      try await Task.sleep(nanoseconds: 1_000_000_000)
    }
  }
}

func findWindow(named name: String, in windows: [SCWindow]) -> SCWindow? {
  let query = name.lowercased()
  return windows.first { window in
    let title = (window.title ?? "").lowercased()
    let app = (window.owningApplication?.applicationName ?? "").lowercased()
    return title.contains(query) || app.contains(query)
  }
}

final class WindowRecorder: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  let queue = DispatchQueue(label: "raft.record.window.samples")
  private let writer: AVAssetWriter
  private let input: AVAssetWriterInput
  private let stateQueue = DispatchQueue(label: "raft.record.window.state")
  private var sourceStart: CMTime?
  private var finished = false
  private var frameCount = 0
  var onStreamStoppedWithError: (@Sendable (Error) -> Void)?

  var capturedFrameCount: Int {
    stateQueue.sync { frameCount }
  }

  init(outputURL: URL, width: Int, height: Int) throws {
    writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)
    input = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.h264,
      AVVideoWidthKey: width,
      AVVideoHeightKey: height,
      AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: 5_000_000,
        AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel
      ]
    ])
    input.expectsMediaDataInRealTime = true
    if writer.canAdd(input) {
      writer.add(input)
    }
  }

  func stream(
    _ stream: SCStream,
    didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
    of type: SCStreamOutputType
  ) {
    guard type == .screen, sampleBuffer.isValid else { return }
    guard !isFinishing else { return }
    guard isCompleteFrame(sampleBuffer) else { return }

    if sourceStart == nil {
      sourceStart = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
      writer.startWriting()
      writer.startSession(atSourceTime: sourceStart!)
    }

    guard writer.status == .writing else { return }
    guard input.isReadyForMoreMediaData else { return }
    if input.append(sampleBuffer) {
      stateQueue.sync {
        frameCount += 1
      }
    } else if let error = writer.error {
      fputs("AVAssetWriter append failed: \(error)\n", stderr)
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) {
    onStreamStoppedWithError?(error)
  }

  func finish() async {
    guard markFinishing() else { return }

    await withCheckedContinuation { continuation in
      queue.async {
        guard self.sourceStart != nil, self.writer.status == .writing else {
          self.writer.cancelWriting()
          continuation.resume()
          return
        }

        self.input.markAsFinished()
        self.writer.finishWriting {
          if let error = self.writer.error {
            fputs("AVAssetWriter finish failed: \(error)\n", stderr)
          }
          continuation.resume()
        }
      }
    }
  }

  private var isFinishing: Bool {
    stateQueue.sync { finished }
  }

  private func isCompleteFrame(_ sampleBuffer: CMSampleBuffer) -> Bool {
    guard
      let attachmentsArray = CMSampleBufferGetSampleAttachmentsArray(
        sampleBuffer,
        createIfNecessary: false
      ) as? [[SCStreamFrameInfo: Any]],
      let attachments = attachmentsArray.first,
      let statusRaw = attachments[SCStreamFrameInfo.status] as? Int,
      let status = SCFrameStatus(rawValue: statusRaw)
    else {
      return true
    }

    return status == .complete
  }

  private func markFinishing() -> Bool {
    stateQueue.sync {
      if finished {
        return false
      }
      finished = true
      return true
    }
  }
}

final class StopController: @unchecked Sendable {
  private let stream: SCStream
  private let recorder: WindowRecorder
  private let stateQueue = DispatchQueue(label: "raft.record.window.stop")
  private var stopping = false

  init(stream: SCStream, recorder: WindowRecorder) {
    self.stream = stream
    self.recorder = recorder
  }

  func stopAndExit() {
    guard markStopping() else { return }

    Task {
      try? await stream.stopCapture()
      await recorder.finish()
      exit(recorder.capturedFrameCount > 0 ? 0 : 1)
    }
  }

  private func markStopping() -> Bool {
    stateQueue.sync {
      if stopping {
        return false
      }
      stopping = true
      return true
    }
  }
}

func installSignalHandler(_ handler: @Sendable @escaping () -> Void) -> [DispatchSourceSignal] {
  signal(SIGINT, SIG_IGN)
  signal(SIGTERM, SIG_IGN)

  let sigint = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
  sigint.setEventHandler(handler: handler)
  sigint.resume()

  let sigterm = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
  sigterm.setEventHandler(handler: handler)
  sigterm.resume()

  return [sigint, sigterm]
}

extension JSONEncoder {
  static var pretty: JSONEncoder {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    return encoder
  }
}
