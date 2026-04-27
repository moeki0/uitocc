#!/usr/bin/env swift
/// Capture audio from a specified device (or BlackHole by default) and save as WAV chunks
/// Usage: audio_capture <output_dir> [chunk_seconds] [--device <name>]
///   --device default   → system default microphone
///   --device <name>    → device whose name contains <name> (case-insensitive)
///   (no --device)      → BlackHole (legacy behavior)
import AVFoundation
import Foundation

guard CommandLine.arguments.count >= 2 else {
    fputs("Usage: audio_capture <output_dir> [chunk_seconds] [--device <name>]\n", stderr)
    exit(1)
}

let outputDir = CommandLine.arguments[1]
var chunkSeconds: Double = 30.0
var deviceQuery: String? = nil

// Parse arguments
var i = 2
while i < CommandLine.arguments.count {
    if CommandLine.arguments[i] == "--device" && i + 1 < CommandLine.arguments.count {
        deviceQuery = CommandLine.arguments[i + 1]
        i += 2
    } else if chunkSeconds == 30.0, let v = Double(CommandLine.arguments[i]) {
        chunkSeconds = v
        i += 1
    } else {
        i += 1
    }
}

func findDevice(query: String?) -> AVCaptureDevice? {
    // --device default → system default mic
    if let q = query, q == "default" {
        return AVCaptureDevice.default(for: .audio)
    }

    let devices = AVCaptureDevice.DiscoverySession(
        deviceTypes: [.microphone, .external],
        mediaType: .audio,
        position: .unspecified
    ).devices

    // --device <name> → partial match
    if let q = query {
        let lower = q.lowercased()
        for d in devices {
            if d.localizedName.lowercased().contains(lower) { return d }
        }
        return nil
    }

    // No --device → find BlackHole (legacy)
    for d in devices {
        if d.localizedName.lowercased().contains("blackhole") { return d }
    }

    // Also check via Core Audio
    var propAddr = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    var dataSize: UInt32 = 0
    AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &propAddr, 0, nil, &dataSize)
    let count = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
    var deviceIDs = [AudioDeviceID](repeating: 0, count: count)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &propAddr, 0, nil, &dataSize, &deviceIDs)

    for id in deviceIDs {
        var nameAddr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceNameCFString,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var name: CFString = "" as CFString
        var nameSize = UInt32(MemoryLayout<CFString>.size)
        AudioObjectGetPropertyData(id, &nameAddr, 0, nil, &nameSize, &name)
        if (name as String).lowercased().contains("blackhole") {
            return AVCaptureDevice(uniqueID: String(id))
        }
    }
    return nil
}

guard let device = findDevice(query: deviceQuery) else {
    if deviceQuery != nil {
        fputs("Audio device matching '\(deviceQuery!)' not found.\n", stderr)
    } else {
        fputs("BlackHole audio device not found. Install with: brew install --cask blackhole-2ch\n", stderr)
    }
    exit(1)
}

fputs("Using audio device: \(device.localizedName)\n", stderr)

// Create output directory
try? FileManager.default.createDirectory(atPath: outputDir, withIntermediateDirectories: true)

class AudioRecorder: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate {
    let outputDir: String
    let chunkDuration: Double
    var assetWriter: AVAssetWriter?
    var audioInput: AVAssetWriterInput?
    var chunkStart: Date
    var currentFile: String = ""
    var chunkIndex = 0
    let isoFormatter: ISO8601DateFormatter

    init(outputDir: String, chunkDuration: Double) {
        self.outputDir = outputDir
        self.chunkDuration = chunkDuration
        self.chunkStart = Date()
        self.isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        super.init()
    }

    func startNewChunk() {
        // Finish previous
        if let writer = assetWriter, writer.status == .writing {
            audioInput?.markAsFinished()
            let sem = DispatchSemaphore(value: 0)
            writer.finishWriting { sem.signal() }
            sem.wait()
            let ts = self.isoFormatter.string(from: self.chunkStart)
            // Print completed chunk info as JSON
            let info = "{\"file\":\"\(self.currentFile)\",\"timestamp\":\"\(ts)\"}"
            print(info)
            fflush(stdout)
        }

        chunkStart = Date()
        let ts = isoFormatter.string(from: chunkStart).replacingOccurrences(of: ":", with: "-").replacingOccurrences(of: ".", with: "-")
        currentFile = "\(outputDir)/audio_\(ts).wav"
        let url = URL(fileURLWithPath: currentFile)

        do {
            assetWriter = try AVAssetWriter(outputURL: url, fileType: .wav)
            let settings: [String: Any] = [
                AVFormatIDKey: kAudioFormatLinearPCM,
                AVSampleRateKey: 16000,
                AVNumberOfChannelsKey: 1,
                AVLinearPCMBitDepthKey: 16,
                AVLinearPCMIsFloatKey: false,
                AVLinearPCMIsBigEndianKey: false,
                AVLinearPCMIsNonInterleaved: false,
            ]
            audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
            audioInput?.expectsMediaDataInRealTime = true
            assetWriter?.add(audioInput!)
            assetWriter?.startWriting()
            assetWriter?.startSession(atSourceTime: .zero)
        } catch {
            fputs("Failed to create writer: \(error)\n", stderr)
        }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        if assetWriter == nil || Date().timeIntervalSince(chunkStart) >= chunkDuration {
            startNewChunk()
        }
        if audioInput?.isReadyForMoreMediaData == true {
            audioInput?.append(sampleBuffer)
        }
    }
}

let session = AVCaptureSession()
guard let input = try? AVCaptureDeviceInput(device: device) else {
    fputs("Failed to create audio input\n", stderr)
    exit(1)
}
session.addInput(input)

let audioOutput = AVCaptureAudioDataOutput()
let recorder = AudioRecorder(outputDir: outputDir, chunkDuration: chunkSeconds)
let queue = DispatchQueue(label: "audio-capture")
audioOutput.setSampleBufferDelegate(recorder, queue: queue)
session.addOutput(audioOutput)

session.startRunning()
fputs("Recording system audio in \(Int(chunkSeconds))s chunks to \(outputDir)\n", stderr)

// Handle SIGINT/SIGTERM gracefully
signal(SIGINT) { _ in
    fputs("\nStopping...\n", stderr)
    exit(0)
}
signal(SIGTERM) { _ in
    exit(0)
}

// Keep running
RunLoop.current.run()
