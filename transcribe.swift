#!/usr/bin/env swift
/// Transcribe recent audio segments using SFSpeechRecognizer
import Foundation
import Speech

let segmentDir = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/uitocc/audio")

// Collect recent segment files, sorted by modification date (newest first)
guard let files = try? FileManager.default.contentsOfDirectory(
    at: segmentDir, includingPropertiesForKeys: [.contentModificationDateKey],
    options: .skipsHiddenFiles
) else {
    fputs("No audio segments found\n", stderr)
    exit(1)
}

let wavFiles = files
    .filter { $0.pathExtension == "wav" }
    .sorted { a, b in
        let da = (try? a.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
        let db = (try? b.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
        return da > db
    }

// Take the most recent segments (up to ~60s worth = 2 files at 30s each)
let recentFiles = Array(wavFiles.prefix(2)).reversed()

guard !recentFiles.isEmpty else {
    fputs("No audio segments found\n", stderr)
    exit(1)
}

// Concatenate segments into a single temp file
let tempDir = FileManager.default.temporaryDirectory
let mergedPath = tempDir.appendingPathComponent("uitocc-merged-\(ProcessInfo.processInfo.processIdentifier).wav")

// Use ffmpeg to concatenate
var concatList = ""
for f in recentFiles {
    concatList += "file '\(f.path)'\n"
}
let listPath = tempDir.appendingPathComponent("uitocc-concat-\(ProcessInfo.processInfo.processIdentifier).txt")
try! concatList.write(to: listPath, atomically: true, encoding: .utf8)

let ffmpeg = Process()
ffmpeg.executableURL = URL(fileURLWithPath: "/usr/bin/env")
ffmpeg.arguments = ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", listPath.path, "-c", "copy", mergedPath.path]
ffmpeg.standardOutput = FileHandle.nullDevice
ffmpeg.standardError = FileHandle.nullDevice
try! ffmpeg.run()
ffmpeg.waitUntilExit()

defer {
    try? FileManager.default.removeItem(at: mergedPath)
    try? FileManager.default.removeItem(at: listPath)
}

guard ffmpeg.terminationStatus == 0 else {
    fputs("ffmpeg concat failed\n", stderr)
    exit(1)
}

// Transcribe with SFSpeechRecognizer
guard SFSpeechRecognizer.authorizationStatus() == .authorized ||
      SFSpeechRecognizer.authorizationStatus() == .notDetermined else {
    fputs("Speech recognition not authorized\n", stderr)
    exit(1)
}

let semaphore = DispatchSemaphore(value: 0)
var transcription: String?
var transcribeError: Error?

SFSpeechRecognizer.requestAuthorization { status in
    guard status == .authorized else {
        fputs("Speech recognition denied\n", stderr)
        semaphore.signal()
        return
    }

    let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "ja-JP"))
        ?? SFSpeechRecognizer()!
    let request = SFSpeechURLRecognitionRequest(url: mergedPath)

    recognizer.recognitionTask(with: request) { result, error in
        if let error = error {
            transcribeError = error
            semaphore.signal()
            return
        }
        if let result = result, result.isFinal {
            transcription = result.bestTranscription.formattedString
            semaphore.signal()
        }
    }
}

let timeout = DispatchTime.now() + .seconds(30)
if semaphore.wait(timeout: timeout) == .timedOut {
    fputs("Transcription timed out\n", stderr)
    exit(1)
}

if let err = transcribeError {
    fputs("Transcription error: \(err.localizedDescription)\n", stderr)
    exit(1)
}

if let text = transcription, !text.isEmpty {
    print(text)
} else {
    fputs("No speech detected\n", stderr)
    exit(1)
}
